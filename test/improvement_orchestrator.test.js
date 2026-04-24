import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  inspectAndPrepareImprovementJob,
  loadImprovementExecutionContext,
  markImprovementPromotion,
  runImprovementAutomation,
  runImprovementCanary,
  runImprovementPatch,
  runImprovementTests,
  summarizeBoardForImprovement,
} from '../src/application/improvement_orchestrator.js';

class StubClient {
  constructor() {
    this.created = [];
    this.reported = [];
    this.jobs = new Map();
  }

  async createImprovementJob(threadId, body) {
    const jobId = body.job_id || `job_${this.created.length + 1}`;
    const payload = {
      job_id: jobId,
      improvement_target: body.target_repo,
      target_runtime: body.target_runtime,
      workspace_root: body.workspace_root,
      instruction: body.instruction,
      status: 'created',
      phase: 'created',
      report_counts: {},
      latest_reports: {},
      meta: body.meta || {},
    };
    const job = { id: jobId, payload, text: body.instruction };
    this.created.push({ threadId, body, job });
    this.jobs.set(jobId, { job, reports: [] });
    return { ok: true, job };
  }

  async reportImprovementJob(threadId, jobId, body) {
    this.reported.push({ threadId, jobId, body });
    const entry = this.jobs.get(jobId);
    if (entry) {
      entry.job.payload.status = body.status || entry.job.payload.status;
      entry.job.payload.phase = body.phase || entry.job.payload.phase;
      entry.job.payload.report_counts = entry.job.payload.report_counts || {};
      entry.job.payload.report_counts[body.kind] = (entry.job.payload.report_counts[body.kind] || 0) + 1;
      entry.job.payload.latest_reports = entry.job.payload.latest_reports || {};
      entry.job.payload.latest_reports[body.kind] = {
        status: body.status,
        phase: body.phase,
        summary: body.summary,
      };
      if (body.kind === 'code_diff') entry.job.payload.last_patch_status = body.status;
      if (body.kind === 'test_report') entry.job.payload.last_test_status = body.status;
      if (body.kind === 'canary_result') entry.job.payload.last_canary_status = body.status;
      if (body.kind === 'promotion_decision') entry.job.payload.last_promotion_status = body.status;
      entry.reports.push({ payload: { resource_kind: body.kind, status: body.status, phase: body.phase, summary: body.summary }, text: body.preview_text || '', id: `report_${entry.reports.length + 1}` });
    }
    return { ok: true };
  }

  async getImprovementJob(threadId, jobId) {
    const entry = this.jobs.get(jobId);
    return { ok: true, job: entry.job, reports: entry.reports };
  }
}

test('summarizeBoardForImprovement returns counts and raw history streams', () => {
  const summary = summarizeBoardForImprovement({
    lanes: [
      { id: 'raw_history', count: 2, cards: [{ history_stream_key: 'chat:1' }, { history_stream_key: 'chat:2' }] },
      { id: 'promotion_candidates', count: 1, cards: [] },
    ],
  });
  assert.equal(summary.raw_history_count, 2);
  assert.equal(summary.candidate_count, 1);
  assert.deepEqual(summary.raw_history_streams, ['chat:1', 'chat:2']);
});

test('inspectAndPrepareImprovementJob creates job and repo snapshot reports', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-job-'));
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"demo"}');
  const client = new StubClient();
  const prepared = await inspectAndPrepareImprovementJob({
    client,
    threadId: 'thread_1',
    targetRepo: 'ddalggak',
    instruction: 'Inspect runtime and prepare forge patch.',
    requestedBy: 'telegram:1',
    board: { lanes: [{ id: 'raw_history', cards: [{ history_stream_key: 'chat:1' }] }] },
    workspaceRoot: tmp,
  });
  assert.match(prepared.jobId, /^job_/);
  assert.equal(prepared.snapshot.workspace_exists, true);
  assert.equal(client.created.length, 1);
  assert.equal(client.reported.some((entry) => entry.body.kind === 'repo_snapshot'), true);
});

test('runImprovementTests and canary update reports using configured commands', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-run-'));
  const client = new StubClient();
  await client.createImprovementJob('thread_1', { target_repo: 'ddalggak', instruction: 'x', target_runtime: 'forge', workspace_root: tmp });
  const testResult = await runImprovementTests({
    client,
    threadId: 'thread_1',
    jobId: 'job_1',
    targetConfig: { workspace_root: tmp, test_commands: ['echo test-ok'] },
  });
  const canaryResult = await runImprovementCanary({
    client,
    threadId: 'thread_1',
    jobId: 'job_1',
    targetConfig: { workspace_root: tmp, canary_commands: ['echo canary-ok'] },
  });
  assert.equal(testResult.ok, true);
  assert.equal(canaryResult.ok, true);
  assert.equal(client.reported.some((entry) => entry.body.kind === 'test_report'), true);
  assert.equal(client.reported.some((entry) => entry.body.kind === 'canary_result'), true);
});

test('loadImprovementExecutionContext resolves config from stored job payload', async () => {
  const client = new StubClient();
  await client.createImprovementJob('thread_1', {
    job_id: 'job_custom',
    target_repo: 'goc',
    instruction: 'x',
    target_runtime: 'forge',
    workspace_root: '/srv/goc-forge',
  });
  const loaded = await loadImprovementExecutionContext({ client, threadId: 'thread_1', jobId: 'job_custom' });
  assert.equal(loaded.targetConfig.target, 'goc');
  assert.equal(loaded.targetConfig.workspace_root, '/srv/goc-forge');
});

test('markImprovementPromotion reports ready_for_promote when no restart command exists', async () => {
  const client = new StubClient();
  await client.createImprovementJob('thread_1', { target_repo: 'goc', instruction: 'x', target_runtime: 'forge', workspace_root: '/srv/goc-forge' });
  const result = await markImprovementPromotion({
    client,
    threadId: 'thread_1',
    jobId: 'job_1',
    targetConfig: { workspace_root: '/srv/goc-forge', restart_command: '' },
  });
  assert.equal(result.status, 'ready_for_promote');
  assert.equal(client.reported.some((entry) => entry.body.kind === 'promotion_decision'), true);
});

test('runImprovementPatch applies configured patch command and reports code diff', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-patch-'));
  await runImprovementTests({
    client: new StubClient(),
    threadId: 'noop',
    jobId: 'noop',
    targetConfig: { workspace_root: tmp, test_commands: [] },
  }).catch(() => null);
  const client = new StubClient();
  await client.createImprovementJob('thread_1', { target_repo: 'ddalggak', instruction: 'patch demo', target_runtime: 'forge', workspace_root: tmp });
  await import('node:child_process').then(async ({ spawnSync }) => {
    spawnSync('/bin/bash', ['-lc', 'git init && git config user.email test@example.com && git config user.name test && printf "base\n" > demo.txt && git add demo.txt && git commit -m init'], { cwd: tmp });
  });
  const loaded = await loadImprovementExecutionContext({ client, threadId: 'thread_1', jobId: 'job_1' });
  const patchResult = await runImprovementPatch({
    client,
    threadId: 'thread_1',
    jobId: 'job_1',
    targetConfig: {
      ...loaded.targetConfig,
      workspace_root: tmp,
      patch_command: "printf 'patched\\n' >> demo.txt",
    },
    jobPayload: loaded.jobPayload,
    reports: loaded.reports,
    boardSummary: { raw_history_count: 1 },
  });
  assert.equal(patchResult.ok, true);
  assert.equal(patchResult.status, 'applied');
  assert.equal(client.reported.some((entry) => entry.body.kind === 'code_diff'), true);
  assert.match(fs.readFileSync(path.join(tmp, 'demo.txt'), 'utf8'), /patched/);
});

test('runImprovementAutomation runs patch, tests, canary and leaves job ready for promote', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-auto-'));
  await import('node:child_process').then(async ({ spawnSync }) => {
    spawnSync('/bin/bash', ['-lc', 'git init && git config user.email test@example.com && git config user.name test && printf "start\n" > demo.txt && git add demo.txt && git commit -m init'], { cwd: tmp });
  });
  const client = new StubClient();
  await client.createImprovementJob('thread_1', {
    target_repo: 'ddalggak',
    instruction: 'auto patch demo',
    target_runtime: 'forge',
    workspace_root: tmp,
    meta: { auto_mode: true },
  });
  const automation = await runImprovementAutomation({
    client,
    threadId: 'thread_1',
    jobId: 'job_1',
    targetConfig: {
      target: 'ddalggak',
      workspace_root: tmp,
      patch_command: "printf 'auto\\n' >> demo.txt",
      test_commands: ['test -f demo.txt'],
      canary_commands: ['grep -q auto demo.txt'],
      auto_promote: false,
    },
    board: { lanes: [{ id: 'raw_history', cards: [{ history_stream_key: 'chat:1' }] }] },
  });
  assert.equal(automation.ok, true);
  assert.equal(automation.status, 'ready_for_promote');
  const job = await client.getImprovementJob('thread_1', 'job_1');
  assert.equal(job.job.payload.last_patch_status, 'applied');
  assert.equal(job.job.payload.last_test_status, 'passed');
  assert.equal(job.job.payload.last_canary_status, 'passed');
  assert.equal(job.job.payload.status, 'ready_for_promote');
});
