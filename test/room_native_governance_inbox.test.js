import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRoomGovernanceDecision,
  buildRoomNativeInbox,
  findInboxItem,
  readRoomGovernance,
} from '../src/room_runtime/room_governance_inbox.js';

test('Room-native inbox combines approvals, blockers, and failed validations with stable actions', () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'room-native-inbox-'));
  try {
    const status = {
      room_id: 'room-1',
      focus_run_id: 'run-1',
      focus_status: 'awaiting_approval',
      open_blockers: ['Need a product decision'],
    };
    const receipts = [{
      run_id: 'run-1',
      receipt_hash: 'receipt-1',
      reported: { validations: [{ name: 'npm test', status: 'failed', evidence: '1 failing test' }] },
    }];
    const artifacts = [{ artifact_id: 'a1', relative_path: 'dist/report.pdf', approval_state: 'pending', receipt_hash: 'receipt-1' }];
    const initial = buildRoomNativeInbox({ status, receipts, artifacts, governance: readRoomGovernance(stateRoot) });
    assert.equal(initial.totals.approvals, 2);
    assert.equal(initial.totals.blockers, 1);
    assert.equal(initial.totals.failed_validations, 1);
    const blocker = initial.items.find((item) => item.kind === 'blocker');
    assert.equal(findInboxItem(initial, '2')?.kind, 'blocker');
    appendRoomGovernanceDecision(stateRoot, {
      item_id: blocker.item_id,
      item_kind: blocker.kind,
      action: 'resolve',
      note: 'Accepted by owner',
      source_run_id: 'run-1',
    });
    const after = buildRoomNativeInbox({ status, receipts, artifacts, governance: readRoomGovernance(stateRoot) });
    assert.equal(after.totals.blockers, 0);
    assert.equal(after.totals.failed_validations, 1, 'validation evidence remains until separately acknowledged or superseded');
  } finally {
    fs.rmSync(stateRoot, { recursive: true, force: true });
  }
});
