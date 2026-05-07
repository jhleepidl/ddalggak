import test from 'node:test';
import assert from 'node:assert/strict';

import { selectAdaptiveExecutionMode } from '../src/application/execution_mode_adaptation.js';
import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';
import { installWorkflowExecutionContract } from '../src/application/workflow_execution_contract.js';
import { buildExecutionQualitySignals } from '../src/application/execution_quality_signals.js';

const LOOP_REQUEST = '이 작업을 계속 점검하고 개선하는 loop로 돌려줘. 매 개선마다 구현을 review하고, 문제나 개선점이 있으면 수정해. 큰 변경이나 위험한 작업은 승인받아. 중단 조건은 충분히 완성도가 높고 새로움이 있는 결과물이 나오면 중단하는 거야.';

test('bounded loop contract is a hard floor even when direct multi start is disabled', () => {
  const selection = selectAdaptiveExecutionMode({
    goal: LOOP_REQUEST,
    message: LOOP_REQUEST,
    taskInterpretation: {
      goal: LOOP_REQUEST,
      task_type: 'implementation',
      deliverable_type: 'website',
      candidate_capability_slots: [{ role_id: 'builder', purpose: 'implement' }],
    },
    runtimePolicy: { execution_mode_policy: { default_mode: 'single_compiled', allow_direct_multi_start: false, allow_direct_hybrid_start: false } },
  });
  assert.notEqual(selection.mode, 'single_compiled');
  assert.equal(selection.team_workflow_contract.workflow_kind, 'bounded_continuous_loop');
  assert.ok(selection.reasons.includes('workflow_contract_bounded_loop_hybrid_floor'));
});

test('orchestrator forces generated workflow actions over a single explicit route when contract exists', () => {
  const orchestration = buildRuntimeOrchestration({
    mode: 'run',
    goal: LOOP_REQUEST,
    message: LOOP_REQUEST,
    registry: { agents: [{ id: 'builder', role_type: 'builder', provider: 'codex', model: 'codex', prompt: 'build' }] },
    routePlan: { reason: 'route_contract_preferred_agent', actions: [{ type: 'agent_run', agent: 'builder', prompt: LOOP_REQUEST, inputs: {} }] },
    maxAgents: 5,
  });
  assert.equal(orchestration.planner_metadata.team_workflow_contract.workflow_kind, 'bounded_continuous_loop');
  assert.equal(orchestration.route_plan.action_source, 'generated_team_actions');
  assert.ok(orchestration.route_plan.actions.length > 1);
  assert.ok(orchestration.runtime_agents.some((agent) => agent.role_id === 'reviewer'));
  assert.equal(orchestration.planner_metadata.runtime_execution_contract_patch.continuous_improvement.enabled, true);
  assert.equal(orchestration.planner_metadata.runtime_execution_contract_patch.continuous_improvement.mode, 'bounded_watch_loop');
});

test('workflow execution contract install enables continuous improvement on runtime', () => {
  const runtime = { runtime_execution: { continuous_improvement: { enabled: false, max_turns: 8 } } };
  const contract = {
    workflow_kind: 'bounded_continuous_loop',
    min_iterations: 2,
    max_iterations: 3,
    required_passes: ['plan', 'implement_or_diagnose', 'verify', 'review', 'stop_condition_evaluation'],
    stop_conditions: ['novel_and_sufficiently_complete'],
  };
  const installed = installWorkflowExecutionContract(runtime, contract, { source: 'test' });
  assert.equal(installed.changed, true);
  assert.equal(runtime.runtime_execution.continuous_improvement.enabled, true);
  assert.equal(runtime.runtime_execution.continuous_improvement.mode, 'bounded_watch_loop');
  assert.equal(runtime.runtime_execution.continuous_improvement.min_turns, 2);
  assert.equal(runtime.team_workflow_contract.enforced, true);
});

test('quality signals flag a loop contract hidden in task interpretation when actual run is one-shot', () => {
  const quality = buildExecutionQualitySignals({
    status: 'done',
    routePlan: {
      planner_metadata: { execution_mode: 'single_compiled' },
      task_interpretation: {
        team_workflow_contract: {
          workflow_kind: 'bounded_continuous_loop',
          min_iterations: 2,
          required_passes: ['implement_or_diagnose', 'review', 'stop_condition_evaluation'],
          approval_boundary: true,
        },
      },
    },
    execution: { runtime_agents: [{ role_id: 'builder' }], iteration_count: 1 },
    executionInsights: { execution: { planned_agent_count: 1, observed_agent_count: 1, participation_pct: 100 } },
  });
  assert.equal(quality.workflow_contract_ok, false);
  assert.ok(quality.workflow_contract_violations.includes('loop_min_iterations_not_met'));
  assert.ok(quality.workflow_contract_violations.includes('review_pass_missing'));
  assert.ok(quality.quality_gap >= 2);
});
