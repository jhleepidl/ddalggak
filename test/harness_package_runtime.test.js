import test from 'node:test';
import assert from 'node:assert/strict';

import { applyInstalledHarnessPackageToRuntime, getInstalledHarnessPackageState, installHarnessPackageToSession } from '../src/application/harness_package_runtime.js';

class SessionStoreStub {
  constructor() {
    this.map = new Map();
  }
  get(chatId) {
    return this.map.get(chatId) || {};
  }
  upsert(chatId, value) {
    const current = this.get(chatId);
    const next = typeof value === 'function' ? value(current) : { ...current, ...(value || {}) };
    this.map.set(chatId, next);
    return next;
  }
}

test('installHarnessPackageToSession applies team manifest and stores package install state', async () => {
  const sessionStore = new SessionStoreStub();
  const runtime = { map: { threadId: 'thread_1' } };
  const result = await installHarnessPackageToSession({
    sessionStore,
    chatId: 'chat_1',
    runtime,
    applyState: 'active',
    harnessPackage: {
      package_id: 'pkg.alpha',
      package_hash: 'deadbeefcafebabe',
      metadata: { name: 'Alpha Harness' },
      harness_spec: { schema_version: 'openharness.spec/v1', metadata: { name: 'Alpha Harness' } },
      team_manifest: {
        kind: 'ddalggak_team_blueprint',
        version: 1,
        team: {
          supervisor: 'planner',
          pattern: 'single',
          mode: 'structured',
          agents: [{ role: 'planner', model: 'gpt-5' }],
        },
      },
      skill_packages: [{ id: 'skill.alpha', name: 'Alpha Skill' }],
    },
  });

  assert.equal(result.package_ref.package_id, 'pkg.alpha');
  const state = getInstalledHarnessPackageState(sessionStore, 'chat_1');
  assert.equal(state.package_ref.package_hash, 'deadbeefcafebabe');
  assert.equal(state.apply_state, 'active');
  assert.equal(state.skill_packages.length, 1);
  assert.equal(runtime.harnessPackageRef.package_id, 'pkg.alpha');
  assert.equal(result.team_install.apply_state, 'active');
});

test('applyInstalledHarnessPackageToRuntime tolerates empty state', () => {
  const runtime = {};
  applyInstalledHarnessPackageToRuntime(runtime, { installState: null });
  assert.deepEqual(runtime, { openharnessInstallState: {} });
});


test('installHarnessPackageToSession stores runtime policy and exposes runtime execution fallback', async () => {
  const sessionStore = new SessionStoreStub();
  const runtime = { map: { threadId: 'thread_2' } };
  await installHarnessPackageToSession({
    sessionStore,
    chatId: 'chat_2',
    runtime,
    applyState: 'active',
    harnessPackage: {
      package_id: 'pkg.runtime',
      harness_summary: {
        delivery_policy: { default_delivery_mode: 'projection_only' },
        audit_flags: { timeline_enabled: false },
      },
      harness_spec: { tool_policy: { tool_rag_enabled: false } },
      team_manifest: {
        kind: 'ddalggak_team_blueprint',
        team: {
          supervisor: 'planner',
          agents: [{ role: 'planner', model: 'gpt-5' }],
          runtime_execution: { approval_matrix: { verification: 'ask' } },
        },
      },
    },
  });
  const state = getInstalledHarnessPackageState(sessionStore, 'chat_2');
  assert.equal(state.runtime_policy.delivery_policy.default_delivery_mode, 'projection_only');
  assert.equal(runtime.harnessRuntimePolicy.tool_policy.tool_rag_enabled, false);
  assert.equal(runtime.runtimeExecutionPolicy.approval_matrix.verification, 'ask');
});
