import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveRoomRuntimeRoots, roomPaths, validateRoomWorkspace } from '../src/room_runtime/room_workspace_registry.js';

function tempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-room-roots-'));
  const control = path.join(root, 'control');
  const runtime = path.join(root, 'runtime');
  fs.mkdirSync(control, { recursive: true });
  return {
    root,
    env: {
      ROOM_RUNTIME_ROOT: runtime,
      ROOM_WORKSPACES_ROOT: path.join(runtime, 'workspaces'),
      ROOM_STATE_ROOT: path.join(runtime, 'state'),
      DDALGGAK_CONTROL_ROOT: control,
    },
  };
}

test('Room workspace and state roots are outside the control plane', () => {
  const { root, env } = tempEnv();
  try {
    const paths = roomPaths('telegram--123', { env, create: true });
    assert.equal(paths.roomId, 'telegram--123');
    assert.ok(paths.workspaceRoot.startsWith(path.resolve(env.ROOM_WORKSPACES_ROOT)));
    assert.ok(!paths.workspaceRoot.startsWith(path.resolve(env.DDALGGAK_CONTROL_ROOT)));
    assert.equal(validateRoomWorkspace('telegram--123', { env }).workspaceRoot, paths.workspaceRoot);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Room workspace root inside the control plane is rejected', () => {
  const { root, env } = tempEnv();
  try {
    env.ROOM_WORKSPACES_ROOT = path.join(env.DDALGGAK_CONTROL_ROOT, 'rooms');
    assert.throws(() => resolveRoomRuntimeRoots(env), /inside ROOM_RUNTIME_ROOT|ddalggak control plane/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinked Room workspace components are rejected', () => {
  const { root, env } = tempEnv();
  try {
    const roots = resolveRoomRuntimeRoots(env);
    fs.mkdirSync(roots.workspacesRoot, { recursive: true });
    const external = path.join(root, 'external');
    fs.mkdirSync(external, { recursive: true });
    fs.symlinkSync(external, path.join(roots.workspacesRoot, 'bad-room'));
    assert.throws(() => roomPaths('bad-room', { env, create: false }), /symbolic links are not allowed/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('workspace symlink escaping the canonical Room is rejected', () => {
  const { root, env } = tempEnv();
  try {
    const paths = roomPaths('room-link', { env, create: true });
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'secret');
    fs.symlinkSync(outside, path.join(paths.workspaceRoot, 'escape-link'));
    assert.throws(() => validateRoomWorkspace('room-link', { env }), /symlink escapes canonical workspace/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('Room workspace and state roots cannot overlap', () => {
  const { root, env } = tempEnv();
  try {
    env.ROOM_STATE_ROOT = path.join(env.ROOM_WORKSPACES_ROOT, 'state');
    assert.throws(() => resolveRoomRuntimeRoots(env), /must not overlap/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Room runtime root cannot contain or be contained by the control plane', () => {
  const { root, env } = tempEnv();
  try {
    env.ROOM_RUNTIME_ROOT = root;
    env.ROOM_WORKSPACES_ROOT = path.join(root, 'workspaces');
    env.ROOM_STATE_ROOT = path.join(root, 'state');
    assert.throws(() => resolveRoomRuntimeRoots(env), /must be disjoint/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

 test('symlinked runtime root is rejected even when the Room child path is ordinary', () => {
  const { root, env } = tempEnv();
  try {
    const realRuntime = path.join(root, 'real-runtime');
    fs.mkdirSync(realRuntime, { recursive: true });
    const linkedRuntime = path.join(root, 'linked-runtime');
    fs.symlinkSync(realRuntime, linkedRuntime);
    env.ROOM_RUNTIME_ROOT = linkedRuntime;
    env.ROOM_WORKSPACES_ROOT = path.join(linkedRuntime, 'workspaces');
    env.ROOM_STATE_ROOT = path.join(linkedRuntime, 'state');
    assert.throws(() => roomPaths('symlink-runtime', { env, create: true }), /symbolic-link component|cannot be a symbolic link/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
