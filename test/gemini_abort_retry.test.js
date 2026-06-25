import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiPrompt } from '../src/gemini.js';

test('runGeminiPrompt stops after abort without falling through to extra retry paths', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-abort-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const counterFile = path.join(tempDir, 'count.txt');
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/bin/sh
COUNT=0
if [ -f "${counterFile}" ]; then COUNT=$(cat "${counterFile}"); fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${counterFile}"
sleep 5
exit 1
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  const prevPath = process.env.PATH;
  const prevMinInterval = process.env.GEMINI_MIN_INTERVAL_MS;
  const prevAllowGeminiCli = process.env.DDALGGAK_ALLOW_GEMINI_CLI;
  process.env.PATH = `${binDir}:${prevPath}`;
  process.env.GEMINI_MIN_INTERVAL_MS = '0';
  process.env.DDALGGAK_ALLOW_GEMINI_CLI = '1';
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 150);
  try {
    const result = await runGeminiPrompt({
      workspaceRoot: tempDir,
      cwd: tempDir,
      prompt: 'abort me',
      signal: controller.signal,
      model: 'auto',
      approvalMode: 'default',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_type, 'aborted');
    const count = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8').trim()) : 0;
    assert.ok(count <= 1, `expected at most one Gemini subprocess, got ${count}`);
  } finally {
    process.env.PATH = prevPath;
    if (typeof prevMinInterval === 'undefined') delete process.env.GEMINI_MIN_INTERVAL_MS;
    else process.env.GEMINI_MIN_INTERVAL_MS = prevMinInterval;
    if (typeof prevAllowGeminiCli === 'undefined') delete process.env.DDALGGAK_ALLOW_GEMINI_CLI;
    else process.env.DDALGGAK_ALLOW_GEMINI_CLI = prevAllowGeminiCli;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
