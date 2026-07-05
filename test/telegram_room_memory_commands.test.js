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

function makeSessionStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => map.get(String(key)) || {},
    upsert: (key, updater) => {
      const id = String(key);
      const prev = map.get(id) || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...(updater || {}) };
      map.set(id, next);
      return next;
    },
  };
}

function makeHandler({ sent = [], sessionStore = makeSessionStore() } = {}) {
  return createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    chatSessionStore: sessionStore,
    resolveLiveJobIdForChat: () => null,
    jobs: null,
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    createAgentRoomTeamConfiguration: async ({ description }) => ({ task_brief: description, agents: [] }),
  });
}

test('/memory shows active room memory as structured text', async () => {
  const sent = [];
  const sessionStore = makeSessionStore({
    chat1: {
      room_memory_items: [
        { memory_id: 'mem_food', type: 'preference', summary: '사용자는 서울대입구역 주변 추천을 선호한다.', owner_companion_ids: ['personal'] },
      ],
    },
  });
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat1' }, from: { id: 'u' } }, text: '/memory', chatId: 'chat1', userId: 'u' });

  assert.match(sent.at(-1).text, /Room Memory/);
  assert.match(sent.at(-1).text, /서울대입구역/);
  assert.match(sent.at(-1).text, /GoC/);
});

test('/memory proposals and approve latest promote an idle candidate to active memory', async () => {
  const sent = [];
  const sessionStore = makeSessionStore({
    chat1: {
      room_idle_memory_candidates: [
        { candidate_id: 'cand_music', status: 'pending', observation_type: 'stable_preference_candidate', memory_summary: '사용자는 베이스와 기타를 배우고 싶어한다.', target_companion_ids: ['personal'] },
      ],
    },
  });
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat1' }, from: { id: 'u' } }, text: '/memory proposals', chatId: 'chat1', userId: 'u' });
  assert.match(sent.at(-1).text, /Room Memory Proposals/);
  assert.match(sent.at(-1).text, /베이스와 기타/);

  await handler({ msg: { chat: { id: 'chat1' }, from: { id: 'u' } }, text: '/memory approve latest', chatId: 'chat1', userId: 'u' });
  assert.match(sent.at(-1).text, /approved/);
  const session = sessionStore.get('chat1');
  assert.equal(session.room_memory_items.length, 1);
  assert.match(session.room_memory_items[0].summary, /베이스와 기타/);

  await handler({ msg: { chat: { id: 'chat1' }, from: { id: 'u' } }, text: `/memory explain ${session.room_memory_items[0].memory_id}`, chatId: 'chat1', userId: 'u' });
  assert.match(sent.at(-1).text, /Room Memory Detail/);
  assert.match(sent.at(-1).text, /canonical_write_enabled: false/);
});
