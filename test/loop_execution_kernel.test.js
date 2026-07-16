import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildLoopRunSpec,
  createLoopRunState,
  createLoopKernelEvent,
  reduceLoopRunState,
  evaluateLoopStopConditions,
} from '../src/application/loop_execution_kernel.js';

test('review workflow becomes a bounded review loop with controllable progress and memory policy', () => {
  const spec = buildLoopRunSpec({
    loopId: 'loop-1',
    objective: '구현하고 독립적으로 검토한 뒤 수정해',
    workflowContract: { workflow_kind: 'bounded_continuous_loop', min_iterations: 2, max_iterations: 3, review_each_iteration: true },
  });
  assert.equal(spec.topology.topology_id, 'review_loop');
  assert.equal(spec.budget_policy.min_rounds, 2);
  assert.equal(spec.budget_policy.max_rounds, 3);
  assert.equal(spec.progress_policy.visibility, 'quiet');
  assert.equal(spec.memory_policy.raw_trace, 'append_only');
  assert.equal(spec.memory_policy.durable_promotion, 'proposal_only');
});

test('loop reducer tracks agent lifecycle, blocking review issues, resolution, and final synthesis', () => {
  const spec = buildLoopRunSpec({ loopId: 'loop-2', objective: 'review loop', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
  let state = createLoopRunState(spec);
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'agent_started', actor: 'builder-1', roleId: 'builder' }));
  assert.equal(state.counters.agent_starts, 1);
  assert.equal(state.active_agents.length, 1);
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'agent_completed', actor: 'builder-1', roleId: 'builder', summary: 'draft done' }));
  assert.equal(state.active_agents.length, 0);
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'blocking_issue_found', summary: 'test failure', payload: { issue_id: 'issue-1' } }));
  assert.equal(state.status, 'blocked');
  assert.equal(state.blocking_issue_ids.length, 1);
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'blocking_issue_resolved', payload: { issue_id: 'issue-1' } }));
  assert.equal(state.status, 'running');
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'agent_completed', actor: 'synth', roleId: 'synthesizer', summary: 'iteration synthesis', payload: { final_synthesis: true } }));
  assert.equal(state.status, 'running');
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'iteration_completed', summary: 'iteration 1 ready', payload: { iteration: 1, status: 'next_iteration_ready' } }));
  assert.equal(state.current_round, 1);
  assert.equal(state.next_action, 'start_next_iteration');
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'iteration_started', payload: { iteration: 2 } }));
  assert.equal(state.current_round, 2);
  state = reduceLoopRunState(state, createLoopKernelEvent({ loopId: 'loop-2', eventType: 'iteration_completed', summary: 'watch complete', payload: { iteration: 2, status: 'completed' } }));
  assert.equal(state.status, 'completed');
  assert.deepEqual(evaluateLoopStopConditions(state), { should_stop: true, reason: 'completed' });
});

test('deliberation topology requires independent proposals before cross review', () => {
  const spec = buildLoopRunSpec({ objective: '여러 관점에서 토론하고 판정해', workflowContract: { workflow_kind: 'explore_then_synthesize' } });
  assert.equal(spec.topology.topology_id, 'deliberation');
  const independent = spec.topology.stages.find((row) => row.stage_id === 'independent_proposals');
  assert.equal(independent.isolation_required, true);
});
