import test from 'node:test';
import assert from 'node:assert/strict';

import { setAwait, getAwait, clearAwait } from '../src/application/telegram_runtime_state.js';

test('awaiting state expires and is cleared when stale', () => {
  const originalNow = Date.now;
  let now = 1_700_000_000_000;
  Date.now = () => now;
  try {
    setAwait('chat-expire', 'job-1', 'user-1');
    assert.equal(getAwait('chat-expire')?.jobId, 'job-1');
    now += 21 * 60 * 1000;
    assert.equal(getAwait('chat-expire'), null);
  } finally {
    Date.now = originalNow;
    clearAwait('chat-expire');
  }
});
