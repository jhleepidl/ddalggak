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

test('/home frames Telegram as the continuity doorway and points advanced controls to help more', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  const handled = await handler({
    msg: { chat: { id: 'chat-door', type: 'private' }, from: { id: 'u' } },
    text: '/home',
    chatId: 'chat-door',
    userId: 'u',
  });

  assert.equal(handled, true);
  assert.match(sent.at(-1).text, /Continuity Home/);
  assert.match(sent.at(-1).text, /목표·근거·규칙·작업 상태/);
  assert.match(sent.at(-1).text, /\/brief/);
  assert.match(sent.at(-1).text, /\/continue/);
  assert.match(sent.at(-1).text, /\/sources/);
  assert.match(sent.at(-1).text, /\/rules/);
  assert.match(sent.at(-1).text, /\/help more/);
});

test('/companions describes a companion room roster with memory boundaries', async () => {
  const sent = [];
  const handler = makeHandler({ sent });

  await handler({
    msg: { chat: { id: 'chat-companions' }, from: { id: 'u' } },
    text: '/companions',
    chatId: 'chat-companions',
    userId: 'u',
  });

  assert.match(sent.at(-1).text, /Companion Room/);
  assert.match(sent.at(-1).text, /memory boundary/);
  assert.match(sent.at(-1).text, /Research Companion/);
  assert.match(sent.at(-1).text, /Critic Companion/);
  assert.match(sent.at(-1).text, /Personal Context Companion/);
  assert.match(sent.at(-1).text, /\/council ask/);
});

test('/council ask creates visible backchannel transcript and log entry', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  await handler({
    msg: { chat: { id: 'chat-council' }, from: { id: 'u' } },
    text: '/council ask 텔레그램을 room entry point로 어떻게 보여줄까?',
    chatId: 'chat-council',
    userId: 'u',
  });

  assert.match(sent.at(-1).text, /Companion Council/);
  assert.match(sent.at(-1).text, /visible backchannel/);
  assert.match(sent.at(-1).text, /Room decision/);
  assert.match(sent.at(-1).text, /room boundary/);
  assert.match(sent.at(-1).text, /고정 prompt 분류가 아니라/);

  const state = sessionStore.get('chat-council').room_companion_state;
  assert.equal(state.recent_councils.length, 1);
  assert.match(state.recent_councils[0].summary, /room boundary/);

  await handler({
    msg: { chat: { id: 'chat-council' }, from: { id: 'u' } },
    text: '/council log',
    chatId: 'chat-council',
    userId: 'u',
  });
  assert.match(sent.at(-1).text, /Recent Companion Councils/);
  assert.match(sent.at(-1).text, /room entry point/);
});

test('/memory idle creates idle memory candidates and /council can raise governed exchange proposal from them', async () => {
  const sent = [];
  const sessionStore = makeSessionStore({
    'chat-exchange': {
      recent_room_turns: [
        { role: 'user', turn_id: 't1', text: '앞으로 geospatial은 절대 추천하지 말아줘. 나는 그 방향은 안할거야.' },
      ],
    },
  });
  const handler = makeHandler({ sent, sessionStore });

  await handler({
    msg: { chat: { id: 'chat-exchange' }, from: { id: 'u' } },
    text: '/memory idle',
    chatId: 'chat-exchange',
    userId: 'u',
  });
  assert.match(sent.at(-1).text, /Room idle memory structuring/);
  assert.match(sent.at(-1).text, /schema-agnostic/);

  let state = sessionStore.get('chat-exchange').room_companion_state;
  assert.equal(state.idle_memory_observations.length, 1);
  assert.equal(state.idle_memory_observations[0].status, 'pending');

  await handler({
    msg: { chat: { id: 'chat-exchange' }, from: { id: 'u' } },
    text: '/council ask 이 방의 다음 작업 방향을 정리해줘',
    chatId: 'chat-exchange',
    userId: 'u',
  });

  state = sessionStore.get('chat-exchange').room_companion_state;
  assert.equal(state.memory_exchange_proposals.length, 1);
  assert.equal(state.memory_exchange_proposals[0].status, 'pending');
  assert.match(sent.at(-1).text, /Memory exchange proposal created/);

  await handler({
    msg: { chat: { id: 'chat-exchange' }, from: { id: 'u' } },
    text: '/inbox',
    chatId: 'chat-exchange',
    userId: 'u',
  });
  assert.match(sent.at(-1).text, /companion memory exchange: pending=1/);
  assert.match(sent.at(-1).text, /idle memory structuring: pending=1/);

  await handler({
    msg: { chat: { id: 'chat-exchange' }, from: { id: 'u' } },
    text: '/council approve latest',
    chatId: 'chat-exchange',
    userId: 'u',
  });
  state = sessionStore.get('chat-exchange').room_companion_state;
  assert.equal(state.memory_exchange_proposals[0].status, 'accepted');
  assert.match(sent.at(-1).text, /accepted/);
});
