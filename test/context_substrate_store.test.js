import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upsertSemanticBoardCards, upsertSemanticBoardLinks } from '../src/application/semantic_board.js';
import {
  commitContextWriteIntent,
  compactContextSubstrate,
  getContextProjection,
  listContextOperations,
  mirrorContextSubstrateToSemanticBoard,
  mirrorSemanticBoardToContextSubstrate,
  readContextSubstrate,
  summarizeContextSubstrate,
} from '../src/application/context_substrate_store.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'context-substrate-test-')); }

test('context substrate commits low-risk atoms with MVCC snapshots', () => {
  const rootDir = tmpRoot();
  const result = commitContextWriteIntent({
    actor: 'agent:builder',
    intent_type: 'assert_atom',
    payload: {
      id: 'atom.pref.risk_first_ui',
      atom_type: 'user_preference',
      title: 'Risk-first UI preference',
      text_original: '리스크와 불확실성을 먼저 보여주는 UI를 선호한다.',
      canonical_text_en: 'The user prefers risk-first UI.',
      tags: ['finance_ui', 'builder'],
      confidence: 0.91,
    },
  }, { rootDir });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'committed');
  assert.equal(result.lane, 'normal');

  const substrate = readContextSubstrate({ rootDir });
  assert.equal(substrate.atoms.length, 1);
  assert.equal(substrate.version, 1);
  assert.equal(substrate.snapshot_id, 'ctx_000001');

  const ops = listContextOperations({ rootDir }, { limit: 10 });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'assert_atom');

  const compacted = compactContextSubstrate({ rootDir });
  assert.equal(compacted.snapshot_id, 'ctx_000001');
});

test('context substrate routes high-risk writes to proposals without mutating current state', () => {
  const rootDir = tmpRoot();
  const result = commitContextWriteIntent({
    actor: 'agent:risk_reviewer',
    intent_type: 'assert_atom',
    payload: {
      id: 'atom.claim.buy_stock',
      atom_type: 'financial_claim',
      title: 'Buy recommendation',
      canonical_text_en: 'The user should buy this stock.',
    },
  }, { rootDir });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'review_required');
  assert.equal(result.lane, 'slow');
  assert.equal(readContextSubstrate({ rootDir }).atoms.length, 0);
  const proposals = listContextOperations({ rootDir }, { proposals: true, limit: 10 });
  assert.equal(proposals.length, 1);
});

test('context substrate detects stale MVCC preconditions', () => {
  const rootDir = tmpRoot();
  commitContextWriteIntent({ intent_type: 'assert_atom', payload: { id: 'atom.a', atom_type: 'memory', canonical_text_en: 'A' } }, { rootDir });
  const conflict = commitContextWriteIntent({
    intent_type: 'patch_atom',
    payload: { id: 'atom.a', atom_type: 'memory', canonical_text_en: 'B' },
    preconditions: { expected_version: 999 },
  }, { rootDir });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.status, 'conflict');
  assert.ok(conflict.errors.some((row) => row.code === 'atom_version_conflict'));
});

test('context substrate mirrors semantic board and builds cached role projection', () => {
  const rootDir = tmpRoot();
  upsertSemanticBoardCards([
    { id: 'skill.karpathy', type: 'skill_card', title: 'Karpathy Guidelines', content: { canonical_en: 'Think first, keep changes surgical, verify.' }, tags: ['builder', 'code_change'], status: 'active' },
    { id: 'rule.verify', type: 'rule_card', title: 'Verify before claiming success', content: { canonical_en: 'Verify before claiming success.' }, status: 'active' },
  ], { rootDir });
  upsertSemanticBoardLinks([{ from: 'skill.karpathy', to: 'rule.verify', type: 'exports_rule', weight: 0.8 }], { rootDir });

  const mirrored = mirrorSemanticBoardToContextSubstrate({ rootDir });
  assert.equal(mirrored.committed, 3);
  assert.equal(readContextSubstrate({ rootDir }).atoms.length, 2);

  const projection1 = getContextProjection({ rootDir }, { role: 'builder', task_type: 'code_change', limit: 10 });
  assert.equal(projection1.atom_count, 2);
  assert.equal(projection1.cache_hit, false);
  const projection2 = getContextProjection({ rootDir }, { role: 'builder', task_type: 'code_change', limit: 10 });
  assert.equal(projection2.cache_hit, true);

  const back = mirrorContextSubstrateToSemanticBoard({ rootDir });
  assert.equal(back.cards, 2);
  assert.equal(summarizeContextSubstrate({ rootDir }).atom_count, 2);
});
