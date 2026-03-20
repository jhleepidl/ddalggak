import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeRuntimeCheckpointBundle, loadLatestRuntimeCheckpoint } from '../src/application/runtime_checkpointing.js';
import { writeCodexInstructionFile, writeGeminiMemoryFile } from '../src/application/cli_workspace_contract.js';

test('runtime checkpoint bundle can be restored into CLI support files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-runtime-checkpoint-'));
  const workspaceRoot = path.join(root, 'workspace');
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  const checkpoint = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-test',
    stage: 'approval_pause',
    trigger: 'pending_approval',
    userText: '계속 개선해줘',
    reason: 'awaiting approval',
    results: [{ label: 'coder', status: 'ok', note: 'draft complete' }],
    outputs: [{ agentId: 'coder', mode: 'codex', output: 'First draft complete.' }],
    remainingActions: [{ type: 'run_agent', agent_id: 'reviewer', prompt: 'Review it' }],
  });

  assert.equal(fs.existsSync(checkpoint.json_file), true);
  assert.equal(fs.existsSync(checkpoint.markdown_file), true);

  const restored = loadLatestRuntimeCheckpoint({ workspaceRoot });
  assert.equal(restored?.payload?.job_id, 'job-test');
  assert.match(String(restored?.summary || ''), /approval_pause/i);

  const codexInstructions = writeCodexInstructionFile({
    workspaceRoot,
    roleMemo: 'builder role',
    kbContract: 'use implementation_blueprint.md',
    instruction: 'continue work',
  });
  const geminiMemory = writeGeminiMemoryFile({
    workspaceRoot,
    roleMemo: 'review role',
    kbContract: 'use review_ruling.md',
    goal: 'review the draft',
  });

  const codexText = fs.readFileSync(codexInstructions, 'utf8');
  const geminiText = fs.readFileSync(geminiMemory, 'utf8');
  assert.match(codexText, /Runtime restore context/i);
  assert.match(geminiText, /Runtime restore context/i);
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.orchestrator', 'runtime_restore.md')), true);
  assert.equal(fs.existsSync(path.join(workspaceRoot, '.orchestrator', 'runtime_restore.json')), true);
});
