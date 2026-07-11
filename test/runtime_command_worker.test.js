import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultRuntimeCommandHandlers, startRuntimeCommandWorker } from '../src/runtime_capabilities/runtime_command_worker.js';

test('default runtime command handlers expose ping and bounded cancel_run', async () => {
  const calls = [];
  const handlers = createDefaultRuntimeCommandHandlers({
    cancelJobExecution(jobId) { calls.push(jobId); return { aborted: true, dropped: 2 }; },
  });
  const ping = await handlers.runtime_ping({ commandId: 'cmd_ping', payload: { value: 1 } });
  assert.equal(ping.ok, true);
  const cancelled = await handlers.cancel_run({ aggregateId: 'job_1', payload: {} });
  assert.deepEqual(calls, ['job_1']);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.dropped, 2);
});

test('runtime command worker remains inert unless explicitly enabled', async () => {
  const worker = startRuntimeCommandWorker({
    client: { async listPendingRuntimeCommands() { throw new Error('must not run'); } },
    pollEnabled: 'false',
  });
  assert.equal(worker.enabled, false);
  const result = await worker.pollOnce();
  assert.equal(result.skipped, true);
});
