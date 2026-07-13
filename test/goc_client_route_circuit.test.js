import test from 'node:test';
import assert from 'node:assert/strict';

import { GocClient, getGocRouteCircuitSnapshot } from '../src/goc_client.js';

test('GoC client route circuit breaker skips repeatedly failing optional routes', async () => {
  const previousThreshold = process.env.GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD;
  const previousCooldown = process.env.GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS;
  process.env.GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD = '1';
  process.env.GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS = '60000';
  try {
    const client = new GocClient({ apiBase: 'http://goc.test', serviceKey: 'k' });
    const calls = [];
    client._request = async ({ method, path }) => {
      calls.push(`${method} ${path}`);
      const err = new Error('not found');
      err.status = 404;
      throw err;
    };
    await assert.rejects(() => client._requestAny({ method: 'POST', attempts: [{ path: '/api/missing' }] }), /not found/);
    assert.equal(calls.length, 1);
    await assert.rejects(() => client._requestAny({ method: 'POST', attempts: [{ path: '/api/missing' }] }), /circuit breaker/);
    assert.equal(calls.length, 1);
    assert.ok(getGocRouteCircuitSnapshot().some((row) => row.key.includes('/api/missing')));
  } finally {
    if (previousThreshold === undefined) delete process.env.GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD;
    else process.env.GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD = previousThreshold;
    if (previousCooldown === undefined) delete process.env.GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS;
    else process.env.GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS = previousCooldown;
  }
});

test('GoC client exposes canonical runtime command creation, lookup, and event cursor routes', async () => {
  const client = new GocClient({ apiBase: 'http://goc.test', serviceKey: 'k' });
  const calls = [];
  client._requestAny = async (input) => { calls.push(input); return { ok: true }; };
  await client.createRuntimeCommand({ command_type: 'room_message', payload: { message: 'hello' } });
  await client.getRuntimeCommand('cmd-1');
  await client.listRuntimeEvents({ threadId: 'thread-1', afterEventId: 'event-1', limit: 50 });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].attempts[0].path, '/api/runtime/commands');
  assert.equal(calls[1].attempts[0].path, '/api/runtime/commands/cmd-1');
  assert.equal(calls[2].attempts[0].path, '/api/runtime/events');
  assert.deepEqual(calls[2].attempts[0].query, { run_id: '', thread_id: 'thread-1', after_event_id: 'event-1', limit: 50 });
});
