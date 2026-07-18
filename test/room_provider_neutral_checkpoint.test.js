import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildProviderNeutralCheckpoint, validateResumeCheckpoint, writeProviderNeutralCheckpoint } from '../src/room_runtime/room_checkpoint.js';

test('provider-neutral checkpoint preserves receipt index and does not require provider sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-checkpoint-'));
  try {
    const checkpointPath = path.join(root, 'checkpoint.json');
    const checkpointsRoot = path.join(root, 'checkpoints');
    fs.mkdirSync(checkpointsRoot);
    const spec = {
      run_id: 'run-1', room_id: 'room-1',
      room_contract: { schema_version: 'ai_rooms.room_contract/v1', contract_revision: 1, contract_hash: 'contract-hash' },
      execution_graph: { collaboration_profile_id: 'solo', stages: [{ stage_id: 'execute' }] },
    };
    const run = { paths: { runId: 'run-1', checkpointPath, checkpointsRoot }, state: { status: 'running', completed_stage_ids: ['execute'], skipped_stage_ids: [], current_stage_id: null } };
    const receipt = { receipt_id: 'run-1:execute', stage_id: 'execute', provider: 'codex', status: 'completed', receipt_hash: 'receipt-hash', workspace: { revision_after: 'workspace-hash' }, reported: { artifacts: [{ location: 'artifact.txt' }] } };
    const checkpoint = buildProviderNeutralCheckpoint({ run, spec, workingMemory: { decisions: ['d'], open_blockers: [], next_actions: ['ship'], artifacts: [], receipt_index: [] }, receipt, workspaceRevision: 'workspace-hash' });
    writeProviderNeutralCheckpoint(run.paths, checkpoint, { stage_id: 'execute', order: 1 });
    assert.equal(checkpoint.provider_sessions_required, false);
    assert.equal(checkpoint.resume_contract.provider_may_change, true);
    assert.equal(checkpoint.receipt_index.length, 1);
    assert.equal(checkpoint.receipt_index[0].receipt_id, 'run-1:execute');
    assert.equal(checkpoint.next_stage_id, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resume checkpoint fails closed on workspace drift unless explicitly allowed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-checkpoint-drift-'));
  try {
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'a.txt'), 'before');
    const checkpointPath = path.join(root, 'checkpoint.json');
    fs.writeFileSync(checkpointPath, JSON.stringify({ room_contract: { hash: 'same' }, workspace_revision: 'not-current' }));
    const args = { paths: { checkpointPath }, spec: { room_contract: { contract_hash: 'same' } }, workspaceRoot: workspace, env: {} };
    assert.throws(() => validateResumeCheckpoint(args), { code: 'ROOM_WORKSPACE_REVISION_DRIFT' });
    const allowed = validateResumeCheckpoint({ ...args, env: { ROOM_RESUME_ALLOW_WORKSPACE_DRIFT: 'true' } });
    assert.equal(allowed.drift, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
