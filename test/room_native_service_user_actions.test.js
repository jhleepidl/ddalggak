import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomNativeService } from '../src/room_runtime/room_native_service.js';
import { createRoomRun, updateRoomRunState, writeWorkingMemory } from '../src/room_runtime/room_run_store.js';
import { writeJsonAtomic } from '../src/room_runtime/fs_utils.js';

function makeEnv(root) {
  const runtime = path.join(root, 'runtime');
  const control = path.join(root, 'control');
  fs.mkdirSync(control, { recursive: true });
  return {
    ROOM_EXECUTION_ENGINE: 'room_native_v2',
    ROOM_RUNTIME_ROOT: runtime,
    ROOM_WORKSPACES_ROOT: path.join(runtime, 'workspaces'),
    ROOM_STATE_ROOT: path.join(runtime, 'state'),
    DDALGGAK_CONTROL_ROOT: control,
    ROOM_ARTIFACT_MAX_SEND_BYTES: String(1024 * 1024),
  };
}

test('RoomNativeService keeps artifact approval, blocker resolution, and corrections in Room-owned state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-native-service-actions-'));
  try {
    const env = makeEnv(root);
    const service = new RoomNativeService({ env, engine: { agentRuntime: { inspectCapabilities: () => ({}) } } });
    const room = service.initializeRoom('room-1');
    fs.mkdirSync(path.join(room.workspaceRoot, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(room.workspaceRoot, 'dist', 'report.md'), '# Report\n', 'utf8');
    const contract = {
      schema_version: 'ai_rooms.room_contract/v1',
      room_id: room.roomId,
      goal: 'Ship report',
      objective: 'Build report',
      completion_contract: [],
      constraints: [],
      sources: { authoritative: [], excluded: [] },
      corrections: [],
      requested_artifacts: [{ location: 'dist/report.md', kind: 'report' }],
      approval_policy: { mode: 'bounded', require_for: ['artifact_delivery'] },
      provider_policy: {},
      continuity: { next_action: '', branches: [], pending_review_count: 0 },
      contract_revision: 1,
    };
    writeJsonAtomic(room.manifestPath, { ...room.manifest, room_contract: contract });
    const run = createRoomRun({ roomStateRoot: room.roomStateRoot, spec: {
      schema_version: 'ai_rooms.room_run/v3', run_id: 'run-1', room_id: room.roomId,
      objective: 'Build report', workspace_root: room.workspaceRoot, room_contract: contract,
      execution_graph: { collaboration_profile_id: 'solo', stages: [{ stage_id: 'execute', order: 1 }] },
    } });
    updateRoomRunState(run.paths, { status: 'completed_with_blockers', completed_stage_ids: ['execute'], completed_at: new Date().toISOString() });
    writeWorkingMemory(run.paths, { objective: 'Build report', open_blockers: ['Owner decision needed'], artifacts: [{ path: 'dist/report.md' }], next_actions: [], receipt_index: [{ stage_id: 'execute' }] });
    writeJsonAtomic(path.join(run.paths.receiptsRoot, '01-execute.json'), {
      run_id: 'run-1', room_id: room.roomId, stage_id: 'execute', provider: 'codex', receipt_hash: 'receipt-hash',
      workspace: { files_changed: [{ path: 'dist/report.md', change: 'added' }] },
      reported: { artifacts: [{ location: 'dist/report.md', kind: 'report' }], validations: [{ name: 'npm test', status: 'failed', evidence: 'one failure' }], blocking_issues: ['Owner decision needed'] },
    });
    writeJsonAtomic(run.paths.checkpointPath, { artifacts: [{ path: 'dist/report.md' }], receipt_index: [{ stage_id: 'execute' }], open_blockers: ['Owner decision needed'] });

    const artifactResult = service.artifacts(room.roomId);
    assert.equal(artifactResult.artifacts[0].approval_state, 'pending');
    const inbox = service.inbox(room.roomId);
    assert.equal(inbox.totals.approvals, 1);
    assert.equal(inbox.totals.blockers, 1);
    assert.equal(inbox.totals.failed_validations, 1);

    const artifactItem = inbox.items.find((item) => item.kind === 'artifact');
    service.decideInboxItem(room.roomId, { itemId: artifactItem.item_id, action: 'approve', actor: 'owner' });
    assert.equal(service.artifacts(room.roomId).artifacts[0].approval_state, 'approved');

    const blockerItem = service.inbox(room.roomId).items.find((item) => item.kind === 'blocker');
    assert.throws(
      () => service.decideInboxItem(room.roomId, { itemId: blockerItem.item_id, action: 'resolve', actor: 'owner' }),
      (error) => error?.code === 'ROOM_INBOX_BLOCKER_NOTE_REQUIRED',
    );
    service.decideInboxItem(room.roomId, { itemId: blockerItem.item_id, action: 'resolve', note: 'Accepted by owner', actor: 'owner' });
    assert.equal(service.status(room.roomId).open_blockers.length, 0);

    const correction = service.recordCorrection(room.roomId, { text: 'Keep compatibility mode', actor: 'owner' });
    assert.equal(correction.contract.contract_revision, 2);
    assert.equal(service.contract(room.roomId).corrections.at(-1).text, 'Keep compatibility mode');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
