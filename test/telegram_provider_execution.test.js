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

test('runAgentProviderExecution fails over Gemini capacity errors to Codex assist', async () => {
  const messages = [];
  const logs = [];
  const bot = { sendMessage: async (_chatId, text) => { messages.push(text); return { ok: true }; } };
  const result = await runAgentProviderExecution({
    provider: 'gemini',
    agentId: 'research_lead',
    roleId: 'researcher',
    model: 'gemini-3-flash-preview',
    bot,
    chatId: 77,
    jobId: 'job-failover',
    prompts: { goal: 'help with travel', instruction: 'help with travel', userRequest: 'help with travel' },
    callbacks: {
      geminiResearch: async () => {
        throw new Error('Gemini failed (exit=-1)\nNo capacity available for model gemini-3-flash-preview\nMODEL_CAPACITY_EXHAUSTED\n429');
      },
      codexAssist: async (_jobId, instruction, _signal, opts) => {
        assert.match(instruction, /help with travel/);
        assert.equal(opts.failoverDecision.to_provider, 'codex');
        return 'codex fallback answer';
      },
      appendLocalLogs: (output, mode) => { logs.push({ output, mode }); },
      memoryModeWithFallback: () => 'local',
      takeGocFallbackReason: () => '',
    },
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.output, 'codex fallback answer');
  assert.equal(result.failover.to_provider, 'codex');
  assert.equal(logs.some((row) => /provider_failover/.test(row.output)), true);
  assert.equal(messages.some((text) => /Codex|codex|fallback/.test(text)), true);
});
