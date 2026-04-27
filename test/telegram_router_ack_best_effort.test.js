import test from 'node:test';
import assert from 'node:assert/strict';

import { sendRouterAckMessage } from '../src/application/telegram_route_planning.js';

test('sendRouterAckMessage is best-effort and does not abort chat on Telegram transport failure', async () => {
  const error = new Error('EFATAL: Error: connect ETIMEDOUT 149.154.166.110:443');
  error.code = 'EFATAL';
  const bot = {
    sendMessage: async () => { throw error; },
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await sendRouterAckMessage(bot, 123, { replyToMessageId: 456 });
    assert.equal(result, null);
  } finally {
    console.warn = originalWarn;
  }
});
