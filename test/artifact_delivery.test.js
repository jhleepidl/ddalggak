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
  sendArtifactBundle,
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
    assert.equal(String(sent[0].options.caption || ''), '📄 report.md');
  });
});

test('refreshArtifactIndex incorporates workspace artifact publish manifest and writes shared artifact_index.md', async () => {
  await withTempRunsDir(() => {
    const job = jobs.createJob({ title: 'artifact publish manifest' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'dist/MyApp.exe')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'dist/MyApp.exe'), 'binary', 'utf8');
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, '.orchestrator/artifact_publish.json')), { recursive: true });
    fs.writeFileSync(
      jobs.ensureWorkspacePath(job.jobId, '.orchestrator/artifact_publish.json'),
      JSON.stringify({
        artifacts: [
          { path: 'dist/MyApp.exe', label: 'Windows installer', kind: 'exe', final: true },
        ],
        notes: ['npm install completed', 'npm run dist completed'],
      }, null, 2),
      'utf8',
    );

    const artifactIndex = refreshArtifactIndex(job.jobId, { maxFiles: 5 });
    assert.equal(artifactIndex.artifacts[0].path, 'dist/MyApp.exe');
    assert.equal(artifactIndex.artifacts[0].label, 'Windows installer');
    assert.equal(artifactIndex.artifacts[0].kind, 'exe');
    assert.deepEqual(artifactIndex.notes, ['npm install completed', 'npm run dist completed']);
    const markdown = fs.readFileSync(path.join(jobs.jobDir(job.jobId), 'shared', 'artifact_index.md'), 'utf8');
    assert.match(markdown, /Windows installer/);
    assert.match(markdown, /npm install completed/);
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


test('sendArtifactBundle packages selected workspace artifacts into a zip document', async () => {
  await withTempRunsDir(async () => {
    const job = jobs.createJob({ title: 'artifact bundle' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md'), 'report-body', 'utf8');
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'src/app.js')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'src/app.js'), 'console.log("bundle")', 'utf8');

    const artifactIndex = refreshArtifactIndex(job.jobId, { maxFiles: 5 });
    const sent = [];
    const bot = {
      async sendDocument(chatId, filePath, options) {
        sent.push({ chatId, filePath, options });
        return { ok: true };
      },
    };

    const bundle = await sendArtifactBundle(bot, 'chat-1', job.jobId, ['1', '2'], { artifactIndex });
    assert.equal(sent.length, 1);
    assert.equal(String(sent[0].options.caption || '').includes('artifact bundle'), true);
    assert.equal(String(sent[0].options.caption || '').includes(job.jobId), false);
    assert.equal(bundle.entries.length, 2);
    assert.equal(String(sent[0].filePath).endsWith('.zip'), true);
    const zipBytes = fs.readFileSync(bundle.bundlePath);
    assert.equal(zipBytes.slice(0, 2).toString('utf8'), 'PK');
    assert.equal(zipBytes.includes(Buffer.from('docs/report.md')), true);
    assert.equal(zipBytes.includes(Buffer.from('src/app.js')), true);
  });
});


test('collectWorkspaceFileEntries and artifact index exclude internal support files like GEMINI.md and .codex instructions', async () => {
  await withTempRunsDir(() => {
    const job = jobs.createJob({ title: 'artifact skip internal support files' });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'GEMINI.md'), 'internal gemini memory', 'utf8');
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, '.orchestrator/runtime_execution_policy.md'), 'policy', 'utf8');
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, '.codex/instructions.md'), 'codex instructions', 'utf8');
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'deliverable.ipynb'), '{}', 'utf8');

    const workspaceFiles = collectWorkspaceFileEntries(job.jobId, { scope: 'workspace' }).map((row) => row.rel);
    const artifactIndex = refreshArtifactIndex(job.jobId, { maxFiles: 5 });
    const artifactPaths = artifactIndex.artifacts.map((row) => row.path);

    assert.equal(workspaceFiles.includes('GEMINI.md'), false);
    assert.equal(workspaceFiles.some((row) => row.startsWith('.orchestrator/')), false);
    assert.equal(artifactPaths.includes('GEMINI.md'), false);
    assert.equal(artifactPaths.some((row) => row.startsWith('.orchestrator/')), false);
    assert.equal(artifactPaths.includes('deliverable.ipynb'), true);
    assert.equal(artifactPaths.some((entry) => entry.startsWith('.codex/')), false);
  });
});


test('sendArtifactBundle blocks bundle delivery when artifact publish contract has no publisher', async () => {
  await withTempRunsDir(async () => {
    const job = jobs.createJob({ title: 'artifact bundle blocked by publish contract' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'docs/report.md'), 'report-body', 'utf8');

    const artifactIndex = refreshArtifactIndex(job.jobId, { maxFiles: 5 });
    const bot = {
      async sendDocument() {
        throw new Error('bundle should not be sent when contract is blocked');
      },
    };

    await assert.rejects(
      () => sendArtifactBundle(bot, 'chat-1', job.jobId, ['1'], {
        artifactIndex,
        runtime: {
          activeTeamConfig: {
            interaction_spec: { final_answer_owner: 'Repo Scout' },
            agents: [
              { agent_id: 'repo_scout', name: 'Repo Scout', role: 'researcher', provider: 'gemini' },
            ],
            structure_v2: {
              participants: [
                { participant_id: 'repo_scout', name: 'Repo Scout', role: 'researcher', provider: 'gemini' },
              ],
              control_policy: { final_answer_owner_participant_id: 'repo_scout' },
              memory_plan: {
                surfaces: [
                  { surface_id: 'research', write_policy: 'shared', target_roles: ['researcher'] },
                ],
              },
            },
          },
        },
      }),
      /artifact publish contract blocked/i,
    );
  });
});


test('maybeSendArtifactSummary does not re-announce stale artifacts for a later memory-only turn', async () => {
  await withTempRunsDir(async () => {
    const job = jobs.createJob({ title: 'artifact summary stale suppression' });
    fs.mkdirSync(path.dirname(jobs.ensureWorkspacePath(job.jobId, 'travel/icde2026_itinerary.md')), { recursive: true });
    fs.writeFileSync(jobs.ensureWorkspacePath(job.jobId, 'travel/icde2026_itinerary.md'), 'old itinerary', 'utf8');
    refreshArtifactIndex(job.jobId, { maxFiles: 5 });

    const sentMessages = [];
    const bot = {
      async sendMessage(chatId, text, options) {
        sentMessages.push({ chatId, text, options });
        return { ok: true };
      },
    };

    await maybeSendArtifactSummary(bot, 'chat-1', job.jobId, {
      sinceMs: Date.now() + 60_000,
      replyToMessageId: 123,
    });

    assert.equal(sentMessages.length, 0);
  });
});
