import fs from 'node:fs';
import path from 'node:path';
import { buildExecutionGraph, normalizeCollaborationProfile } from './room_execution_graph.js';
import { RoomLoopEngine } from './room_loop_engine.js';
import {
  createRoomRunId,
  findActiveRoomRun,
  listRoomRuns,
  readRoomRun,
  updateRoomRunControl,
  appendRoomRunEvent,
} from './room_run_store.js';
import { cleanText, readJson, writeJsonAtomic } from './fs_utils.js';
import { buildRoomNativeArtifactIndex, previewRoomNativeArtifact, resolveRoomNativeArtifactSelection, roomArtifactDeliveryLimits } from './room_native_artifacts.js';
import { appendRoomGovernanceCorrection, appendRoomGovernanceDecision, buildRoomNativeInbox, findInboxItem, normalizeInboxAction, readRoomGovernance, roomInboxItemId } from './room_governance_inbox.js';
import { normalizeRoomId, roomPaths } from './room_workspace_registry.js';
import { buildRoomContract, formatRoomContractSummary, normalizeRoomContract } from './room_contract.js';

function parseProfile(value = '') {
  const text = cleanText(value);
  const match = text.match(/(?:--profile|--collaboration|--topology|--mode)\s+([a-z0-9_-]+)/i);
  return match ? normalizeCollaborationProfile(match[1]) : '';
}

function stripFlags(value = '') {
  return cleanText(value).replace(/(?:--profile|--collaboration|--topology|--mode)\s+[a-z0-9_-]+/ig, '').trim();
}

function validVisibility(value = '') {
  const clean = cleanText(value).toLowerCase();
  return ['quiet', 'standard', 'debug'].includes(clean) ? clean : 'quiet';
}

function readReceiptIndex(run = null) {
  const checkpoint = run?.paths?.checkpointPath ? readJson(run.paths.checkpointPath, null) : null;
  return Array.isArray(checkpoint?.receipt_index) ? checkpoint.receipt_index : [];
}

export function deriveTelegramRoomId(chatId = '') {
  return normalizeRoomId(`telegram-${cleanText(chatId) || 'unknown'}`);
}

export class RoomNativeService {
  constructor({ env = process.env, engine = null } = {}) {
    this.env = env;
    this.engine = engine || new RoomLoopEngine({ env });
    this.active = new Map();
  }

  isEnabled() {
    return ['room_native_v2', 'room_native', 'v2'].includes(cleanText(this.env.ROOM_EXECUTION_ENGINE).toLowerCase());
  }

  getRoom(roomId, { create = true } = {}) {
    return roomPaths(roomId, { env: this.env, create });
  }

  initializeRoom(roomId, { title = '' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const current = readJson(paths.manifestPath, paths.manifest || {}) || {};
    const next = {
      ...current,
      schema_version: 'ai_rooms.room/v3',
      room_id: paths.roomId,
      ...(title ? { title: cleanText(title) } : {}),
      workspace_root: paths.workspaceRoot,
      state_root: paths.roomStateRoot,
      updated_at: new Date().toISOString(),
    };
    if (!current.created_at) next.created_at = next.updated_at;
    writeJsonAtomic(paths.manifestPath, next);
    return { ...paths, manifest: next };
  }

  async startRun({
    roomId,
    objective,
    topology = '',
    collaborationProfile = '',
    modelPolicy = {},
    visibility = 'quiet',
    roomContext = null,
    completionContract = [],
    requestedArtifacts = [],
    approvalPolicy = {},
    onProgress = null,
  } = {}) {
    const paths = this.initializeRoom(roomId);
    const active = this.active.get(paths.roomId) || findActiveRoomRun(paths.roomStateRoot);
    if (active) throw Object.assign(new Error(`Room already has an active run: ${active.paths?.runId || active.runId || 'unknown'}`), { code: 'ROOM_RUN_ALREADY_ACTIVE' });
    const cleanObjective = stripFlags(objective);
    if (!cleanObjective) throw new Error('Room run objective is required');
    const manifest = readJson(paths.manifestPath, paths.manifest || {}) || {};
    const requestedProfile = parseProfile(objective) || collaborationProfile || topology
      || cleanText(manifest.collaboration_profile_id)
      || cleanText(this.env.ROOM_DEFAULT_COLLABORATION_PROFILE)
      || 'solo';
    const profileId = normalizeCollaborationProfile(requestedProfile);
    const providerPolicy = {
      execution_provider: 'codex',
      research_provider: 'antigravity',
      review_provider: 'antigravity',
      provider_native_default: profileId === 'solo',
      ...modelPolicy,
    };
    const roomContract = buildRoomContract({
      roomId: paths.roomId,
      objective: cleanObjective,
      roomContext,
      previousContract: manifest.room_contract || null,
      completionContract,
      requestedArtifacts,
      providerPolicy,
      approvalPolicy,
    });
    writeJsonAtomic(paths.manifestPath, {
      ...manifest,
      schema_version: 'ai_rooms.room/v3',
      room_id: paths.roomId,
      workspace_root: paths.workspaceRoot,
      state_root: paths.roomStateRoot,
      collaboration_profile_id: profileId,
      room_contract: roomContract,
      updated_at: new Date().toISOString(),
    });
    const graph = buildExecutionGraph({
      objective: cleanObjective,
      collaborationProfile: profileId,
      maxReviewRounds: Number(this.env.ROOM_REVIEW_MAX_ROUNDS || 2),
    });
    const runId = createRoomRunId({ roomId: paths.roomId });
    const providerCapabilities = this.engine.agentRuntime?.inspectCapabilities?.() || null;
    const spec = {
      schema_version: 'ai_rooms.room_run/v3',
      run_id: runId,
      room_id: paths.roomId,
      objective: cleanObjective,
      workspace_root: paths.workspaceRoot,
      room_contract: roomContract,
      contract_hash: roomContract.contract_hash,
      execution_graph: graph,
      provider_capabilities: providerCapabilities,
      progress_policy: { visibility: validVisibility(visibility) },
      model_policy: modelPolicy,
      memory_policy: { raw_trace: 'append_only', working_memory: 'compacted', durable_memory: 'proposal_only' },
      checkpoint_policy: { provider_neutral: true, validate_workspace_revision_on_resume: true },
      created_at: new Date().toISOString(),
    };
    const controller = new AbortController();
    const completion = this.engine.execute({ roomPaths: paths, spec, signal: controller.signal, onProgress })
      .finally(() => this.active.delete(paths.roomId));
    this.active.set(paths.roomId, { runId, controller, completion, paths, spec });
    return { room: paths, run_id: runId, spec, completion };
  }

  async resumeRun({ roomId, onProgress = null } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const inMemory = this.active.get(paths.roomId);
    if (inMemory) {
      const activeRun = readRoomRun(paths.roomStateRoot, inMemory.runId);
      if (activeRun) updateRoomRunControl(activeRun.paths, { status: 'running', reason: 'resume_in_memory' });
      return { room: paths, run_id: inMemory.runId, spec: inMemory.spec, completion: inMemory.completion, resumed: true };
    }
    const persisted = findActiveRoomRun(paths.roomStateRoot)
      || listRoomRuns(paths.roomStateRoot, { limit: 20 }).find((run) => ['failed', 'paused', 'running', 'awaiting_approval'].includes(run.state.status));
    if (!persisted) throw Object.assign(new Error('No resumable Room run found'), { code: 'ROOM_RUN_NOT_FOUND' });
    updateRoomRunControl(persisted.paths, { status: 'running', reason: 'resume_after_restart' });
    const controller = new AbortController();
    const completion = this.engine.execute({ roomPaths: paths, spec: persisted.spec, existingRun: persisted, signal: controller.signal, onProgress })
      .finally(() => this.active.delete(paths.roomId));
    this.active.set(paths.roomId, { runId: persisted.paths.runId, controller, completion, paths, spec: persisted.spec });
    return { room: paths, run_id: persisted.paths.runId, spec: persisted.spec, completion, resumed: true };
  }

  hasState(roomId) {
    try {
      const paths = this.getRoom(roomId, { create: false });
      if (fs.existsSync(paths.manifestPath)) {
        const manifest = readJson(paths.manifestPath, null);
        if (manifest?.room_contract?.contract_hash || manifest?.room_contract?.goal || manifest?.room_contract?.objective) return true;
      }
      return listRoomRuns(paths.roomStateRoot, { limit: 1 }).length > 0;
    } catch {
      return false;
    }
  }

  contract(roomId) {
    const paths = this.getRoom(roomId, { create: true });
    const manifest = readJson(paths.manifestPath, {}) || {};
    return manifest.room_contract ? normalizeRoomContract(manifest.room_contract) : null;
  }

  receipts(roomId, { runId = '', limit = 20 } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const selected = cleanText(runId)
      ? readRoomRun(paths.roomStateRoot, cleanText(runId))
      : (findActiveRoomRun(paths.roomStateRoot) || listRoomRuns(paths.roomStateRoot, { limit: 1 })[0] || null);
    if (!selected) return { room_id: paths.roomId, run_id: null, receipts: [] };
    const index = readReceiptIndex(selected);
    const receipts = index.slice(-Math.max(1, Math.min(100, Number(limit) || 20))).map((summary) => {
      const file = fs.existsSync(selected.paths.receiptsRoot)
        ? fs.readdirSync(selected.paths.receiptsRoot).find((name) => name.endsWith(`${summary.stage_id}.json`))
        : '';
      return file ? readJson(path.join(selected.paths.receiptsRoot, file), summary) : summary;
    });
    return { room_id: paths.roomId, run_id: selected.paths.runId, status: selected.state.status, receipts };
  }

  artifacts(roomId, { runId = '', limit = 24 } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const selected = cleanText(runId)
      ? readRoomRun(paths.roomStateRoot, cleanText(runId))
      : (findActiveRoomRun(paths.roomStateRoot) || listRoomRuns(paths.roomStateRoot, { limit: 1 })[0] || null);
    if (!selected) return { room_id: paths.roomId, run_id: null, status: null, contract_revision: null, artifacts: [] };
    const checkpoint = selected.paths.checkpointPath ? readJson(selected.paths.checkpointPath, null) : null;
    const rows = Array.isArray(checkpoint?.artifacts) ? checkpoint.artifacts : (Array.isArray(selected.workingMemory?.artifacts) ? selected.workingMemory.artifacts : []);
    const receiptResult = this.receipts(paths.roomId, { runId: selected.paths.runId, limit: 100 });
    const contract = selected.spec?.room_contract || this.contract(paths.roomId);
    const artifacts = buildRoomNativeArtifactIndex({
      workspaceRoot: paths.workspaceRoot,
      checkpointArtifacts: rows,
      receipts: receiptResult.receipts,
      contract,
      limit,
      env: this.env,
    });
    const governance = readRoomGovernance(paths.roomStateRoot);
    const decisions = new Map((governance.decisions || []).map((decision) => [String(decision?.item_id || ''), decision]));
    for (const artifact of artifacts) {
      const artifactPath = cleanText(artifact?.relative_path || artifact?.location || artifact?.artifact_id);
      const approvalItemId = roomInboxItemId('artifact', `${selected.paths.runId}\n${artifactPath}`);
      const decision = decisions.get(approvalItemId);
      artifact.approval_item_id = approvalItemId;
      if (decision?.action === 'approve') artifact.approval_state = 'approved';
      else if (decision?.action === 'reject') artifact.approval_state = 'rejected';
    }
    return {
      room_id: paths.roomId,
      run_id: selected.paths.runId,
      status: selected.state.status,
      workspace_root: paths.workspaceRoot,
      contract_revision: contract?.contract_revision || null,
      contract_hash: contract?.contract_hash || null,
      artifacts,
    };
  }

  artifact(roomId, { runId = '', selection = '', limit = 100 } = {}) {
    const result = this.artifacts(roomId, { runId, limit });
    return { ...result, artifact: resolveRoomNativeArtifactSelection(result.artifacts, selection) };
  }

  previewArtifact(roomId, { runId = '', selection = '', limit = 100 } = {}) {
    const result = this.artifact(roomId, { runId, selection, limit });
    return { ...result, preview: previewRoomNativeArtifact(result.artifact, { env: this.env }) };
  }

  artifactDeliveryLimits() {
    return roomArtifactDeliveryLimits(this.env);
  }

  recordArtifactDelivery(roomId, { runId = '', artifact = null, action = 'sent', actor = 'user' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const selected = cleanText(runId)
      ? readRoomRun(paths.roomStateRoot, cleanText(runId))
      : (findActiveRoomRun(paths.roomStateRoot) || listRoomRuns(paths.roomStateRoot, { limit: 1 })[0] || null);
    if (!selected) return null;
    return appendRoomRunEvent(selected.paths, {
      event_type: 'room_artifact_accessed',
      action: cleanText(action).toLowerCase(),
      artifact_id: cleanText(artifact?.artifact_id),
      artifact_path: cleanText(artifact?.relative_path || artifact?.location),
      receipt_hash: cleanText(artifact?.receipt_hash),
      bytes: Number(artifact?.bytes || 0) || 0,
      contract_revision: Number(artifact?.contract_revision || 0) || null,
      contract_hash: cleanText(artifact?.contract_hash),
      approval_state: cleanText(artifact?.approval_state).toLowerCase(),
      actor: cleanText(actor).slice(0, 160),
    });
  }

  inbox(roomId, { runId = '' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const status = this.status(paths.roomId);
    const selectedRunId = runId || status.focus_run_id || '';
    const receipts = this.receipts(paths.roomId, { runId: selectedRunId, limit: 100 }).receipts;
    const artifacts = this.artifacts(paths.roomId, { runId: selectedRunId, limit: 100 }).artifacts;
    const governance = readRoomGovernance(paths.roomStateRoot);
    return buildRoomNativeInbox({ status, receipts, artifacts, governance });
  }

  decideInboxItem(roomId, { itemId = '', action = '', note = '', actor = 'user' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const inbox = this.inbox(paths.roomId);
    const item = findInboxItem(inbox, itemId);
    if (!item) throw Object.assign(new Error(`Inbox item not found: ${itemId}`), { code: 'ROOM_INBOX_ITEM_NOT_FOUND' });
    const normalizedAction = normalizeInboxAction(action);
    if (!normalizedAction || !Array.isArray(item.actions) || !item.actions.includes(normalizedAction)) {
      throw Object.assign(new Error(`Action ${action || '-'} is not allowed for ${item.kind}`), { code: 'ROOM_INBOX_ACTION_NOT_ALLOWED' });
    }
    if (item.kind === 'blocker' && normalizedAction === 'resolve' && !cleanText(note)) {
      throw Object.assign(new Error('Blocker를 닫으려면 결정 또는 수용 근거를 메모로 남겨야 합니다.'), { code: 'ROOM_INBOX_BLOCKER_NOTE_REQUIRED' });
    }
    let control = null;
    if (item.kind === 'approval') {
      control = normalizedAction === 'approve'
        ? this.control(paths.roomId, 'resume', 'telegram_inbox_approval')
        : this.control(paths.roomId, 'cancel', `telegram_inbox_rejection:${cleanText(note).slice(0, 300)}`);
      if (normalizedAction === 'approve' && control?.reason === 'resume_requires_executor_restart') {
        control = { ...control, requires_continue: true };
      }
    }
    const decision = appendRoomGovernanceDecision(paths.roomStateRoot, {
      item_id: item.item_id,
      item_kind: item.kind,
      action: normalizedAction,
      note,
      actor,
      source_run_id: item.source_run_id || inbox.run_id || '',
    });
    const selected = item.source_run_id ? readRoomRun(paths.roomStateRoot, item.source_run_id) : null;
    if (selected) appendRoomRunEvent(selected.paths, {
      event_type: 'room_inbox_decision',
      item_id: item.item_id,
      item_kind: item.kind,
      action: normalizedAction,
      note: cleanText(note).slice(0, 600),
      actor: cleanText(actor).slice(0, 160),
    });
    return { ok: true, item, decision, control, inbox: this.inbox(paths.roomId) };
  }

  recordCorrection(roomId, { text = '', actor = 'user', scope = 'room', appliesTo = 'next_run' } = {}) {
    const cleanCorrection = cleanText(text).slice(0, 2400);
    if (!cleanCorrection) throw Object.assign(new Error('Correction text is required'), { code: 'ROOM_CORRECTION_REQUIRED' });
    const paths = this.initializeRoom(roomId);
    const manifest = readJson(paths.manifestPath, paths.manifest || {}) || {};
    const previous = manifest.room_contract ? normalizeRoomContract(manifest.room_contract) : normalizeRoomContract({ room_id: paths.roomId, goal: '', objective: '' });
    const duplicate = (previous.corrections || []).find((row) => cleanText(row?.text).toLowerCase() === cleanCorrection.toLowerCase() && cleanText(row?.status || 'active').toLowerCase() === 'active');
    const active = this.active.get(paths.roomId) || findActiveRoomRun(paths.roomStateRoot);
    if (duplicate) {
      return {
        ok: true,
        duplicate: true,
        correction: duplicate,
        applies_to: active ? 'next_run' : 'next_run',
        active_run_id: active?.runId || active?.paths?.runId || null,
        contract: previous,
      };
    }
    const correction = {
      correction_id: `correction-${Date.now()}`,
      text: cleanCorrection,
      status: 'active',
      scope: cleanText(scope || 'room').toLowerCase(),
      source: 'telegram_user',
    };
    const next = normalizeRoomContract({
      ...previous,
      corrections: [...(previous.corrections || []), correction],
      contract_revision: Number(previous.contract_revision || 1) + 1,
      updated_at: new Date().toISOString(),
    });
    writeJsonAtomic(paths.manifestPath, {
      ...manifest,
      schema_version: 'ai_rooms.room/v3',
      room_id: paths.roomId,
      workspace_root: paths.workspaceRoot,
      state_root: paths.roomStateRoot,
      room_contract: next,
      updated_at: next.updated_at,
    });
    const applies = active ? (cleanText(appliesTo).toLowerCase() === 'restart' ? 'restart_requested' : 'next_run') : 'next_run';
    const record = appendRoomGovernanceCorrection(paths.roomStateRoot, {
      ...correction,
      actor,
      applies_to: applies,
      source_run_id: active?.runId || active?.paths?.runId || '',
      contract_revision: next.contract_revision,
    });
    const selected = active?.paths ? active : active?.runId ? readRoomRun(paths.roomStateRoot, active.runId) : null;
    if (selected?.paths) appendRoomRunEvent(selected.paths, {
      event_type: 'room_correction_recorded',
      correction_id: correction.correction_id,
      applies_to: applies,
      contract_revision: next.contract_revision,
      actor: cleanText(actor).slice(0, 160),
    });
    return {
      ok: true,
      duplicate: false,
      correction: record,
      applies_to: applies,
      active_run_id: active?.runId || active?.paths?.runId || null,
      contract: next,
    };
  }

  async restartWithCorrection(roomId, { text = '', actor = 'user', scope = 'room', onProgress = null } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const memory = this.active.get(paths.roomId);
    const persisted = memory?.runId ? readRoomRun(paths.roomStateRoot, memory.runId) : findActiveRoomRun(paths.roomStateRoot);
    const spec = memory?.spec || persisted?.spec || null;
    const correction = this.recordCorrection(paths.roomId, { text, actor, scope, appliesTo: spec ? 'restart' : 'next_run' });
    if (!spec) return { correction, restarted: false, started: null };
    if (memory?.controller) memory.controller.abort('correction_redirect');
    if (persisted?.paths) updateRoomRunControl(persisted.paths, { status: 'cancelled', reason: 'correction_redirect' });
    try { if (memory?.completion) await memory.completion; } catch {}
    this.active.delete(paths.roomId);
    const contract = correction.contract;
    const roomContext = {
      goal: contract.goal,
      rules: contract.constraints,
      corrections: contract.corrections,
      source_policy: {
        included_sources: contract.sources?.authoritative || [],
        excluded_sources: contract.sources?.excluded || [],
      },
      next_action: contract.continuity?.next_action || '',
    };
    const started = await this.startRun({
      roomId: paths.roomId,
      objective: spec.objective,
      collaborationProfile: spec.execution_graph?.collaboration_profile_id || spec.execution_graph?.topology_id || '',
      modelPolicy: spec.model_policy || {},
      visibility: spec.progress_policy?.visibility || 'quiet',
      roomContext,
      completionContract: contract.completion_contract || [],
      requestedArtifacts: contract.requested_artifacts || [],
      approvalPolicy: contract.approval_policy || {},
      onProgress,
    });
    return { correction, restarted: true, previous_run_id: persisted?.paths?.runId || memory?.runId || null, started };
  }

  status(roomId) {
    const paths = this.getRoom(roomId, { create: true });
    const activeMemory = this.active.get(paths.roomId);
    const activeRun = activeMemory ? readRoomRun(paths.roomStateRoot, activeMemory.runId) : findActiveRoomRun(paths.roomStateRoot);
    const recent = listRoomRuns(paths.roomStateRoot, { limit: 5 });
    const focusRun = activeRun || recent[0] || null;
    const completed = new Set(focusRun?.state?.completed_stage_ids || []);
    const skipped = new Set(focusRun?.state?.skipped_stage_ids || []);
    const stages = focusRun?.spec?.execution_graph?.stages || [];
    const nextStage = stages.find((stage) => !completed.has(stage.stage_id) && !skipped.has(stage.stage_id)) || null;
    const doneCount = completed.size + skipped.size;
    const contract = focusRun?.spec?.room_contract || this.contract(paths.roomId);
    const checkpoint = focusRun?.paths?.checkpointPath ? readJson(focusRun.paths.checkpointPath, null) : null;
    const status = {
      room_id: paths.roomId,
      workspace_root: paths.workspaceRoot,
      state_root: paths.roomStateRoot,
      active_run_id: activeMemory?.runId || activeRun?.paths?.runId || null,
      active_state: activeRun?.state || null,
      focus_run_id: focusRun?.paths?.runId || null,
      focus_status: focusRun?.state?.status || null,
      objective: focusRun?.spec?.objective || contract?.objective || '',
      goal: contract?.goal || '',
      next_action: checkpoint?.next_actions?.[0] || contract?.continuity?.next_action || '',
      collaboration_profile_id: focusRun?.spec?.execution_graph?.collaboration_profile_id || focusRun?.spec?.execution_graph?.topology_id || '',
      topology_id: focusRun?.spec?.execution_graph?.topology_id || '',
      contract_revision: contract?.contract_revision || null,
      contract_hash: contract?.contract_hash || null,
      current_stage_id: focusRun?.state?.current_stage_id || null,
      next_stage_id: nextStage?.stage_id || null,
      stage_done_count: doneCount,
      stage_total: stages.length,
      workspace_revision: checkpoint?.workspace_revision || null,
      checkpoint_hash: checkpoint?.checkpoint_hash || null,
      receipt_count: Array.isArray(checkpoint?.receipt_index) ? checkpoint.receipt_index.length : 0,
      open_blockers: focusRun?.workingMemory?.open_blockers || checkpoint?.open_blockers || [],
      recent_runs: recent.map((run) => ({
        run_id: run.paths.runId,
        status: run.state.status,
        objective: run.spec.objective,
        collaboration_profile_id: run.spec.execution_graph?.collaboration_profile_id || run.spec.execution_graph?.topology_id,
        updated_at: run.state.updated_at,
      })),
    };
    const governance = readRoomGovernance(paths.roomStateRoot);
    const unresolved = buildRoomNativeInbox({ status, receipts: [], governance }).items
      .filter((item) => item.kind === 'blocker')
      .map((item) => item.title);
    status.open_blockers = unresolved;
    return status;
  }

  timeline(roomId, { limit = 20, runId = '' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const selected = cleanText(runId)
      ? readRoomRun(paths.roomStateRoot, cleanText(runId))
      : (findActiveRoomRun(paths.roomStateRoot) || listRoomRuns(paths.roomStateRoot, { limit: 1 })[0] || null);
    if (!selected || !fs.existsSync(selected.paths.eventsPath)) return { room_id: paths.roomId, run_id: null, events: [] };
    const rows = fs.readFileSync(selected.paths.eventsPath, 'utf8')
      .split(/\r?\n/).filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .filter((event) => [
        'run_started', 'run_resumed', 'stage_started', 'stage_output', 'stage_completed', 'stage_skipped',
        'stage_retry', 'stage_attempt_failed', 'review_feedback_delivered', 'review_feedback_consumed',
        'execution_receipt_recorded', 'checkpoint_written', 'workspace_revision_drift_accepted',
        'run_completed', 'run_completed_with_blockers', 'run_failed', 'run_cancelled', 'control_updated',
      ].includes(event.event_type));
    return {
      room_id: paths.roomId,
      run_id: selected.paths.runId,
      status: selected.state.status,
      objective: selected.spec.objective,
      collaboration_profile_id: selected.spec.execution_graph?.collaboration_profile_id || selected.spec.execution_graph?.topology_id,
      events: rows.slice(-Math.max(1, Math.min(100, Number(limit) || 20))),
    };
  }

  control(roomId, action = '', reason = '') {
    const paths = this.getRoom(roomId, { create: true });
    const memory = this.active.get(paths.roomId);
    const activeRun = findActiveRoomRun(paths.roomStateRoot);
    const runPaths = activeRun?.paths;
    if (!memory && !runPaths) return { ok: false, reason: 'no_active_run' };
    const cleanAction = cleanText(action).toLowerCase();
    if (cleanAction === 'cancel') {
      if (memory?.controller) memory.controller.abort(reason || 'cancelled_by_user');
      if (runPaths) updateRoomRunControl(runPaths, { status: 'cancelled', reason: reason || 'cancelled_by_user' });
      return { ok: true, status: 'cancelled' };
    }
    if (!runPaths) return { ok: false, reason: memory ? 'control_not_ready' : 'run_state_not_materialized_yet' };
    if (cleanAction === 'resume' && !memory) return { ok: false, reason: 'resume_requires_executor_restart' };
    const status = cleanAction === 'pause' ? 'paused' : cleanAction === 'resume' ? 'running' : '';
    if (!status) return { ok: false, reason: 'unsupported_control' };
    updateRoomRunControl(runPaths, { status, reason: reason || `user_${cleanAction}` });
    return { ok: true, status };
  }

  setVisibility(roomId, visibility = 'quiet') {
    const paths = this.getRoom(roomId, { create: true });
    const file = path.join(paths.roomStateRoot, 'preferences.json');
    const clean = validVisibility(visibility);
    writeJsonAtomic(file, { progress_visibility: clean, updated_at: new Date().toISOString() });
    return clean;
  }
}

export function formatRoomNativeStatus(status = {}) {
  const total = Number(status.stage_total || 0);
  const done = Number(status.stage_done_count || 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const rows = [
    `🏠 Room ${status.room_id || '-'}`,
    status.goal ? `Room 목표: ${status.goal}` : '',
    status.objective && status.objective !== status.goal ? `현재 실행: ${status.objective}` : '',
    `상태: ${status.focus_status || '실행 기록 없음'}`,
    status.focus_run_id ? `run: ${status.focus_run_id}` : '',
    status.collaboration_profile_id ? `profile: ${status.collaboration_profile_id}` : '',
    status.contract_revision ? `contract: v${status.contract_revision} · ${String(status.contract_hash || '').slice(0, 12)}` : '',
    total > 0 ? `진행: ${done}/${total} (${percent}%)` : '',
    status.current_stage_id ? `현재 단계: ${status.current_stage_id}` : '',
    status.next_stage_id && status.next_stage_id !== status.current_stage_id ? `다음 단계: ${status.next_stage_id}` : '',
    status.next_action ? `다음 행동: ${status.next_action}` : '',
    status.receipt_count ? `execution receipts: ${status.receipt_count}` : '',
    status.checkpoint_hash ? `checkpoint: ${String(status.checkpoint_hash).slice(0, 12)}` : '',
    Array.isArray(status.open_blockers) && status.open_blockers.length ? `미해결 blocker: ${status.open_blockers.length}` : '',
    `workspace: ${status.workspace_root || '-'}`,
  ].filter(Boolean);
  if (status.active_run_id) rows.push('', '제어: /room pause · /room cancel · /room timeline');
  else if (status.focus_run_id) rows.push('', '확인: /room timeline · /room receipts · 새 실행: /room run <목표>');
  else rows.push('', '시작: /room run <목표>');
  if (Array.isArray(status.recent_runs) && status.recent_runs.length > 1) {
    rows.push('', '최근 실행:');
    for (const run of status.recent_runs.slice(0, 3)) rows.push(`- ${run.run_id}: ${run.status} · ${run.collaboration_profile_id || '-'} · ${String(run.objective || '').slice(0, 60)}`);
  }
  return rows.join('\n');
}

export function formatRoomNativeTimeline(timeline = {}) {
  if (!timeline.run_id) return '표시할 Room 실행 기록이 없습니다.';
  const labels = {
    run_started: '🚀 시작', run_resumed: '▶️ 재개', stage_started: '▶️ 단계 시작', stage_output: '  · 활동',
    stage_completed: '✅ 단계 완료', stage_skipped: '⏭️ 단계 건너뜀', stage_retry: '🔁 재시도',
    stage_attempt_failed: '⚠️ 시도 실패', review_feedback_delivered: '📨 리뷰 전달', review_feedback_consumed: '📥 리뷰 반영',
    execution_receipt_recorded: '🧾 실행 영수증', checkpoint_written: '💾 체크포인트',
    workspace_revision_drift_accepted: '⚠️ workspace 변경 허용', run_completed: '🏁 완료',
    run_completed_with_blockers: '⚠️ blocker와 함께 완료', run_failed: '❌ 실패', run_cancelled: '🛑 취소', control_updated: '🎛️ 제어 변경',
  };
  const rows = [
    `🧭 Room timeline · ${timeline.run_id}`,
    timeline.objective ? `목표: ${timeline.objective}` : '',
    timeline.collaboration_profile_id ? `profile: ${timeline.collaboration_profile_id}` : '',
    `상태: ${timeline.status || '-'}`,
    '',
  ].filter((value, index) => value || index === 4);
  for (const event of timeline.events || []) {
    const label = labels[event.event_type] || event.event_type;
    const stage = event.stage_id ? ` · ${event.stage_id}` : '';
    const provider = event.provider ? ` · ${event.provider}${event.role ? `/${event.role}` : ''}` : '';
    const kind = event.event_type === 'stage_output' && event.output_kind ? ` · ${event.output_kind}` : '';
    let time = '';
    try {
      time = event.at ? new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(event.at)) : '';
    } catch {}
    const message = cleanText(event.message || event.summary || event.reason || event.error?.message || '');
    const evidence = event.event_type === 'execution_receipt_recorded'
      ? `files=${event.file_change_count || 0}, validations=${event.validation_count || 0}, blockers=${event.blocker_count || 0}`
      : event.event_type === 'checkpoint_written' ? `next=${event.next_stage_id || 'done'}` : '';
    rows.push(`${time ? `${time} ` : ''}${label}${stage}${provider}${kind}${message ? ` — ${message.slice(0, 280)}` : evidence ? ` — ${evidence}` : ''}`);
  }
  return rows.join('\n');
}

export function formatRoomNativeContract(contract = null) {
  return contract ? formatRoomContractSummary(contract) : '아직 Room Contract가 없습니다. /room run <목표>로 첫 실행을 시작하세요.';
}

export function formatRoomNativeReceipts(result = {}) {
  if (!result.run_id) return '표시할 Execution Receipt가 없습니다.';
  const rows = [`🧾 Execution Receipts · ${result.run_id}`, `상태: ${result.status || '-'}`, ''];
  for (const receipt of result.receipts || []) {
    rows.push(`- ${receipt.stage_id || '-'} · ${receipt.provider || '-'} · ${receipt.status || '-'}`);
    rows.push(`  files=${receipt.workspace?.files_changed?.length || receipt.file_change_count || 0} · validations=${receipt.reported?.validations?.length || receipt.validation_count || 0} · blockers=${receipt.reported?.blocking_issues?.length || receipt.blocker_count || 0}`);
    const hash = receipt.receipt_hash || '';
    if (hash) rows.push(`  receipt=${hash.slice(0, 16)} · workspace=${String(receipt.workspace?.revision_after || receipt.workspace_revision_after || '').slice(0, 16)}`);
  }
  return rows.join('\n');
}
