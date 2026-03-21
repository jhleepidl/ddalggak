import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalContextEngine } from '../src/runtime_capabilities/context_engines/local_engine.js';
import { updateRoleSummary } from '../src/application/summary_memory.js';

function makeJobRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-local-engine-'));
}

function makeJobs(root) {
  return {
    jobDir(jobId) {
      const dir = path.join(root, jobId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    tailConversation() {
      return [];
    },
  };
}

test('local context engine loads role summary by roleId even when agentId is custom', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-role-summary';
  updateRoleSummary({
    jobDir: jobs.jobDir(jobId),
    roleId: 'builder',
    agentId: 'notebook_builder',
    goal: 'polish notebook flow',
    output: 'refined notebook cells and tightened ordering',
    provider: 'codex',
    model: 'gpt-5-codex',
  });

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Notebook Builder',
    roleId: 'builder',
    goal: 'keep improving the notebook',
  });

  assert.match(prepared.contextText, /ROLE SUMMARY/);
  assert.match(prepared.contextText, /polish notebook flow/);
  assert.ok((prepared.meta?.roleSummaryChars || 0) > 0);
});

test('local context engine derives builder focus and budget from roleId when agentId is custom', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-role-focus';

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Notebook Builder',
    roleId: 'builder',
    goal: 'improve workbook UX',
  });

  assert.match(prepared.contextText, /실행 가능한 코드\/노트북 산출물/);
  assert.equal(prepared.meta?.budgetTokens, 1400);
});
