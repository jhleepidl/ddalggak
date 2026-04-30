import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractUserFactEvents,
  formatActiveUserFactContext,
  readUserFacts,
  recordUserFactEvents,
  resolveActiveUserFacts,
} from '../src/application/user_fact_context.js';

test('extracts profile, preferences, meal records, and no-intake facts', () => {
  const text = '어제 저녁 6시엔 청국장과 보리비빔밥, 그리고 수육을 먹었고, 오늘 오후 1시엔 오리고기 포케를 먹었어. 사실 어제 점심에는 아무것도 먹지 않았어. 내 키는 174cm, 몸무게는 68kg이고 나이는 만 31살, 성별은 남성이야. 활동량은 적은 편이고 느끼한 건 별로 안 좋아해.';
  const facts = extractUserFactEvents(text, { timestamp: '2026-04-27T00:00:00.000Z' });
  assert.ok(facts.some((f) => f.type === 'profile' && f.field === 'height_cm' && f.value === 174));
  assert.ok(facts.some((f) => f.type === 'profile' && f.field === 'activity_level' && f.value === 'low'));
  assert.ok(facts.some((f) => f.type === 'preference' && f.value === 'greasy_food'));
  assert.ok(facts.some((f) => f.type === 'meal' && f.relative_day === 'yesterday' && f.meal_slot === 'dinner' && /청국장/.test(f.value)));
  assert.ok(facts.some((f) => f.type === 'meal' && f.relative_day === 'today' && f.meal_slot === 'lunch' && /오리고기 포케/.test(f.value)));
  assert.ok(facts.some((f) => f.type === 'meal' && f.relative_day === 'yesterday' && f.meal_slot === 'lunch' && f.status === 'verified_no_intake'));
});

test('renders active user fact context for LLM prompt projection without local fallback generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-user-facts-'));
  try {
    recordUserFactEvents(dir, '어제 점심에는 아무것도 먹지 않았어. 오늘 저녁으로 서울대입구 칠리향도삭면에서 마라볶음면 세트를 주문했어.', { timestamp: '2026-04-27T01:00:00.000Z' });
    recordUserFactEvents(dir, '내 키는 174cm, 몸무게는 68kg이고 나이는 만 31살, 성별은 남성이야. 활동량은 적은 편이고 느끼한 건 별로 안 좋아하고 다양한 영양소를 섭취하고 싶어.', { timestamp: '2026-04-27T01:01:00.000Z' });
    const context = formatActiveUserFactContext(dir);
    assert.match(context, /ACTIVE USER FACT CONTEXT/);
    assert.match(context, /height=174cm/);
    assert.match(context, /어제 점심 = no_intake/);
    assert.match(context, /마라볶음면 세트/);
    assert.match(context, /governance: do not infer unrecorded meals/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('anchors relative meal facts to absolute target_date in the observed timezone', () => {
  const facts = extractUserFactEvents('어제 점심에는 아무것도 먹지 않았어. 오늘 저녁은 김밥을 먹었어.', {
    timestamp: '2026-04-27T01:00:00.000Z',
    timezone: 'Asia/Seoul',
  });
  assert.ok(facts.some((f) => f.type === 'meal' && f.relative_day === 'yesterday' && f.target_date === '2026-04-26'));
  assert.ok(facts.some((f) => f.type === 'meal' && f.relative_day === 'today' && f.target_date === '2026-04-27'));
});

test('verified no-intake fact is not overwritten by a lower-priority later candidate for the same meal slot', () => {
  const verified = {
    type: 'meal',
    key: 'meal:2026-04-26:lunch',
    relative_day: 'yesterday',
    target_date: '2026-04-26',
    meal_slot: 'lunch',
    value: 'no_intake',
    status: 'verified_no_intake',
    created_at: '2026-04-27T01:00:00.000Z',
  };
  const candidate = {
    type: 'meal',
    key: 'meal:2026-04-26:lunch',
    relative_day: 'yesterday',
    target_date: '2026-04-26',
    meal_slot: 'lunch',
    value: '김밥',
    status: 'candidate',
    created_at: '2026-04-27T02:00:00.000Z',
    confidence: 0.99,
  };
  const [active] = resolveActiveUserFacts([verified, candidate]);
  assert.equal(active.value, 'no_intake');
  assert.equal(active.status, 'verified_no_intake');
});
