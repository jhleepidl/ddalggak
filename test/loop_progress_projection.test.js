import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun, recordActiveLoopAgentEvent, applyActiveLoopUserControl } from '../src/application/loop_run_store.js';
import { buildLoopProgressProjection, formatLoopProgressForUser } from '../src/application/loop_progress_projection.js';

test('progress projection hides raw events by default and reveals them only in debug mode', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-progress-'));
  try {
    createLoopRun({ jobDir, spec: buildLoopRunSpec({ loopId: 'loop-progress', objective: 'progress', workflowContract: { workflow_kind: 'review_gated_pipeline' } }) });
    recordActiveLoopAgentEvent({ jobDir, phase: 'started', agentId: 'builder', roleId: 'builder' });
    let projection = buildLoopProgressProjection({ jobDir });
    assert.equal(projection.visibility, 'quiet');
    assert.equal(projection.recent_events, undefined);
    assert.match(formatLoopProgressForUser({ projection }), /단계:/);
    applyActiveLoopUserControl({ jobDir, control: 'visibility', visibility: 'debug' });
    projection = buildLoopProgressProjection({ jobDir });
    assert.equal(projection.visibility, 'debug');
    assert.ok(projection.recent_events.length >= 1);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
