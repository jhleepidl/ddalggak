import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCodexExec } from '../src/codex.js';
import { runAntigravityPrompt } from '../src/antigravity.js';

test('Room-scoped Codex rejects control-plane workspace before invoking CLI', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-provider-boundary-'));
  const old = process.env.DDALGGAK_CONTROL_ROOT;
  const oldCommand = process.env.CODEX_CLI_COMMAND;
  try {
    process.env.DDALGGAK_CONTROL_ROOT = root;
    process.env.CODEX_CLI_COMMAND = '/definitely/not/invoked';
    const result = await runCodexExec({
      workspaceRoot: root,
      cwd: root,
      prompt: 'test',
      addDirs: [],
      traceMetadata: { room_id: 'room-a', room_run_id: 'run-a' },
    });
    assert.equal(result.ok, false);
    assert.match(result.stderr, /inside the ddalggak control plane/);
  } finally {
    if (old === undefined) delete process.env.DDALGGAK_CONTROL_ROOT; else process.env.DDALGGAK_CONTROL_ROOT = old;
    if (oldCommand === undefined) delete process.env.CODEX_CLI_COMMAND; else process.env.CODEX_CLI_COMMAND = oldCommand;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Room-scoped Antigravity requires explicit workspace', async () => {
  await assert.rejects(() => runAntigravityPrompt({
    prompt: 'test',
    traceMetadata: { room_id: 'room-a', room_run_id: 'run-a' },
  }), /requires an explicit workspaceRoot/);
});
