import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatRunManager } from '../src/chat/run_manager.js';

function makeSessionStore() {
  const rows = new Map();
  return {
    get(chatId) {
      return rows.get(String(chatId)) || {};
    },
    upsert(chatId, patch) {
      const key = String(chatId);
      const current = rows.get(key) || {};
      const next = typeof patch === 'function' ? patch(current) : { ...current, ...patch };
      rows.set(key, next);
      return next;
    },
  };
}

test('ChatRunManager preserves command work kind and team config into runChat', async () => {
  const calls = [];
  const teamConfig = { team_name: 'ask_single', agents: [{ role: 'researcher' }] };
  const manager = new ChatRunManager({
    sessionStore: makeSessionStore(),
    interruptDebounceMs: 0,
    runChat: async (row) => calls.push(row),
  });

  await manager.handleIncoming({
    chatId: 'chat-1',
    userId: 'u1',
    text: 'explain briefly',
    kind: 'ask',
    teamConfig,
  });
  await manager.chatState.get('chat-1').promise;

  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputKind, 'ask');
  assert.equal(calls[0].teamConfig, teamConfig);
});

test('ChatRunManager reports the preserved input kind on run errors', async () => {
  const errors = [];
  const manager = new ChatRunManager({
    sessionStore: makeSessionStore(),
    interruptDebounceMs: 0,
    runChat: async () => { throw new Error('boom'); },
    onRunError: async (row) => errors.push(row),
  });

  await manager.handleIncoming({ chatId: 'chat-2', text: 'question', kind: 'ask' });
  await manager.chatState.get('chat-2').promise;

  assert.equal(errors.length, 1);
  assert.equal(errors[0].inputKind, 'ask');
  assert.match(String(errors[0].error?.message || ''), /boom/);
});
