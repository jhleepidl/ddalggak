import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { resolveCodexGitRepoCheckPolicy, resolveCodexWorkspaceApprovalPolicy, runCodexExec } from '../src/codex.js';

const testRoot = path.join(os.homedir(), 'tmp', 'ddalggak-workspace-auto');

test('workspace-auto approval maps to non-interactive workspace-write inside workspace', () => {
  const workspace = path.join(testRoot, 'ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'workspace-auto',
    sandboxMode: 'read-only',
    workspacePath: workspace,
    commandCwd: path.join(workspace, 'subdir'),
    addDirs: [path.join(workspace, 'tools')],
  });
  assert.equal(resolved.error, '');
  assert.equal(resolved.workspaceAutoApprove, true);
  assert.equal(resolved.approvalPolicy, 'workspace-auto');
  assert.equal(resolved.cliApprovalPolicy, 'never');
  assert.equal(resolved.sandboxMode, 'workspace-write');
});

test('workspace-auto approval refuses cwd outside workspace', () => {
  const workspace = path.join(testRoot, 'ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'workspace-auto',
    sandboxMode: 'workspace-write',
    workspacePath: workspace,
    commandCwd: path.join(testRoot, 'other'),
  });
  assert.equal(resolved.workspaceAutoApprove, true);
  assert.match(resolved.error, /cwd inside workspace/);
});

test('workspace-auto approval refuses add-dir outside workspace', () => {
  const workspace = path.join(testRoot, 'ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'trusted-workspace',
    sandboxMode: 'workspace-write',
    workspacePath: workspace,
    commandCwd: workspace,
    addDirs: [path.join(testRoot, 'other')],
  });
  assert.equal(resolved.workspaceAutoApprove, true);
  assert.match(resolved.error, /add-dir outside workspace/);
});

test('standard approval policy passes through unchanged', () => {
  const workspace = path.join(testRoot, 'ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'on-request',
    sandboxMode: 'read-only',
    workspacePath: workspace,
    commandCwd: workspace,
  });
  assert.equal(resolved.error, '');
  assert.equal(resolved.workspaceAutoApprove, false);
  assert.equal(resolved.cliApprovalPolicy, 'on-request');
  assert.equal(resolved.sandboxMode, 'read-only');
});

test('headless benchmark may skip the git repository check only inside its explicit output root', () => {
  const outputRoot = path.join(os.homedir(), 'tmp', 'ai_rooms_room_journeys');
  const workspace = path.join(outputRoot, '_runtime', 'job-1', 'workspace');
  const resolved = resolveCodexGitRepoCheckPolicy({ workspacePath: workspace, requested: true, allowedRoot: outputRoot });
  assert.equal(resolved.error, '');
  assert.equal(resolved.enabled, true);
  assert.equal(resolved.allowedRoot, path.resolve(outputRoot));
});

test('git repository check bypass is blocked without an allowed root or outside it', () => {
  const outputRoot = path.join(os.homedir(), 'tmp', 'ai_rooms_room_journeys');
  const noRoot = resolveCodexGitRepoCheckPolicy({ workspacePath: path.join(outputRoot, 'workspace'), requested: true });
  assert.match(noRoot.error, /explicit allowed root/);
  const outside = resolveCodexGitRepoCheckPolicy({
    workspacePath: path.join(os.homedir(), 'projects', 'untrusted'),
    requested: true,
    allowedRoot: outputRoot,
  });
  assert.match(outside.error, /limited to the configured benchmark root/);
  assert.equal(outside.enabled, false);
});

test('runCodexExec passes --skip-git-repo-check only for a workspace under the bounded headless output root', async () => {
  fs.mkdirSync(testRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(testRoot, 'codex-cli-'));
  const workspace = path.join(root, '_runtime', 'job-1', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const capture = path.join(root, 'args.txt');
  const fakeCli = path.join(root, 'fake-codex.sh');
  fs.writeFileSync(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(capture)}\ncat >/dev/null\nprintf 'ok\\n'\n`, { mode: 0o755 });
  const previous = {
    command: process.env.CODEX_CLI_COMMAND,
    skip: process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK,
    allowed: process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT,
  };
  try {
    process.env.CODEX_CLI_COMMAND = fakeCli;
    process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK = '1';
    process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT = root;
    const result = await runCodexExec({ workspaceRoot: workspace, cwd: workspace, prompt: 'hello', timeoutMs: 5000 });
    assert.equal(result.ok, true, result.stderr);
    const args = fs.readFileSync(capture, 'utf8').split(/\r?\n/).filter(Boolean);
    assert.ok(args.includes('--skip-git-repo-check'));
  } finally {
    if (previous.command === undefined) delete process.env.CODEX_CLI_COMMAND; else process.env.CODEX_CLI_COMMAND = previous.command;
    if (previous.skip === undefined) delete process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK; else process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK = previous.skip;
    if (previous.allowed === undefined) delete process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT; else process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT = previous.allowed;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
