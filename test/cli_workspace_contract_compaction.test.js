import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeGeminiMemoryFile, writeCodexInstructionFile } from '../src/application/cli_workspace_contract.js';

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-cli-contract-'));
}

test('writeGeminiMemoryFile compacts oversized sections', () => {
  const dir = tempDir();
  const longText = 'A'.repeat(6000);
  const file = writeGeminiMemoryFile({
    workspaceRoot: dir,
    goal: longText,
    roleMemo: longText,
    kbContract: longText,
  });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /truncated goal/);
  assert.match(content, /truncated role memory/);
  assert.match(content, /truncated knowledge base contract/);
  assert.ok(content.length < 12000);
});

test('writeCodexInstructionFile compacts oversized current task', () => {
  const dir = tempDir();
  const longText = 'B'.repeat(8000);
  const file = writeCodexInstructionFile({
    workspaceRoot: dir,
    goal: longText,
    roleMemo: longText,
    kbContract: longText,
    instruction: longText,
  });
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /truncated current task/);
  assert.match(content, /truncated goal/);
  assert.match(content, /truncated role memory/);
  assert.match(content, /truncated knowledge base contract/);
  assert.ok(content.length < 15000);
});
