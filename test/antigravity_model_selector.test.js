import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runAntigravityPrompt } from '../src/antigravity.js';

test('Antigravity execution passes the complete discovered display selector as one model argument', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-agy-selector-'));
  const command = path.join(dir, 'agy');
  const argsPath = path.join(dir, 'args.json');
  const stdinPath = path.join(dir, 'stdin.txt');
  fs.writeFileSync(command, `#!/usr/bin/env node\nimport fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));\nlet input = '';\nprocess.stdin.setEncoding('utf8');\nprocess.stdin.on('data', (chunk) => input += chunk);\nprocess.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(stdinPath)}, input); console.log('OK'); });\n`);
  fs.chmodSync(command, 0o755);

  const old = {
    ANTIGRAVITY_CLI_COMMAND: process.env.ANTIGRAVITY_CLI_COMMAND,
    ANTIGRAVITY_MODEL_ARG: process.env.ANTIGRAVITY_MODEL_ARG,
    LLM_TRACE_ENABLED: process.env.LLM_TRACE_ENABLED,
  };
  try {
    process.env.ANTIGRAVITY_CLI_COMMAND = command;
    process.env.ANTIGRAVITY_MODEL_ARG = '--model';
    process.env.LLM_TRACE_ENABLED = 'false';
    const selector = 'Claude Opus 4.6 (Thinking)';
    const result = await runAntigravityPrompt({
      workspaceRoot: dir,
      cwd: dir,
      prompt: 'Return exactly OK',
      model: selector,
      timeoutMs: 5000,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(argsPath, 'utf8')), ['--model', selector]);
    assert.equal(fs.readFileSync(stdinPath, 'utf8'), 'Return exactly OK');
    assert.equal(result.requested_model, selector);
    assert.equal(result.resolved_model, selector);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
