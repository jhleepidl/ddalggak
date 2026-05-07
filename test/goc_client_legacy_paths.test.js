import test from 'node:test';
import assert from 'node:assert/strict';

import { GocClient } from '../src/goc_client.js';

function notFound(path) {
  const error = new Error(`missing ${path}`);
  error.status = 404;
  throw error;
}

test('GoC client skips legacy non-/api and singular /api/thread routes by default', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc' });
  const calls = [];
  client._request = async ({ path }) => {
    calls.push(path);
    notFound(path);
  };

  await assert.rejects(() => client.createThread('legacy cleanup'), /skipped 3 legacy routes/);
  assert.deepEqual(calls, ['/api/threads']);
});

test('GoC client can re-enable legacy API route fallbacks explicitly', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc', allowLegacyApiPaths: true });
  const calls = [];
  client._request = async ({ path }) => {
    calls.push(path);
    notFound(path);
  };

  await assert.rejects(() => client.createThread('legacy cleanup'));
  assert.deepEqual(calls, ['/api/threads', '/threads', '/v1/threads', '/api/thread']);
});

test('GoC client prefers thread-scoped graph node route and skips obsolete global node aliases', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc' });
  const calls = [];
  client._request = async ({ path }) => {
    calls.push(path);
    if (path === '/api/threads/thread-1/nodes') {
      return { id: 'node-1', thread_id: 'thread-1', type: 'Run', payload_json: '{}' };
    }
    notFound(path);
  };

  const node = await client.createNode('thread-1', { type: 'Run', text: 'run started' });
  assert.equal(node.id, 'node-1');
  assert.deepEqual(calls, ['/api/threads/thread-1/nodes']);
});

test('GoC client treats obsolete global graph aliases as legacy by default', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc' });
  const calls = [];
  client._request = async ({ path }) => {
    calls.push(path);
    notFound(path);
  };

  await assert.rejects(() => client.createEdge('thread-1', 'a', 'b', 'NEXT'));
  assert.deepEqual(calls, ['/api/threads/thread-1/edges']);
});


test('previewMemoryMaterialization uses canonical api route by default', async () => {
  const client = new GocClient({ apiBase: 'https://example.invalid', serviceKey: 'svc' });
  const calls = [];
  client._request = async ({ path }) => {
    calls.push(path);
    return { ok: true };
  };
  const preview = await client.previewMemoryMaterialization('thread-1', { include_backfill_preview: true });
  assert.equal(preview.ok, true);
  assert.deepEqual(calls, ['/api/threads/thread-1/memory/materialization/preview']);
});
