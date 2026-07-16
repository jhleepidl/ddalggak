import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun } from '../src/application/loop_run_store.js';
import { appendDiscussionRecord, readDiscussionLedger, deriveDiscussionState, formatDiscussionDigest } from '../src/application/loop_discussion_ledger.js';

test('discussion ledger preserves claims, blocking objections, and explicit resolutions', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-discussion-'));
  try {
    createLoopRun({ jobDir, spec: buildLoopRunSpec({ loopId: 'loop-discussion', objective: 'discuss', workflowContract: { workflow_kind: 'explore_then_synthesize' } }) });
    const claim = appendDiscussionRecord({ jobDir, loopId: 'loop-discussion', record: { record_type: 'claim', actor: 'proposer', text: 'API를 유지한다.' } });
    const objection = appendDiscussionRecord({ jobDir, loopId: 'loop-discussion', record: { record_type: 'objection', parent_id: claim.record_id, severity: 'blocking', actor: 'reviewer', text: '기존 call site가 깨진다.' } });
    appendDiscussionRecord({ jobDir, loopId: 'loop-discussion', record: { record_type: 'resolution', parent_id: objection.record_id, text: '호환 wrapper를 추가했다.' } });
    const rows = readDiscussionLedger({ jobDir, loopId: 'loop-discussion' });
    const state = deriveDiscussionState({ records: rows });
    assert.equal(state.claim_count, 1);
    assert.equal(state.blocking_open_count, 0);
    assert.match(formatDiscussionDigest({ records: rows }), /호환 wrapper/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
