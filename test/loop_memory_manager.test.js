import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun, appendLoopRunEvent } from '../src/application/loop_run_store.js';
import { appendDiscussionRecord } from '../src/application/loop_discussion_ledger.js';
import { inspectLoopMemoryPressure, compactLoopRunMemory, finalizeLoopMemory, runLoopMemoryMaintenance } from '../src/application/loop_memory_manager.js';

test('loop memory compaction keeps raw evidence and exposes a compact prompt projection', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-memory-'));
  try {
    const spec = buildLoopRunSpec({ loopId: 'loop-memory', objective: 'long loop', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
    spec.memory_policy.compact_after_events = 20;
    createLoopRun({ jobDir, spec });
    for (let i = 0; i < 25; i += 1) appendLoopRunEvent({ jobDir, loopId: 'loop-memory', eventType: 'stage_started', stageId: 'draft', summary: `event ${i}` });
    appendDiscussionRecord({ jobDir, loopId: 'loop-memory', record: { record_type: 'decision', text: 'Room-local review loop을 기본값으로 사용한다.' } });
    const pressure = inspectLoopMemoryPressure({ jobDir, loopId: 'loop-memory' });
    assert.equal(pressure.compaction_recommended, true);
    const compacted = compactLoopRunMemory({ jobDir, loopId: 'loop-memory' });
    assert.equal(compacted.ok, true);
    assert.ok(fs.existsSync(compacted.working_memory_path));
    const rawEvents = path.join(jobDir, 'local_memory', 'loop_runs', 'loop-memory', 'events.jsonl');
    assert.ok(fs.existsSync(rawEvents));
    const finalized = finalizeLoopMemory({ jobDir, loopId: 'loop-memory', archive: true, allowRawPrune: false });
    assert.equal(finalized.candidates.length, 1);
    const archiveFile = path.join(jobDir, 'local_memory', 'loop_runs', 'loop-memory', 'cold_archive', 'events.jsonl.gz');
    assert.ok(fs.existsSync(archiveFile));
    assert.match(zlib.gunzipSync(fs.readFileSync(archiveFile)).toString('utf8'), /run_started/);
    assert.ok(fs.existsSync(rawEvents), 'raw trace must remain by default');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});


test('idle loop memory maintenance finalizes terminal runs once without pruning raw evidence', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-memory-maintenance-'));
  try {
    const spec = buildLoopRunSpec({ loopId: 'loop-terminal', objective: 'terminal loop', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
    createLoopRun({ jobDir, spec });
    appendDiscussionRecord({ jobDir, loopId: 'loop-terminal', record: { record_type: 'decision', text: '검증된 결정만 Room memory 후보로 승격한다.' } });
    appendLoopRunEvent({ jobDir, loopId: 'loop-terminal', eventType: 'run_completed', summary: 'done' });
    const first = runLoopMemoryMaintenance({ jobDir });
    assert.equal(first.finalized.length, 1);
    assert.equal(first.finalized[0].promotion_candidate_count, 1);
    const rawEvents = path.join(jobDir, 'local_memory', 'loop_runs', 'loop-terminal', 'events.jsonl');
    assert.ok(fs.existsSync(rawEvents));
    const second = runLoopMemoryMaintenance({ jobDir });
    assert.equal(second.finalized.length, 0);
    assert.ok(second.skipped.some((row) => row.reason === 'already_finalized'));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
