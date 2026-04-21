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

function createHandlerHarness(sessionStore, sent) {
  return createTelegramCommandHandler({
    telegramUi: {
      bot: {
        sendMessage: async (chatId, text) => {
          sent.push({ kind: 'sendMessage', chatId, text: String(text || '') });
          return { message_id: 1 };
        },
      },
      sendLong: async (_bot, chatId, text) => {
        sent.push({ kind: 'sendLong', chatId, text: String(text || '') });
        return { message_id: 2 };
      },
      sendContextInfo: async () => null,
      sendRouterAckMessage: async () => 1,
      clip: (value) => String(value || ''),
    },
    runtimeOps: {
      parseChatMessageWithFlags: (raw) => ({ message: String(raw || '').trim(), debug: false }),
      loadSupervisorRuntime: async () => null,
      runSupervisorChat: async () => null,
      normalizeForceMode: (value) => value || 'normal',
      memoryModeWithFallback: () => 'local',
      requireGocClient: () => ({}),
    },
    sessionOps: {
      getAwait: () => null,
      clearAwait: () => null,
      setAwait: () => null,
      rememberLastChatJob: () => null,
      resetChatSession: () => null,
      activeJobByChat: new Map(),
      lastChatJobByChat: new Map(),
      chatSessionStore: sessionStore,
      chatRunManager: { handleIncoming: async () => ({ status: 'started' }) },
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
}

test('/team why surfaces latest strategy controller result from session state', async () => {
  const sent = [];
  const store = createSessionStore();
  store.upsert(101, {
    last_team_strategy: {
      recommendation: 'augment_context',
      rationale: ['prefer_memory_skill_context_augmentation'],
      augmentation: { score: 2.4, reasons: ['missing_capability_or_skill'] },
      role_separation: { score: 0.8, reasons: [] },
      capability_gap_summary: 'missing_skill:repo.search',
    },
  });
  const handler = createHandlerHarness(store, sent);

  await handler({
    msg: {
      message_id: 1,
      chat: { id: 101, type: 'private' },
      from: { id: 202 },
    },
    text: '/team why',
    chatId: 101,
    userId: 202,
  });

  const output = sent.map((row) => row.text).join('\n');
  assert.match(output, /Latest team strategy/);
  assert.match(output, /recommendation: augment_context/);
  assert.match(output, /capability_gaps: missing_skill:repo.search/);
});

test('/team overview includes latest strategy summary when available', async () => {
  const sent = [];
  const store = createSessionStore();
  store.upsert(101, {
    last_team_strategy: {
      recommendation: 'expand_team',
      rationale: ['persistent_role_separation_has_clear_value'],
      augmentation: { score: 1.6, reasons: [] },
      role_separation: {
        score: 4.4,
        reasons: ['independent_review_required'],
        independent_review_needed: true,
      },
      auto_prepared_draft: true,
    },
  });
  const handler = createHandlerHarness(store, sent);

  await handler({
    msg: {
      message_id: 1,
      chat: { id: 101, type: 'private' },
      from: { id: 202 },
    },
    text: '/team',
    chatId: 101,
    userId: 202,
  });

  const output = sent.map((row) => row.text).join('\n');
  assert.match(output, /Latest team strategy/);
  assert.match(output, /recommendation: expand_team/);
  assert.match(output, /pending draft auto-prepared/);
});
