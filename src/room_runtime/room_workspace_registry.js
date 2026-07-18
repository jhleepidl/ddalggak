import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertCanonicalDirectory,
  assertNoEscapingSymlinks,
  assertNoSymlinkComponents,
  assertPathInside,
  cleanText,
  ensureDir,
  readJson,
  safeSegment,
  writeJsonAtomic,
} from './fs_utils.js';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..');

function isTruthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function resolveRoomRuntimeRoots(env = process.env) {
  const runtimeRoot = path.resolve(cleanText(env.ROOM_RUNTIME_ROOT) || '/home/jhlee/ai_rooms_runtime');
  const workspacesRoot = path.resolve(cleanText(env.ROOM_WORKSPACES_ROOT) || path.join(runtimeRoot, 'workspaces'));
  const stateRoot = path.resolve(cleanText(env.ROOM_STATE_ROOT) || path.join(runtimeRoot, 'state'));
  const controlRoot = path.resolve(cleanText(env.DDALGGAK_CONTROL_ROOT) || PROJECT_ROOT);

  const insideOrEqual = (root, candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const runsRoot = path.resolve(controlRoot, cleanText(env.RUNS_DIR) || 'runs');
  const runtimeInsideControlRoot = insideOrEqual(controlRoot, runtimeRoot);
  const controlInsideRuntimeRoot = insideOrEqual(runtimeRoot, controlRoot);
  const allowRuntimeInsideControlRoot = isTruthy(env.ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT);
  if (controlInsideRuntimeRoot) {
    throw new Error(`ROOM_RUNTIME_ROOT cannot contain the ddalggak control plane: runtime=${runtimeRoot} control=${controlRoot}`);
  }
  if (runtimeInsideControlRoot) {
    if (!allowRuntimeInsideControlRoot) {
      throw new Error(`ROOM_RUNTIME_ROOT is inside the ddalggak control plane; set ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT=true only with provider OS sandboxing: runtime=${runtimeRoot} control=${controlRoot}`);
    }
    if (!insideOrEqual(runsRoot, runtimeRoot)) {
      throw new Error(`Nested ROOM_RUNTIME_ROOT must stay inside RUNS_DIR: runtime=${runtimeRoot} runs=${runsRoot}`);
    }
    if (cleanText(env.ROOM_PROVIDER_OS_SANDBOX).toLowerCase() !== 'bwrap') {
      throw new Error('Nested ROOM_RUNTIME_ROOT requires ROOM_PROVIDER_OS_SANDBOX=bwrap');
    }
  }
  if (!insideOrEqual(runtimeRoot, workspacesRoot)) {
    throw new Error(`ROOM_WORKSPACES_ROOT must be inside ROOM_RUNTIME_ROOT: ${workspacesRoot}`);
  }
  if (!insideOrEqual(runtimeRoot, stateRoot)) {
    throw new Error(`ROOM_STATE_ROOT must be inside ROOM_RUNTIME_ROOT: ${stateRoot}`);
  }
  if (insideOrEqual(workspacesRoot, stateRoot) || insideOrEqual(stateRoot, workspacesRoot)) {
    throw new Error(`ROOM_WORKSPACES_ROOT and ROOM_STATE_ROOT must not overlap: workspaces=${workspacesRoot} state=${stateRoot}`);
  }
  if (!runtimeInsideControlRoot && (insideOrEqual(controlRoot, workspacesRoot) || insideOrEqual(workspacesRoot, controlRoot))) {
    throw new Error(`ROOM_WORKSPACES_ROOT and ddalggak control plane must be disjoint unless nested runtime mode is explicitly enabled: ${workspacesRoot}`);
  }
  if (!runtimeInsideControlRoot && (insideOrEqual(controlRoot, stateRoot) || insideOrEqual(stateRoot, controlRoot))) {
    throw new Error(`ROOM_STATE_ROOT and ddalggak control plane must be disjoint unless nested runtime mode is explicitly enabled: ${stateRoot}`);
  }
  return { runtimeRoot, workspacesRoot, stateRoot, controlRoot, runsRoot, runtimeInsideControlRoot, allowRuntimeInsideControlRoot };
}

export function normalizeRoomId(value = '') {
  return safeSegment(cleanText(value), 'room');
}

export function roomPaths(roomId = '', { env = process.env, create = true } = {}) {
  const roots = resolveRoomRuntimeRoots(env);
  const id = normalizeRoomId(roomId);
  const roomWorkspaceRoot = path.resolve(roots.workspacesRoot, id);
  const workspaceRoot = path.resolve(roomWorkspaceRoot, 'workspace');
  const roomStateRoot = path.resolve(roots.stateRoot, id);
  assertPathInside(roots.workspacesRoot, roomWorkspaceRoot, 'Room workspace root');
  assertPathInside(roots.stateRoot, roomStateRoot, 'Room state root');
  if (create) {
    ensureDir(roots.runtimeRoot);
    ensureDir(roots.workspacesRoot);
    ensureDir(roots.stateRoot);
    ensureDir(workspaceRoot);
    ensureDir(roomStateRoot);
  }
  if (fs.existsSync(roots.runtimeRoot)) assertCanonicalDirectory(roots.runtimeRoot, 'ROOM_RUNTIME_ROOT');
  if (fs.existsSync(roots.workspacesRoot)) assertCanonicalDirectory(roots.workspacesRoot, 'ROOM_WORKSPACES_ROOT');
  if (fs.existsSync(roots.stateRoot)) assertCanonicalDirectory(roots.stateRoot, 'ROOM_STATE_ROOT');
  assertNoSymlinkComponents(roomWorkspaceRoot, { stopAt: roots.workspacesRoot });
  assertNoSymlinkComponents(roomStateRoot, { stopAt: roots.stateRoot });
  if (fs.existsSync(roomWorkspaceRoot)) assertCanonicalDirectory(roomWorkspaceRoot, 'Room workspace container');
  if (fs.existsSync(workspaceRoot)) assertCanonicalDirectory(workspaceRoot, 'Room canonical workspace');
  if (fs.existsSync(roomStateRoot)) assertCanonicalDirectory(roomStateRoot, 'Room state directory');
  const manifestPath = path.join(roomStateRoot, 'room.json');
  if (create && !fs.existsSync(manifestPath)) {
    writeJsonAtomic(manifestPath, {
      schema_version: 'ai_rooms.room/v3',
      room_id: id,
      workspace_root: workspaceRoot,
      state_root: roomStateRoot,
      created_at: new Date().toISOString(),
      source: 'room_native_runtime',
    });
  }
  const manifest = readJson(manifestPath, null);
  if (manifest) {
    if (normalizeRoomId(manifest.room_id) !== id) throw new Error(`Room manifest identity mismatch: expected=${id} actual=${manifest.room_id}`);
    if (path.resolve(cleanText(manifest.workspace_root)) !== workspaceRoot) throw new Error(`Room manifest workspace mismatch: expected=${workspaceRoot} actual=${manifest.workspace_root}`);
    if (path.resolve(cleanText(manifest.state_root)) !== roomStateRoot) throw new Error(`Room manifest state mismatch: expected=${roomStateRoot} actual=${manifest.state_root}`);
  }
  return {
    ...roots,
    roomId: id,
    roomWorkspaceRoot,
    workspaceRoot,
    roomStateRoot,
    manifestPath,
    manifest,
  };
}

export function validateRoomWorkspace(roomId = '', options = {}) {
  const paths = roomPaths(roomId, { ...options, create: false });
  if (!fs.existsSync(paths.workspaceRoot)) throw new Error(`Room workspace is not initialized: ${paths.workspaceRoot}`);
  if (!fs.statSync(paths.workspaceRoot).isDirectory()) throw new Error(`Room workspace is not a directory: ${paths.workspaceRoot}`);
  assertNoSymlinkComponents(paths.workspaceRoot, { stopAt: paths.workspacesRoot });
  assertNoEscapingSymlinks(paths.workspaceRoot, { maxEntries: Number(options?.env?.ROOM_WORKSPACE_MAX_SCAN_ENTRIES || 100000) });
  if (paths.workspaceRoot === paths.controlRoot) {
    throw new Error('Room workspace cannot be the ddalggak source tree');
  }
  if (paths.workspaceRoot.startsWith(`${paths.controlRoot}${path.sep}`) && !paths.runtimeInsideControlRoot) {
    throw new Error('Room workspace cannot be inside the ddalggak source tree unless nested runtime mode is explicitly enabled');
  }
  return paths;
}
