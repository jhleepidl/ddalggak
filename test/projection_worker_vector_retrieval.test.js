import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { upsertCanonicalProjectionRequest, readCanonicalProjectionState } from '../src/application/canonical_projection.js';
import { runCanonicalProjectionWorker } from '../src/application/canonical_projection_worker.js';
import { addSemanticIndexItems, refreshSemanticIndexCanonicalProjections, searchSemanticIndex } from '../src/application/semantic_index.js';
import { embedTextLocalHash, searchSemanticVectors } from '../src/application/semantic_vector_adapter.js';
import { buildMemoryDemandContext } from '../src/application/memory_demand_context.js';
import { discoverLocalSkills, indexLocalSkillPackages } from '../src/application/local_skill_catalog.js';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'projection-vector-')); }

test('projection worker applies model projection and refreshes semantic vectors', async () => {
  const jobDir = tmp();
  const created = upsertCanonicalProjectionRequest({ jobDir, item: { object_type: 'memory', source_id: 'mem_soft', source_original_text: '좋은 느낌으로 잘 만들어줘', source_original_language: 'ko' } });
  addSemanticIndexItems({ jobDir, items: [{ itemType: 'memory', sourceId: 'mem_soft', title: '사용자 선호', text: '좋은 느낌으로 잘 만들어줘', originalLanguage: 'ko' }] });
  let before = searchSemanticIndex({ jobDir, query: 'polished high quality outcome', itemTypes: ['memory'] });
  assert.equal(before.item_count, 0);
  const worker = await runCanonicalProjectionWorker({
    jobDir,
    projector: () => ({ projections: [{ projection_id: created.projection.projection_id, canonical_text_en: 'Prefer a polished and high-quality outcome.', confidence: 0.95 }] }),
  });
  assert.equal(worker.ready_count, 1);
  const state = readCanonicalProjectionState({ jobDir, statuses: ['ready'] });
  assert.match(state.projections[0].canonical_text_en, /polished/);
  const refreshed = refreshSemanticIndexCanonicalProjections({ jobDir });
  assert.ok(refreshed.updated_count >= 0);
  const after = searchSemanticIndex({ jobDir, query: 'polished high quality outcome', itemTypes: ['memory'] });
  assert.equal(after.item_count, 1);
  assert.ok(after.items[0].vector_score > 0 || after.items[0].lexical_semantic_score > 0);
});

test('local vector adapter ranks semantically overlapping skill item', () => {
  const jobDir = tmp();
  addSemanticIndexItems({ jobDir, items: [
    { itemType: 'skill', sourceId: 'skill_news', title: 'News Impact', text: 'Analyze recent news impact on Korean stock prices.', canonicalTextEn: 'Analyze recent news impact on Korean stock prices.' },
    { itemType: 'skill', sourceId: 'skill_css', title: 'CSS Polish', text: 'Improve spacing, layout, and visual polish.', canonicalTextEn: 'Improve spacing, layout, and visual polish.' },
  ] });
  const result = searchSemanticVectors({ jobDir, query: 'stock news price impact', itemTypes: ['skill'], limit: 2 });
  assert.equal(result.item_count, 1);
  assert.equal(result.items[0].item_id, 'skill_news');
  assert.equal(embedTextLocalHash('abc').length, 256);
});

test('memory demand context includes semantic memory hits', () => {
  const jobDir = tmp();
  addSemanticIndexItems({ jobDir, items: [{ itemType: 'memory', sourceId: 'mem_loop', title: 'Loop preference', text: 'Run a bounded continuous review-and-improvement loop with approval gates.', canonicalTextEn: 'Run a bounded continuous review-and-improvement loop with approval gates.' }] });
  const ctx = buildMemoryDemandContext({ jobDir, userText: '전에 말한 loop approval 관련 메모리 찾아줘', persist: true });
  assert.ok(ctx.items.some((item) => item.kind === 'semantic_memory'));
  assert.match(ctx.text, /semantic_index|bounded continuous/i);
});

test('skill discovery indexes local skills and searches via canonical text', () => {
  const rootDir = tmp();
  const skillDir = path.join(rootDir, 'skills', 'news-impact');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({ id: 'skill.news-impact.local', name: '뉴스 영향 분석', description: '최신 뉴스가 국내 주식 가격에 미치는 영향을 분석한다.', capability_tags: ['finance', 'news'] }, null, 2));
  const indexed = indexLocalSkillPackages({ rootDir, jobDir: rootDir });
  assert.equal(indexed.indexed_count, 1);
  const found = discoverLocalSkills({ rootDir, jobDir: rootDir, query: 'recent news Korean stock prices', autoIndex: false });
  assert.equal(found.skill_count, 1);
  assert.equal(found.skills[0].skill_id, 'skill.news-impact.local');
});
