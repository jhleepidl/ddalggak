import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRoomProviderChildEnv,
  prepareRoomProviderInvocation,
  rewriteWorkspacePathForSandbox,
} from '../src/room_runtime/provider_process_boundary.js';

test('Room provider child env omits ddalggak secrets and keeps provider auth only', () => {
  const env = buildRoomProviderChildEnv('codex', {
    PATH: process.env.PATH,
    HOME: '/home/test',
    OPENAI_API_KEY: 'openai-secret',
    TELEGRAM_BOT_TOKEN: 'telegram-secret',
    GOC_SERVICE_KEY: 'goc-secret',
    CODEX_HOME: '/home/test/.codex',
  });
  assert.equal(env.OPENAI_API_KEY, 'openai-secret');
  assert.equal(env.CODEX_HOME, '/home/test/.codex');
  assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
  assert.equal(env.GOC_SERVICE_KEY, undefined);
  assert.equal(env.ROOM_WORKSPACE, undefined);
});

test('nested Room provider invocation wraps CLI with bubblewrap and masks control tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-boundary-'));
  try {
    const control = path.join(root, 'ddalggak');
    const workspace = path.join(control, 'runs', '_room_native', 'workspaces', 'room-a', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const invocation = prepareRoomProviderInvocation({
      provider: 'codex',
      command: '/usr/bin/codex-placeholder',
      args: ['exec', '-C', '/workspace', '-'],
      workspacePath: workspace,
      roomScoped: true,
      env: {
        PATH: process.env.PATH,
        HOME: os.homedir(),
        DDALGGAK_CONTROL_ROOT: control,
        ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT: 'true',
        ROOM_PROVIDER_OS_SANDBOX: 'bwrap',
        ROOM_PROVIDER_BWRAP_COMMAND: process.execPath,
      },
    });
    assert.equal(invocation.ok, true);
    assert.equal(invocation.command, process.execPath);
    assert.equal(invocation.osSandbox, 'bwrap');
    assert.equal(invocation.visibleWorkspacePath, '/workspace');
    assert.equal(invocation.inheritEnv, false);
    assert.equal(invocation.childEnv.ROOM_WORKSPACE, '/workspace');
    const args = invocation.args;
    assert.ok(args.includes('--unshare-pid'));
    assert.ok(args.includes('--tmpfs'));
    const maskIndex = args.findIndex((value, index) => value === '--tmpfs' && args[index + 1] === control);
    assert.ok(maskIndex >= 0);
    const bindIndex = args.findIndex((value, index) => value === '--bind' && args[index + 1] === workspace && args[index + 2] === '/workspace');
    assert.ok(bindIndex >= 0);
    assert.ok(bindIndex < maskIndex, 'workspace is mounted before the parent control tree is masked');
    const separatorIndex = args.lastIndexOf('--');
    assert.ok(separatorIndex >= 0);
    assert.equal(args[separatorIndex + 1], '/usr/bin/codex-placeholder');
    assert.deepEqual(args.slice(separatorIndex + 2), ['exec', '-C', '/workspace', '-']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested Room provider invocation fails closed without bwrap policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-boundary-'));
  try {
    const control = path.join(root, 'ddalggak');
    const workspace = path.join(control, 'runs', 'room', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const invocation = prepareRoomProviderInvocation({
      provider: 'antigravity',
      command: 'agy',
      workspacePath: workspace,
      roomScoped: true,
      env: { DDALGGAK_CONTROL_ROOT: control, ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT: 'true' },
    });
    assert.equal(invocation.ok, false);
    assert.match(invocation.error, /ROOM_PROVIDER_OS_SANDBOX=bwrap/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace path is rewritten to sandbox-visible path in provider prompt', () => {
  assert.equal(
    rewriteWorkspacePathForSandbox('Inspect /host/room/workspace and run tests', '/host/room/workspace', '/workspace'),
    'Inspect /workspace and run tests',
  );
});
