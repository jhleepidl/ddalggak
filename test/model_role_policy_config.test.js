import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  CANONICAL_MODEL_ROLES,
  loadModelRolePolicyFile,
  normalizeModelRolePolicyDocument,
} from '../src/application/model_role_policy_config.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const defaultPolicy = path.join(root, 'config', 'model_roles', 'default.json');
const portfolioPolicy = path.join(root, 'config', 'model_roles', 'portfolio_benchmark.json');

test('repository model-role policies cover every canonical role', () => {
  for (const file of [defaultPolicy, portfolioPolicy]) {
    const policy = loadModelRolePolicyFile(file);
    assert.deepEqual(Object.keys(policy.assignments).sort(), [...CANONICAL_MODEL_ROLES].sort());
    assert.equal(policy.governance.room_override_mode, 'role_by_role_merge');
    assert.equal(policy.governance.room_policy_learning, 'proposal_then_trial_then_approval');
  }
});

test('portfolio policy is versioned and provider-only assignments preserve provider defaults', () => {
  const policy = loadModelRolePolicyFile(portfolioPolicy);
  assert.equal(policy.policy_id, 'portfolio_benchmark_default');
  assert.equal(policy.scope, 'benchmark');
  assert.equal(policy.revision, 1);
  assert.equal(policy.assignments.source_grounder.provider, 'claude');
  assert.equal(policy.assignments.source_grounder.model, '');
  assert.equal(policy.assignments.delivery_synthesizer.provider, 'codex');
});

test('legacy flat role maps remain accepted as explicit overrides', () => {
  const policy = normalizeModelRolePolicyDocument({
    source_grounder: { provider: 'claude' },
    delivery_synthesizer: { provider: 'codex' },
  });
  assert.equal(policy.assignments.source_grounder.provider, 'claude');
  assert.equal(policy.assignments.delivery_synthesizer.provider, 'codex');
});

test('unknown roles are rejected before execution', () => {
  assert.throws(() => normalizeModelRolePolicyDocument({
    schema_version: 'ddalggak.model_role_policy/v1',
    policy_id: 'bad',
    roles: { scenario_specific_router: { provider: 'codex' } },
  }), /Unsupported model role/i);
});


test('saved policy descriptors can be loaded again as explicit experiment overrides', () => {
  const original = loadModelRolePolicyFile(portfolioPolicy);
  const reloaded = normalizeModelRolePolicyDocument(original);
  assert.equal(reloaded.policy_id, 'portfolio_benchmark_default');
  assert.equal(reloaded.assignments.source_grounder.provider, 'claude');
  assert.equal(reloaded.assignments.delivery_synthesizer.provider, 'codex');
});
