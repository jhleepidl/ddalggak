import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import {
  createLoopRun,
  readActiveLoopRun,
  recordActiveLoopAgentEvent,
  recordActiveLoopIterationEvent,
} from '../src/application/loop_run_store.js';
import {
  ensureWatchTaskContract,
  startWatchIteration,
  completeWatchIteration,
} from '../src/application/watch_task_store.js';

function setup() {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-watch-bridge-'));
  const workflowContract = {
    workflow_kind: 'bounded_continuous_loop',
    min_iterations: 2,
    max_iterations: 3,
    review_each_iteration: true,
  };
  const watch = ensureWatchTaskContract({ jobDir, jobId: 'job-1', userText: 'implement and review', workflowContract });
  createLoopRun({ jobDir, spec: buildLoopRunSpec({ loopId: 'loop-watch', objective: 'implement and review', workflowContract }) });
  return { jobDir, workflowContract, watch };
}

test('watch iteration owns bounded-loop completion rather than iteration-local synthesis', () => {
  const { jobDir, watch } = setup();
  try {
    const iteration1 = startWatchIteration({ jobDir, contract: watch.contract, userText: 'go' });
    recordActiveLoopIterationEvent({ jobDir, phase: 'started', iteration: iteration1.iteration });
    recordActiveLoopAgentEvent({ jobDir, phase: 'completed', agentId: 'synth-1', roleId: 'synthesizer', finalSynthesis: true, completeRun: false });
    let run = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(run.state.status, 'running');

    const completion1 = completeWatchIteration({
      jobDir,
      contract: { ...watch.contract, current_iteration: 1 },
      iteration: iteration1,
      execution: { outputs: [{}], results: [{}] },
      stopSignals: [],
    });
    assert.equal(completion1.status, 'next_iteration_ready');
    recordActiveLoopIterationEvent({ jobDir, phase: 'completed', iteration: completion1.iteration, status: completion1.status });
    run = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(run.state.status, 'running');
    assert.equal(run.state.next_action, 'start_next_iteration');

    const contract2 = { ...watch.contract, current_iteration: 1 };
    const iteration2 = startWatchIteration({ jobDir, contract: contract2, userText: 'continue' });
    recordActiveLoopIterationEvent({ jobDir, phase: 'started', iteration: iteration2.iteration });
    const completion2 = completeWatchIteration({
      jobDir,
      contract: { ...watch.contract, current_iteration: 2 },
      iteration: iteration2,
      execution: { outputs: [{}], results: [{}] },
      stopReason: 'continuous_goal_met',
      stopSignals: ['quality_threshold_met'],
    });
    assert.equal(completion2.status, 'completed');
    recordActiveLoopIterationEvent({ jobDir, phase: 'completed', iteration: completion2.iteration, status: completion2.status, stopSignals: completion2.stop_signals });
    run = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(run.active, false);
    assert.equal(run.state.status, 'completed');
    assert.equal(run.state.current_round, 2);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('watch pending approval becomes an explicit resumable LoopRun state', () => {
  const { jobDir, watch } = setup();
  try {
    const iteration = startWatchIteration({ jobDir, contract: watch.contract, userText: 'deploy' });
    recordActiveLoopIterationEvent({ jobDir, phase: 'started', iteration: iteration.iteration });
    const completion = completeWatchIteration({
      jobDir,
      contract: { ...watch.contract, current_iteration: 1 },
      iteration,
      execution: { pendingApproval: { kind: 'deployment' }, outputs: [], results: [] },
      stopReason: 'pending_approval',
    });
    recordActiveLoopIterationEvent({
      jobDir,
      phase: 'completed',
      iteration: completion.iteration,
      status: completion.status,
      pendingApproval: completion.pending_approval,
    });
    const run = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(run.state.status, 'awaiting_approval');
    assert.equal(run.state.next_action, 'await_approval');
    assert.ok(run.events.some((row) => row.event_type === 'approval_required'));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
