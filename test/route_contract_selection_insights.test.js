import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveRoutingContractSummary, resolveRouteContractHeuristic, formatRouteReadiness, formatRouteReason, alignPlanActionsToRouteContract } from '../src/application/route_contract.js';
import { summarizeSelectionInsights } from '../src/application/team_execution_insights.js';
import { normalizeRuntimeTeamSnapshot } from '../src/application/runtime_metadata.js';

const structure = {
  participants: [
    { participant_id: 'builder', kind: 'agent', name: 'Client Companion Builder', role: 'builder', provider: 'codex' },
    { participant_id: 'synth', kind: 'agent', name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'gemini' },
  ],
  topology: {
    pattern: 'pipeline',
    final_participant_id: 'synth',
  },
  control_policy: {
    final_answer_owner_participant_id: 'synth',
  },
  memory_plan: {
    surfaces: [
      { surface_id: 'final_answer', file_name: 'final_answer.md', write_policy: 'final', semantic_slots: ['final_answer'], target_roles: ['synthesizer'] },
      { surface_id: 'artifact_index', file_name: 'artifact_index.md', write_policy: 'index', semantic_slots: ['artifact_index'], target_roles: ['builder'] },
    ],
  },
};

test('resolveRoutingContractSummary reports publish readiness from structure_v2', () => {
  const summary = resolveRoutingContractSummary({
    activeTeam: {
      interaction_spec: { final_answer_owner: 'Delivery Synthesizer' },
      structure_v2: structure,
    },
  });
  assert.equal(summary?.final_owner, 'Delivery Synthesizer');
  assert.equal(summary?.final_answer_publish_ok, true);
  assert.equal(summary?.artifact_publish_ok, true);
  assert.match(String(summary?.summary_line || ''), /final owner Delivery Synthesizer/);
});

test('selection insights surface route contract planner facts and explanations', () => {
  const snapshot = normalizeRuntimeTeamSnapshot({
    runtime_agents: [
      { instance_id: 'run-synth', template_id: 'synth', role_id: 'synthesizer', role_label: 'synthesizer', display_label: 'Delivery Synthesizer' },
    ],
    selection_explanations: [
      { subject_id: 'route_contract', reason: 'current team route contract: final owner Delivery Synthesizer · final publish ready · artifact publish ready' },
    ],
    route_contract: {
      available: true,
      final_owner: 'Delivery Synthesizer',
      final_owner_role: 'synthesizer',
      final_answer_publish_ok: true,
      artifact_publish_ok: true,
      artifact_publishers: ['Client Companion Builder'],
      planner_facts: ['final_owner=Delivery Synthesizer', 'final_publish=ready', 'artifact_publish=ready', 'memory_contract=hard_role_scoped_local_only'],
    },
    blueprint_summary: {
      execution_pattern: 'pipeline',
      memory_contract_enforcement: { read_scope: 'hard_role_scoped_local_only' },
      publish_contract_readiness: { final_owner: 'Delivery Synthesizer', final_answer_publish_ok: true, artifact_publish_ok: true },
    },
  });
  const insight = summarizeSelectionInsights({ runtimeTeamSnapshot: snapshot, actions: [] });
  assert.ok(insight.planner_facts.includes('final_owner=Delivery Synthesizer'));
  assert.ok(insight.planner_facts.includes('final_publish=ready'));
  assert.ok(insight.planner_facts.includes('artifact_publish=ready'));
  assert.ok(insight.selected.some((entry) => entry.includes('route_contract: current team route contract')));
});


test('route contract heuristic prefers final owner agent for finalization-like fallback', () => {
  const heuristic = resolveRouteContractHeuristic({
    message: '최종 정리해서 답변해줘',
    agents: [
      { id: 'builder', provider: 'codex' },
      { id: 'synth', provider: 'gemini' },
    ],
    activeTeam: {
      agents: [
        { agent_id: 'builder', name: 'Client Companion Builder', role: 'builder', provider: 'codex' },
        { agent_id: 'synth', name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'gemini' },
      ],
      structure_v2: structure,
    },
  });
  assert.equal(heuristic.preferred_agent_id, 'synth');
  assert.equal(heuristic.blocked_finalization, false);
  assert.match(String(heuristic.route_readiness || ''), /owner=Delivery Synthesizer/);
});

test('route contract heuristic flags blocked final publish for explanation fallback', () => {
  const blockedStructure = {
    ...structure,
    memory_plan: {
      surfaces: [
        { surface_id: 'final_answer', file_name: 'final_answer.md', write_policy: 'final', semantic_slots: ['final_answer'], target_roles: ['reviewer'] },
      ],
    },
  };
  const heuristic = resolveRouteContractHeuristic({
    message: '최종 답변으로 정리해줘',
    agents: [{ id: 'synth', provider: 'gemini' }],
    activeTeam: {
      agents: [{ agent_id: 'synth', name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'gemini' }],
      structure_v2: blockedStructure,
    },
  });
  assert.equal(heuristic.blocked_finalization, true);
  assert.equal(heuristic.should_explain_constraints, true);
  assert.match(String(heuristic.blocked_explanation || ''), /cannot publish final_answer/);
  assert.match(formatRouteReadiness(heuristic.summary, { compact: true }), /final blocked/);
});


test('route contract summary marks final publish as unset when no final owner is declared', () => {
  const noOwnerStructure = {
    ...structure,
    topology: { pattern: 'pipeline' },
    control_policy: {},
  };
  const summary = resolveRoutingContractSummary({
    activeTeam: { structure_v2: noOwnerStructure },
  });
  assert.equal(summary?.final_owner_missing, true);
  assert.equal(summary?.final_answer_publish_ok, false);
  assert.equal(summary?.final_answer_publish_state, 'unset');
  assert.match(String(summary?.summary_line || ''), /final owner unset/);
  assert.match(String(summary?.summary_line || ''), /final publish unset/);
});

test('route contract heuristic detects status intent with ascii word boundary regex', () => {
  const heuristic = resolveRouteContractHeuristic({
    message: 'status 보여줘',
    agents: [{ id: 'synth', provider: 'gemini' }],
    activeTeam: { structure_v2: structure },
  });
  assert.equal(heuristic.intent?.wants_status, true);
});

test('alignPlanActionsToRouteContract reranks first run_agent toward final publisher when needed', () => {
  const aligned = alignPlanActionsToRouteContract({
    plan: {
      actions: [
        { type: 'run_agent', agent_id: 'builder', goal: '최종 답변을 정리해줘', risk: 'L1' },
      ],
    },
    message: '최종 답변을 정리해줘',
    agents: [
      { id: 'builder', provider: 'codex', role: 'builder' },
      { id: 'synth', provider: 'gemini', role: 'synthesizer' },
    ],
    activeTeam: {
      agents: [
        { agent_id: 'builder', name: 'Client Companion Builder', role: 'builder', provider: 'codex' },
        { agent_id: 'synth', name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'gemini' },
      ],
      structure_v2: structure,
    },
  });
  assert.equal(aligned.adjusted, true);
  assert.equal(aligned.plan.actions[0].agent_id, 'synth');
  assert.equal(aligned.plan.route_contract_adjusted, true);
});


test('formatRouteReason explains unset final owner compactly', () => {
  const summary = resolveRoutingContractSummary({
    activeTeam: { structure_v2: { ...structure, topology: { pattern: 'pipeline' }, control_policy: {} } },
  });
  assert.match(formatRouteReason(summary, { compact: true }), /final owner/);
});
