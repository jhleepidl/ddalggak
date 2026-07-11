import test from 'node:test';
import assert from 'node:assert/strict';

import { RuntimeCommandProcessor } from '../src/runtime_capabilities/runtime_command_processor.js';

test('runtime command processor acknowledges accepted and applied states', async () => {
  const acks = [];
  const client = {
    async listPendingRuntimeCommands() {
      return { items: [{ command_id: 'cmd_1', command_type: 'apply_context_policy', aggregate_type: 'room', aggregate_id: 'room_1', expected_revision: 2, payload: { policy: 'strict' } }] };
    },
    async acknowledgeRuntimeCommand(commandId, body) { acks.push({ commandId, ...body }); return {}; },
  };
  const processor = new RuntimeCommandProcessor({
    client,
    workerId: 'worker_1',
    resolveAggregateRevision: async () => 2,
    handlers: {
      apply_context_policy: async ({ payload }) => ({ applied: true, policy: payload.policy, aggregate_revision: 3 }),
    },
  });
  const result = await processor.pollOnce();
  assert.equal(result.processed, 1);
  assert.equal(result.results[0].status, 'applied');
  assert.deepEqual(acks.map((row) => row.status), ['accepted', 'applied']);
});

test('runtime command processor rejects stale commands before handler execution', async () => {
  const acks = [];
  let called = false;
  const processor = new RuntimeCommandProcessor({
    client: { async acknowledgeRuntimeCommand(commandId, body) { acks.push({ commandId, ...body }); } },
    resolveAggregateRevision: async () => 7,
    handlers: { install_room_package: async () => { called = true; } },
  });
  const result = await processor.process({ command_id: 'cmd_stale', command_type: 'install_room_package', aggregate_id: 'room_1', expected_revision: 6 });
  assert.equal(result.reason, 'revision_conflict');
  assert.equal(called, false);
  assert.equal(acks[0].status, 'rejected');
});

test('runtime command processor skips a command already claimed by another worker', async () => {
  let called = false;
  const processor = new RuntimeCommandProcessor({
    client: {
      async acknowledgeRuntimeCommand() {
        const error = new Error('command already claimed');
        error.status = 409;
        throw error;
      },
    },
    handlers: {
      cancel_run: async () => { called = true; return { cancelled: true }; },
    },
  });
  const result = await processor.process({ command_id: 'cmd_claimed', command_type: 'cancel_run' });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'claim_conflict');
  assert.equal(called, false);
});
