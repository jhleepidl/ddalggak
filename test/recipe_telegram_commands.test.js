import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';

function makeBot(sent) {
  return {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  };
}

function makeSessionStore() {
  const rows = new Map();
  return {
    get(chatId) { return rows.get(chatId); },
    upsert(chatId, updater) {
      const next = updater(rows.get(chatId) || {});
      rows.set(chatId, next);
      return next;
    },
  };
}

function makeHandler(sent, chatSessionStore = makeSessionStore()) {
  return createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    chatSessionStore,
    resolveLiveJobIdForChat: () => null,
  });
}

async function run(handler, text) {
  return handler({
    msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } },
    text,
    chatId: 'chat-1',
    userId: 'user-1',
  });
}

test('/examples and /example expose evidence-aware recipe guidance', async () => {
  const sent = [];
  const handler = makeHandler(sent);
  assert.equal(await run(handler, '/examples coding'), true);
  assert.match(sent.at(-1).text, /coding\.small_change/);
  assert.match(sent.at(-1).text, /Revalidation needed/);

  assert.equal(await run(handler, '/example coding.small_change'), true);
  assert.match(sent.at(-1).text, /live runs: 4/i);
  assert.match(sent.at(-1).text, /작성 틀 보기/);
});

test('/use renders a blank template and turns a filled form into a task contract', async () => {
  const sent = [];
  const handler = makeHandler(sent);
  assert.equal(await run(handler, '/use coding.bug_fix'), true);
  assert.match(sent.at(-1).text, /현재 증상:/);
  assert.match(sent.at(-1).text, /완료 조건:/);

  const command = [
    '/use coding.bug_fix 현재 증상: 없는 사용자 조회가 500을 반환함',
    '기대 동작: 404를 반환해야 함',
    '금지 사항: DB schema 변경 금지',
    '완료 조건: 회귀 테스트 추가 및 npm test 통과',
  ].join('\n');
  assert.equal(await run(handler, command), true);
  assert.match(sent.at(-1).text, /task contract/);
  assert.match(sent.at(-1).text, /404를 반환해야 함/);
  assert.match(sent.at(-1).text, /DB schema 변경 금지/);
});


test('/examples includes diverse non-coding recipes', async () => {
  const sent = [];
  const handler = makeHandler(sent);
  assert.equal(await run(handler, '/examples'), true);
  assert.match(sent.at(-1).text, /recommendation\.contextual/);
  assert.match(sent.at(-1).text, /source\.file_grounded/);
  assert.match(sent.at(-1).text, /thinking\.parallel_ideas/);
  assert.match(sent.at(-1).text, /research\.long_horizon/);
});

test('/collab lists, applies native profiles, and refuses preview-only profiles', async () => {
  const sent = [];
  const store = makeSessionStore();
  const handler = makeHandler(sent, store);

  assert.equal(await run(handler, '/collab'), true);
  assert.match(sent.at(-1).text, /parallel_ideation/);

  assert.equal(await run(handler, '/collab use parallel_ideation'), true);
  assert.match(sent.at(-1).text, /적용했습니다/);
  assert.equal(store.get('chat-1').agent_room_profile.collaboration_profile_id, 'parallel_ideation');

  assert.equal(await run(handler, '/collab use selective_panel'), true);
  assert.match(sent.at(-1).text, /preview profile/);
  assert.equal(store.get('chat-1').agent_room_profile.collaboration_profile_id, 'parallel_ideation');

  assert.equal(await run(handler, '/collab reset'), true);
  assert.equal(store.get('chat-1').agent_room_profile.collaboration_profile_id, 'auto');
});
