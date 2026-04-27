import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiPrompt } from '../src/gemini.js';

test('runGeminiPrompt does not retry inline after a CLI timeout', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-timeout-'));
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const counterFile = path.join(tempDir, 'count.txt');
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/bin/sh
COUNT=0
if [ -f "${counterFile}" ]; then COUNT=$(cat "${counterFile}"); fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "${counterFile}"
sleep 2
exit 1
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  const prevPath = process.env.PATH;
  const prevInline = process.env.GEMINI_INLINE_RETRY_ON_STDIN_FAILURE;
  process.env.PATH = `${binDir}:${prevPath}`;
  delete process.env.GEMINI_INLINE_RETRY_ON_STDIN_FAILURE;
  try {
    const result = await runGeminiPrompt({
      workspaceRoot: tempDir,
      cwd: tempDir,
      prompt: 'timeout me',
      model: 'auto',
      approvalMode: 'default',
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error_type, 'timeout');
    assert.equal(Number(fs.readFileSync(counterFile, 'utf8').trim()), 1);
    assert.equal(result.attempt_count, 1);
    assert.equal(result.transport, 'stdin');
    assert.ok(Number(result.wallDurationMs) >= 900);
    assert.ok(Number(result.wallDurationMs) < 3500);
  } finally {
    process.env.PATH = prevPath;
    if (typeof prevInline === 'undefined') delete process.env.GEMINI_INLINE_RETRY_ON_STDIN_FAILURE;
    else process.env.GEMINI_INLINE_RETRY_ON_STDIN_FAILURE = prevInline;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
