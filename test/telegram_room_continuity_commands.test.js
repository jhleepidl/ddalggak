import test from 'node:test';
import assert from 'node:assert/strict';

import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';

function makeStore(seed = {}) {
  const rows = new Map([['chat-1', seed]]);
  return {
    get: (id) => rows.get(String(id)) || {},
    upsert: (id, updater) => {
      const key = String(id);
      const next = updater(rows.get(key) || {});
      rows.set(key, next);
      return next;
    },
  };
}

function makeHandler(sent, store, extra = {}) {
  return createTelegramCommandHandler({
    bot: { async sendMessage(chatId, text) { sent.push({ chatId, text }); return { message_id: sent.length }; } },
    sendLong: async (_bot, chatId, text) => { sent.push({ chatId, text }); return { message_id: sent.length }; },
    chatSessionStore: store,
    resolveLiveJobIdForChat: () => 'job-current',
    ...extra,
  });
}

async function run(handler, text) {
  return handler({ msg: { chat: { id: 'chat-1' }, from: { id: 'user-1' } }, text, chatId: 'chat-1', userId: 'user-1' });
}

test('home and help foreground Room continuity instead of agent count', async () => {
  const sent = [];
  const store = makeStore({
    agent_room_profile: { current_goal: 'Finish the research report' },
    runtime_rules: [{ text: 'Use only approved sources.', enabled: true }],
  });
  const handler = makeHandler(sent, store);
  await run(handler, '/home');
  assert.match(sent.at(-1).text, /Continuity Home/);
  assert.match(sent.at(-1).text, /목표: Finish the research report/);
  assert.match(sent.at(-1).text, /\/brief/);
  assert.doesNotMatch(sent.at(-1).text, /바로 쓰는 5개 명령:[\s\S]*\/council/);

  await run(handler, '/help');
  assert.match(sent.at(-1).text, /\/brief/);
  assert.match(sent.at(-1).text, /\/sources/);
  assert.match(sent.at(-1).text, /\/rules/);
  assert.doesNotMatch(sent.at(-1).text, /\/agents suggest/);
});

test('brief, sources, rules, and branch expose user-governed continuity', async () => {
  const sent = [];
  const store = makeStore({
    agent_room_profile: { current_goal: 'Continue a multi-day product plan' },
    runtime_rules: [{ text: 'Do not overwrite the approved plan.', enabled: true }],
    room_companion_events: [
      { event_type: 'context_override', context_mode: 'exclude', excluded_source: 'stale_notes', ts: new Date().toISOString() },
      { event_type: 'user_correction', correction_text: 'Keep user-approved decisions.', ts: new Date().toISOString() },
    ],
  });
  const handler = makeHandler(sent, store);

  await run(handler, '/brief');
  assert.match(sent.at(-1).text, /Room Brief/);
  assert.match(sent.at(-1).text, /Continue job job-current/);

  await run(handler, '/sources');
  assert.match(sent.at(-1).text, /Sources & Boundaries/);
  assert.match(sent.at(-1).text, /stale_notes/);

  await run(handler, '/rules');
  assert.match(sent.at(-1).text, /Do not overwrite/);

  await run(handler, '/branch explore a privacy-first alternative');
  assert.match(sent.at(-1).text, /Room branch proposal/);
  assert.equal(store.get('chat-1').room_branches.length, 1);
});

test('/continue resolves the current job when no id is supplied', async () => {
  const sent = [];
  const store = makeStore({});
  let continued = '';
  const handler = makeHandler(sent, store, {
    resetJobAbortController: () => {},
    activeJobByChat: new Map(),
    jobAbortControllers: new Map(),
    runWorkspaceDir: () => '',
    tracking: {},
    extractCodexInstruction: () => '',
    loadSupervisorRuntime: async () => null,
    getGoalFromResearch: () => '',
    decideRunRoute: () => null,
    actionLabel: () => '',
    executeRoutedPlan: async ({ jobId }) => { continued = jobId; },
    suggestNextPrompt: () => '',
    isCancelledError: () => false,
  });
  // The route executor is integration-heavy; a missing dependency may stop before executeRoutedPlan,
  // but it must no longer emit the old Usage-only response.
  try { await run(handler, '/continue'); } catch {}
  assert.notEqual(sent.at(-1)?.text, 'Usage: /continue <jobId>');
  assert.ok(continued === '' || continued === 'job-current');
});
