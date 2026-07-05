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

test('/room presets lists built-in room defaults and /room preset installs one', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });
  await handler({ msg: { message_id: 1, chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/room presets research', chatId: 'chat-1', userId: 'u' });
  assert.match(sent.at(-1).text, /Default Room Presets/);
  assert.match(sent.at(-1).text, /research_paper_factory/);

  await handler({ msg: { message_id: 2, chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/room preset research_paper_factory', chatId: 'chat-1', userId: 'u' });
  const profile = sessionStore.get('chat-1').agent_room_profile;
  assert.equal(profile.preset_id, 'research_paper_factory');
  assert.equal(profile.default_depth, 'loop');
  assert.ok(profile.installed_skills.includes('related_work_mapping'));
  assert.match(sent.at(-1).text, /memory hierarchy/);
});

test('/loop accepts mobile em dash loops flag and preserves explicit loop count', async () => {
  const sent = [];
  const incoming = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, incoming, sessionStore });
  await handler({ msg: { message_id: 1, chat: { id: 'chat-loop' }, from: { id: 'u' } }, text: '/l —loops 5 SIGIR AP 논문 연구와 실험을 진행해줘', chatId: 'chat-loop', userId: 'u' });
  const combined = sent.map((x) => x.text).join('\n');
  assert.match(combined, /max loops: 5/);
  assert.equal(incoming.length, 1);
  assert.match(incoming[0].text, /"max_iterations":5/);
});

test('/loop supports short leading number syntax and default preset loop floor', async () => {
  const sent = [];
  const incoming = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, incoming, sessionStore });
  await handler({ msg: { message_id: 1, chat: { id: 'chat-loop2' }, from: { id: 'u' } }, text: '/room preset autonomous_code_loop', chatId: 'chat-loop2', userId: 'u' });
  await handler({ msg: { message_id: 2, chat: { id: 'chat-loop2' }, from: { id: 'u' } }, text: '/loop 4 버그를 고치고 테스트해줘', chatId: 'chat-loop2', userId: 'u' });
  const combined = sent.map((x) => x.text).join('\n');
  assert.match(combined, /max loops: 4/);
  assert.match(incoming.at(-1).text, /"max_iterations":4/);
});

test('/room apply reports package composition and /room alternatives shows the same basis', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });
  const goal = '논문 아이디어를 실험 코드로 검증하고 교수님 미팅 준비까지 같이 하는 방';
  await handler({ msg: { message_id: 1, chat: { id: 'chat-compose' }, from: { id: 'u' } }, text: `/room apply ${goal}`, chatId: 'chat-compose', userId: 'u' });
  assert.match(sent.at(-1).text, /Room package selection/);
  assert.match(sent.at(-1).text, /base package: research_paper_factory/);
  assert.match(sent.at(-1).text, /borrowed components/);
  const profile = sessionStore.get('chat-compose').agent_room_profile;
  assert.equal(profile.preset_id, 'research_paper_factory');
  assert.ok(profile.room_package_composition.borrowed_packages.length >= 1);

  await handler({ msg: { message_id: 2, chat: { id: 'chat-compose' }, from: { id: 'u' } }, text: '/room alternatives', chatId: 'chat-compose', userId: 'u' });
  assert.match(sent.at(-1).text, /Room package selection/);
  assert.match(sent.at(-1).text, /not a fixed prompt route/);
});
