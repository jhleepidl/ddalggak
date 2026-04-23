import test from 'node:test';
import assert from 'node:assert/strict';

import { GocClient } from '../src/goc_client.js';

class StubGocClient extends GocClient {
  constructor() {
    process.env.GOC_API_BASE = 'http://example.test';
    process.env.GOC_SERVICE_KEY = 'svk.test.token';
    super();
    this.lastRequest = null;
  }

  async _requestAny(request) {
    this.lastRequest = request;
    return { ok: true };
  }
}

test('approveBoardCandidate sends approve payload to GoC board route', async () => {
  const client = new StubGocClient();
  await client.approveBoardCandidate('thread_1', 'node_2', { publishToLibrary: true });
  assert.equal(client.lastRequest.method, 'POST');
  assert.equal(Array.isArray(client.lastRequest.attempts), true);
  assert.match(client.lastRequest.attempts[0].path, /\/api\/threads\/thread_1\/board\/candidates\/node_2\/approve$/);
  assert.deepEqual(client.lastRequest.attempts[0].body, { publish_to_library: true });
});
