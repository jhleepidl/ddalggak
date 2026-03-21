import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ChatSessionStore } from '../src/chat/session.js';
import { writeRuntimeCheckpointBundle, summarizeRuntimeCheckpointRef } from '../src/application/runtime_checkpointing.js';

test('pending approval runtime checkpoint is compacted before session save', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-approval-checkpoint-'));
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  const store = new ChatSessionStore({ baseDir: root });

  const pendingApproval = {
    id: 'appr_123',
    chat_id: 'chat-1',
    job_id: 'job-1',
    reason: 'risk=L3',
    remaining_actions: [{ type: 'run_agent', agent_id: 'builder' }],
  };

  const checkpoint = writeRuntimeCheckpointBundle({
    sharedDir,
    jobId: 'job-1',
    stage: 'approval_pause',
    trigger: 'pending_approval',
    userText: 'build notebook',
    reason: 'risk=L3',
    pendingApproval,
    remainingActions: pendingApproval.remaining_actions,
  });

  pendingApproval.runtime_checkpoint = checkpoint;

  assert.doesNotThrow(() => {
    store.upsert('chat-1', {
      state: 'awaiting_approval',
      pending_approval: pendingApproval,
    });
  });

  const saved = JSON.parse(fs.readFileSync(path.join(root, 'chat_sessions.json'), 'utf8'));
  const runtimeCheckpoint = saved.sessions['chat-1'].pending_approval.runtime_checkpoint;
  assert.deepEqual(runtimeCheckpoint, summarizeRuntimeCheckpointRef(checkpoint));
  assert.equal(Object.prototype.hasOwnProperty.call(runtimeCheckpoint, 'payload'), false);
});
