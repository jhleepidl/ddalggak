import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyCanonicalProjection,
  buildCanonicalProjectionRequest,
  buildLocalCanonicalProjection,
  processCanonicalProjectionQueue,
  readCanonicalProjectionState,
  upsertCanonicalProjectionRequest,
} from '../src/application/canonical_projection.js';
import { appendProposalToLog, normalizeProposal } from '../src/application/proposal_log.js';
import { addSemanticIndexItems, searchSemanticIndex } from '../src/application/semantic_index.js';
import { normalizeLocalSkillManifest } from '../src/application/local_skill_catalog.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'canonical-projection-')); }

test('local canonical projection creates English seed without overwriting Korean original', () => {
  const result = buildLocalCanonicalProjection({
    text: '이 작업을 계속 점검하고 개선하는 loop로 돌려줘. 매 개선마다 review하고 큰 변경은 승인 받아.',
    originalLanguage: 'ko',
    objectType: 'watch_task',
  });
  assert.equal(result.canonical_projection_status, 'ready');
  assert.match(result.canonical_text_en, /bounded continuous review-and-improvement loop/i);
  assert.match(result.canonical_text_en, /Review each implementation iteration/i);
  assert.match(result.canonical_text_en, /Require approval/i);
});

test('canonical projection queue stores pending and applies model projection later', () => {
  const jobDir = tmp();
  const created = upsertCanonicalProjectionRequest({
    jobDir,
    item: {
      object_type: 'memory',
      source_id: 'mem_1',
      source_original_text: '좋은 느낌으로 잘 해줘',
      source_original_language: 'ko',
    },
  });
  assert.equal(created.projection.status, 'pending_model_projection');
  const pending = readCanonicalProjectionState({ jobDir, statuses: ['pending_model_projection'] });
  assert.equal(pending.projections.length, 1);
  const applied = applyCanonicalProjection({ jobDir, projectionId: created.projection.projection_id, canonicalTextEn: 'Prefer a polished and high-quality outcome.', actor: 'test' });
  assert.equal(applied.projection.status, 'ready');
  const ready = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  assert.equal(ready.projections[0].canonical_text_en, 'Prefer a polished and high-quality outcome.');
});

test('projection worker can use an injected projector for pending Korean text', () => {
  const jobDir = tmp();
  upsertCanonicalProjectionRequest({ jobDir, item: { object_type: 'rule', source_id: 'rule_1', source_original_text: '애매하게 하지마', source_original_language: 'ko' } });
  const processed = processCanonicalProjectionQueue({
    jobDir,
    projector: () => ({ canonical_text_en: 'Avoid ambiguous responses; state uncertainty clearly.', projection_method: 'test_projector', confidence: 0.99 }),
  });
  assert.equal(processed.ready_count, 1);
  const ready = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  assert.equal(ready.projections[0].projection_method, 'test_projector');
});

test('proposal log queues canonical projection and upgrades common Korean rule locally', () => {
  const jobDir = tmp();
  const proposal = normalizeProposal({ kind: 'learned_rule_candidate', summary: '한국어로 간결하게 답해' });
  assert.equal(proposal.source_original_language, 'ko');
  assert.equal(proposal.canonical_projection_status, 'ready');
  assert.match(proposal.canonical_text_en, /Respond concisely in Korean/);
  appendProposalToLog({ jobDir, proposal });
  const state = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  assert.ok(state.projections.some((p) => /Respond concisely in Korean/.test(p.canonical_text_en)));
});

test('semantic index stores original and canonical projection, and queues projection state', () => {
  const jobDir = tmp();
  const added = addSemanticIndexItems({
    jobDir,
    items: [{ itemType: 'skill', sourceId: 'skill_stock_news', title: '뉴스 주식 레이더', text: '최신 뉴스가 국내 주식 가격에 미치는 영향을 분석한다.' }],
  });
  assert.equal(added.added_count, 1);
  const result = searchSemanticIndex({ jobDir, query: 'recent news stock prices', itemTypes: ['skill'] });
  assert.equal(result.item_count, 1);
  assert.match(result.items[0].canonical_text_en, /recent news|stocks|prices|Korean stock/i);
  const projections = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  assert.equal(projections.projections.length, 1);
});

test('local skill manifests receive canonical English description fields', () => {
  const skill = normalizeLocalSkillManifest({
    id: 'skill.news-impact.local',
    name: '뉴스 영향 분석',
    description: '최신 뉴스가 국내 주식에 미치는 영향을 분석한다.',
    capability_tags: ['finance', 'news'],
  }, { dir: '/tmp/skills/news-impact' });
  assert.equal(skill.canonical_language, 'en');
  assert.equal(skill.source_original_language, 'ko');
  assert.equal(skill.canonical_projection_status, 'ready');
  assert.match(skill.canonical_description_en, /recent news|Korean stock/i);
});
