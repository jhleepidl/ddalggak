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
  process.env.PATH = `${binDir}:${prevPath}`;
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
    const launches = fs.existsSync(counterFile) ? Number(fs.readFileSync(counterFile, 'utf8').trim()) : 0;
    assert.ok(launches <= 1);
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
