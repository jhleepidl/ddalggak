import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiPrompt, resolveGeminiModelCandidates } from '../src/gemini.js';

function withEnv(patch, fn) {
  const previous = {};
  for (const key of Object.keys(patch)) {
    previous[key] = process.env[key];
    if (typeof patch[key] === 'undefined') delete process.env[key];
    else process.env[key] = patch[key];
  }
  const restore = () => {
    for (const key of Object.keys(patch)) {
      if (typeof previous[key] === 'undefined') delete process.env[key];
      else process.env[key] = previous[key];
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') return result.finally(restore);
    restore();
    return result;
  } catch (err) {
    restore();
    throw err;
  }
}

test('Gemini sticky success is enabled by default and has no default TTL', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-sticky-'));
  const binDir = path.join(tempDir, 'bin');
  const runsDir = path.join(tempDir, 'runs');
  const workspaceDir = path.join(runsDir, 'job-sticky', 'workspace');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const callsFile = path.join(tempDir, 'calls.jsonl');
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : (process.env.GEMINI_MODEL || 'auto');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ model, cwd: process.cwd() }) + '\\n');
if (model === 'gemini-2.5-flash') {
  console.error('No capacity available for model gemini-2.5-flash');
  console.error('RESOURCE_EXHAUSTED MODEL_CAPACITY_EXHAUSTED status 429');
  process.exit(1);
}
console.log('OK via ' + model);
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  await withEnv({
    PATH: `${binDir}:${process.env.PATH || ''}`,
    RUNS_DIR: runsDir,
    GEMINI_MODEL: 'auto',
    GEMINI_MODEL_PRIMARY: undefined,
    GEMINI_MODEL_AUTO_MODE: 'pool',
    GEMINI_MODEL_POOL: 'gemini-2.5-flash,gemini-2.5-pro,auto',
    GEMINI_MODEL_FALLBACKS: 'auto',
    GEMINI_MODEL_STICKY_SUCCESS: undefined,
    GEMINI_MODEL_STICKY_SUCCESS_SCOPE: undefined,
    GEMINI_MODEL_STICKY_SUCCESS_TTL_MS: undefined,
    GEMINI_MIN_INTERVAL_MS: '0',
    GEMINI_CAPACITY_SWITCH_AFTER: '1',
    GEMINI_MAX_RETRIES: '2',
    GEMINI_CONTEXT_MODE: 'isolated',
    GEMINI_CONTEXT_REUSE: 'stable',
    DDALGGAK_ALLOW_GEMINI_CLI: '1',
  }, async () => {
    const first = await runGeminiPrompt({
      workspaceRoot: workspaceDir,
      cwd: workspaceDir,
      prompt: 'hello',
      jobId: 'job-sticky',
      surface: 'agent_answer',
      workspaceSettingsPatch: { surface: 'agent_answer' },
      timeoutMs: 5000,
    });
    assert.equal(first.ok, true);
    assert.equal(first.used_model, 'gemini-2.5-pro');

    const statePath = path.join(runsDir, 'provider_state', 'gemini_model_success.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(state.buckets['surface:agent_answer'].model, 'gemini-2.5-pro');

    const reordered = resolveGeminiModelCandidates('', {
      surface: 'agent_answer',
      originalCwd: workspaceDir,
      jobId: 'job-sticky',
    });
    assert.deepEqual(reordered, ['gemini-2.5-pro', 'gemini-2.5-flash', 'auto']);

    fs.writeFileSync(callsFile, '', 'utf8');
    const second = await runGeminiPrompt({
      workspaceRoot: workspaceDir,
      cwd: workspaceDir,
      prompt: 'hello again',
      jobId: 'job-sticky',
      surface: 'agent_answer',
      workspaceSettingsPatch: { surface: 'agent_answer' },
      timeoutMs: 5000,
    });
    assert.equal(second.ok, true);
    assert.equal(second.used_model, 'gemini-2.5-pro');
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((row) => row.model), ['gemini-2.5-pro']);
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
});
