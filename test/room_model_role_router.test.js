import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomModelRolePlanForTelegram,
  modelRoleForAgentRole,
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


test('model role router maps Room agent roles without scenario-specific routing', () => {
  assert.equal(modelRoleForAgentRole('researcher_lane_2'), 'source_grounder');
  assert.equal(modelRoleForAgentRole('canon_reviewer'), 'verifier_critic');
  assert.equal(modelRoleForAgentRole('implementation_planner'), 'code_executor');
  assert.equal(modelRoleForAgentRole('revision_synthesizer'), 'delivery_synthesizer');
  assert.equal(modelRoleForAgentRole('operator'), 'concierge_router');
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

test('explicit Room profile model policy overrides package defaults role by role', () => {
  const roomPackage = {
    kind: 'room_package_v1',
    model_policy: {
      strategy: 'package_defaults',
      default_assignment: [
        { role: 'source_grounder', provider: 'codex', model: 'package-source' },
        { role: 'verifier_critic', provider: 'codex', model: 'package-review' },
      ],
    },
  };
  const profile = {
    model_policy: {
      strategy: 'benchmark_override',
      default_assignment: [
        { role: 'source_grounder', provider: 'claude', model: '' },
      ],
    },
  };
  const policy = normalizeRoomModelRolePolicy({ roomPackage, profile });
  const source = policy.default_assignment.find((row) => row.role === 'source_grounder');
  const reviewer = policy.default_assignment.find((row) => row.role === 'verifier_critic');
  assert.equal(policy.strategy, 'benchmark_override');
  assert.equal(source.provider, 'claude');
  assert.equal(source.model, '');
  assert.equal(reviewer.provider, 'codex');
  assert.equal(reviewer.model, 'package-review');
});


test('effective Room model policy preserves repository inheritance and Room revision metadata', () => {
  const policy = normalizeRoomModelRolePolicy({
    roomPackage: {
      model_policy: {
        policy_id: 'repository_default',
        policy_scope: 'repository_default',
        policy_revision: 1,
        default_assignment: [{ role: 'source_grounder', provider: 'codex', model: '' }],
      },
    },
    profile: {
      model_policy: {
        policy_id: 'room_policy_room_42',
        policy_scope: 'room',
        policy_revision: 4,
        parent_policy_id: 'repository_default',
        inherited_policy_id: 'portfolio_benchmark_default',
        inherited_policy_revision: 2,
        default_assignment: [{ role: 'source_grounder', provider: 'claude', model: '' }],
        governance: { room_policy_learning: 'proposal_then_trial_then_approval' },
      },
    },
  });
  assert.equal(policy.policy_id, 'room_policy_room_42');
  assert.equal(policy.policy_scope, 'room');
  assert.equal(policy.policy_revision, 4);
  assert.equal(policy.parent_policy_id, 'repository_default');
  assert.equal(policy.inherited_policy_id, 'portfolio_benchmark_default');
  assert.equal(policy.inherited_policy_revision, 2);
  assert.equal(policy.governance.room_override_mode, 'role_by_role_merge');
  assert.equal(policy.governance.room_policy_learning, 'proposal_then_trial_then_approval');
  assert.equal(policy.default_assignment.find((row) => row.role === 'source_grounder').provider, 'claude');
});
