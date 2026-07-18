import test from 'node:test';
import assert from 'node:assert/strict';
import { buildExecutionReceipt } from '../src/room_runtime/room_execution_receipt.js';

test('Execution Receipt records workspace changes, validations, artifacts, blockers, and contract identity', () => {
  const receipt = buildExecutionReceipt({
    spec: { run_id: 'run-1', room_id: 'room-1', workspace_root: '/workspace', room_contract: { schema_version: 'ai_rooms.room_contract/v1', contract_revision: 3, contract_hash: 'abc' } },
    stage: { stage_id: 'execute', kind: 'execute', role: 'builder', provider: 'codex', access: 'workspace_write', required_capabilities: ['workspace_write'] },
    parsed: {
      contract_observed: true,
      structured: {
        summary: 'implemented',
        decisions: ['kept native provider planning'],
        validations: [{ name: 'npm test', status: 'passed', evidence: '42 tests' }],
        artifacts: [{ path: 'dist/report.json', kind: 'report' }],
        claims: [{ claim: 'tests pass', evidence: ['npm test'] }],
        blocking_issues: [],
        resolved_issues: [],
        next_actions: ['deliver'],
        checkpoint: { hint: 'done' },
      },
    },
    execution: {
      canonical_workspace_root: '/workspace',
      execution_root: '/workspace',
      snapshot: false,
      result: { ok: true, exitCode: 0, durationMs: 50, outputEventCount: 2 },
      workspace_evidence: {
        canonical_before: [{ path: 'a.js', size: 1, sha256: '1' }],
        canonical_after: [{ path: 'a.js', size: 2, sha256: '2' }, { path: 'b.js', size: 1, sha256: '3' }],
      },
    },
    projectedEvents: [{ kind: 'validation', message: 'Running npm test', stream: 'stdout', sequence: 1 }],
  });
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.input_contract.revision, 3);
  assert.deepEqual(receipt.workspace.files_changed.map((row) => [row.path, row.change]), [['a.js', 'modified'], ['b.js', 'added']]);
  assert.equal(receipt.reported.validations[0].status, 'passed');
  assert.equal(receipt.reported.artifacts[0].location, 'dist/report.json');
  assert.equal(receipt.reported.claims[0].evidence[0], 'npm test');
  assert.match(receipt.receipt_hash, /^[a-f0-9]{64}$/);
});
