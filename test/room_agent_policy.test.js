import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDefaultAgentActivationPolicy,
  deriveAgentTelemetry,
  normalizeAgentExecutionTelemetry,
  summarizeAgentExecutionTelemetry,
  formatAgentActivationPolicyForTelegram,
  formatAgentSpecializationProposalForTelegram,
  proposeAgentRosterSpecialization,
} from '../src/application/room_agent_policy.js';

test('agent activation policy separates required, active, on-demand, and shadow states', () => {
  const pkg = {
    package_id: 'research_paper_factory',
    domain_label: 'research_paper',
    default_depth: 'loop',
    agents: ['research_scout', 'novelty_critic', 'method_designer', 'experiment_planner', 'implementation_planner', 'paper_synthesizer'],
    tags: ['research', 'paper'],
  };
  const policy = buildDefaultAgentActivationPolicy(pkg);
  assert.equal(policy.strategy, 'cost_aware_outcome_aware_agent_roster');
  assert.ok(policy.roster.some((row) => row.agent === 'novelty_critic' && row.state === 'required'));
  assert.ok(policy.roster.some((row) => row.state === 'active'));
  assert.match(policy.optimization_target, /not_fewer_tokens_alone/);
  assert.equal(policy.governance.durable_roster_change, 'user_or_goc_approval_required');
});

test('specialization proposal never disables required agents and uses trace evidence', () => {
  const pkg = {
    package_id: 'wide_room',
    domain_label: 'general_workbench',
    default_depth: 'team',
    agents: ['planner', 'builder', 'reviewer', 'extra_unused_agent'],
  };
  const policy = buildDefaultAgentActivationPolicy(pkg);
  const events = Array.from({ length: 10 }, (_, idx) => ({
    ts: `2026-07-05T00:0${idx}:00.000Z`,
    event_type: 'work_depth_used',
    command: '/loop',
    goal: 'builder가 코드 패치와 테스트를 진행함',
    extra: { artifact: idx % 2 === 0 ? 'test passed' : 'patch' },
  }));
  const proposal = proposeAgentRosterSpecialization({ events, policy, roomPackage: pkg });
  assert.ok(['proposal_ready', 'no_safe_change_found'].includes(proposal.status));
  assert.equal(proposal.guardrail.required_agents_never_auto_disabled, true);
  assert.equal(proposal.guardrail.token_cost_only, 'insufficient_for_pruning');
  assert.equal(proposal.actions.some((a) => a.from === 'required'), false);
  assert.equal(proposal.actions.some((a) => a.to === 'disabled' && a.agent === 'reviewer'), false);
  const formatted = formatAgentSpecializationProposalForTelegram(proposal);
  assert.match(formatted, /token_cost_only/);
});

test('telemetry and telegram formatting expose contribution and cost signals', () => {
  const pkg = { package_id: 'code_room', default_depth: 'loop', domain_label: 'code_review', agents: ['builder', 'verifier', 'delivery_synthesizer'] };
  const policy = buildDefaultAgentActivationPolicy(pkg);
  const telemetry = deriveAgentTelemetry({
    events: [{ event_type: 'work_depth_used', goal: 'builder patch test artifact', command: '/loop' }],
    policy,
    roomPackage: pkg,
  });
  assert.ok(telemetry.some((row) => row.agent === 'builder'));
  const text = formatAgentActivationPolicyForTelegram(policy, { telemetry });
  assert.match(text, /Room agent activation policy/);
  assert.match(text, /token cost is an optimization signal/);
});


test('per-agent telemetry aggregates tokens latency model role and contribution', () => {
  const events = [{
    event_type: 'agent_call_completed',
    extra: {
      agent_telemetry: [
        { agent: 'builder', model_role: 'code_executor', provider: 'codex', model: 'gpt-5-codex', tokens: { input_tokens: 100, output_tokens: 40, total_tokens: 140 }, latency_ms: 1200, contribution_score: 0.75 },
        { agent: 'verifier', model_role: 'verifier_critic', provider: 'gemini', model: 'gemini-pro', usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, latencyMs: 900, contributionScore: 0.6 },
      ],
    },
  }];
  const normalized = normalizeAgentExecutionTelemetry(events[0].extra.agent_telemetry[0]);
  assert.equal(normalized.agent, 'builder');
  assert.equal(normalized.model_role, 'code_executor');
  assert.equal(normalized.total_tokens, 140);
  const summary = summarizeAgentExecutionTelemetry(events);
  assert.equal(summary.find((row) => row.agent === 'builder').avg_latency_ms, 1200);
  const policy = buildDefaultAgentActivationPolicy({ package_id: 'code_room', domain_label: 'code_review', agents: ['builder', 'verifier'] });
  const telemetry = deriveAgentTelemetry({ events, policy, roomPackage: { agents: ['builder', 'verifier'] } });
  const builder = telemetry.find((row) => row.agent === 'builder');
  assert.equal(builder.call_count, 1);
  assert.equal(builder.total_tokens, 140);
  assert.equal(builder.observed_model_roles.code_executor, 1);
  assert.equal(builder.telemetry_quality, 'per_agent_execution_telemetry');
});
