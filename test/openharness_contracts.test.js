import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GocClient } from '../src/goc_client.js';
import { buildHarnessPackageHashInput, normalizeHarnessPackage, normalizeHarnessRuntimePolicy, OPENHARNESS_PACKAGE_SCHEMA_VERSION, OPENHARNESS_RUN_TRACE_SCHEMA_VERSION, OPENHARNESS_RUN_SYNC_SCHEMA_VERSION, OPENHARNESS_RUNTIME_POLICY_SCHEMA_VERSION, stableJsonHash } from '../src/shared/openharness_contracts.js';
import { LocalRunEventSink } from '../src/runtime_capabilities/run_event_sink.js';

class JobsStub {
  constructor(root) {
    this.root = root;
  }

  jobDir(jobId) {
    const dir = path.join(this.root, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

test('normalizeHarnessPackage preserves existing manifest/spec and adds stable package metadata', () => {
  const pkg = normalizeHarnessPackage({
    metadata: {
      name: 'Research Harness',
      tags: ['Research', 'Debug'],
      thread_id: 'thread_1',
    },
    compatibility: {
      install_target: 'thread_team_config',
    },
    harness_spec: {
      schema_version: 'openharness.spec/v1',
    },
    harness_summary: {
      name: 'Research Harness',
      spec_hash: 'abc123',
    },
    team_manifest: {
      kind: 'ddalggak_team_blueprint',
    },
    skill_packages: [{ id: 'skill.run_trace_debugging.v1', name: 'Run Trace Debugging' }],
  });

  assert.equal(pkg.schema_version, OPENHARNESS_PACKAGE_SCHEMA_VERSION);
  assert.equal(pkg.kind, 'openharness_package');
  assert.equal(pkg.metadata.thread_id, 'thread_1');
  assert.equal(pkg.compatibility.install_target, 'thread_team_config');
  assert.equal(pkg.trace_contract.schema_version, OPENHARNESS_RUN_TRACE_SCHEMA_VERSION);
  assert.equal(pkg.sync_contract.schema_version, OPENHARNESS_RUN_SYNC_SCHEMA_VERSION);
  assert.ok(pkg.package_hash);
  assert.equal(pkg.skill_packages.length, 1);
});


test('normalizeHarnessPackage keeps package_hash stable across export timestamps and wrapped payloads', () => {
  const payload = {
    package: {
      package_id: 'pkg.wrap',
      metadata: { name: 'Wrapped Harness', exported_at: '2026-04-16T00:00:00Z', thread_id: 'thread_a' },
      harness_spec: { schema_version: 'openharness.spec/v1' },
      team_manifest: { kind: 'ddalggak_team_blueprint' },
      skill_packages: [],
    },
  };
  const pkgA = normalizeHarnessPackage(payload);
  const pkgB = normalizeHarnessPackage({
    package: {
      ...payload.package,
      metadata: { ...payload.package.metadata, exported_at: '2026-04-16T00:00:10Z', thread_id: 'thread_b' },
    },
  });
  assert.equal(pkgA.package_hash, pkgB.package_hash);
  assert.equal(pkgA.package_hash, stableJsonHash(buildHarnessPackageHashInput(payload)));
});

test('goc client getHarnessPackage prefers canonical package route and normalizes payload', async () => {
  const client = new GocClient({ apiBase: 'http://example.invalid', serviceKey: 'svc_test' });
  let captured = null;
  client._requestAny = async ({ method, attempts = [] }) => {
    captured = { method, attempts };
    return {
      metadata: { name: 'Pkg' },
      harness_spec: {},
      team_manifest: {},
      skill_packages: [],
    };
  };

  const pkg = await client.getHarnessPackage('thread_1');
  assert.equal(captured?.attempts?.[0]?.path, '/api/threads/thread_1/harness_package');
  assert.equal(pkg.schema_version, OPENHARNESS_PACKAGE_SCHEMA_VERSION);
  assert.equal(pkg.metadata.name, 'Pkg');
});


test('goc client installHarnessPackage prefers canonical install route and unwraps package response', async () => {
  const client = new GocClient({ apiBase: 'http://example.invalid', serviceKey: 'svc_test' });
  const calls = [];
  client._requestAny = async ({ method, attempts = [] }) => {
    calls.push({ method, attempts });
    return { ok: true, package: { package_id: 'pkg.alpha', metadata: { name: 'Alpha' }, harness_spec: {}, team_manifest: {} } };
  };

  const pkg = await client.installHarnessPackage('thread_1', { package_id: 'pkg.alpha', harness_spec: {}, team_manifest: {} }, 'pending');
  assert.equal(calls[0]?.attempts?.[0]?.path, '/api/threads/thread_1/harness_package/install');
  assert.equal(calls[0]?.attempts?.[0]?.body?.apply_state, 'pending');
  assert.equal(pkg.package_id, 'pkg.alpha');
});

test('goc client installHarnessPackage falls back to harness spec + team blueprint writes', async () => {
  const client = new GocClient({ apiBase: 'http://example.invalid', serviceKey: 'svc_test' });
  const calls = [];
  client._requestAny = async ({ method, attempts = [] }) => {
    calls.push({ method, attempts });
    if (attempts[0]?.path?.includes('/harness_package/install')) throw new Error('route missing');
    return { ok: true };
  };

  const pkg = await client.installHarnessPackage('thread_1', {
    package_id: 'pkg.beta',
    metadata: { name: 'Beta' },
    harness_spec: { schema_version: 'openharness.spec/v1' },
    team_manifest: { kind: 'ddalggak_team_blueprint' },
  }, 'active');
  assert.equal(calls.length, 3);
  assert.match(calls[1].attempts[0].path, /\/harness_spec$/);
  assert.match(calls[2].attempts[0].path, /\/team\/blueprint\/install$/);
  assert.equal(pkg.package_id, 'pkg.beta');
});

test('LocalRunEventSink writes standardized run trace records', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-run-events-'));
  const jobs = new JobsStub(root);
  const sink = new LocalRunEventSink({ jobs });

  await sink.startRun({ run_id: 'run_1', status: 'running' }, { jobId: 'job_1' });
  await sink.recordAgentEvent('agent.step', { detail: 'ok' }, { jobId: 'job_1' });
  await sink.finishRun({ status: 'done' }, { jobId: 'job_1' });

  const eventPath = path.join(root, 'job_1', 'runtime_events.jsonl');
  const rows = fs.readFileSync(eventPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows[0].schema_version, OPENHARNESS_RUN_TRACE_SCHEMA_VERSION);
  assert.equal(rows[0].run_id, 'run_1');
  assert.equal(rows[1].sync_schema_version, OPENHARNESS_RUN_SYNC_SCHEMA_VERSION);
  assert.equal(rows[1].job_id, 'job_1');
});


test('normalizeHarnessRuntimePolicy derives delivery/tool/approval/runtime_execution from package payload', () => {
  const policy = normalizeHarnessRuntimePolicy({
    harness_summary: {
      delivery_policy: { default_delivery_mode: 'projection_only', appendix_char_budget_ratio: 0.2, default_budget_tier: 'medium', default_risk_level: 'standard', projection_appendix_enabled_by_default: true },
      resolved_role_delivery: { planner: { effective_role_id: 'operator', delivery_mode: 'projection_only' } },
      audit_flags: { timeline_enabled: false, cross_reference_enabled: true, show_lifecycle: false, show_conflict_history: true },
    },
    harness_spec: {
      tool_policy: { tool_rag_enabled: false, tool_view_mode: 'task_scoped' },
      approval_policy: { deny_feedback_mode: 'structured_feedback', default_escalation: 'operator' },
    },
    team_manifest: { team: { runtime_execution: { checkpointing: { enabled: true }, approval_matrix: { verification: 'ask' } } } },
  });
  assert.equal(policy.schema_version, OPENHARNESS_RUNTIME_POLICY_SCHEMA_VERSION);
  assert.equal(policy.delivery_policy.default_delivery_mode, 'projection_only');
  assert.equal(policy.tool_policy.tool_rag_enabled, false);
  assert.equal(policy.approval_policy.default_escalation, 'operator');
  assert.equal(policy.runtime_execution.approval_matrix.verification, 'ask');
});


test('LocalRunEventSink respects harness audit timeline policy', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openharness-run-events-disabled-'));
  const jobs = new JobsStub(root);
  const sink = new LocalRunEventSink({
    jobs,
    runtimePolicy: { audit_flags: { timeline_enabled: false } },
  });

  await sink.startRun({ run_id: 'run_disabled', status: 'running' }, { jobId: 'job_disabled' });
  const eventPath = path.join(root, 'job_disabled', 'runtime_events.jsonl');
  assert.equal(fs.existsSync(eventPath), false);
});
