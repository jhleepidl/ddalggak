#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCommand } from '../src/proc.js';
import { resolveAntigravityCliCommand } from '../src/antigravity.js';
import { resolveRoomRuntimeRoots, roomPaths } from '../src/room_runtime/room_workspace_registry.js';

const clean = (value) => String(value ?? '').trim();
const lower = (value) => clean(value).toLowerCase();

const expectedProviders = {
  DDALGGAK_FAST_PROVIDER: 'antigravity',
  DDALGGAK_SEARCH_PROVIDER: 'antigravity',
  DDALGGAK_WORK_PROVIDER: 'codex',
  CHAT_SUPERVISOR_PROVIDER: 'antigravity',
  TEAM_PLANNER_PROVIDER: 'antigravity',
  DDALGGAK_MODEL_ROLE_CODE_EXECUTOR_PROVIDER: 'codex',
  DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER: 'antigravity',
  DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER: 'antigravity',
};

function testWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `.room-doctor-${process.pid}-${Date.now()}`);
  fs.writeFileSync(file, 'ok', 'utf8');
  fs.rmSync(file, { force: true });
}

export function evaluateRoomNativeEnvironment(env = process.env, { models = [], codexAvailable = true } = {}) {
  const errors = [];
  const warnings = [];
  const providers = {};
  const engine = lower(env.ROOM_EXECUTION_ENGINE);
  if (!['room_native_v2', 'room_native', 'v2'].includes(engine)) errors.push('Set ROOM_EXECUTION_ENGINE=room_native_v2.');
  for (const [key, expected] of Object.entries(expectedProviders)) {
    const value = clean(env[key]);
    if (value) providers[key] = value;
    if (lower(value) === 'claude') errors.push(`${key}=claude is unavailable for this deployment`);
    if (value && lower(value) !== expected) warnings.push(`${key}=${value}; expected ${expected}`);
    if (!value) warnings.push(`${key} is unset`);
  }
  if (lower(env.CLAUDE_CLI_MODEL_DISCOVERY_ENABLED) !== 'false') errors.push('Set CLAUDE_CLI_MODEL_DISCOVERY_ENABLED=false.');
  if (!models.length) errors.push('Antigravity model discovery returned no selectors.');
  if (!codexAvailable) errors.push('Codex CLI is unavailable.');
  let roots = null;
  let probeRoom = null;
  try {
    roots = resolveRoomRuntimeRoots(env);
    testWritable(roots.workspacesRoot);
    testWritable(roots.stateRoot);
    probeRoom = roomPaths('doctor-probe', { env, create: true });
    const roomStat = fs.lstatSync(probeRoom.workspaceRoot);
    if (roomStat.isSymbolicLink()) errors.push('Room workspace cannot be a symlink.');
    const skipGitCheck = ['1', 'true', 'yes', 'on'].includes(lower(env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK));
    if (!skipGitCheck) errors.push('Set DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK=true so empty/non-git Room workspaces can run Codex safely.');
    const allowedRoot = path.resolve(clean(env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT || ''));
    const workspaceRoot = path.resolve(roots.workspacesRoot);
    const relative = path.relative(allowedRoot, workspaceRoot);
    if (!clean(env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT) || relative.startsWith('..') || path.isAbsolute(relative)) {
      errors.push('DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT must contain ROOM_WORKSPACES_ROOT.');
    }
  } catch (error) {
    errors.push(`Room runtime boundary failed: ${error.message}`);
  }
  return {
    ready: errors.length === 0,
    errors,
    warnings,
    engine,
    providers,
    models,
    codex_available: Boolean(codexAvailable),
    roots,
    probe_room: probeRoom ? { room_id: probeRoom.roomId, workspace_root: probeRoom.workspaceRoot, state_root: probeRoom.roomStateRoot } : null,
  };
}

export async function checkRoomNativeDogfood({ env = process.env, runner = runCommand } = {}) {
  const antigravityCommand = resolveAntigravityCliCommand(env);
  const discoveryArgs = clean(env.ANTIGRAVITY_MODEL_DISCOVERY_ARGS || 'models').split(/\s+/).filter(Boolean);
  const discovery = await runner(antigravityCommand, discoveryArgs, {
    cwd: process.cwd(),
    timeoutMs: Number(env.ANTIGRAVITY_DISCOVERY_TIMEOUT_MS || 15000),
    env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const models = discovery.ok
    ? String(discovery.stdout || '').split(/\r?\n/).map(clean).filter(Boolean).map((row) => row.replace(/\s*\(current\)\s*$/i, '').trim())
    : [];
  const codexCommand = clean(env.CODEX_CLI_COMMAND || 'codex');
  const codex = await runner(codexCommand, ['--version'], {
    cwd: process.cwd(),
    timeoutMs: Number(env.CODEX_DISCOVERY_TIMEOUT_MS || 15000),
    env: { CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const evaluation = evaluateRoomNativeEnvironment(env, { models, codexAvailable: codex.ok });
  if (!discovery.ok) evaluation.errors.unshift(`Antigravity discovery failed: command=${antigravityCommand} exit_code=${discovery.exit_code}`);
  if (!codex.ok) evaluation.errors.push(`Codex check failed: command=${codexCommand} exit_code=${codex.exit_code}`);
  evaluation.ready = evaluation.errors.length === 0;
  return {
    schema_version: 'ddalggak.room_native_dogfood_readiness/v3',
    command: antigravityCommand,
    antigravity_command: antigravityCommand,
    discovery_args: discoveryArgs,
    discovery_ok: discovery.ok,
    codex_command: codexCommand,
    codex_check_ok: codex.ok,
    ...evaluation,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const output = await checkRoomNativeDogfood();
  console.log(JSON.stringify(output, null, 2));
  process.exit(output.ready ? 0 : 1);
}
