import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { jobs } from '../src/application/telegram_runtime_state.js';
import {
  collectWorkspaceFileEntries,
  refreshArtifactIndex,
  sendArtifactBySelection,
  maybeSendArtifactSummary,
} from '../src/application/telegram_runtime_io.js';

async function withTempRunsDir(fn) {
  const prevBaseDir = jobs.baseDir;
  const prevRunsDir = jobs.runsDir;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-artifacts-'));
  jobs.baseDir = baseDir;
  jobs.runsDir = baseDir;
  fs.mkdirSync(baseDir, { recursive: true });
  try {
    return await fn(baseDir);
  } finally {
    jobs.baseDir = prevBaseDir;
    jobs.runsDir = prevRunsDir;
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

test('collectWorkspaceFileEntries treats workspace artifacts as primary files and excludes uploads/outputs from workspace scope', async () => {
  await withTempRunsDir(() => {
    const job = jobs.createJob({ title: 'artifact workspace listing' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md'), 'report', 'utf8');
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'src/app.js')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'src/app.js'), 'console.log("ok")', 'utf8');
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'uploads/input.txt'), 'input', 'utf8');
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'outputs/legacy.txt'), 'legacy', 'utf8');

    const workspaceFiles = collectWorkspaceFileEntries(job.jobId, { scope: 'workspace' }).map((row) => row.rel);
    const uploadFiles = collectWorkspaceFileEntries(job.jobId, { scope: 'uploads' }).map((row) => row.rel);

    assert.deepEqual(uploadFiles, ['uploads/input.txt']);
    assert.equal(workspaceFiles.includes('docs/report.md'), true);
    assert.equal(workspaceFiles.includes('src/app.js'), true);
    assert.equal(workspaceFiles.includes('uploads/input.txt'), false);
    assert.equal(workspaceFiles.includes('outputs/legacy.txt'), false);
  });
});

test('refreshArtifactIndex prioritizes execution artifact refs and /send selection sends original workspace file', async () => {
  await withTempRunsDir(async () => {
    const job = jobs.createJob({ title: 'artifact send' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md'), 'artifact-body', 'utf8');
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'src/app.js')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'src/app.js'), 'console.log("ok")', 'utf8');

    const artifactIndex = refreshArtifactIndex(job.jobId, {
      execution: { outputs: [{ artifact_path: 'docs/report.md' }] },
      maxFiles: 5,
    });

    assert.equal(artifactIndex.artifacts[0].path, 'docs/report.md');

    const sent = [];
    const bot = {
      async sendDocument(chatId, filePath, options) {
        sent.push({ chatId, filePath, options });
        return { ok: true };
      },
    };

    const result = await sendArtifactBySelection(bot, 'chat-1', job.jobId, '1', { artifactIndex });
    assert.equal(result.rel, 'docs/report.md');
    assert.equal(sent.length, 1);
    assert.equal(String(sent[0].filePath).endsWith(path.join('docs', 'report.md')), true);
    assert.match(String(sent[0].options.caption || ''), /docs\/report\.md/);
  });
});

test('maybeSendArtifactSummary announces candidates without auto-sending documents', async () => {
  await withTempRunsDir(async () => {
    const job = jobs.createJob({ title: 'artifact summary' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'final/summary.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'final/summary.md'), 'done', 'utf8');

    const sentMessages = [];
    const bot = {
      async sendMessage(chatId, text, options) {
        sentMessages.push({ chatId, text, options });
        return { ok: true };
      },
      async sendDocument() {
        throw new Error('documents should not be auto-sent');
      },
    };

    await maybeSendArtifactSummary(bot, 'chat-1', job.jobId, {
      execution: { outputs: [{ path: 'final/summary.md' }] },
      replyToMessageId: 123,
    });

    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0].text, /주요 산출물 후보/);
    assert.match(sentMessages[0].text, /\/send 1/);
    assert.match(sentMessages[0].text, /final\/summary\.md/);
  });
});
