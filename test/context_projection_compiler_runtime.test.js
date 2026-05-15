import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { commitContextWriteIntent, readContextSubstrate, listContextOperations } from '../src/application/context_substrate_store.js';
import { compileAgentContextProjection } from '../src/application/context_projection_compiler.js';
import { extractContextWriteIntentsFromAgentResult } from '../src/application/context_write_intent_extractor.js';
import { commitContextWriteIntentsBatch } from '../src/application/context_write_batcher.js';
import { buildHandoffDeltaFromAgentResult, appendHandoffDelta } from '../src/application/handoff_delta_store.js';
import { loadRunContext } from '../src/application/run_context_cache.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'context-runtime-test-')); }

test('context projection compiler builds cached role/task projection with fallback context', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_a';
  commitContextWriteIntent({
    intent_type: 'assert_atom',
    payload: {
      id: 'skill.karpathy',
      atom_type: 'skill',
      title: 'Karpathy Guidelines',
      canonical_text_en: 'Think first, keep changes surgical, verify before claiming success.',
      tags: ['builder', 'code_change'],
      scope: { roles: ['builder'], task_types: ['code_change'] },
      confidence: 0.9,
    },
  }, { rootDir, jobId });

  const compiled1 = compileAgentContextProjection({
    rootDir,
    jobId,
    agentId: 'builder',
    roleId: 'builder',
    goal: 'Patch the webapp and run tests',
    baseContextText: 'Legacy context block',
    modelNode: 'codex:gpt-5.5',
  });
  assert.equal(compiled1.ok, true);
  assert.equal(compiled1.role, 'builder');
  assert.match(compiled1.prompt_block, /Karpathy Guidelines/);
  assert.match(compiled1.prompt_block, /Legacy context block/);
  assert.equal(compiled1.metrics.cache_hit, false);

  const compiled2 = compileAgentContextProjection({
    rootDir,
    jobId,
    agentId: 'builder',
    roleId: 'builder',
    goal: 'Patch the webapp and run tests',
    baseContextText: 'Legacy context block',
    modelNode: 'codex:gpt-5.5',
  });
  assert.equal(compiled2.metrics.cache_hit, true);
});

test('batched context write intents share a base snapshot without intra-batch conflicts', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_b';
  commitContextWriteIntent({ intent_type: 'assert_atom', payload: { id: 'atom.seed', atom_type: 'memory', canonical_text_en: 'Seed memory' } }, { rootDir, jobId });
  const base = readContextSubstrate({ rootDir, jobId }).snapshot_id;
  const result = commitContextWriteIntentsBatch([
    { actor: 'agent:builder', intent_type: 'append_event', payload: { atom_type: 'event', title: 'Builder done' }, preconditions: { base_snapshot_id: base } },
    { actor: 'agent:builder', intent_type: 'record_usage', payload: { atom_type: 'usage_event', provider: 'codex' }, preconditions: { base_snapshot_id: base } },
    { actor: 'agent:builder', intent_type: 'assert_atom', payload: { id: 'atom.review', atom_type: 'review_finding', canonical_text_en: 'Needs review.' }, preconditions: { base_snapshot_id: base } },
  ], { rootDir, jobId });
  assert.equal(result.committed, 3);
  assert.equal(result.conflicts, 0);
  assert.equal(readContextSubstrate({ rootDir, jobId }).atoms.some((atom) => atom.id === 'atom.review'), true);
  assert.equal(listContextOperations({ rootDir, jobId }, { limit: 10 }).length, 4);
});

test('agent output extraction and handoff delta are lightweight runtime side effects', () => {
  const rootDir = tmpRoot();
  const jobId = 'job_c';
  const preparedContext = { context_info: { projection_id: 'proj_1', snapshot_id: 'ctx_000000' } };
  const result = {
    provider: 'codex',
    model: 'gpt-5.5',
    output: 'Changed files: src/App.tsx\nTest result: npm test passed\nRisk: financial wording needs review',
  };
  const intents = extractContextWriteIntentsFromAgentResult({ agentId: 'builder', roleId: 'builder', goal: 'Implement risk UI', result, preparedContext });
  assert.ok(intents.length >= 3);
  const batch = commitContextWriteIntentsBatch(intents, { rootDir, jobId });
  assert.ok(batch.committed >= 2);

  const handoff = buildHandoffDeltaFromAgentResult({ agentId: 'builder', roleId: 'builder', goal: 'Implement risk UI', result, preparedContext });
  assert.equal(handoff.handoff_type, 'review_request');
  appendHandoffDelta(handoff, { rootDir, jobId });
  const state = loadRunContext({ rootDir, jobId });
  assert.equal(state.handoffs.length, 1);
  assert.match(JSON.stringify(state.handoffs[0].delta), /financial wording/);
});
