import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { resolveCodexWorkspaceApprovalPolicy } from '../src/codex.js';

test('workspace-auto approval maps to non-interactive workspace-write inside workspace', () => {
  const workspace = path.resolve('/tmp/ddalggak-workspace-auto/ws');
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
  const workspace = path.resolve('/tmp/ddalggak-workspace-auto/ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'workspace-auto',
    sandboxMode: 'workspace-write',
    workspacePath: workspace,
    commandCwd: path.resolve('/tmp/ddalggak-workspace-auto/other'),
  });
  assert.equal(resolved.workspaceAutoApprove, true);
  assert.match(resolved.error, /cwd inside workspace/);
});

test('workspace-auto approval refuses add-dir outside workspace', () => {
  const workspace = path.resolve('/tmp/ddalggak-workspace-auto/ws');
  const resolved = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: 'trusted-workspace',
    sandboxMode: 'workspace-write',
    workspacePath: workspace,
    commandCwd: workspace,
    addDirs: [path.resolve('/tmp/ddalggak-workspace-auto/other')],
  });
  assert.equal(resolved.workspaceAutoApprove, true);
  assert.match(resolved.error, /add-dir outside workspace/);
});

test('standard approval policy passes through unchanged', () => {
  const workspace = path.resolve('/tmp/ddalggak-workspace-auto/ws');
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
