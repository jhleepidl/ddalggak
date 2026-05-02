import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { runOpenAICompatiblePrompt } from '../src/providers/openai_compatible.js';

test('OpenAI-compatible provider calls chat completions and extracts text', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        assert.equal(parsed.model, 'local-test');
        assert.equal(parsed.messages.at(-1).content, 'hello');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'local ok' } }] }));
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const result = await runOpenAICompatiblePrompt({ baseUrl: `http://127.0.0.1:${port}/v1`, model: 'local-test', prompt: 'hello', jobId: '' });
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'local ok');
    assert.equal(result.used_model, 'local-test');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
