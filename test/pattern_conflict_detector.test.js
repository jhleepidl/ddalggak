import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPatternConflict,
  applyTemporaryExecutionOverrideToRuntimeSnapshot,
  buildPatternRecoveryState,
} from '../src/application/pattern_conflict_detector.js';

const teamConfig = {
  structure_v2: {
    topology: {
      pattern: 'debate',
      final_participant_id: 'judge',
    },
    control_policy: {
      final_answer_owner_participant_id: 'judge',
    },
    participants: [
      { participant_id: 'pro', kind: 'agent', role: 'researcher', executable: true },
      { participant_id: 'con', kind: 'agent', role: 'researcher', executable: true },
      { participant_id: 'judge', kind: 'agent', role: 'judge', executable: true },
    ],
  },
};

test('detectPatternConflict recommends temporary override for direct-answer interrupt on complex pattern', () => {
  const result = detectPatternConflict({
    message: '토론 없이 이번엔 그냥 결론만 짧게 말해줘',
    teamConfig,
  });
  assert.equal(result.classification, 'temporary_execution_override');
  assert.equal(result.current_pattern, 'debate');
  assert.equal(result.override.effective_pattern, 'sequential');
  assert.deepEqual(result.override.target_participant_ids, ['judge']);
});

test('detectPatternConflict recommends team refine for structural edit request', () => {
  const result = detectPatternConflict({
    message: 'reviewer 빼고 builder 추가해서 패턴 바꿔',
    teamConfig,
  });
  assert.equal(result.classification, 'structure_override_required');
  assert.equal(result.suggested_command, '/team refine');
});

test('applyTemporaryExecutionOverrideToRuntimeSnapshot narrows runtime agents for single-agent override', () => {
  const snapshot = {
    structure_v2: teamConfig.structure_v2,
    topology_pattern: 'debate',
    runtime_participants: teamConfig.structure_v2.participants,
    runtime_agents: [
      { participant_id: 'pro', template_id: 'pro', slot_id: 'slot_pro' },
      { participant_id: 'con', template_id: 'con', slot_id: 'slot_con' },
      { participant_id: 'judge', template_id: 'judge', slot_id: 'slot_judge' },
    ],
    execution_graph: {
      pattern: 'debate',
      order: ['slot_pro', 'slot_con', 'slot_judge'],
    },
    team_plan: {
      slots: [
        { slot_id: 'slot_pro', role_id: 'researcher' },
        { slot_id: 'slot_con', role_id: 'researcher' },
        { slot_id: 'slot_judge', role_id: 'reviewer' },
      ],
      execution_graph: {
        pattern: 'debate',
        order: ['slot_pro', 'slot_con', 'slot_judge'],
      },
    },
  };
  const { runtimeTeamSnapshot, runtimeAgents, applied } = applyTemporaryExecutionOverrideToRuntimeSnapshot(snapshot, {
    mode: 'single_agent',
    effective_pattern: 'single',
    target_participant_ids: ['judge'],
  });
  assert.equal(applied, true);
  assert.equal(runtimeAgents.length, 1);
  assert.equal(runtimeAgents[0].participant_id, 'judge');
  assert.equal(runtimeTeamSnapshot.execution_graph.pattern, 'single');
  assert.equal(runtimeTeamSnapshot.team_plan.execution_graph.pattern, 'single');
});

test('buildPatternRecoveryState creates normalized recovery state', () => {
  const state = buildPatternRecoveryState({
    originalPattern: 'debate',
    activePattern: 'sequential',
    reason: 'latest_user_interrupt_priority',
  });
  assert.equal(state.status, 'temporary_override_active');
  assert.equal(state.original_pattern, 'debate');
  assert.equal(state.active_pattern, 'sequential');
});
