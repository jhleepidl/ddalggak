import test from 'node:test';
import assert from 'node:assert/strict';

import {
  summarizeUserSafeGocFallbackReason,
  useCompactProgressUpdates,
  buildCompactExecutionUpdateText,
  notifyAndConsumeGocFallback,
} from '../src/application/telegram_status_notifications.js';

test('summarizeUserSafeGocFallbackReason sanitizes raw errors into stable codes', () => {
  assert.equal(summarizeUserSafeGocFallbackReason('connect ETIMEDOUT to goc'), 'projection_timeout');
  assert.equal(summarizeUserSafeGocFallbackReason('403 forbidden token expired'), 'projection_access_denied');
  assert.equal(summarizeUserSafeGocFallbackReason('404 not found'), 'projection_missing');
  assert.equal(summarizeUserSafeGocFallbackReason('socket hang up'), 'projection_network_error');
  assert.equal(summarizeUserSafeGocFallbackReason('weird internal stacktrace'), 'projection_unavailable');
});

test('useCompactProgressUpdates respects env override and verbose flag', () => {
  const prev = process.env.TELEGRAM_PROGRESS_DETAIL_MODE;
  process.env.TELEGRAM_PROGRESS_DETAIL_MODE = 'full';
  assert.equal(useCompactProgressUpdates(false), false);
  assert.equal(useCompactProgressUpdates(true), false);
  process.env.TELEGRAM_PROGRESS_DETAIL_MODE = 'compact';
  assert.equal(useCompactProgressUpdates(false), true);
  if (prev == null) delete process.env.TELEGRAM_PROGRESS_DETAIL_MODE;
  else process.env.TELEGRAM_PROGRESS_DETAIL_MODE = prev;
});

test('buildCompactExecutionUpdateText formats a compact preview summary', () => {
  const text = buildCompactExecutionUpdateText({ displayName: 'Builder', output: 'hello world', routeSignals: ['a', 'b'], final: true, provider: 'codex', model: 'gpt-5-codex' });
  assert.match(text, /최종 합성 완료/);
  assert.match(text, /Builder/);
  assert.match(text, /model: codex\/gpt-5-codex/);
  assert.match(text, /route_signals: a, b/);
  assert.match(text, /hello world/);
});

test('notifyAndConsumeGocFallback sends a sanitized user message and consumes the raw reason', async () => {
  const calls = [];
  const bot = { sendMessage: async (...args) => { calls.push(args); return { ok: true }; } };
  let stored = '403 forbidden token mismatch';
  const raw = await notifyAndConsumeGocFallback(bot, 123, {
    notify: true,
    takeFallbackReason: () => {
      const next = stored;
      stored = '';
      return next;
    },
  });
  assert.equal(raw, '403 forbidden token mismatch');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 123);
  assert.match(calls[0][1], /projection_access_denied/);
  assert.doesNotMatch(calls[0][1], /token mismatch/);
});


test('appendRuntimeModelFooter adds per-response provider and model metadata', async () => {
  const mod = await import('../src/application/telegram_status_notifications.js');
  const text = mod.appendRuntimeModelFooter('답변 본문', { provider: 'antigravity', model: 'auto', route: 'concierge_direct_answer' });
  assert.match(text, /답변 본문/);
  assert.match(text, /🤖 model: antigravity\/auto/);
  assert.match(text, /route=concierge_direct_answer/);
});
