import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTestTierRegistry, resolveTestTierFiles } from '../scripts/test_tier_registry.js';

test('test tier registry covers every test exactly once across fast, integration, and system', () => {
  const registry = buildTestTierRegistry();
  const combined = [...registry.fast, ...registry.integration, ...registry.system];
  assert.equal(new Set(combined).size, combined.length);
  assert.deepEqual([...combined].sort(), registry.all);
  assert.ok(registry.fast.length > registry.integration.length);
  assert.ok(registry.integration.length > registry.system.length);
});

test('test tier registry keeps external-process and release smoke tests out of the fast tier', () => {
  const registry = buildTestTierRegistry();
  for (const name of [
    'runtime_execution_real_usage_fixes.test.js',
    'artifact_delivery.test.js',
    'run_supervisor_chat_bootstrap_smoke.test.js',
    'source_bundle_hygiene.test.js',
  ]) {
    assert.equal(registry.fast.includes(name), false, name);
  }
});

test('resolveTestTierFiles rejects unknown tiers', () => {
  assert.throws(() => resolveTestTierFiles('mystery'), /Unknown test tier/);
});
