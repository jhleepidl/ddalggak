import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Jobs } from '../src/jobs.js';
import { ensureGeminiWorkspaceConfig } from '../src/gemini.js';

test('new jobs keep workspace minimal until files are actually needed', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-jobs-'));
  try {
    const jobs = new Jobs();
    jobs.baseDir = baseDir;
    jobs.runsDir = baseDir;
    const job = jobs.createJob({ title: 'workspace hygiene' });
    const workspaceEntries = fs.readdirSync(job.workspaceDir).sort();
    assert.deepEqual(workspaceEntries, []);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('gemini workspace config is not materialized unless explicitly needed', () => {
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-'));
  const prevManage = process.env.GEMINI_MANAGE_WORKSPACE_CONFIG;
  const prevModel = process.env.GEMINI_WORKSPACE_MODEL;
  delete process.env.GEMINI_MANAGE_WORKSPACE_CONFIG;
  delete process.env.GEMINI_WORKSPACE_MODEL;
  try {
    const result = ensureGeminiWorkspaceConfig(workspaceDir);
    assert.equal(result.skipped, true);
    assert.equal(fs.existsSync(path.join(workspaceDir, '.gemini')), false);
  } finally {
    if (prevManage === undefined) delete process.env.GEMINI_MANAGE_WORKSPACE_CONFIG;
    else process.env.GEMINI_MANAGE_WORKSPACE_CONFIG = prevManage;
    if (prevModel === undefined) delete process.env.GEMINI_WORKSPACE_MODEL;
    else process.env.GEMINI_WORKSPACE_MODEL = prevModel;
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});
