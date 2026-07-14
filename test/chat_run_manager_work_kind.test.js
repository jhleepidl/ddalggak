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

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatSessionStore } from '../src/chat/session.js';

test('ChatRunManager preserves team-task metadata through the real ChatSessionStore normalization boundary', async () => {
  const rootBase = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
  fs.mkdirSync(rootBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(rootBase, 'chat-run-manager-team-task-'));
  try {
    const calls = [];
    const teamConfig = {
      team_name: 'builder_reviewer',
      agents: [
        { id: 'builder', role: 'builder', model_role: 'code_executor' },
        { id: 'reviewer', role: 'reviewer', model_role: 'verifier_critic' },
      ],
      interaction_spec: {
        final_participant_id: 'reviewer',
        handoffs: [{ from: 'builder', to: 'reviewer' }],
      },
    };
    const manager = new ChatRunManager({
      sessionStore: new ChatSessionStore({ baseDir: root }),
      interruptDebounceMs: 0,
      runChat: async (row) => calls.push(row),
    });

    await manager.handleIncoming({
      chatId: 'chat-team-real-store',
      userId: 'u1',
      text: 'build and review this',
      kind: 'team_task',
      teamConfig,
      userReplyToMessageId: 88,
    });
    await manager.chatState.get('chat-team-real-store').promise;

    assert.equal(calls.length, 1);
    assert.equal(calls[0].inputKind, 'team_task');
    assert.equal(calls[0].userReplyToMessageId, 88);
    assert.equal(calls[0].teamConfig?.team_name, 'builder_reviewer');
    assert.equal(calls[0].teamConfig?.agents?.[0]?.model_role, 'code_executor');
    assert.equal(calls[0].teamConfig?.agents?.[1]?.model_role, 'verifier_critic');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
