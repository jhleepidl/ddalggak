import fs from 'node:fs';
import path from 'node:path';
import { runCodexExec } from '../codex.js';
import { runAntigravityPrompt } from '../antigravity.js';
import {
  assertPathInside,
  copyWorkspaceSnapshot,
  directoryManifest,
  ensureDir,
  writeJsonAtomic,
} from './fs_utils.js';
import { validateRoomWorkspace } from './room_workspace_registry.js';

function resultOutput(result = {}) {
  return String(result?.stdout || result?.output || result?.stderr || '').trim();
}

function ensureProviderSuccess(provider = '', result = {}) {
  if (result?.ok === true) return;
  const message = String(result?.stderr || result?.error || `${provider} execution failed`).trim();
  const error = new Error(message || `${provider} execution failed`);
  error.code = 'ROOM_PROVIDER_EXECUTION_FAILED';
  error.provider = provider;
  error.result = result;
  throw error;
}

export class RoomAgentRuntime {
  constructor({ env = process.env, providers = {} } = {}) {
    this.env = env;
    this.providers = {
      codex: providers.codex || runCodexExec,
      antigravity: providers.antigravity || runAntigravityPrompt,
    };
  }

  prepareStageWorkspace({ roomId, roomPaths, runPaths, stage }) {
    const validated = validateRoomWorkspace(roomId, { env: this.env });
    if (validated.workspaceRoot !== roomPaths.workspaceRoot) throw new Error('Room workspace identity changed during execution');
    if (stage.access === 'workspace_write') return { executionRoot: validated.workspaceRoot, snapshot: false };
    const snapshotRoot = path.join(runPaths.snapshotsRoot, `${String(stage.order).padStart(2, '0')}-${stage.stage_id}`);
    copyWorkspaceSnapshot(validated.workspaceRoot, snapshotRoot);
    assertPathInside(runPaths.snapshotsRoot, snapshotRoot, 'read-only snapshot');
    return { executionRoot: snapshotRoot, snapshot: true };
  }

  async execute({ roomId, roomPaths, runPaths, stage, prompt, signal, modelPolicy = {}, onOutput = null }) {
    const prepared = this.prepareStageWorkspace({ roomId, roomPaths, runPaths, stage });
    const manifestOptions = {
      ignored: ['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.next', '.venv', 'venv', '.cache', 'dist', 'build', 'target', 'coverage'],
      maxEntries: Number(this.env.ROOM_WORKSPACE_MANIFEST_MAX_ENTRIES || 500000),
      maxHashBytes: Number(this.env.ROOM_WORKSPACE_MANIFEST_MAX_HASH_BYTES || 33554432),
    };
    const before = prepared.snapshot ? directoryManifest(roomPaths.workspaceRoot, manifestOptions) : null;
    const common = {
      workspaceRoot: prepared.executionRoot,
      cwd: prepared.executionRoot,
      prompt,
      signal,
      jobId: runPaths.runId,
      surface: `room_native_${stage.stage_id}`,
      agentId: `${stage.role}-${stage.stage_id}`,
      roleId: stage.role,
      traceMetadata: {
        room_id: roomId,
        room_run_id: runPaths.runId,
        room_workspace_root: roomPaths.workspaceRoot,
        stage_id: stage.stage_id,
        access: stage.access,
        snapshot: prepared.snapshot,
        paper_evidence_eligible: false,
        exploratory_only: true,
      },
      timeoutMs: Number(this.env.ROOM_AGENT_TIMEOUT_MS || 900000),
      env: this.env,
      onOutput: typeof onOutput === 'function' ? (event) => onOutput({ ...event, provider: event?.provider || stage.provider, stage_id: stage.stage_id, role: stage.role }) : null,
    };
    let result;
    if (stage.provider === 'codex') {
      result = await this.providers.codex({
        ...common,
        model: modelPolicy.codex_model || this.env.DDALGGAK_WORK_MODEL || this.env.CODEX_MODEL || '',
        reasoningEffort: modelPolicy.codex_reasoning_effort || this.env.CODEX_REASONING_EFFORT || '',
        addDirs: [],
        sandboxMode: stage.access === 'workspace_write' ? 'workspace-write' : 'read-only',
        approvalPolicy: 'never',
        configOverrides: {},
      });
    } else if (stage.provider === 'antigravity') {
      result = await this.providers.antigravity({
        ...common,
        model: modelPolicy.antigravity_model || this.env.ANTIGRAVITY_MODEL || '',
      });
    } else {
      throw new Error(`Unsupported Room provider: ${stage.provider}`);
    }
    ensureProviderSuccess(stage.provider, result);
    const after = prepared.snapshot ? directoryManifest(roomPaths.workspaceRoot, manifestOptions) : null;
    if (prepared.snapshot && JSON.stringify(before) !== JSON.stringify(after)) {
      const error = new Error(`Read-only Room agent mutated the canonical workspace during ${stage.stage_id}`);
      error.code = 'ROOM_READ_ONLY_MUTATION';
      throw error;
    }
    const rawFile = path.join(runPaths.rawRoot, `${String(stage.order).padStart(2, '0')}-${stage.stage_id}.json`);
    writeJsonAtomic(rawFile, {
      schema_version: 'ai_rooms.provider_result/v2',
      provider: stage.provider,
      stage_id: stage.stage_id,
      execution_root: prepared.executionRoot,
      canonical_workspace_root: roomPaths.workspaceRoot,
      snapshot: prepared.snapshot,
      result,
    });
    return {
      provider: stage.provider,
      execution_root: prepared.executionRoot,
      snapshot: prepared.snapshot,
      output: resultOutput(result),
      result,
      raw_file: rawFile,
    };
  }
}
