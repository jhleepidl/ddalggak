import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ensureWatchTaskContract,
  startWatchIteration,
  completeWatchIteration,
  readWatchTaskState,
  setWatchTaskStatus,
  summarizeWatchTaskState,
} from '../src/application/watch_task_store.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'watch-task-')); }

const LOOP_CONTRACT = {
  workflow_kind: 'bounded_continuous_loop',
  min_iterations: 2,
  max_iterations: 3,
  required_passes: ['review', 'implementation', 'verification', 'stop_condition_evaluation'],
  approval_boundary: true,
  stop_conditions: ['novel_and_sufficiently_complete'],
};

test('watch task contract persists contract, state, and iteration lifecycle', () => {
  const jobDir = tmp();
  const installed = ensureWatchTaskContract({
    jobDir,
    jobId: 'job1',
    threadId: 'thread1',
    userText: '계속 점검하고 개선하는 loop로 돌려줘',
    workflowContract: LOOP_CONTRACT,
    runtimeExecutionPolicy: { continuous_improvement: { enabled: true, min_turns: 2, max_turns: 3 } },
  });
  assert.equal(installed.contract.workflow_kind, 'bounded_continuous_loop');
  assert.equal(installed.contract.status, 'active');

  const started = startWatchIteration({ jobDir, contract: installed.contract, userText: 'iteration one', routePlan: { reason: 'test', actions: [{ type: 'agent_run' }] } });
  assert.equal(started.iteration, 1);
  assert.equal(readWatchTaskState(jobDir).state.status, 'running');

  const completed = completeWatchIteration({
    jobDir,
    contract: { ...installed.contract, current_iteration: started.iteration },
    iteration: started,
    execution: { results: [{ status: 'ok' }], outputs: [{ output: 'done' }] },
    routePlan: { done: true },
    stopReason: 'done',
  });
  assert.equal(completed.status, 'next_iteration_ready');
  const summary = summarizeWatchTaskState(jobDir);
  assert.equal(summary.current_iteration, 1);
  assert.equal(summary.completed_count, 1);
  assert.equal(summary.status, 'next_iteration_ready');
});

test('watch task pause/resume/stop status updates are persisted as events', () => {
  const jobDir = tmp();
  ensureWatchTaskContract({ jobDir, jobId: 'job2', workflowContract: LOOP_CONTRACT });
  assert.equal(setWatchTaskStatus({ jobDir, status: 'paused', reason: 'manual pause' }).ok, true);
  assert.equal(summarizeWatchTaskState(jobDir).status, 'paused');
  assert.equal(setWatchTaskStatus({ jobDir, status: 'active', reason: 'resume' }).ok, true);
  assert.equal(summarizeWatchTaskState(jobDir).status, 'active');
  assert.equal(setWatchTaskStatus({ jobDir, status: 'stopped', reason: 'user stop' }).ok, true);
  const state = readWatchTaskState(jobDir);
  assert.equal(state.contract.status, 'stopped');
  assert.ok(state.iterations.length === 0);
});
