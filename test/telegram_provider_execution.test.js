import test from 'node:test';
import assert from 'node:assert/strict';

import { runAgentProviderExecution } from '../src/application/telegram_provider_execution.js';

test('runAgentProviderExecution executes chatgpt provider through Codex bridge by default', async () => {
  const calls = [];
  let fallbackStored = 'connect ECONNRESET';
  const bot = { sendMessage: async (...args) => { calls.push(args); return { ok: true }; } };
  const appended = [];
  const codexCalls = [];

  const result = await runAgentProviderExecution({
    provider: 'chatgpt',
    agentId: 'planner',
    roleId: 'reviewer',
    model: 'gpt-5.5',
    bot,
    chatId: 55,
    jobId: 'job-1',
    prompts: { chatQuestion: 'hello there' },
    callbacks: {
      codexAssist: async (_jobId, prompt, _signal, opts) => {
        codexCalls.push({ prompt, opts });
        return 'codex bridge answer';
      },
      sendChatGPTPrompt: async () => { throw new Error('manual fallback should not be used'); },
      appendLocalLogs: (output, mode) => { appended.push({ output, mode }); },
      memoryModeWithFallback: () => 'local_fallback',
      takeGocFallbackReason: () => {
        const next = fallbackStored;
        fallbackStored = '';
        return next;
      },
    },
  });

  assert.equal(codexCalls[0].prompt, 'hello there');
  assert.equal(codexCalls[0].opts.providerOptions.sandboxMode, 'read-only');
  assert.equal(result.provider, 'codex');
  assert.equal(result.mode, 'local_fallback');
  assert.equal(result.output, 'codex bridge answer');
  assert.equal(appended.length, 1);
  assert.equal(calls.some((row) => /ChatGPT 역할을 Codex CLI bridge/.test(row[1])), true);
  assert.equal(calls.some((row) => /projection_network_error/.test(row[1])), true);
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

test('runAgentProviderExecution uses Codex assist for non-coding researcher roles', async () => {
  const calls = [];
  const result = await runAgentProviderExecution({
    provider: 'codex',
    agentId: 'research_lead',
    roleId: 'researcher',
    model: 'gpt-5.5',
    bot: null,
    chatId: 1,
    jobId: 'job-research-codex',
    prompts: {
      instruction: 'implementation-looking template should not force code mode',
      goal: '서울대입구역 주변 기준으로 배달 식당 추천',
      chatQuestion: '서울대입구역 주변 기준으로 배달 식당 추천',
      userRequest: '배달해서 먹을만한 곳은 없을까?',
    },
    callbacks: {
      codexAssist: async (_jobId, prompt, _signal, opts) => {
        calls.push({ mode: 'assist', prompt, opts });
        return 'assistant-style answer';
      },
      codexImplement: async () => {
        calls.push({ mode: 'implement' });
        return 'implementation answer';
      },
      memoryModeWithFallback: () => 'local',
      takeGocFallbackReason: () => '',
    },
  });

  assert.equal(result.output, 'assistant-style answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'assist');
  assert.equal(calls[0].opts.roleId, 'researcher');
  assert.equal(calls[0].opts.providerOptions.sandboxMode, 'read-only');
});

test('runAgentProviderExecution keeps Codex implement for coding builder roles', async () => {
  const calls = [];
  const result = await runAgentProviderExecution({
    provider: 'codex',
    agentId: 'builder',
    roleId: 'builder',
    model: 'codex',
    bot: null,
    chatId: 1,
    jobId: 'job-builder-codex',
    prompts: { instruction: 'patch the source file' },
    callbacks: {
      codexAssist: async () => {
        calls.push({ mode: 'assist' });
        return 'assist answer';
      },
      codexImplement: async (_jobId, instruction) => {
        calls.push({ mode: 'implement', instruction });
        return 'implementation answer';
      },
      memoryModeWithFallback: () => 'local',
      takeGocFallbackReason: () => '',
    },
  });

  assert.equal(result.output, 'implementation answer');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'implement');
});

test('runAgentProviderExecution reports trace-derived Codex assist model when available', async () => {
  const result = await runAgentProviderExecution({
    provider: 'codex',
    agentId: 'research_lead',
    roleId: 'researcher',
    model: 'configured-display-model',
    bot: null,
    chatId: 1,
    jobId: 'job-codex-model-reporting',
    prompts: { chatQuestion: '간단히 답해줘' },
    callbacks: {
      codexAssist: async () => ({
        output: 'model-aware answer',
        provider: 'codex',
        model: 'gpt-5.5-thinking',
        used_model: 'gpt-5.5-thinking',
      }),
      memoryModeWithFallback: () => 'local',
      takeGocFallbackReason: () => '',
    },
  });

  assert.equal(result.provider, 'codex');
  assert.equal(result.output, 'model-aware answer');
  assert.equal(result.model, 'gpt-5.5-thinking');
});
