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
