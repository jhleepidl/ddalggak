import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiPrompt } from '../src/gemini.js';

test('Gemini capacity on one concrete model switches to the next model candidate', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-switch-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const callsFile = path.join(tempDir, 'calls.jsonl');
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const modelIdx = args.indexOf('--model');
const model = modelIdx >= 0 ? args[modelIdx + 1] : (process.env.GEMINI_MODEL || 'auto');
fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ model, cwd: process.cwd() }) + '\\n');
if (model === 'gemini-3-flash-preview') {
  console.error('No capacity available for model gemini-3-flash-preview');
  console.error('RESOURCE_EXHAUSTED MODEL_CAPACITY_EXHAUSTED status 429');
  process.exit(1);
}
console.log('OK via ' + model);
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  const prev = {
    PATH: process.env.PATH,
    GEMINI_MIN_INTERVAL_MS: process.env.GEMINI_MIN_INTERVAL_MS,
    GEMINI_MODEL_FALLBACKS: process.env.GEMINI_MODEL_FALLBACKS,
    GEMINI_CAPACITY_SWITCH_AFTER: process.env.GEMINI_CAPACITY_SWITCH_AFTER,
    GEMINI_MAX_RETRIES: process.env.GEMINI_MAX_RETRIES,
    GEMINI_CONTEXT_MODE: process.env.GEMINI_CONTEXT_MODE,
  };
  process.env.PATH = `${binDir}:${prev.PATH}`;
  process.env.GEMINI_MIN_INTERVAL_MS = '0';
  process.env.GEMINI_MODEL_FALLBACKS = 'gemini-2.5-flash,auto';
  process.env.GEMINI_CAPACITY_SWITCH_AFTER = '1';
  process.env.GEMINI_MAX_RETRIES = '2';
  process.env.GEMINI_CONTEXT_MODE = 'isolated';
  try {
    const result = await runGeminiPrompt({
      workspaceRoot: tempDir,
      cwd: tempDir,
      prompt: 'hello',
      model: 'gemini-3-flash-preview',
      approvalMode: 'default',
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.used_model, 'gemini-2.5-flash');
    assert.match(result.stdout, /OK via gemini-2\.5-flash/);
    const calls = fs.readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((row) => row.model), ['gemini-3-flash-preview', 'gemini-2.5-flash']);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (typeof value === 'undefined') delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
