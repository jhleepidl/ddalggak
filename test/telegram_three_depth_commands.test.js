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

test('public help exposes /ask, /team, and /loop as primary commands', () => {
  const source = readFileSync(new URL('../src/adapters/telegram/commands.js', import.meta.url), 'utf8');
  assert.match(source, /- \/ask <question>/);
  assert.match(source, /- \/team <goal>/);
  assert.match(source, /- \/loop \[--loops n\] <goal>/);
  assert.match(source, /if \(cmd === "\/ask"\)/);
  assert.match(source, /if \(cmd === "\/loop"\)/);
});

test('/ask enqueues a quick answer without teamConfig', async () => {
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
  assert.equal(incoming[0].teamConfig, null);
  assert.match(sent.map((row) => row.text).join('\n'), /quick single-agent answer/);
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
