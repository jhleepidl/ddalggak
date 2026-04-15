import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentProviderExecution } from '../src/application/telegram_provider_execution.js';

test('runAgentProviderExecution executes chatgpt provider path and appends local logs', async () => {
  const calls = [];
  let fallbackStored = 'connect ECONNRESET';
  const bot = { sendMessage: async (...args) => { calls.push(args); return { ok: true }; } };
  const sent = [];
  const appended = [];

  const result = await runAgentProviderExecution({
    provider: 'chatgpt',
    agentId: 'planner',
    model: 'chatgpt',
    bot,
    chatId: 55,
    jobId: 'job-1',
    prompts: { chatQuestion: 'hello there' },
    callbacks: {
      sendChatGPTPrompt: async (_bot, _chatId, _jobId, prompt) => { sent.push(prompt); },
      appendLocalLogs: (output, mode) => { appended.push({ output, mode }); },
      memoryModeWithFallback: () => 'local_fallback',
      takeGocFallbackReason: () => {
        const next = fallbackStored;
        fallbackStored = '';
        return next;
      },
    },
  });

  assert.equal(sent[0], 'hello there');
  assert.equal(result.provider, 'chatgpt');
  assert.equal(result.mode, 'local_fallback');
  assert.match(result.output, /ChatGPT prompt generated/);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].mode, 'local_fallback');
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /projection_network_error/);
});
