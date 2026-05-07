import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatMemoryMaterializationPlanForTelegram, planMemoryMaterialization } from '../src/application/memory_materialization_planner.js';

function makeJobDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-materialize-'));
  fs.mkdirSync(path.join(dir, 'local_memory'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  return dir;
}
function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

test('plans meal tracking materialization from repeated meal memories and aggregate queries', () => {
  const jobDir = makeJobDir();
  appendJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), [
    { role: 'user', text: '아침은 삶은 계란 2개랑 바나나 먹었어.', ts: '2026-05-01T08:00:00Z' },
    { role: 'user', text: '점심은 김치찌개랑 밥 먹었어.', ts: '2026-05-01T12:00:00Z' },
    { role: 'user', text: '저녁은 닭가슴살 샐러드 먹었어.', ts: '2026-05-01T19:00:00Z' },
    { role: 'user', text: '오늘 아침은 오트밀이랑 커피.', ts: '2026-05-02T08:00:00Z' },
    { role: 'user', text: '아까 점심에 밥도 추가로 먹었어.', ts: '2026-05-02T13:00:00Z' },
    { role: 'user', text: '이번 주 아침 거른 날이 며칠인지 알려줘.' },
  ]);
  appendJsonl(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl'), [
    { query: '이번 주 아침 거른 날이 며칠이야?', demand_reasons: ['user_fact_reference'], sources: ['user_facts.jsonl'], item_count: 3 },
    { query: '최근 식사 단백질 섭취 추세 알려줘', demand_reasons: ['user_fact_reference'], sources: ['local_memory/turns.jsonl'], item_count: 5 },
  ]);
  const plan = planMemoryMaterialization({ jobDir, persist: true });
  const meal = plan.candidates.find((row) => row.domain === 'meal_tracking');
  assert.ok(meal, 'meal candidate should exist');
  assert.equal(meal.proposed_schema.table, 'meal_entries');
  assert.ok(meal.proposed_operations.some((op) => op.name === 'summarize_meals'));
  assert.ok(meal.backfill_preview.total_candidates >= 4);
  assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'memory_materialization_latest.json')));
  assert.match(formatMemoryMaterializationPlanForTelegram(plan), /Meal tracking/);
});

test('marks conference knowledge as publishable sourced knowledge pack candidate', () => {
  const jobDir = makeJobDir();
  fs.writeFileSync(path.join(jobDir, 'shared', 'core_memory.md'), [
    '# Core memory',
    '- ICDE 2026 official conference page: https://example.org/icde2026',
    '- ICDE submission deadline and registration info should be refreshed before use.',
    '- Conference venue and CFP are public-sourceable facts.',
  ].join('\n'), 'utf8');
  appendJsonl(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl'), [
    { query: 'ICDE 등록 마감과 venue 최신 정보 알려줘', sources: ['shared/core_memory.md'], item_count: 1 },
  ]);
  const plan = planMemoryMaterialization({ jobDir });
  const conf = plan.candidates.find((row) => row.domain === 'conference_knowledge');
  assert.ok(conf, 'conference candidate should exist');
  assert.equal(conf.publish_policy.publishable_as, 'sourced_knowledge_pack');
  assert.equal(conf.publish_policy.raw_private_memory_included, false);
  assert.equal(conf.publish_policy.freshness_policy.refresh_on_clone, true);
});
