import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildRepoSnapshot,
  collectWorkspaceDiff,
  createImprovementContextBundle,
  formatRepoSnapshotPreview,
  formatWorkspaceDiffPreview,
  resolveImprovementTargetConfig,
  runCommandSequence,
} from '../src/application/improvement_runtime.js';

test('resolveImprovementTargetConfig picks env overrides and default commands', () => {
  process.env.SELF_IMPROVE_DDALGGAK_WORKSPACE = '/srv/ddalggak-forge';
  process.env.SELF_IMPROVE_DDALGGAK_TEST_CMD = 'echo one;;echo two';
  process.env.SELF_IMPROVE_DDALGGAK_PATCH_CMD = 'echo patch';
  const cfg = resolveImprovementTargetConfig('ddalggak');
  assert.equal(cfg.workspace_root, '/srv/ddalggak-forge');
  assert.deepEqual(cfg.test_commands, ['echo one', 'echo two']);
  assert.equal(cfg.patch_command, 'echo patch');
  delete process.env.SELF_IMPROVE_DDALGGAK_WORKSPACE;
  delete process.env.SELF_IMPROVE_DDALGGAK_TEST_CMD;
  delete process.env.SELF_IMPROVE_DDALGGAK_PATCH_CMD;
});

test('buildRepoSnapshot inspects configured files and formats preview', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-snapshot-'));
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"name":"demo"}');
  fs.writeFileSync(path.join(tmp, 'src', 'demo.js'), 'export const ok = true;');
  const snapshot = buildRepoSnapshot({
    target: 'ddalggak',
    workspaceRoot: tmp,
    inspectPaths: ['package.json', 'src/demo.js', 'missing.js'],
  });
  assert.equal(snapshot.workspace_exists, true);
  assert.equal(snapshot.package_json_exists, true);
  assert.equal(snapshot.inspect_paths[0].exists, true);
  assert.equal(snapshot.inspect_paths[2].exists, false);
  assert.match(formatRepoSnapshotPreview(snapshot), /workspace_root/);
});

test('createImprovementContextBundle writes manifest and instruction files', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-bundle-'));
  const bundle = createImprovementContextBundle({
    workspaceRoot: tmp,
    jobId: 'job_bundle',
    target: 'ddalggak',
    instruction: 'Patch the improvement loop.',
    jobPayload: { phase: 'created' },
    reports: [{ id: 'r1', payload: { resource_kind: 'repo_snapshot', status: 'ok' }, text: 'snapshot' }],
    boardSummary: { raw_history_count: 2 },
  });
  assert.equal(fs.existsSync(bundle.manifest_path), true);
  assert.equal(fs.existsSync(bundle.instruction_path), true);
  const manifest = JSON.parse(fs.readFileSync(bundle.manifest_path, 'utf8'));
  assert.equal(manifest.job_id, 'job_bundle');
  assert.equal(manifest.target, 'ddalggak');
  assert.equal(manifest.board_summary.raw_history_count, 2);
});

test('collectWorkspaceDiff returns changed files for git workspace', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-git-'));
  await runCommandSequence([
    'git init',
    'git config user.email test@example.com',
    'git config user.name test',
    "printf 'one\n' > demo.txt",
    'git add demo.txt',
    'git commit -m init',
    "printf 'two\n' >> demo.txt",
  ], { cwd: tmp });
  const diff = await collectWorkspaceDiff({ workspaceRoot: tmp });
  assert.equal(diff.git_available, true);
  assert.equal(diff.changed_file_count, 1);
  assert.match(formatWorkspaceDiffPreview(diff), /changed_file_count: 1/);
});

test('runCommandSequence returns failure summary when one command fails', async () => {
  const result = await runCommandSequence(['echo ok', 'exit 3']);
  assert.equal(result.ok, false);
  assert.equal(result.status, 'failed');
  assert.equal(Array.isArray(result.results), true);
  assert.equal(result.results.length, 2);
  assert.match(result.stdout, /ok/);
});
