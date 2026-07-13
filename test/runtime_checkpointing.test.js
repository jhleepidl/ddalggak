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


test('runtime checkpoint loader falls back when latest.json is corrupted', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-runtime-checkpoint-corrupt-'));
  const workspaceRoot = path.join(root, 'workspace');
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  const first = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-a',
    stage: 'approval_pause',
    trigger: 'pending_approval',
    userText: '첫 번째 체크포인트',
    reason: 'awaiting approval',
    results: [],
    outputs: [],
    remainingActions: [{ type: 'run_agent', agent_id: 'reviewer' }],
  });
  const second = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-b',
    stage: 'resume',
    trigger: 'resume_after_approval',
    userText: '두 번째 체크포인트',
    reason: 'resuming',
    results: [{ label: 'planner', status: 'ok' }],
    outputs: [],
    remainingActions: [],
  });
  const runtimeDir = path.join(sharedDir, 'runtime_checkpoints');
  fs.writeFileSync(path.join(runtimeDir, 'latest.json'), '{broken json', 'utf8');

  const restored = loadLatestRuntimeCheckpoint({ workspaceRoot });
  assert.ok(restored);
  assert.equal(restored?.payload?.job_id, second.payload.job_id);
  assert.equal(restored?.json_file, second.json_file);
  assert.match(String(restored?.summary || ''), /resume/i);
  assert.notEqual(restored?.json_file, first.json_file);
});

test('runtime checkpoint loader skips a damaged newest historical checkpoint', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-runtime-checkpoint-damaged-history-'));
  const workspaceRoot = path.join(root, 'workspace');
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });

  const first = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-valid',
    stage: 'approval_pause',
    trigger: 'pending_approval',
    userText: '정상 체크포인트',
    remainingActions: [],
  });
  const damaged = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-damaged',
    stage: 'resume',
    trigger: 'resume_after_approval',
    userText: '손상될 체크포인트',
    remainingActions: [],
  });
  fs.writeFileSync(damaged.json_file, '{damaged historical json', 'utf8');
  fs.writeFileSync(path.join(sharedDir, 'runtime_checkpoints', 'latest.json'), '{damaged latest json', 'utf8');

  const restored = loadLatestRuntimeCheckpoint({ workspaceRoot });
  assert.equal(restored?.payload?.job_id, 'job-valid');
  assert.equal(restored?.json_file, first.json_file);
});
