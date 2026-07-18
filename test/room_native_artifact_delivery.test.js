import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoomNativeArtifactIndex,
  previewRoomNativeArtifact,
  resolveRoomNativeArtifactSelection,
  roomArtifactDeliveryLimits,
} from '../src/room_runtime/room_native_artifacts.js';

function withWorkspace(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-native-artifacts-'));
  try {
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'reports', 'result.md'), '# Result\nPassed.\n', 'utf8');
    fs.writeFileSync(path.join(root, 'large.bin'), Buffer.alloc(2048, 1));
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Room-native artifact index enriches workspace files with receipt and contract evidence', () => withWorkspace((workspaceRoot) => {
  const artifacts = buildRoomNativeArtifactIndex({
    workspaceRoot,
    checkpointArtifacts: [{ path: 'reports/result.md', description: 'Result report' }],
    receipts: [{
      provider: 'codex',
      stage_id: 'execute',
      receipt_hash: 'abc123',
      reported: { artifacts: [{ location: 'reports/result.md', kind: 'report' }] },
      workspace: { files_changed: [{ path: 'reports/result.md', change: 'added' }] },
    }],
    contract: { contract_revision: 4, contract_hash: 'contract-hash', approval_policy: { require_for: [] } },
    env: { ROOM_ARTIFACT_MAX_SEND_BYTES: '1024' },
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].relative_path, 'reports/result.md');
  assert.equal(artifacts[0].provider, 'codex');
  assert.equal(artifacts[0].receipt_hash, 'abc123');
  assert.equal(artifacts[0].contract_revision, 4);
  assert.equal(artifacts[0].previewable, true);
  assert.equal(artifacts[0].sendable, true);
  assert.equal(resolveRoomNativeArtifactSelection(artifacts, '1').artifact_id, artifacts[0].artifact_id);
  const preview = previewRoomNativeArtifact(artifacts[0], { env: { ROOM_ARTIFACT_PREVIEW_MAX_BYTES: '4096' } });
  assert.match(preview.text, /Passed/);
  assert.equal(preview.truncated, false);
}));

test('Room-native artifact index blocks path traversal, symlinks, and oversize delivery', () => withWorkspace((workspaceRoot) => {
  fs.symlinkSync('/etc/passwd', path.join(workspaceRoot, 'reports', 'escape.txt'));
  const artifacts = buildRoomNativeArtifactIndex({
    workspaceRoot,
    checkpointArtifacts: [
      { path: '../secret.txt' },
      { path: 'reports/escape.txt' },
      { path: 'large.bin' },
    ],
    contract: { contract_revision: 1, approval_policy: { require_for: ['artifact_delivery'] } },
    env: { ROOM_ARTIFACT_MAX_SEND_BYTES: '1024' },
  });
  assert.equal(artifacts.some((row) => row.location === '../secret.txt'), false);
  const symlink = artifacts.find((row) => row.location === 'reports/escape.txt');
  assert.equal(symlink.available, false);
  assert.equal(symlink.sendable, false);
  const large = artifacts.find((row) => row.location === 'large.bin');
  assert.equal(large.available, true);
  assert.equal(large.sendable, false);
  assert.equal(large.approval_state, 'pending');
}));

test('Room-native artifact delivery limits are bounded and shared by preview/send flows', () => {
  assert.deepEqual(roomArtifactDeliveryLimits({
    ROOM_ARTIFACT_MAX_SEND_BYTES: '2048',
    ROOM_ARTIFACT_PREVIEW_MAX_BYTES: '4096',
  }), {
    max_send_bytes: 2048,
    max_preview_bytes: 4096,
  });
  assert.equal(roomArtifactDeliveryLimits({ ROOM_ARTIFACT_PREVIEW_MAX_BYTES: String(4 * 1024 * 1024) }).max_preview_bytes, 1024 * 1024);
});
