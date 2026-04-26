import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreTaskAutonomy, inferTypedMemoryNeeds, shouldRunIdleMaintenance } from '../src/application/autonomy_policy.js';

test('scores complex skill and memory request above single-agent threshold', () => {
  const result = scoreTaskAutonomy({
    userText: '최근 기록과 선호도를 저장하고, 검색 skill과 영양 분석 skill을 사용해서 추천해줘.',
    availableAgents: 3,
    traceStats: { prompt_chars: 90000, trace_count: 12 },
  });
  assert.ok(result.score >= 7);
  assert.equal(result.mode, 'multi');
  assert.ok(result.reasons.includes('skill_or_tool_needed'));
  assert.ok(result.reasons.includes('typed_memory_needed'));
});

test('infers general typed memory slots without food-specific coupling', () => {
  const result = inferTypedMemoryNeeds({ userText: '앞으로 내가 싫어하는 옵션과 프로젝트 결정을 계속 기록해줘.' });
  const slots = result.slots.map((row) => row.slot);
  assert.ok(slots.includes('event_log'));
  assert.ok(slots.includes('user_preferences'));
  assert.ok(slots.includes('project_state') || slots.includes('decisions'));
});

test('idle maintenance becomes due when idle and pressure is high', () => {
  const result = shouldRunIdleMaintenance({
    lastActivityAt: '2026-04-26T00:00:00.000Z',
    now: new Date('2026-04-26T00:31:00.000Z'),
    runStats: { prompt_chars: 100000, event_count: 120 },
    minIdleMinutes: 20,
  });
  assert.equal(result.due, true);
  assert.ok(result.recommended_actions.includes('publish_gc_report_to_goc'));
});
