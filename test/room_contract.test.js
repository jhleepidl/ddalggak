import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoomContract, normalizeRoomContract } from '../src/room_runtime/room_contract.js';

test('Room Contract materializes continuity, source boundaries, corrections, and stable provider policy', () => {
  const contract = buildRoomContract({
    roomId: 'telegram-42',
    objective: 'Implement the requested feature',
    roomContext: {
      goal: 'Ship a reliable feature',
      rules: ['Do not touch production secrets'],
      corrections: ['The legacy API must not be used'],
      source_policy: { included_sources: ['docs/v2'], excluded_sources: ['docs/v1'] },
      next_action: 'Continue implementation',
    },
    requestedArtifacts: [{ path: 'patch.diff', kind: 'patch' }],
    providerPolicy: { execution_provider: 'codex', review_provider: 'antigravity' },
  });
  assert.equal(contract.schema_version, 'ai_rooms.room_contract/v1');
  assert.equal(contract.goal, 'Ship a reliable feature');
  assert.deepEqual(contract.constraints, ['Do not touch production secrets']);
  assert.equal(contract.corrections[0].text, 'The legacy API must not be used');
  assert.equal(contract.sources.authoritative[0].label, 'docs/v2');
  assert.equal(contract.sources.excluded[0].label, 'docs/v1');
  assert.equal(contract.requested_artifacts[0].location, 'patch.diff');
  assert.equal(contract.provider_policy.execution_provider, 'codex');
  assert.match(contract.contract_hash, /^[a-f0-9]{64}$/);
});

test('Room Contract revision increases only when governed content changes', () => {
  const first = buildRoomContract({ roomId: 'room', objective: 'first' });
  const same = buildRoomContract({ roomId: 'room', objective: 'first', previousContract: first });
  assert.equal(same.contract_revision, first.contract_revision);
  assert.equal(same.contract_hash, first.contract_hash);
  const changed = buildRoomContract({ roomId: 'room', objective: 'second', previousContract: first });
  assert.equal(changed.contract_revision, first.contract_revision + 1);
  assert.notEqual(changed.contract_hash, first.contract_hash);
  assert.deepEqual(normalizeRoomContract(changed).completion_contract, changed.completion_contract);
});
