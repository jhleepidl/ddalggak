import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { discoverOllamaModelNodes } from '../src/application/model_node_discovery.js';

function startFakeOllama() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'gemma3:12b', model: 'gemma3:12b', size: 123, digest: 'abc', details: { family: 'gemma', parameter_size: '12.2B', quantization_level: 'Q4_K_M' } }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/show') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ details: { family: 'gemma', parameter_size: '12.2B', quantization_level: 'Q4_K_M' }, modelfile: 'FROM gemma3\nPARAMETER num_ctx 32768\n' }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('Ollama discovery builds trusted model nodes with catalog metadata', async () => {
  const { server, url } = await startFakeOllama();
  try {
    const result = await discoverOllamaModelNodes({ baseUrl: url, trustedContext: true, timeoutMs: 1000 });
    assert.equal(result.ok, true);
    assert.equal(result.nodes.length, 1);
    const node = result.nodes[0];
    assert.equal(node.runtime, 'ollama');
    assert.equal(node.model, 'gemma3:12b');
    assert.equal(node.privacy_profile.tier, 'local_private');
    assert.equal(node.limits.context_tokens, 32768);
    assert.equal(node.model_catalog.parameter_size, '12.2B');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
