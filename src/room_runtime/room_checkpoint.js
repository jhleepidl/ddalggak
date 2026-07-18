import path from 'node:path';
import { cleanText, directoryManifest, readJson, sha256, writeJsonAtomic } from './fs_utils.js';
import { stableJson } from './room_contract.js';
import { hashWorkspaceManifest } from './room_execution_receipt.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unique(values = [], limit = 128, keySelector = null) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const selected = keySelector
      ? keySelector(value)
      : (typeof value === 'string' ? value : value?.location || value?.path || value?.text || value?.receipt_id || value?.id || '');
    const text = cleanText(selected);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(typeof value === 'string' ? text : value);
    if (out.length >= limit) break;
  }
  return out;
}

export function computeWorkspaceRevision(workspaceRoot = '', env = process.env) {
  const manifest = directoryManifest(workspaceRoot, {
    ignored: ['.git', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache', '.next', '.venv', 'venv', '.cache', 'dist', 'build', 'target', 'coverage'],
    maxEntries: Number(env.ROOM_WORKSPACE_MANIFEST_MAX_ENTRIES || 500000),
    maxHashBytes: Number(env.ROOM_WORKSPACE_MANIFEST_MAX_HASH_BYTES || 33554432),
  });
  return { revision: hashWorkspaceManifest(manifest), manifest };
}

function nextIncompleteStage(spec = {}, state = {}) {
  const completed = new Set(asArray(state.completed_stage_ids));
  const skipped = new Set(asArray(state.skipped_stage_ids));
  return asArray(spec.execution_graph?.stages).find((stage) => !completed.has(stage.stage_id) && !skipped.has(stage.stage_id)) || null;
}

export function buildProviderNeutralCheckpoint({
  run = {},
  spec = {},
  workingMemory = {},
  receipt = null,
  workspaceRevision = '',
  status = '',
} = {}) {
  const state = asObject(run.state);
  const contract = asObject(spec.room_contract);
  const nextStage = nextIncompleteStage(spec, state);
  const prior = readJson(run.paths?.checkpointPath || '', null);
  const receipts = unique([
    ...asArray(prior?.receipt_index),
    ...(receipt ? [{
      receipt_id: receipt.receipt_id,
      stage_id: receipt.stage_id,
      provider: receipt.provider,
      status: receipt.status,
      receipt_hash: receipt.receipt_hash,
      workspace_revision_after: receipt.workspace?.revision_after || null,
    }] : []),
  ], 256, (value) => value?.receipt_id || `${value?.stage_id || ''}:${value?.receipt_hash || ''}`);
  const artifacts = unique([
    ...asArray(prior?.artifacts),
    ...asArray(workingMemory.artifacts),
    ...asArray(receipt?.reported?.artifacts),
  ], 256);
  const checkpoint = {
    schema_version: 'ai_rooms.provider_neutral_checkpoint/v1',
    run_id: spec.run_id || run.paths?.runId || null,
    room_id: spec.room_id || null,
    room_contract: {
      schema_version: contract.schema_version || null,
      revision: contract.contract_revision || null,
      hash: contract.contract_hash || spec.contract_hash || null,
    },
    collaboration_profile_id: spec.execution_graph?.collaboration_profile_id || spec.execution_graph?.topology_id || null,
    status: status || state.status || 'running',
    completed_stage_ids: asArray(state.completed_stage_ids),
    skipped_stage_ids: asArray(state.skipped_stage_ids),
    current_stage_id: state.current_stage_id || null,
    next_stage_id: nextStage?.stage_id || null,
    workspace_revision: workspaceRevision || receipt?.workspace?.revision_after || prior?.workspace_revision || null,
    decisions: unique(asArray(workingMemory.decisions), 128),
    open_blockers: unique(asArray(workingMemory.open_blockers), 128),
    next_actions: unique(asArray(workingMemory.next_actions), 128),
    artifacts,
    receipt_index: receipts,
    authoritative_sources: asArray(contract.sources?.authoritative).slice(0, 128),
    excluded_sources: asArray(contract.sources?.excluded).slice(0, 128),
    active_corrections: asArray(contract.corrections).filter((row) => String(row?.status || 'active').toLowerCase() === 'active').slice(0, 128),
    provider_sessions_required: false,
    resume_contract: {
      restore_room_contract_hash: contract.contract_hash || spec.contract_hash || null,
      restore_workspace_revision: workspaceRevision || receipt?.workspace?.revision_after || prior?.workspace_revision || null,
      resume_at_stage_id: nextStage?.stage_id || null,
      provider_may_change: true,
    },
    updated_at: new Date().toISOString(),
  };
  checkpoint.checkpoint_hash = sha256(stableJson(checkpoint));
  return checkpoint;
}

export function writeProviderNeutralCheckpoint(paths = {}, checkpoint = {}, stage = null) {
  writeJsonAtomic(paths.checkpointPath, checkpoint);
  if (stage?.stage_id && paths.checkpointsRoot) {
    const file = path.join(paths.checkpointsRoot, `${String(stage.order || 0).padStart(2, '0')}-${stage.stage_id}.json`);
    writeJsonAtomic(file, checkpoint);
  }
  return paths.checkpointPath;
}

export function validateResumeCheckpoint({ paths = {}, spec = {}, workspaceRoot = '', env = process.env } = {}) {
  const checkpoint = readJson(paths.checkpointPath, null);
  if (!checkpoint) return { ok: true, checkpoint: null, drift: false };
  const expectedContract = checkpoint.room_contract?.hash || null;
  const actualContract = spec.room_contract?.contract_hash || spec.contract_hash || null;
  if (expectedContract && actualContract && expectedContract !== actualContract) {
    const error = new Error(`Room contract changed since checkpoint: expected=${expectedContract} actual=${actualContract}`);
    error.code = 'ROOM_CONTRACT_REVISION_DRIFT';
    throw error;
  }
  const current = computeWorkspaceRevision(workspaceRoot, env);
  const expectedWorkspace = checkpoint.workspace_revision || checkpoint.resume_contract?.restore_workspace_revision || null;
  const drift = Boolean(expectedWorkspace && current.revision !== expectedWorkspace);
  const allowDrift = ['1', 'true', 'yes', 'on'].includes(String(env.ROOM_RESUME_ALLOW_WORKSPACE_DRIFT || '').trim().toLowerCase());
  if (drift && !allowDrift) {
    const error = new Error(`Room workspace changed since checkpoint: expected=${expectedWorkspace} actual=${current.revision}`);
    error.code = 'ROOM_WORKSPACE_REVISION_DRIFT';
    error.expected_revision = expectedWorkspace;
    error.actual_revision = current.revision;
    throw error;
  }
  return { ok: true, checkpoint, drift, current_revision: current.revision, expected_revision: expectedWorkspace };
}
