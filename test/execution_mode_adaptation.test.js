import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyAdaptiveExecutionModeToTaskInterpretation,
  buildAdaptiveExecutionSignals,
  recordAdaptiveExecutionOutcome,
  selectAdaptiveExecutionMode,
} from '../src/application/execution_mode_adaptation.js';
import { ensureRuntimeSessionState } from '../src/application/runtime_session_state.js';
import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';

const interpretation = {
  goal: '두 소스를 조사하고 결과를 검토해서 요약해줘',
  task_type: 'analysis',
  deliverable_type: 'brief',
  review_policy: 'required',
  candidate_capability_slots: [
    { role_id: 'researcher', purpose: 'collect evidence' },
    { role_id: 'reviewer', purpose: 'check contradictions' },
    { role_id: 'synthesizer', purpose: 'write summary' },
  ],
};

test('adaptive execution defaults to single_compiled when pressure is low', () => {
  const selection = selectAdaptiveExecutionMode({
    goal: interpretation.goal,
    message: interpretation.goal,
    taskInterpretation: interpretation,
    preferredRoles: ['researcher'],
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
      },
    },
  });
  assert.equal(selection.mode, 'single_compiled');
  assert.equal(selection.max_agents, 1);
  const shaped = applyAdaptiveExecutionModeToTaskInterpretation(interpretation, selection);
  assert.equal(shaped.candidate_capability_slots.length, 1);
  assert.equal(shaped.candidate_capability_slots[0].role_id, 'researcher');
});



test('adaptive execution can start directly in multi_motif from explicit request', () => {
  const requested = {
    ...interpretation,
    execution_mode_request: 'multi_motif',
    parallelism_preference: 'parallel',
  };
  const selection = selectAdaptiveExecutionMode({
    goal: requested.goal,
    message: requested.goal,
    taskInterpretation: requested,
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
        allow_direct_multi_start: true,
      },
    },
  });
  assert.equal(selection.mode, 'multi_motif');
  assert.ok(selection.reasons.includes('explicit_mode_request_multi'));
});

test('adaptive execution can start from task family stable default mode', () => {
  const selection = selectAdaptiveExecutionMode({
    goal: interpretation.goal,
    message: interpretation.goal,
    taskInterpretation: interpretation,
    promotionSummary: {
      task_family_mode_profiles: {
        'analysis::brief': {
          recommended_mode: 'multi_motif',
          confidence: 0.81,
          sample_size: 4,
        },
      },
    },
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
        respect_task_family_default: true,
        task_family_confidence_threshold: 0.6,
      },
    },
  });
  assert.equal(selection.mode, 'multi_motif');
  assert.equal(selection.task_family_mode_hint?.mode, 'multi_motif');
  assert.ok(selection.reasons.includes('task_family_default_mode'));
});

test('adaptive execution escalates to hybrid and multi based on session pressure', () => {
  const runtime = {
    participantContributionHistory: [
      { contribution: { kind: 'critique' } },
      { contribution: { kind: 'conflict_flag' } },
      { contribution: { kind: 'summary' } },
    ],
  };
  ensureRuntimeSessionState(runtime, {});
  runtime.runtimeSessionState.execution_state.adaptive_execution = {
    current_mode: 'hybrid_sidecar',
    failure_streak: 2,
    capability_gap_runs: 1,
    success_streak: 0,
  };
  runtime.runtimeSessionState.observability_state.participant_surface = {
    decision_log_size: 4,
    last_folded_count: 2,
  };
  const selection = selectAdaptiveExecutionMode({
    goal: interpretation.goal,
    message: interpretation.goal,
    taskInterpretation: interpretation,
    preferredRoles: ['researcher'],
    runtime,
    runtimeSessionState: runtime.runtimeSessionState,
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
        participant_pressure_threshold: 2,
        failure_streak_threshold: 1,
        capability_gap_threshold: 1,
        decomposability_threshold: 1.5,
      },
    },
  });
  assert.equal(selection.mode, 'multi_motif');
  assert.ok(selection.reasons.includes('hybrid_to_multi_pressure') || selection.reasons.includes('direct_multi_escalation'));
});

test('recordAdaptiveExecutionOutcome tracks streaks and current mode', () => {
  const runtime = {};
  ensureRuntimeSessionState(runtime, {});
  recordAdaptiveExecutionOutcome({
    runtime,
    status: 'done',
    plannerMetadata: {
      execution_mode: 'hybrid_sidecar',
      execution_mode_signals: { participant_pressure: 2 },
    },
    capabilityGapCount: 0,
    qualitySignals: {
      followup_burden: 0,
      quality_gap: 0,
      contradiction_pressure: 1,
      contradiction_resolved: true,
      quality_health_score: 0.9,
    },
  });
  let adaptive = runtime.runtimeSessionState.execution_state.adaptive_execution;
  assert.equal(adaptive.current_mode, 'hybrid_sidecar');
  assert.equal(adaptive.success_streak, 1);
  assert.equal(adaptive.contradiction_resolved_runs, 1);
  assert.equal(adaptive.mode_history.length, 1);
  recordAdaptiveExecutionOutcome({
    runtime,
    status: 'error',
    plannerMetadata: {
      execution_mode: 'multi_motif',
      execution_mode_signals: { participant_pressure: 4 },
    },
    capabilityGapCount: 1,
    qualitySignals: {
      followup_burden: 1,
      quality_gap: 2,
      contradiction_pressure: 2,
      contradiction_resolved: false,
      quality_health_score: 0.2,
    },
  });
  adaptive = runtime.runtimeSessionState.execution_state.adaptive_execution;
  assert.equal(adaptive.current_mode, 'multi_motif');
  assert.equal(adaptive.failure_streak, 1);
  assert.equal(adaptive.capability_gap_runs, 1);
  assert.equal(adaptive.followup_burden_runs, 1);
  assert.equal(adaptive.quality_gap_runs, 1);
  assert.equal(adaptive.mode_history.length, 2);
});



test('adaptive execution escalates from single when quality pressure accumulates', () => {
  const runtime = {};
  ensureRuntimeSessionState(runtime, {});
  runtime.runtimeSessionState.execution_state.adaptive_execution = {
    current_mode: 'single_compiled',
    success_streak: 0,
    failure_streak: 0,
    followup_burden_runs: 1,
    quality_gap_runs: 1,
    contradiction_pressure_runs: 2,
    last_quality_signals: {
      quality_health_score: 0.3,
      followup_burden: 1,
      quality_gap: 2,
      contradiction_pressure: 2,
    },
    mode_history: [
      { mode: 'single_compiled', status: 'await_user', quality_gap: 2, followup_burden: 1, contradiction_pressure: 2, quality_health_score: 0.3 },
    ],
  };
  const selection = selectAdaptiveExecutionMode({
    goal: interpretation.goal,
    message: interpretation.goal,
    taskInterpretation: interpretation,
    runtime,
    runtimeSessionState: runtime.runtimeSessionState,
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
        followup_burden_threshold: 1,
        quality_gap_threshold: 1,
        contradiction_pressure_threshold: 2,
        min_quality_health_score: 0.55,
      },
    },
  });
  assert.equal(selection.mode, 'hybrid_sidecar');
  assert.ok(selection.reasons.includes('single_to_hybrid_pressure'));
  assert.ok(Array.isArray(selection.history_tail));
  assert.equal(selection.history_tail.length, 1);
  assert.equal(selection.quality_signals.quality_health_score, 0.3);
});

test('runtime orchestration starts single and can expand under adaptive pressure', () => {
  const registry = {
    agents: [
      { id: 'researcher', role_type: 'researcher', provider: 'gemini', model: 'gemini', prompt: 'research' },
      { id: 'reviewer', role_type: 'reviewer', provider: 'gemini', model: 'gemini', prompt: 'review' },
      { id: 'synthesizer', role_type: 'synthesizer', provider: 'gemini', model: 'gemini', prompt: 'summary' },
    ],
  };
  const initial = buildRuntimeOrchestration({
    mode: 'run',
    goal: '관련 자료 조사 후 요약해줘',
    message: '관련 자료 조사 후 요약해줘',
    registry,
    preferredRoles: ['researcher'],
    runtimePolicy: { execution_mode_policy: { default_mode: 'single_compiled' } },
  });
  assert.equal(initial.planner_metadata.execution_mode, 'single_compiled');
  assert.equal(initial.runtime_agents.length, 1);

  const pressuredState = {
    execution_state: {
      adaptive_execution: {
        current_mode: 'hybrid_sidecar',
        failure_streak: 2,
        capability_gap_runs: 1,
      },
    },
    observability_state: {
      participant_surface: {
        decision_log_size: 4,
        last_folded_count: 2,
      },
    },
  };
  const escalated = buildRuntimeOrchestration({
    mode: 'run',
    goal: '관련 자료 조사 후 검토까지 해서 요약해줘',
    message: '관련 자료 조사 후 검토까지 해서 요약해줘',
    registry,
    preferredRoles: ['researcher'],
    runtimePolicy: {
      execution_mode_policy: {
        default_mode: 'single_compiled',
        participant_pressure_threshold: 2,
        failure_streak_threshold: 1,
        capability_gap_threshold: 1,
        decomposability_threshold: 1.5,
      },
    },
    runtimeSessionState: pressuredState,
  });
  assert.equal(escalated.planner_metadata.execution_mode, 'multi_motif');
  assert.ok(escalated.runtime_agents.length >= 2);
});

