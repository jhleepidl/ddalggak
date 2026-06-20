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
    set: (key, value) => map.set(String(key), value),
    upsert: (key, updater) => {
      const id = String(key);
      const prev = map.get(id) || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...(updater || {}) };
      map.set(id, next);
      return next;
    },
  };
}

function makeHandler({ sent = [], incoming = [], sessionStore = makeSessionStore() } = {}) {
  return createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    sendRouterAckMessage: async (_bot, chatId) => {
      sent.push({ chatId, text: 'ACK' });
      return { message_id: sent.length };
    },
    chatSessionStore: sessionStore,
    resolveLiveJobIdForChat: () => null,
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    createAgentRoomTeamConfiguration: async ({ description }) => ({
      agents: [{ agent_id: 'fallback', name: 'Fallback', role: 'builder' }],
      task_brief: description,
    }),
    chatRunManager: {
      async handleIncoming(payload) {
        incoming.push(payload);
        return { status: 'started' };
      },
    },
  });
}

test('/room apply specializes the chat and /room export emits ROOM.md', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });
  await handler({ msg: { message_id: 1, chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/room apply 연구 아이디어를 논문으로 발전시키는 방', chatId: 'chat-1', userId: 'u' });
  assert.match(sent.map((x) => x.text).join('\n'), /specialized AI Room/);
  assert.equal(sessionStore.get('chat-1').agent_room_profile.domain_label, 'research_paper');

  await handler({ msg: { message_id: 2, chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/room export', chatId: 'chat-1', userId: 'u' });
  const output = sent.map((x) => x.text).join('\n');
  assert.match(output, /ROOM\.md/);
  assert.match(output, /shared_room_package_v1/);
  assert.match(output, /private memory copied: no/);
});

test('/team setup-only creative writing prepares room without enqueueing execution', async () => {
  const sent = [];
  const incoming = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, incoming, sessionStore });
  await handler({
    msg: { message_id: 3, chat: { id: 'chat-2' }, from: { id: 'u' } },
    text: '/team 팬픽 작성을 도와줘. 줄거리는 나중에 말할테니 작성, 검토, 모순점 확인 팀을 준비해줘.',
    chatId: 'chat-2',
    userId: 'u',
  });
  assert.equal(incoming.length, 0);
  assert.equal(sessionStore.get('chat-2').agent_room_profile.domain_label, 'creative_writing');
  assert.match(sent.map((x) => x.text).join('\n'), /specialized room prepared/);
  assert.match(sent.map((x) => x.text).join('\n'), /setup-only/);
});
