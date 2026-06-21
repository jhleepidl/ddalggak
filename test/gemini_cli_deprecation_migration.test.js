import test from 'node:test';
import assert from 'node:assert/strict';

import { geminiCliDisabledByDefault, migrateProviderAwayFromGemini, normalizeRuntimeProvider, sanitizeGeminiModelForProvider } from '../src/provider_migration.js';
import { runGeminiPrompt } from '../src/gemini.js';
import { buildRoomFirstRuntimeSelection } from '../src/application/ai_room_runtime_selection.js';

function withEnv(patch, fn) {
  const previous = new Map();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    if (patch[key] === undefined) delete process.env[key];
    else process.env[key] = String(patch[key]);
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('Gemini CLI is disabled by default and provider names migrate away from gemini', async () => {
  await withEnv({ DDALGGAK_ALLOW_GEMINI_CLI: undefined, DDALGGAK_GEMINI_REPLACEMENT_PROVIDER: undefined }, async () => {
    assert.equal(geminiCliDisabledByDefault(), true);
    assert.equal(normalizeRuntimeProvider('gemini', 'codex'), 'codex');
    assert.deepEqual(migrateProviderAwayFromGemini('gemini', { fallback: 'codex' }).provider, 'codex');
    assert.equal(sanitizeGeminiModelForProvider('gemini-3-flash-preview', 'codex'), '');
  });
});

test('runGeminiPrompt does not invoke Gemini CLI when replacement is disabled', async () => {
  await withEnv({ DDALGGAK_ALLOW_GEMINI_CLI: undefined, DDALGGAK_GEMINI_REPLACEMENT_PROVIDER: 'disabled' }, async () => {
    const result = await runGeminiPrompt({ prompt: 'hello', workspaceRoot: process.cwd(), cwd: process.cwd(), jobId: '' });
    assert.equal(result.ok, false);
    assert.match(String(result.stderr || ''), /Gemini CLI is disabled/);
    assert.equal(/IneligibleTierError|gemini-cli\/bundle/.test(String(result.stderr || '')), false);
  });
});

test('room-first ask selection never defaults to Gemini provider', async () => {
  await withEnv({ ROOM_ASK_PROVIDER: 'gemini', DDALGGAK_ALLOW_GEMINI_CLI: undefined }, async () => {
    const selection = buildRoomFirstRuntimeSelection({ taskText: '내일 점심 메뉴 추천해줘', workMode: 'ask', chatId: 'c1' });
    assert.equal(selection.work_mode, 'ask');
    assert.notEqual(selection.agents[0].provider, 'gemini');
    assert.equal(selection.agents[0].provider, 'codex');
  });
});
