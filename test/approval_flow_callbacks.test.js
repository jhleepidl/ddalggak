import test from 'node:test';
import assert from 'node:assert/strict';

import { handleActionApprovalCallback, isActionApprovalCallbackData } from '../src/application/approval_flow.js';

function createSessionStore(initialByChat = {}) {
  const store = new Map(Object.entries(initialByChat).map(([key, value]) => [String(key), { ...value }]));
  return {
    get(chatId) {
      return store.get(String(chatId)) || null;
    },
    upsert(chatId, patch = {}) {
      const key = String(chatId);
      const current = store.get(key) || {};
      const resolvedPatch = typeof patch === 'function' ? patch(current) : patch;
      const next = { ...current, ...(resolvedPatch || {}) };
      store.set(key, next);
      return next;
    },
  };
}

function createBot() {
  const calls = { answers: [], messages: [] };
  return {
    calls,
    async answerCallbackQuery(id, payload) {
      calls.answers.push({ id, payload });
    },
    async sendMessage(chatId, text) {
      calls.messages.push({ chatId, text });
    },
  };
}

const baseMessage = {
  message_id: 10,
  chat: { id: 123, type: 'private', title: 'chat' },
};

test('approval callback detection accepts known prefixes only', () => {
  assert.equal(isActionApprovalCallbackData('approve_action:abc'), true);
  assert.equal(isActionApprovalCallbackData('reject_action:abc'), true);
  assert.equal(isActionApprovalCallbackData('work_action:abc'), true);
  assert.equal(isActionApprovalCallbackData('noop:abc'), false);
});

test('approval callback reports missing pending approval without mutating session', async () => {
  const chatSessionStore = createSessionStore({
    '123': { state: 'idle', pending_approval: null },
  });
  const bot = createBot();
  const result = await handleActionApprovalCallback({
    q: { id: 'cb1' },
    msg: baseMessage,
    data: 'approve_action:approval-1',
    bot,
    chatId: 123,
    userId: 5,
    deps: {
      chatSessionStore,
      resolveCurrentJobIdForChat: () => '',
    },
  });

  assert.equal(result.handled, true);
  assert.equal(bot.calls.answers.at(-1)?.payload?.text, 'pending approval 없음');
  assert.match(bot.calls.messages.at(-1)?.text || '', /현재 승인 대기 중인 액션이 없습니다/);
  assert.equal(chatSessionStore.get(123)?.pending_approval, null);
});

test('approval callback rejects mismatched approval token and preserves pending state', async () => {
  const chatSessionStore = createSessionStore({
    '123': {
      jobId: 'job-1',
      state: 'awaiting_approval',
      pending_approval: {
        id: 'approval-expected',
        job_id: 'job-1',
        action: { type: 'run_agent' },
      },
    },
  });
  const bot = createBot();
  const result = await handleActionApprovalCallback({
    q: { id: 'cb2' },
    msg: baseMessage,
    data: 'approve_action:approval-other',
    bot,
    chatId: 123,
    userId: 5,
    deps: {
      chatSessionStore,
      resolveCurrentJobIdForChat: () => 'job-1',
    },
  });

  assert.equal(result.handled, true);
  assert.equal(bot.calls.answers.at(-1)?.payload?.text, 'approval id 불일치');
  assert.match(bot.calls.messages.at(-1)?.text || '', /승인 토큰이 현재 대기 상태와 일치하지 않습니다/);
  assert.equal(chatSessionStore.get(123)?.state, 'awaiting_approval');
  assert.equal(chatSessionStore.get(123)?.pending_approval?.id, 'approval-expected');
});

test('approval callback clears stale pending approval when resume job id is missing', async () => {
  const chatSessionStore = createSessionStore({
    '123': {
      state: 'awaiting_approval',
      pending_approval: {
        id: 'approval-expected',
        action: { type: 'run_agent' },
      },
    },
  });
  const bot = createBot();
  const result = await handleActionApprovalCallback({
    q: { id: 'cb3' },
    msg: baseMessage,
    data: 'approve_action:approval-expected',
    bot,
    chatId: 123,
    userId: 5,
    deps: {
      chatSessionStore,
      resolveCurrentJobIdForChat: () => '',
    },
  });

  assert.equal(result.handled, true);
  assert.equal(bot.calls.answers.at(-1)?.payload?.text, 'job 없음');
  assert.match(bot.calls.messages.at(-1)?.text || '', /승인 재개 대상 jobId를 찾지 못해 pending 상태를 정리했습니다/);
  assert.equal(chatSessionStore.get(123)?.state, 'idle');
  assert.equal(chatSessionStore.get(123)?.pending_approval, null);
});


test('approval reject clears interrupt and pending user messages', async () => {
  const chatSessionStore = createSessionStore({
    '123': {
      jobId: 'job-1',
      state: 'awaiting_approval',
      interrupt: { reason: 'user_interrupt' },
      pending_user_messages: [{ text: 'later' }],
      pending_approval: {
        id: 'approval-expected',
        job_id: 'job-1',
        action: { type: 'run_agent', agent_id: 'builder' },
      },
    },
  });
  const bot = createBot();
  const trackingCalls = [];
  const result = await handleActionApprovalCallback({
    q: { id: 'cb4' },
    msg: baseMessage,
    data: 'reject_action:approval-expected',
    bot,
    chatId: 123,
    userId: 5,
    deps: {
      chatSessionStore,
      resolveCurrentJobIdForChat: () => 'job-1',
      tracking: { append: (...args) => trackingCalls.push(args) },
      chatActionLabel: () => 'run_agent(builder)',
    },
  });

  assert.equal(result.handled, true);
  assert.equal(bot.calls.answers.at(-1)?.payload?.text, 'rejected');
  assert.match(bot.calls.messages.at(-1)?.text || '', /승인 거절됨/);
  assert.equal(chatSessionStore.get(123)?.state, 'idle');
  assert.equal(chatSessionStore.get(123)?.pending_approval, null);
  assert.equal(chatSessionStore.get(123)?.interrupt, null);
  assert.deepEqual(chatSessionStore.get(123)?.pending_user_messages, []);
  assert.equal(trackingCalls.length, 1);
});

test('approval with no remaining actions clears stale interrupt state', async () => {
  const chatSessionStore = createSessionStore({
    '123': {
      jobId: 'job-1',
      state: 'awaiting_approval',
      interrupt: { reason: 'resume_pending' },
      pending_user_messages: [{ text: 'queued follow-up' }],
      pending_approval: {
        id: 'approval-expected',
        job_id: 'job-1',
        reason: 'review gate',
        remaining_actions: [],
      },
    },
  });
  const bot = createBot();
  const result = await handleActionApprovalCallback({
    q: { id: 'cb5' },
    msg: baseMessage,
    data: 'approve_action:approval-expected',
    bot,
    chatId: 123,
    userId: 5,
    deps: {
      chatSessionStore,
      resolveCurrentJobIdForChat: () => 'job-1',
      getCurrentTurnReplyMessageId: () => null,
      tracking: { append() {} },
      chatActionLabel: () => 'run_agent(builder)',
      loadSupervisorRuntime: async () => ({ map: {}, jobConfig: {} }),
      memoryModeWithFallback: () => 'local',
      jobs: { jobDir: () => '/tmp/job-1', log() {} },
      buildQueuedAgentStatusFromActions: () => [],
      sendPlanPreviewMessage: async () => {},
      markMutatingActionsConfirmed: (rows) => rows,
      normalizeForceMode: (value) => value || 'normal',
    },
  });

  assert.equal(result.handled, true);
  assert.match(bot.calls.messages.at(-1)?.text || '', /재개할 남은 action이 없어 승인 대기를 해제/);
  assert.equal(chatSessionStore.get(123)?.state, 'idle');
  assert.equal(chatSessionStore.get(123)?.pending_approval, null);
  assert.equal(chatSessionStore.get(123)?.interrupt, null);
  assert.deepEqual(chatSessionStore.get(123)?.pending_user_messages, []);
});
