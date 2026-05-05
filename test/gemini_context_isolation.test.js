import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runGeminiPrompt } from '../src/gemini.js';

test('runGeminiPrompt uses an isolated cwd by default to avoid implicit project context', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-isolate-'));
  const workspace = path.join(tempDir, 'workspace');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'GEMINI.md'), 'SHOULD_NOT_BE_LOADED_BY_DEFAULT\n', 'utf8');
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/bin/sh
echo "PWD=$PWD"
echo "ORIGINAL=$DDALGGAK_ORIGINAL_WORKSPACE_PATH"
echo "MODE=$DDALGGAK_GEMINI_CONTEXT_MODE"
exit 0
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  const prevPath = process.env.PATH;
  const prevMode = process.env.GEMINI_CONTEXT_MODE;
  process.env.PATH = `${binDir}:${prevPath}`;
  delete process.env.GEMINI_CONTEXT_MODE;
  try {
    const result = await runGeminiPrompt({
      workspaceRoot: workspace,
      cwd: workspace,
      prompt: 'hello',
      model: 'auto',
      approvalMode: 'default',
      timeoutMs: 3000,
    });
    assert.equal(result.ok, true);
    assert.match(result.stdout, /MODE=isolated/);
    assert.match(result.stdout, new RegExp(`ORIGINAL=${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    const pwd = result.stdout.match(/^PWD=(.*)$/m)?.[1];
    assert.ok(pwd, 'fake Gemini should report cwd');
    assert.notEqual(path.resolve(pwd), path.resolve(workspace));
    assert.match(path.resolve(pwd), new RegExp(`${path.resolve(tempDir).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*local_memory.*gemini_cwd`));
    assert.ok(fs.existsSync(path.join(pwd, 'GEMINI.md')), 'isolated cwd should contain only a small generated GEMINI.md');
  } finally {
    process.env.PATH = prevPath;
    if (typeof prevMode === 'undefined') delete process.env.GEMINI_CONTEXT_MODE;
    else process.env.GEMINI_CONTEXT_MODE = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GEMINI_CONTEXT_MODE=workspace preserves old cwd behavior when needed', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-workspace-'));
  const workspace = path.join(tempDir, 'workspace');
  const binDir = path.join(tempDir, 'bin');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, 'gemini');
  fs.writeFileSync(scriptPath, `#!/bin/sh
echo "PWD=$PWD"
echo "MODE=$DDALGGAK_GEMINI_CONTEXT_MODE"
exit 0
`, 'utf8');
  fs.chmodSync(scriptPath, 0o755);

  const prevPath = process.env.PATH;
  const prevMode = process.env.GEMINI_CONTEXT_MODE;
  process.env.PATH = `${binDir}:${prevPath}`;
  process.env.GEMINI_CONTEXT_MODE = 'workspace';
  try {
    const result = await runGeminiPrompt({
      workspaceRoot: workspace,
      cwd: workspace,
      prompt: 'hello',
      model: 'auto',
      approvalMode: 'default',
      timeoutMs: 3000,
    });
    assert.equal(result.ok, true);
    assert.match(result.stdout, /MODE=workspace/);
    assert.match(result.stdout, new RegExp(`PWD=${workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  } finally {
    process.env.PATH = prevPath;
    if (typeof prevMode === 'undefined') delete process.env.GEMINI_CONTEXT_MODE;
    else process.env.GEMINI_CONTEXT_MODE = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
