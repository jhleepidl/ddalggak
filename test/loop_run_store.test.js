import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun, readActiveLoopRun, recordActiveLoopAgentEvent, recordActiveLoopIterationEvent, applyActiveLoopUserControl } from '../src/application/loop_run_store.js';

test('loop run store is append-only, resume-safe, and tracks active pointer', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-run-store-'));
  try {
    const spec = buildLoopRunSpec({ loopId: 'loop-store', objective: 'test loop', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
    const created = createLoopRun({ jobDir, spec });
    assert.equal(created.state.status, 'running');
    recordActiveLoopAgentEvent({ jobDir, phase: 'started', agentId: 'builder', roleId: 'builder', provider: 'antigravity', model: 'model-a' });
    recordActiveLoopAgentEvent({ jobDir, phase: 'completed', agentId: 'builder', roleId: 'builder', summary: 'draft' });
    recordActiveLoopIterationEvent({ jobDir, phase: 'started', iteration: 1 });
    recordActiveLoopAgentEvent({ jobDir, phase: 'completed', agentId: 'synth', roleId: 'synthesizer', summary: 'iteration synthesis', finalSynthesis: true, completeRun: false });
    let mid = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(mid.state.status, 'running');
    recordActiveLoopIterationEvent({ jobDir, phase: 'completed', iteration: 1, status: 'awaiting_approval', pendingApproval: true });
    mid = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(mid.state.status, 'awaiting_approval');
    applyActiveLoopUserControl({ jobDir, control: 'resume' });
    applyActiveLoopUserControl({ jobDir, control: 'visibility', visibility: 'debug' });
    const active = readActiveLoopRun({ jobDir, includeEvents: true });
    assert.equal(active.state.counters.agent_starts, 1);
    assert.equal(active.state.counters.agent_completions, 2);
    assert.equal(active.state.progress_visibility, 'debug');
    assert.equal(active.state.current_round, 1);
    assert.ok(active.events.some((row) => row.event_type === 'approval_required'));
    assert.ok(active.events.length >= 8);
    assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'loop_runs', 'active.json')));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
