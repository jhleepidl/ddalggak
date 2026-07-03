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

test('/companions lists profiles and /companion switch records active companion', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });
  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/companions', chatId: 'chat-1', userId: 'u' });
  assert.match(sent.at(-1).text, /Research Companion/);
  assert.match(sent.at(-1).text, /Product Companion/);

  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/companion switch product', chatId: 'chat-1', userId: 'u' });
  assert.equal(sessionStore.get('chat-1').room_companion_state.active_companion.id, 'product');
  assert.match(sent.at(-1).text, /Product Companion/);

  await handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'u' } }, text: '/companion profile', chatId: 'chat-1', userId: 'u' });
  assert.match(sent.at(-1).text, /context controls/);
});

test('/context and /correct update companion control state', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat-2' }, from: { id: 'u' } }, text: '/context project-only', chatId: 'chat-2', userId: 'u' });
  await handler({ msg: { chat: { id: 'chat-2' }, from: { id: 'u' } }, text: '/context exclude gpt-5.4-nano-assumption', chatId: 'chat-2', userId: 'u' });
  await handler({ msg: { chat: { id: 'chat-2' }, from: { id: 'u' } }, text: '/agent mode strict', chatId: 'chat-2', userId: 'u' });
  await handler({ msg: { chat: { id: 'chat-2' }, from: { id: 'u' } }, text: '/correct docs-only means do not touch runtime code', chatId: 'chat-2', userId: 'u' });

  const state = sessionStore.get('chat-2').room_companion_state;
  assert.equal(state.context_controls.mode, 'project-only');
  assert.deepEqual(state.context_controls.excluded_sources, ['gpt-5.4-nano-assumption']);
  assert.equal(state.agent_mode, 'strict');
  assert.match(state.recent_corrections[0].text, /docs-only/);
  assert.match(sent.map((row) => row.text).join('\n'), /correction을 포함합니다|candidate workflow preference/);
});


test('/correct auto-creates proposal for durable corrections and lists proposals', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat-3' }, from: { id: 'u' } }, text: '/correct 앞으로 docs-only면 runtime code는 건드리지 마', chatId: 'chat-3', userId: 'u' });
  let state = sessionStore.get('chat-3').room_companion_state;
  assert.equal(state.recent_corrections.length, 1);
  assert.equal(state.merge_proposals.length, 1);
  assert.match(sent.at(-1).text, /reviewable merge proposal/);

  await handler({ msg: { chat: { id: 'chat-3' }, from: { id: 'u' } }, text: '/correct proposals', chatId: 'chat-3', userId: 'u' });
  assert.match(sent.at(-1).text, /Companion merge proposals/);
  assert.match(sent.at(-1).text, /docs-only/);
  assert.match(sent.at(-1).text, /correct approve/);
});


test('/correct approve and reject mark pending merge proposals through review events', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat-approve' }, from: { id: 'u' } }, text: '/correct 앞으로 docs-only면 runtime code는 건드리지 마', chatId: 'chat-approve', userId: 'u' });
  await handler({ msg: { chat: { id: 'chat-approve' }, from: { id: 'u' } }, text: '/correct approve latest', chatId: 'chat-approve', userId: 'u' });
  let state = sessionStore.get('chat-approve').room_companion_state;
  assert.equal(state.merge_proposals[0].status, 'accepted');
  assert.equal(state.materialization_candidates.length, 1);
  assert.equal(state.materialization_candidates[0].payload.canonical_write_enabled, false);
  assert.match(sent.at(-1).text, /accepted/);
  assert.match(sent.at(-1).text, /materialization_candidate/);

  await handler({ msg: { chat: { id: 'chat-approve' }, from: { id: 'u' } }, text: '/correct materialize-preview', chatId: 'chat-approve', userId: 'u' });
  assert.match(sent.at(-1).text, /Companion materialization candidates/);
  assert.match(sent.at(-1).text, /canonical_write_enabled: false/);

  await handler({ msg: { chat: { id: 'chat-approve' }, from: { id: 'u' } }, text: '/correct reject latest', chatId: 'chat-approve', userId: 'u' });
  assert.match(sent.at(-1).text, /pending companion merge proposal이 없습니다/);

  await handler({ msg: { chat: { id: 'chat-reject' }, from: { id: 'u' } }, text: '/correct 앞으로 외부 검색 없이는 최신이라고 말하지 마', chatId: 'chat-reject', userId: 'u' });
  await handler({ msg: { chat: { id: 'chat-reject' }, from: { id: 'u' } }, text: '/correct reject latest too broad', chatId: 'chat-reject', userId: 'u' });
  state = sessionStore.get('chat-reject').room_companion_state;
  assert.equal(state.merge_proposals[0].status, 'rejected');
  assert.equal(state.materialization_candidates.length, 0);
  assert.match(state.merge_proposals[0].decision_reason, /too broad/);
  assert.match(sent.at(-1).text, /rejected/);
});

test('/correct keeps temporary corrections local and supports manual promote latest', async () => {
  const sent = [];
  const sessionStore = makeSessionStore();
  const handler = makeHandler({ sent, sessionStore });

  await handler({ msg: { chat: { id: 'chat-4' }, from: { id: 'u' } }, text: '/correct 이번엔 기존 맥락 빼고 봐줘', chatId: 'chat-4', userId: 'u' });
  let state = sessionStore.get('chat-4').room_companion_state;
  assert.equal(state.recent_corrections.length, 1);
  assert.equal(state.merge_proposals.length, 0);
  assert.match(sent.at(-1).text, /not created automatically/);

  await handler({ msg: { chat: { id: 'chat-4' }, from: { id: 'u' } }, text: '/correct promote latest', chatId: 'chat-4', userId: 'u' });
  state = sessionStore.get('chat-4').room_companion_state;
  assert.equal(state.merge_proposals.length, 1);
  assert.match(sent.at(-1).text, /reviewable merge proposal/);
});
