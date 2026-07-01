import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomConversationExchange } from '../src/application/room_conversation_ledger.js';
import { createRoomContextSnapshot, buildBudgetedRoomContextProjection, formatRoomContextProjectionBlock, resolveProjectionTierForRoute } from '../src/application/room_context_projection.js';

test('budgeted room context projection renders the same substrate at different tiers', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-context-proj-'));
  try {
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '서울대입구역 주변에서 먹을만한 식당으로 추천해줘.',
      assistantText: '서울대입구역 주변 후보를 몇 가지 추천했어요.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '배달해서 먹을만한 곳은 없을까? 실제 있는 식당으로 검색해서 찾아줘.',
      command: '/c',
      route: 'concierge_search_answer',
    });
    assert.equal(snapshot.kind, 'room_context_snapshot_v1');
    assert.match(snapshot.snapshot_id, /^roomctx_/);
    assert.ok(snapshot.turns.length >= 3);

    const micro = buildBudgetedRoomContextProjection({ snapshot, tier: 'micro' });
    const search = buildBudgetedRoomContextProjection({ snapshot, tier: 'search' });
    assert.equal(micro.projection_tier, 'micro');
    assert.equal(search.projection_tier, 'search');
    assert.match(search.text, /ROOM CONTEXT SNAPSHOT/);
    assert.match(search.text, /서울대입구역/);
    assert.match(search.text, /latest_user_request/);
    assert.ok(search.max_chars >= micro.max_chars);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('route names map to projection tiers', () => {
  assert.equal(resolveProjectionTierForRoute('concierge_direct_answer'), 'micro');
  assert.equal(resolveProjectionTierForRoute('concierge_search_answer'), 'search');
  assert.equal(resolveProjectionTierForRoute('team_orchestration'), 'team');
  assert.equal(resolveProjectionTierForRoute('standard_workbench'), 'agent');
});

test('projection formatter includes latest turn even before it is persisted', () => {
  const block = formatRoomContextProjectionBlock({
    snapshot: createRoomContextSnapshot({
      session: { recent_room_turns: [{ role: 'user', text: '어제 버거를 먹었어', turn_id: 't1' }] },
      latestUserText: '오늘 점심은?',
      command: '/c',
    }),
    tier: 'micro',
  });
  assert.match(block, /어제 버거/);
  assert.match(block, /오늘 점심/);
});

test('context state carries generic user context without hard-coded domain slots', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-context-state-generic-'));
  try {
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '서울대입구역 근처에서 먹을만한 곳으로 찾아줘.',
      assistantText: '포케올데이, 밀밀밀, 샐러디 같은 가벼운 후보를 추천합니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '각각 괜찮은 메뉴 추천해줘.',
      assistantText: '포케올데이는 현미밥 포케, 밀밀밀은 수비드 비프 포케, 샐러디는 우삼겹 메밀면을 추천합니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '카우보이 다이어트푸드에서 오리가슴살 덮밥을 시켰어.',
      assistantText: '고단백 식단으로 잘 선택했습니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '내일 점심은 뭘 배달시켜먹으면 좋을까?',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'micro', turnLimit: 3, maxChars: 950 });
    assert.match(projection.text, /ROOM CONTEXT STATE/);
    assert.match(projection.text, /semantic_strategy/);
    assert.match(projection.text, /RECENT USER CONTEXT QUOTES/);
    assert.match(projection.text, /서울대입구역/);
    assert.match(projection.text, /오리가슴살 덮밥/);
    assert.doesNotMatch(projection.text, /active_location_candidates/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('search projection distinguishes unverified direct recommendations from verified evidence', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-context-state-verification-'));
  try {
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '서울대입구역 근처에서 라이트하게 먹을 곳 추천해줘.',
      assistantText: '포케올데이 서울대입구점, 밀밀밀 포케, 샐러디 서울대입구역점을 추천합니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '실제로 서울대입구 주변에서 시킬 수 있는 검증된 음식 메뉴들이야?',
      command: '/c',
      route: 'concierge_search_answer',
    });
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'search', maxChars: 1600 });
    assert.match(projection.text, /latest_user_requires_verification: true/);
    assert.match(projection.text, /DIALOGUE REFERENCE TARGET/);
    assert.match(projection.text, /target_items: .*포케올데이/);
    assert.match(projection.text, /target_external_evidence: not_present_in_target/);
    assert.match(projection.text, /verification_policy/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('verification follow-up binds to immediate previous assistant answer, not older recommendation set', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-context-referent-verification-'));
  try {
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '서울대입구역 근처에서 라이트하게 먹을 곳 추천해줘.',
      assistantText: '포케올데이, 밀밀밀, 샐러디를 추천합니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '카우보이 다이어트푸드에서 오리가슴살 덮밥을 시켰어.',
      assistantText: '고단백 식단으로 잘 선택했습니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    appendRoomConversationExchange({
      jobDir,
      chatId: 'chat-1',
      userText: '내일 점심은 뭘 배달시켜먹으면 좋을까?',
      assistantText: '1. **산뜻한 메밀소바와 초밥 세트** 2. **속이 편안한 쌈밥 정식 또는 순두부찌개** 3. **샌드위치와 따뜻한 스프 조합**을 추천합니다.',
      command: '/c',
      route: 'concierge_direct_answer',
    });
    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '실제로 서울대입구 주변에서 시킬 수 있는 검증된 음식 메뉴들이야?',
      command: '/c',
      route: 'concierge_search_answer',
    });
    assert.equal(snapshot.context_state.latest_dialogue_referent.relation, 'verification_of_immediate_previous_assistant_answer');
    assert.deepEqual(snapshot.context_state.latest_dialogue_referent.extracted_items.slice(0, 3), [
      '산뜻한 메밀소바와 초밥 세트',
      '속이 편안한 쌈밥 정식 또는 순두부찌개',
      '샌드위치와 따뜻한 스프 조합',
    ]);
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'search', maxChars: 2200, turnLimit: 6 });
    assert.match(projection.text, /DIALOGUE REFERENCE TARGET/);
    assert.match(projection.text, /target_items: .*산뜻한 메밀소바와 초밥 세트/);
    assert.match(projection.text, /verification_focus: verify or qualify the target_items above/);
    assert.doesNotMatch(projection.text, /assistant.*포케올데이, 밀밀밀, 샐러디/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});


test('context state can use agent-provided semantic observations without domain-specific extractors', () => {
  const block = formatRoomContextProjectionBlock({
    snapshot: createRoomContextSnapshot({
      session: {
        recent_room_turns: [{
          role: 'user',
          text: '서울대입구역 근처에서 라이트하게 먹고 싶어.',
          turn_id: 'semantic-t1',
          semantic_observations: [
            { type: 'user_constraint', text: 'The user wants a light meal near Seoul National University Station.', confidence: 'agent_extracted' },
          ],
        }],
      },
      latestUserText: '그 조건으로 내일 점심도 추천해줘.',
      command: '/c',
    }),
    tier: 'micro',
    maxChars: 1200,
  });
  assert.match(block, /AGENT-EXTRACTED SEMANTIC OBSERVATIONS/);
  assert.match(block, /user_constraint: The user wants a light meal near Seoul National University Station/);
  assert.doesNotMatch(block, /active_location_candidates/);
});


test('room context projection includes active loop control state from room loop events', async () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-context-loop-proj-'));
  try {
    const { appendRoomLoopEvent, buildRoomLoopStartEvent, normalizeRoomLoop } = await import('../src/application/room_loop_events.js');
    const loop = normalizeRoomLoop({
      loop_id: 'room_loop_projection_test',
      chat_id: 'chat-1',
      objective: '경쟁 제품 조사 루프',
      current_plan: ['collect candidates', 'verify claims'],
      active_constraints: ['latest public evidence only'],
    });
    appendRoomLoopEvent({
      jobDir,
      chatId: 'chat-1',
      event: buildRoomLoopStartEvent({ loop, chatId: 'chat-1', jobId: 'job-1' }),
    });
    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '그 계획에서 가격 비교 기준을 최신으로 바꿔줘',
      command: '/chat',
      route: 'team_orchestration',
    });
    assert.equal(snapshot.active_room_loop.loop_id, 'room_loop_projection_test');
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'team', maxChars: 2400 });
    assert.match(projection.text, /ACTIVE ROOM LOOP/);
    assert.match(projection.text, /경쟁 제품 조사 루프/);
    assert.match(projection.text, /loop_policy/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
