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

test('createImprovementJob sends body to GoC improvement route', async () => {
  const client = new StubGocClient();
  await client.createImprovementJob('thread_1', { target_repo: 'ddalggak', instruction: 'Improve tests' });
  assert.equal(client.lastRequest.method, 'POST');
  assert.match(client.lastRequest.attempts[0].path, /\/api\/threads\/thread_1\/improvement_jobs$/);
  assert.equal(client.lastRequest.attempts[0].body.target_repo, 'ddalggak');
});

test('reportImprovementJob sends report payload to GoC improvement route', async () => {
  const client = new StubGocClient();
  await client.reportImprovementJob('thread_1', 'job_1', { kind: 'test_report', status: 'passed' });
  assert.equal(client.lastRequest.method, 'POST');
  assert.match(client.lastRequest.attempts[0].path, /\/api\/threads\/thread_1\/improvement_jobs\/job_1\/report$/);
  assert.equal(client.lastRequest.attempts[0].body.kind, 'test_report');
});
