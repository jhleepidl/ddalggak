import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planMemoryMaterialization } from '../src/application/memory_materialization_planner.js';
import { createShadowMemoryModule, findMaterializationCandidate, listShadowMemoryModules } from '../src/application/memory_materialization_store.js';

function tmpJob() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-materialize-store-'));
  fs.mkdirSync(path.join(dir, 'local_memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  return dir;
}
function appendTurn(jobDir, text, id) {
  fs.appendFileSync(path.join(jobDir, 'local_memory', 'turns.jsonl'), `${JSON.stringify({ id, role: 'user', text, created_at: '2026-05-06T08:00:00Z' })}\n`);
}

test('creates a shadow module from a materialization candidate without switching canonical memory', () => {
  const jobDir = tmpJob();
  const texts = [
    '아침은 삶은 계란 2개랑 바나나 먹었어.',
    '점심은 김치찌개랑 밥 먹었어.',
    '저녁은 닭가슴살 샐러드 먹었어.',
    '아침은 오트밀 먹었고 점심은 샌드위치 먹었어.',
    '이번 주 아침 거른 날이 며칠인지 알려줘.',
  ];
  texts.forEach((text, i) => appendTurn(jobDir, text, `turn_${i + 1}`));
  fs.appendFileSync(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl'), `${JSON.stringify({ query: '최근 식사 추세와 빠진 아침 알려줘', sources: ['turns'] })}\n`);

  const plan = planMemoryMaterialization({ jobDir, persist: true, minScore: 0.1 });
  const candidate = findMaterializationCandidate(plan, 'meal_tracking');
  assert.ok(candidate);
  const result = createShadowMemoryModule({ jobDir, candidate, reason: 'test_shadow' });
  assert.equal(result.ok, true);
  assert.equal(result.manifest.domain, 'meal_tracking');
  assert.equal(result.manifest.status, 'shadow');
  assert.equal(result.manifest.canonical_memory_switch, false);
  assert.equal(result.manifest.generated_code_execution, false);
  assert.ok(result.stats.row_count >= 3);

  const root = path.join(jobDir, 'local_memory', 'memory_modules', 'meal_tracking');
  assert.ok(fs.existsSync(path.join(root, 'module_manifest.json')));
  assert.ok(fs.existsSync(path.join(root, 'rows.jsonl')));
  const rows = fs.readFileSync(path.join(root, 'rows.jsonl'), 'utf8').trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.ok(rows.length >= 3);
  assert.ok(rows.every((row) => Object.prototype.hasOwnProperty.call(row, 'source_ref')));

  const index = listShadowMemoryModules({ jobDir });
  assert.equal(index.modules.length, 1);
  assert.equal(index.modules[0].module_id, 'meal_tracking');
});
