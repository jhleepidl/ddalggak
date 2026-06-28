import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

function makeHandler({ sent = [], incoming = [] } = {}) {
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
    chatSessionStore: makeSessionStore(),
    resolveLiveJobIdForChat: () => null,
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    createAgentRoomTeamConfiguration: async ({ description }) => ({
      team_name: 'Team Review',
      mode: 'scoped_context',
      composition_mode: 'structured',
      proposal_mode: 'apply',
      task_brief: description,
      agents: [
        { agent_id: 'reviewer', name: 'Reviewer', role: 'reviewer', model: 'test-model', provider: 'test' },
        { agent_id: 'synthesizer', name: 'Synthesizer', role: 'synthesizer', model: 'test-model', provider: 'test' },
      ],
    }),
    chatRunManager: {
      async handleIncoming(payload) {
        incoming.push(payload);
        return { status: 'started' };
      },
    },
  });
}

test('public help exposes /chat primary entry and short aliases', () => {
  const source = readFileSync(new URL('../src/adapters/telegram/commands.js', import.meta.url), 'utf8');
  assert.match(source, /- \/chat 또는 \/c <message>/);
  assert.match(source, /- \/ask 또는 \/a <question>/);
  assert.match(source, /- \/team 또는 \/t <goal>/);
  assert.match(source, /- \/loop 또는 \/l \[--loops n\] <goal>/);
  assert.match(source, /'\/c': '\/chat'/);
  assert.match(source, /'\/t': '\/team'/);
});

test('/ask enqueues a quick answer with an isolated single-agent teamConfig', async () => {
  const sent = [];
  const incoming = [];
  const handler = makeHandler({ sent, incoming });
  const handled = await handler({
    msg: { message_id: 1, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/ask explain briefly',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].text, 'explain briefly');
  assert.equal(incoming[0].kind, 'ask');
  assert.equal(incoming[0].teamConfig?.agents?.length, 1);
  assert.equal(incoming[0].teamConfig?.agents?.[0]?.role, 'researcher');
  assert.match(sent.map((row) => row.text).join('\n'), /standard AI Room conversation/);
});

test('/loop without a goal returns public usage', async () => {
  const sent = [];
  const incoming = [];
  const handler = makeHandler({ sent, incoming });
  const handled = await handler({
    msg: { message_id: 2, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/loop',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 0);
  assert.match(sent[0].text, /Usage: \/loop \[--loops n\] <goal>/);
});

test('/team freeform goal starts a team-review attempt while advanced subcommands remain reserved', async () => {
  const sent = [];
  const incoming = [];
  const handler = makeHandler({ sent, incoming });
  const handled = await handler({
    msg: { message_id: 3, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/team review this framing',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 1);
  assert.equal(incoming[0].kind, 'team_task');
  assert.match(incoming[0].text, /Work depth: team_task/);
  assert.match(incoming[0].text, /review this framing/);
  assert.ok(incoming[0].teamConfig);
  assert.match(sent.map((row) => row.text).join('\n'), /team-review attempt/);
});

test('/c alias routes through /chat and can use Room Concierge direct executor', async () => {
  const sent = [];
  const incoming = [];
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    sendRouterAckMessage: async (_bot, chatId) => {
      sent.push({ chatId, text: 'ACK' });
      return { message_id: sent.length };
    },
    chatSessionStore: makeSessionStore(),
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    directAskExecutor: async ({ prompt, decision }) => {
      assert.equal(decision.route, 'concierge_direct_answer');
      assert.match(prompt, /direct chat mode/);
      return { text: '채팅 답변입니다.', provider: 'test-direct' };
    },
    chatRunManager: {
      isRunning: () => false,
      async handleIncoming(payload) {
        incoming.push(payload);
        return { status: 'started' };
      },
    },
  });

  const handled = await handler({
    msg: { message_id: 70, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/c 오늘 저녁 메뉴 추천해줘',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 0);
  assert.match(sent.map((row) => row.text).join('\n'), /\/c accepted: direct Room Concierge path/);
  assert.match(sent.map((row) => row.text).join('\n'), /채팅 답변입니다/);
});

test('/ask can bypass workbench through Room Concierge direct executor when configured', async () => {
  const sent = [];
  const incoming = [];
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    sendRouterAckMessage: async (_bot, chatId) => {
      sent.push({ chatId, text: 'ACK' });
      return { message_id: sent.length };
    },
    chatSessionStore: makeSessionStore(),
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    directAskExecutor: async ({ prompt, decision }) => {
      assert.equal(decision.route, 'concierge_direct_answer');
      assert.match(prompt, /direct chat mode/);
      return { text: '간단 답변입니다.', provider: 'test-direct' };
    },
    chatRunManager: {
      isRunning: () => false,
      async handleIncoming(payload) {
        incoming.push(payload);
        return { status: 'started' };
      },
    },
  });

  const handled = await handler({
    msg: { message_id: 7, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/ask 오늘 저녁 메뉴 추천해줘',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 0);
  assert.match(sent.map((row) => row.text).join('\n'), /direct Room Concierge path/);
  assert.match(sent.map((row) => row.text).join('\n'), /간단 답변입니다/);
});

test('/ask search-intent can bypass workbench through bounded Room Concierge search executor', async () => {
  const sent = [];
  const incoming = [];
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    sendRouterAckMessage: async (_bot, chatId) => {
      sent.push({ chatId, text: 'ACK' });
      return { message_id: sent.length };
    },
    chatSessionStore: makeSessionStore(),
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    searchAskExecutor: async ({ prompt, decision, maxSeconds }) => {
      assert.equal(decision.route, 'concierge_search_answer');
      assert.match(prompt, /search-intent mode/);
      assert.ok(maxSeconds <= 20);
      return { text: '공식 메뉴 확인이 안 되면 메뉴판 링크나 사진을 보내달라고 답합니다.', provider: 'test-search' };
    },
    chatRunManager: {
      isRunning: () => false,
      async handleIncoming(payload) {
        incoming.push(payload);
        return { status: 'started' };
      },
    },
  });

  const handled = await handler({
    msg: { message_id: 8, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/ask 실제로 해당 식당에서 파는 메뉴들을 검색해보고 그걸 바탕으로 대답해줘.',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  assert.equal(incoming.length, 0);
  assert.match(sent.map((row) => row.text).join('\n'), /bounded Room Concierge search path/);
  assert.match(sent.map((row) => row.text).join('\n'), /공식 메뉴 확인이 안 되면/);
});
