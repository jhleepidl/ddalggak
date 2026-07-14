import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderExecutionWorkspace } from '../src/application/telegram_chat_execution.js';

const testTmpRoot = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
fs.mkdirSync(testTmpRoot, { recursive: true });

test('headless provider isolation moves Claude outside the repository workspace while Codex keeps the run workspace', () => {
  const previousIsolation = process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION;
  const previousRoot = process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT;
  const isolationRoot = fs.mkdtempSync(path.join(testTmpRoot, 'provider-isolation-'));
  try {
    process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION = '1';
    process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT = isolationRoot;

    const claudeWorkspace = resolveProviderExecutionWorkspace('job:ambient/context', 'claude');
    const codexWorkspace = resolveProviderExecutionWorkspace('job:ambient/context', 'codex');

    assert.equal(claudeWorkspace.startsWith(path.resolve(isolationRoot) + path.sep), true);
    assert.equal(path.basename(claudeWorkspace), 'job_ambient_context');
    assert.equal(fs.existsSync(claudeWorkspace), true);
    assert.equal(codexWorkspace.startsWith(path.resolve(isolationRoot) + path.sep), false);
  } finally {
    if (previousIsolation === undefined) delete process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION;
    else process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION = previousIsolation;
    if (previousRoot === undefined) delete process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT;
    else process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(isolationRoot, { recursive: true, force: true });
  }
});
