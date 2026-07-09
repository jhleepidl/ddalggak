import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomModelRolePlanForTelegram,
  modelRoleForPhase,
  normalizeRoomModelRolePolicy,
  resolveRoomModelRole,
  resolveRoomModelRolePlan,
} from '../src/application/room_model_role_router.js';

test('model role router maps runtime phases to room-scoped roles', () => {
  assert.equal(modelRoleForPhase('source'), 'source_grounder');
  assert.equal(modelRoleForPhase('code'), 'code_executor');
  assert.equal(modelRoleForPhase('synthesis'), 'delivery_synthesizer');
});

test('model role router applies env overrides without exporting credentials', () => {
  const resolved = resolveRoomModelRole({
    phase: 'verifier',
    roomPackage: { package_id: 'research_room', domain_label: 'research', model_policy: { default_assignment: [{ role: 'verifier_critic', preferred_tier: 'high_precision_critic' }] } },
    env: { DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER: 'gemini', DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_MODEL: 'gemini-2.5-pro' },
  });
  assert.equal(resolved.role, 'verifier_critic');
  assert.equal(resolved.provider, 'gemini');
  assert.equal(resolved.model, 'gemini-2.5-pro');
  assert.equal(resolved.governance.provider_secret_export, 'never');
});

test('model role plan formats all phase-specific assignments', () => {
  const policy = normalizeRoomModelRolePolicy({ roomPackage: { package_id: 'code_room', domain_label: 'code_review', default_depth: 'loop' } });
  assert.ok(policy.default_assignment.some((row) => row.role === 'code_executor'));
  const plan = resolveRoomModelRolePlan({ roomPackage: { package_id: 'code_room', domain_label: 'code_review', default_depth: 'loop' }, env: {} });
  assert.ok(plan.rows.some((row) => row.role === 'code_executor'));
  assert.equal(plan.guardrail.credentials_exported, false);
  assert.match(formatRoomModelRolePlanForTelegram(plan), /Room model-role router/);
});
