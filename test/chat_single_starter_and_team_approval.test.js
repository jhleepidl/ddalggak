import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';
import { buildStarterSingleAgentTeamConfiguration, teamConfigChangeRequiresApproval } from '../src/application/team_configuration.js';

function makeBot(sent) {
  return {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
  };
}

function makeTeam(name, { role = 'researcher', model = 'gemini-2.5-pro', provider = 'gemini' } = {}) {
  return {
    team_name: name,
    mode: 'scoped_context',
    composition_mode: 'structured',
    proposal_mode: 'apply',
    task_brief: 'test task',
    design_prompt: 'test task',
    status: 'active',
    agents: [
      {
        agent_id: `${name}_${role}`.replace(/[^a-z0-9_]/gi, '_').toLowerCase(),
        name: role === 'builder' ? 'Builder' : 'Research Lead',
        role,
        model,
        purpose: 'test task',
        skills: [],
        provider,
      },
    ],
  };
}

test('starter single-agent config defaults to researcher for lightweight chat and builder for implementation chat', () => {
  const lightweight = buildStarterSingleAgentTeamConfiguration({ taskText: '이 개념을 짧게 설명해줘' });
  const implementation = buildStarterSingleAgentTeamConfiguration({ taskText: '이 코드 버그를 수정하고 패치를 만들어줘' });

  assert.equal(lightweight.agents.length, 1);
  assert.equal(lightweight.agents[0].role, 'researcher');
  assert.equal(implementation.agents.length, 1);
  assert.equal(implementation.agents[0].role, 'builder');
});

test('/chat no longer blocks when there is no active team or uses the concierge fast path', async () => {
  const sent = [];
  const handledIncoming = [];
  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendRouterAckMessage: async (_bot, chatId) => {
      sent.push({ chatId, text: 'ACK' });
      return { message_id: sent.length };
    },
    chatSessionStore: new Map(),
    resolveLiveJobIdForChat: () => null,
    parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
    chatRunManager: {
      async handleIncoming(payload) {
        handledIncoming.push(payload);
      },
    },
  });

  const handled = await handler({
    msg: { message_id: 99, chat: { id: 'chat-1', type: 'private' }, from: { id: 'user-1' } },
    text: '/chat 안녕',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.equal(handled, true);
  if (handledIncoming.length > 0) {
    assert.equal(handledIncoming.length, 1);
    assert.equal(handledIncoming[0].text, '안녕');
    assert.equal(handledIncoming[0].teamConfig, null);
  } else {
    assert.match(sent.map((row) => row.text).join('\n'), /\/chat accepted: direct Room Concierge path|running standard AI Room conversation/);
  }
});

test('/team apply requires explicit confirm when pending team differs from active team', async () => {
  const sent = [];
  const sessionStore = new Map();
  sessionStore.set('chat-1', {
    team_config: {
      status: 'configured',
      active_team: makeTeam('starter_team'),
      pending_team: makeTeam('builder_team', { role: 'builder', model: 'gpt-5-codex', provider: 'codex' }),
    },
  });

  const handler = createTelegramCommandHandler({
    bot: makeBot(sent),
    sendLong: async (_bot, chatId, text) => {
      sent.push({ chatId, text });
      return { message_id: sent.length };
    },
    chatSessionStore: sessionStore,
    resolveLiveJobIdForChat: () => null,
  });

  await handler({
    msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } },
    text: '/team apply',
    chatId: 'chat-1',
    userId: 'user-1',
  });

  assert.match(sent[0].text, /승인 확인/);
  assert.match(sent[0].text, /\/team apply confirm/);
  assert.equal(teamConfigChangeRequiresApproval(makeTeam('starter_team'), makeTeam('builder_team', { role: 'builder', model: 'gpt-5-codex', provider: 'codex' })), true);
});
