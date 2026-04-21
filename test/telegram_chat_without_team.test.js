import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';

function createSessionStore() {
  const map = new Map();
  return {
    get(chatId) {
      return map.get(String(chatId)) || { state: 'idle' };
    },
    upsert(chatId, patchOrUpdater = {}) {
      const key = String(chatId);
      const current = this.get(key);
      const next = typeof patchOrUpdater === 'function'
        ? { ...current, ...(patchOrUpdater(current) || {}) }
        : { ...current, ...(patchOrUpdater || {}) };
      map.set(key, next);
      return next;
    },
    clear(chatId) {
      map.delete(String(chatId));
    },
  };
}

test('/chat no longer blocks when there is no active team', async () => {
  const sent = [];
  const store = createSessionStore();
  const calls = [];
  const handler = createTelegramCommandHandler({
    telegramUi: {
      bot: {
        sendMessage: async (chatId, text) => {
          sent.push({ chatId, text: String(text || '') });
          return { message_id: 55 };
        },
      },
      sendLong: async () => null,
      sendContextInfo: async () => null,
      sendRouterAckMessage: async () => 55,
      clip: (value) => String(value || ''),
    },
    runtimeOps: {
      parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
      loadSupervisorRuntime: async () => null,
      runSupervisorChat: async () => null,
      normalizeForceMode: (value) => value || 'normal',
      memoryModeWithFallback: () => 'local',
      requireGocClient: () => ({}) ,
    },
    sessionOps: {
      getAwait: () => null,
      clearAwait: () => null,
      setAwait: () => null,
      rememberLastChatJob: () => null,
      resetChatSession: () => null,
      activeJobByChat: new Map(),
      lastChatJobByChat: new Map(),
      chatSessionStore: store,
      chatRunManager: {
        handleIncoming: async (payload) => {
          calls.push(payload);
          return { status: 'started' };
        },
      },
      jobAbortControllers: new Map(),
    },
    fileOps: {
      resolveLiveJobIdForChat: () => '',
      parseClampedInt: (value, fallback) => fallback,
      collectWorkspaceFileEntries: () => [],
      formatWorkspaceFileListText: () => '',
      refreshArtifactIndex: () => ({ entries: [] }),
      formatArtifactIndexText: () => '',
      sendArtifactBySelection: async () => null,
      sendArtifactBundle: async () => null,
      formatByteSize: () => '0B',
      runWorkspaceDir: () => '',
    },
    jobOps: {
      formatRunningJobs: () => '',
      cancelJobExecution: async () => null,
      createJob: () => ({ jobId: 'job_x' }),
      resetJobAbortController: () => ({ signal: null }),
      tracking: { append: () => null },
      jobs: { appendConversation: () => null },
      approvals: { request: () => ({ token: 'tok' }) },
      isCancelledError: () => false,
      actionLabel: () => '',
      getGoalFromResearch: () => '',
      extractCodexInstruction: () => '',
      runCommand: async () => ({ ok: true, stdout: '', stderr: '' }),
      extractJsonPlan: () => null,
    },
    teamOps: {
      applyPendingTeam: async () => null,
      isAllowedChat: () => true,
      isAllowedUser: () => true,
      setGocActingTelegramUser: () => null,
    },
  });

  await handler({
    msg: {
      message_id: 1,
      chat: { id: 101, title: 'test', type: 'private' },
      from: { id: 202 },
    },
    text: '/chat hello world',
    chatId: 101,
    userId: 202,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].text, 'hello world');
  assert.equal(sent.some((row) => /현재 활성 팀이 없습니다/.test(row.text)), false);
});
