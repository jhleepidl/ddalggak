import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTelegramMethodRetrier,
  extractTelegramRetryAfter,
  installTelegramRateLimitRetry,
  isTelegramRateLimitError,
  isTelegramNetworkError,
} from '../src/adapters/telegram/rate_limit.js';


function telegramTimeout() {
  const error = new Error('EFATAL: Error: connect ETIMEDOUT 149.154.166.110:443');
  error.code = 'EFATAL';
  return error;
}

function telegram429(retryAfter = 0.001) {
  const error = new Error(`ETELEGRAM: 429 Too Many Requests: retry after ${retryAfter}`);
  error.code = 'ETELEGRAM';
  error.response = {
    statusCode: 429,
    body: {
      error_code: 429,
      description: `Too Many Requests: retry after ${retryAfter}`,
      parameters: { retry_after: retryAfter },
    },
  };
  return error;
}

test('extractTelegramRetryAfter handles structured and text retry_after values', () => {
  assert.equal(extractTelegramRetryAfter(telegram429(0.25)), 0.25);
  assert.equal(extractTelegramRetryAfter(new Error('Too Many Requests: retry after 41')), 41);
});

test('createTelegramMethodRetrier retries 429 and stops after maxRetries', async () => {
  let attempts = 0;
  const call = async () => {
    attempts += 1;
    if (attempts === 1) throw telegram429(0.001);
    return 'ok';
  };

  const retrying = createTelegramMethodRetrier({
    methodName: 'sendMessage',
    call,
    maxRetries: 1,
    retryBufferMs: 0,
    logger: () => {},
  });
  assert.equal(await retrying('chat', 'hello'), 'ok');
  assert.equal(attempts, 2);

  const alwaysLimited = createTelegramMethodRetrier({
    methodName: 'sendMessage',
    call: async () => { throw telegram429(0.001); },
    maxRetries: 1,
    retryBufferMs: 0,
    logger: () => {},
  });
  await assert.rejects(() => alwaysLimited(), isTelegramRateLimitError);
});

test('installTelegramRateLimitRetry keeps callback acknowledgements off the send queue', async () => {
  const events = [];
  let sendAttempts = 0;
  const bot = {
    async sendMessage() {
      sendAttempts += 1;
      events.push(`send:${sendAttempts}`);
      if (sendAttempts === 1) throw telegram429(0.05);
      events.push('send:resolved');
      return 'sent';
    },
    async answerCallbackQuery() {
      events.push('answer');
      return 'answered';
    },
  };

  installTelegramRateLimitRetry(bot, {
    methodGapMs: 0,
    fastMethodGapMs: 0,
    retryBufferMs: 0,
    maxRetries: 1,
    logger: () => {},
  });

  const sendPromise = bot.sendMessage('chat', 'long message');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['send:1']);

  assert.equal(await bot.answerCallbackQuery('callback-id'), 'answered');
  assert.deepEqual(events, ['send:1', 'answer']);

  assert.equal(await sendPromise, 'sent');
  assert.deepEqual(events, ['send:1', 'answer', 'send:2', 'send:resolved']);
});


test('createTelegramMethodRetrier retries transient Telegram network errors', async () => {
  let attempts = 0;
  const retrying = createTelegramMethodRetrier({
    methodName: 'sendMessage',
    call: async () => {
      attempts += 1;
      if (attempts === 1) throw telegramTimeout();
      return 'ok';
    },
    maxRetries: 1,
    networkRetryBaseMs: 0,
    networkRetryMaxMs: 0,
    logger: () => {},
  });

  assert.equal(isTelegramNetworkError(telegramTimeout()), true);
  assert.equal(await retrying(), 'ok');
  assert.equal(attempts, 2);
});
