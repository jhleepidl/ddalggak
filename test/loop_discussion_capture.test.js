import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun, readActiveLoopRun } from '../src/application/loop_run_store.js';
import { extractLoopDiscussionRecords, persistLoopDiscussionRecords, buildLoopDiscussionOutputContract } from '../src/application/loop_discussion_capture.js';
import { readDiscussionLedger } from '../src/application/loop_discussion_ledger.js';

test('discussion blocks are stripped from user output and persisted as structured loop records', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-capture-'));
  try {
    createLoopRun({ jobDir, spec: buildLoopRunSpec({ loopId: 'capture', objective: 'review', workflowContract: { workflow_kind: 'review_gated_pipeline' } }) });
    const output = `검토 결과입니다.\n\n\`\`\`loop_discussion\n{"records":[{"record_type":"objection","text":"회귀 테스트가 실패합니다.","severity":"blocking"}]}\n\`\`\``;
    const extracted = extractLoopDiscussionRecords(output);
    assert.equal(extracted.records.length, 1);
    assert.doesNotMatch(extracted.clean_output, /loop_discussion/);
    const result = persistLoopDiscussionRecords({ jobDir, output, actor: 'reviewer', roleId: 'reviewer' });
    assert.equal(result.persisted.length, 1);
    assert.equal(readDiscussionLedger({ jobDir, loopId: 'capture' }).length, 1);
    assert.equal(readActiveLoopRun({ jobDir }).state.status, 'blocked');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('loop output contract asks for verifiable records without private reasoning', () => {
  const block = buildLoopDiscussionOutputContract({ roleId: 'reviewer', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
  assert.match(block, /Do not reveal private chain-of-thought/);
  assert.match(block, /objection/);
});
