import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

import { GocClient } from '../goc_client.js';
import { readRoomJourneyTrace } from '../application/room_journey_trace.js';
import { runCodexExec } from '../codex.js';
import { runClaudeCliPrompt } from '../claude_cli.js';
import { runAntigravityPrompt } from '../antigravity.js';
import { createHeadlessRoomRuntime } from './headless_room_runtime.js';
import { getAgentRoomProfile, upsertAgentRoomProfile } from '../application/agent_room_profile.js';
import { buildRoomFirstTeamConfiguration } from '../application/ai_room_runtime_selection.js';
import { classifyRoomConciergeRoute } from '../application/room_concierge.js';
import { buildRoomTurnRoute } from '../application/room_turn_router.js';
import { appendRoomConversationExchange } from '../application/room_conversation_ledger.js';
import { recordUserFactEvents } from '../application/user_fact_context.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function nowIso() { return new Date().toISOString(); }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'; }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function appendJsonl(file, value) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function clamp(value, fallback, min, max) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback; }
function stableValue(value) {
  if (Array.isArray(value)) return value.map((item) => stableValue(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
function stableSha256(value) { return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex'); }

function deepClone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function fileSha256(filePath = '') { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }
function walkRegularFiles(root = '') {
  const resolved = path.resolve(root || '.');
  if (!fs.existsSync(resolved)) return [];
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  visit(resolved);
  return out.sort();
}
function frozenSnapshotFileIncluded(relative = '') {
  const rel = clean(relative).replaceAll('\\', '/');
  if (!rel) return false;
  if (rel === 'runtime_events.jsonl' || rel === 'job.log' || rel === 'meta.json') return false;
  if (rel.startsWith('llm_traces/') || rel.includes('/llm_traces/')) return false;
  if (rel.startsWith('improvement_debug/') || rel.includes('/improvement_debug/')) return false;
  return true;
}
function copyFrozenJobState(sourceDir = '', destinationDir = '') {
  ensureDir(destinationDir);
  for (const sourceFile of walkRegularFiles(sourceDir)) {
    const rel = path.relative(sourceDir, sourceFile);
    if (!frozenSnapshotFileIncluded(rel)) continue;
    const destinationFile = path.join(destinationDir, rel);
    ensureDir(path.dirname(destinationFile));
    fs.copyFileSync(sourceFile, destinationFile);
  }
}
function frozenJobStateManifest(root = '') {
  return walkRegularFiles(root)
    .map((file) => ({ relative_path: path.relative(root, file).replaceAll('\\', '/'), sha256: fileSha256(file), size_bytes: fs.statSync(file).size }))
    .filter((row) => frozenSnapshotFileIncluded(row.relative_path));
}
function canonicalFrozenSession(session = {}) {
  const row = deepClone(asObject(session));
  row.chat_id = '__FROZEN_ROOM__';
  row.jobId = '__FROZEN_JOB__';
  row.state = 'idle';
  row.active_run_id = null;
  row.pending_approval = null;
  row.interrupt = null;
  row.agent_status = {};
  row.current_turn_ack_message_id = null;
  row.current_turn_plan_message_id = null;
  row.room_journey_identity = { transport: 'headless', snapshot: true };
  delete row.updated_at;
  return row;
}
function authoritativeContextManifestFromScenario(scenario = {}, targetStepId = '') {
  const required = routingRequiredContextStepIds(scenario);
  if (!required.length) return null;
  const byId = new Map(asArray(scenario.steps).map((step) => [clean(step?.id), step]));
  const items = required.map((stepId) => {
    const step = byId.get(stepId);
    const text = clean(step?.text);
    return { source_step_id: stepId, authority: 'user_source_of_truth', text, sha256: stableSha256({ source_step_id: stepId, text }) };
  }).filter((row) => row.text);
  if (items.length !== required.length) return { manifest_id: null, required_source_step_ids: required, items, complete: false };
  const canonical = { scenario_id: clean(scenario.id), target_step_id: clean(targetStepId), items };
  const sha256 = stableSha256(canonical);
  return {
    schema_version: 'ddalggak.authoritative_context_manifest/v1',
    manifest_id: `ctx_${sha256.slice(0, 20)}`,
    sha256,
    scenario_id: clean(scenario.id),
    target_step_id: clean(targetStepId),
    required_source_step_ids: required,
    items,
    complete: true,
  };
}
function renderAuthoritativeContextEnvelope(text = '', manifest = null) {
  const row = asObject(manifest);
  const items = asArray(row.items);
  if (!clean(row.manifest_id) || !items.length) return clean(text);
  const evidence = items.map((item) => `- source_step_id=${clean(item.source_step_id)} sha256=${clean(item.sha256)}\n  ${clean(item.text)}`).join('\n');
  return [
    `[ROOM_JOURNEY_AUTHORITATIVE_CONTEXT manifest_id=${clean(row.manifest_id)} sha256=${clean(row.sha256)}]`,
    'The following items are the immutable Room source of truth for this benchmark turn. Do not replace them with assumptions.',
    evidence,
    '[/ROOM_JOURNEY_AUTHORITATIVE_CONTEXT]',
    '',
    clean(text),
  ].join('\n');
}

export function loadRoomJourneyScenario(filePath) {
  const row = readJson(filePath);
  if (!clean(row.id)) throw new Error(`Room journey scenario missing id: ${filePath}`);
  if (!asArray(row.steps).length) throw new Error(`Room journey scenario missing steps: ${filePath}`);
  const ids = new Set();
  for (const step of row.steps) {
    const id = clean(step?.id);
    if (!id) throw new Error(`Room journey step missing id: ${filePath}`);
    if (ids.has(id)) throw new Error(`Duplicate Room journey step id: ${id}`);
    ids.add(id);
    if (!clean(step?.action)) throw new Error(`Room journey step missing action: ${id}`);
  }
  return { ...row, __file: path.resolve(filePath) };
}

export function loadRoomJourneySuite(filePath) {
  const row = readJson(filePath);
  const base = path.dirname(path.resolve(filePath));
  const files = asArray(row.scenarios).map((entry) => path.resolve(base, typeof entry === 'string' ? entry : entry.path));
  if (!files.length) throw new Error(`Room journey suite has no scenarios: ${filePath}`);
  return { ...row, __file: path.resolve(filePath), scenario_files: files };
}

function normalizeArm(raw = {}, fallbackId = 'default') {
  const row = asObject(raw);
  return {
    id: clean(row.id || fallbackId) || fallbackId,
    title: clean(row.title || row.id || fallbackId) || fallbackId,
    collaboration_profile: clean(row.collaboration_profile || row.collaborationProfile || ''),
    model_policy: clean(row.model_policy || row.modelPolicy || ''),
    input_kind: clean(row.input_kind || row.inputKind || ''),
    force_mode: clean(row.force_mode || row.forceMode || ''),
    setup_commands: asArray(row.setup_commands || row.setupCommands).map(clean).filter(Boolean),
    metadata: asObject(row.metadata),
  };
}

export function scenarioArms(scenario = {}) {
  const experiment = asObject(scenario.experiment);
  const baseline = experiment.baseline ? normalizeArm(experiment.baseline, 'baseline') : null;
  const challengers = asArray(experiment.challengers).map((row, index) => normalizeArm(row, `challenger_${index + 1}`));
  return baseline ? [baseline, ...challengers] : [normalizeArm({ id: 'default', ...asObject(scenario.arm) }, 'default')];
}

async function runShell(command = '', { cwd = process.cwd(), env = process.env, timeoutMs = 180000 } = {}) {
  const text = clean(command);
  if (!text) return { ok: false, skipped: true, reason: 'command_not_configured' };
  return await new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', text], { cwd, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, clamp(timeoutMs, 180000, 1000, 1800000));
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: code === 0, exit_code: code, signal, stdout, stderr });
    });
    child.on('error', (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      resolve({ ok: false, exit_code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
  });
}

function terminalCommandStatus(status = '') { return ['applied', 'failed', 'rejected', 'cancelled'].includes(clean(status).toLowerCase()); }
function eventType(event = {}) { return clean(event.event_type).toLowerCase(); }
function eventPayload(event = {}) { return asObject(event.payload); }
function eventAt(event = {}) { return Date.parse(event.occurred_at || event.ingested_at || '') || 0; }
function eventOutput(event = {}) {
  const payload = eventPayload(event);
  const type = eventType(event);
  if (type === 'run.finish' || type === 'run.completed') return clean(payload.summary || payload.output || payload.reply || payload.response);
  if (type === 'run.failed') return clean(payload.error || payload.summary);
  return '';
}

function readJsonlFile(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/g)) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  return rows;
}

function runtimeEventKey(event = {}, jobId = '') {
  return clean(event.event_id)
    || `${clean(jobId)}:${Number(event.event_sequence || 0)}:${clean(event.event_type)}:${clean(event.ts || event.occurred_at)}`;
}

function headlessMessageText(row = {}) {
  return clean(row.text || row.caption || row.output || '');
}

export class HeadlessRoomJourneyTransport {
  constructor({
    threadId = '',
    chatId = '',
    userId = '',
    runtimeRoot = '',
    traceRoot = '',
    responseTimeoutMs = 10 * 60 * 1000,
    runtimeFactory = null,
    resetRoom = true,
    modelRoleMap = null,
  } = {}) {
    this.threadId = clean(threadId || chatId);
    this.chatId = clean(chatId || threadId);
    this.userId = clean(userId || 'room_journey_benchmark');
    this.runtimeRoot = path.resolve(runtimeRoot || 'runs/room_journey_headless_runtime');
    this.traceRoot = traceRoot ? path.resolve(traceRoot) : '';
    this.responseTimeoutMs = clamp(responseTimeoutMs, 10 * 60 * 1000, 1000, 60 * 60 * 1000);
    this.runtimeFactory = typeof runtimeFactory === 'function' ? runtimeFactory : createHeadlessRoomRuntime;
    this.resetRoom = resetRoom !== false;
    this.modelRoleMap = asObject(modelRoleMap);
    this.runtime = null;
    this.events = [];
    this.seenRuntimeEventKeys = new Set();
  }

  async initialize() {
    if (!this.chatId) throw new Error('Headless Room journey transport requires a synthetic Room id');
    this.runtime = await this.runtimeFactory({ runtimeRoot: this.runtimeRoot, traceRoot: this.traceRoot });
    const { chatSessionStore } = this.runtime.runtimeCore;
    if (this.resetRoom && typeof chatSessionStore?.clear === 'function') chatSessionStore.clear(this.chatId);
    chatSessionStore.upsert(this.chatId, (current = {}) => ({
      ...current,
      room_journey_trace_enabled: true,
      room_journey_trace_until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      room_journey_trace_source: 'headless_room_journey_benchmark',
      room_journey_identity: {
        thread_id: this.threadId,
        chat_id: this.chatId,
        user_id: this.userId,
        transport: 'headless',
      },
    }));
    const assignments = asObject(this.modelRoleMap.assignments || this.modelRoleMap);
    if (Object.keys(assignments).length > 0) {
      const currentProfile = getAgentRoomProfile(chatSessionStore, this.chatId) || {};
      const descriptorPolicy = asObject(this.modelRoleMap.model_policy || this.modelRoleMap.modelPolicy);
      const roomPolicy = Object.keys(descriptorPolicy).length > 0
        ? {
            ...descriptorPolicy,
            policy_scope: 'room_experiment',
            inherited_policy_id: clean(this.modelRoleMap.policy_id || descriptorPolicy.policy_id),
            inherited_policy_revision: Number(this.modelRoleMap.revision || descriptorPolicy.policy_revision || 1),
            governance: {
              ...asObject(descriptorPolicy.governance),
              source: 'headless_room_journey_repository_policy',
              room_override_mode: 'role_by_role_merge',
              room_policy_learning: 'proposal_then_trial_then_approval',
              durable_model_policy_change: 'benchmark_ephemeral_only',
            },
          }
        : {
            schema_version: 'ddalggak.room_model_role_policy/v1',
            policy_id: 'legacy_headless_role_map',
            policy_scope: 'room_experiment',
            policy_revision: 1,
            strategy: 'headless_room_journey_explicit_model_role_map',
            default_assignment: Object.entries(assignments).map(([role, assignment]) => ({
              role,
              provider: clean(assignment?.provider).toLowerCase(),
              model: clean(assignment?.model),
              node_id: clean(assignment?.node_id || assignment?.nodeId),
              purpose: 'Explicit headless Room journey model-role assignment',
            })),
            governance: {
              source: 'headless_room_journey_legacy_model_role_map',
              room_override_mode: 'role_by_role_merge',
              room_policy_learning: 'proposal_then_trial_then_approval',
              durable_model_policy_change: 'benchmark_ephemeral_only',
            },
          };
      upsertAgentRoomProfile(chatSessionStore, this.chatId, {
        ...currentProfile,
        model_policy: roomPolicy,
      });
    }
    return { transport: 'headless', thread_id: this.threadId, chat_id: this.chatId, runtime_root: this.runtimeRoot };
  }

  _currentJobId() {
    return clean(this.runtime?.runtimeCore?.resolveCurrentJobIdForChat?.(this.chatId));
  }

  _collectRuntimeEvents() {
    const runtimeCore = this.runtime?.runtimeCore;
    const jobId = this._currentJobId();
    if (!runtimeCore || !jobId) return [];
    let eventFile = '';
    try { eventFile = path.join(runtimeCore.jobs.jobDir(jobId), 'runtime_events.jsonl'); } catch { return []; }
    const fresh = [];
    for (const event of readJsonlFile(eventFile)) {
      const key = runtimeEventKey(event, jobId);
      if (!key || this.seenRuntimeEventKeys.has(key)) continue;
      this.seenRuntimeEventKeys.add(key);
      const normalized = { ...event, job_id: clean(event.job_id || event.jobId || jobId) };
      this.events.push(normalized);
      fresh.push(normalized);
    }
    return fresh;
  }

  async _waitForIdle() {
    const started = Date.now();
    while (Date.now() - started < this.responseTimeoutMs) {
      const managerBusy = this.runtime.chatRunManager.isRunning(this.chatId);
      const state = clean(this.runtime.runtimeCore.chatSessionStore.get(this.chatId)?.state).toLowerCase();
      if (!managerBusy && !['routing', 'executing'].includes(state)) return;
      await sleep(100);
    }
    throw new Error(`Headless Room run timed out for ${this.chatId}`);
  }

  _capturedOutput(mark = 0) {
    const rows = this.runtime.bot.messagesSince(mark, this.chatId)
      .filter((row) => ['sendMessage', 'editMessageText'].includes(row.method))
      .map(headlessMessageText)
      .filter(Boolean);
    return rows.join('\n\n').trim();
  }

  snapshotState() {
    const session = this.runtime?.runtimeCore?.chatSessionStore?.get?.(this.chatId) || {};
    const roomProfile = asObject(session.agent_room_profile || session.agentRoomProfile);
    const rules = asArray(session.runtime_rules || session.runtimeRules)
      .filter((row) => row?.enabled !== false && clean(row?.text))
      .map((row) => ({ id: clean(row.id || row.rule_id), text: clean(row.text), source: clean(row.source || row.origin), enabled: row.enabled !== false }));
    const candidates = asArray(session.room_idle_memory_candidates || session.roomIdleMemoryCandidates)
      .map((row) => ({ candidate_id: clean(row.candidate_id || row.candidateId), observation_type: clean(row.observation_type || row.observationType), status: clean(row.status || 'pending'), review_required: row.review_required !== false }));
    const memories = asArray(session.room_memory_items || session.roomMemoryItems)
      .map((row) => ({ memory_id: clean(row.memory_id || row.memoryId), type: clean(row.type), status: clean(row.status), source_candidate_id: clean(row.source_candidate_id || row.sourceCandidateId) }));
    return {
      schema_version: 'ddalggak.headless_room_state/v1',
      captured_at: nowIso(),
      thread_id: this.threadId,
      chat_id: this.chatId,
      state: clean(session.state || 'idle'),
      active_job_id: this._currentJobId() || null,
      collaboration_profile_id: clean(roomProfile.collaboration_profile_id || 'auto') || 'auto',
      agent_room_profile: roomProfile,
      model_role_policy: this.modelRoleMap,
      model_role_map: this.modelRoleMap,
      effective_model_policy: asObject(roomProfile.model_policy || roomProfile.modelPolicy),
      last_room_selection: asObject(session.last_room_selection || session.lastRoomSelection),
      last_team_selection: asObject(session.last_team_selection || session.lastTeamSelection),
      active_team_config: asObject(session.active_team_config || session.activeTeamConfig || session.active_team || session.activeTeam),
      runtime_team_snapshot: asObject(this.runtime?.runtimeCore?.runtime?.runtimeTeamSnapshot || this.runtime?.runtime?.runtimeTeamSnapshot),
      last_route: asObject(session.last_route || session.lastRoute),
      recent_room_turn_count: asArray(session.recent_room_turns || session.recentRoomTurns).length,
      runtime_rules: rules,
      memory_candidates: candidates,
      room_memory_items: memories,
      pending_approval: Boolean(session.pending_approval),
    };
  }

  async exportFrozenSnapshot({ destinationRoot = '', scenarioId = '', targetStepId = '', authoritativeContextManifest = null, buildupSteps = [] } = {}) {
    if (!this.runtime) await this.initialize();
    await this._waitForIdle();
    const runtimeCore = this.runtime.runtimeCore;
    const session = runtimeCore.chatSessionStore.get(this.chatId) || {};
    const jobId = this._currentJobId();
    if (!jobId) throw new Error('Cannot freeze Room journey without an active job');
    const sourceJobDir = runtimeCore.jobs.jobDir(jobId);
    const root = ensureDir(path.resolve(destinationRoot || this.runtimeRoot, safe(scenarioId || this.chatId)));
    const jobStateDir = path.join(root, 'job_state');
    fs.rmSync(jobStateDir, { recursive: true, force: true });
    copyFrozenJobState(sourceJobDir, jobStateDir);
    const canonicalSession = canonicalFrozenSession(session);
    const jobFiles = frozenJobStateManifest(jobStateDir);
    const canonical = {
      schema_version: 'ddalggak.frozen_pre_target_room_snapshot/v1',
      scenario_id: clean(scenarioId),
      target_step_id: clean(targetStepId),
      session: canonicalSession,
      job_files: jobFiles,
      authoritative_context_manifest: asObject(authoritativeContextManifest),
      buildup_step_ids: asArray(buildupSteps).map((row) => clean(row?.step?.id || row?.id)).filter(Boolean),
    };
    const sha256 = stableSha256(canonical);
    const snapshot = {
      ...canonical,
      snapshot_mode: 'frozen_pre_target_room_fork',
      snapshot_id: `room_snapshot_${sha256.slice(0, 20)}`,
      canonical_content_sha256: sha256,
      source_chat_id: this.chatId,
      source_job_id: jobId,
      snapshot_root: root,
      job_state_dir: jobStateDir,
      created_at: nowIso(),
    };
    writeJson(path.join(root, 'snapshot.json'), snapshot);
    return snapshot;
  }

  async restoreFrozenSnapshot(snapshot = {}) {
    if (!this.runtime) await this.initialize();
    const row = asObject(snapshot);
    if (clean(row.snapshot_mode) !== 'frozen_pre_target_room_fork' || !clean(row.job_state_dir)) throw new Error('Invalid frozen pre-target Room snapshot');
    const runtimeCore = this.runtime.runtimeCore;
    const clonedJob = runtimeCore.jobs.createJob({
      title: `Frozen Room fork ${clean(row.scenario_id || this.chatId)}`,
      ownerUserId: this.userId,
      ownerChatId: this.chatId,
    });
    fs.rmSync(clonedJob.dir, { recursive: true, force: true });
    ensureDir(clonedJob.dir);
    copyFrozenJobState(path.resolve(row.job_state_dir), clonedJob.dir);
    ensureDir(path.join(clonedJob.dir, 'workspace'));
    ensureDir(path.join(clonedJob.dir, 'shared'));
    writeJson(path.join(clonedJob.dir, 'meta.json'), {
      jobId: clonedJob.jobId,
      title: `Frozen Room fork ${clean(row.scenario_id || this.chatId)}`,
      ownerUserId: this.userId,
      ownerChatId: this.chatId,
      createdAt: nowIso(),
      frozen_snapshot_id: clean(row.snapshot_id),
      frozen_snapshot_sha256: clean(row.canonical_content_sha256),
    });
    const sourceSession = deepClone(asObject(row.session));
    runtimeCore.chatSessionStore.upsert(this.chatId, {
      ...sourceSession,
      chat_id: this.chatId,
      jobId: clonedJob.jobId,
      state: 'idle',
      active_run_id: null,
      pending_approval: null,
      interrupt: null,
      agent_status: {},
      room_journey_trace_enabled: true,
      room_journey_trace_until: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      room_journey_trace_source: 'headless_room_journey_frozen_fork',
      room_journey_identity: {
        thread_id: this.threadId,
        chat_id: this.chatId,
        user_id: this.userId,
        transport: 'headless',
        frozen_snapshot_id: clean(row.snapshot_id),
      },
    });
    this.events = [];
    this.seenRuntimeEventKeys.clear();
    return {
      ok: true,
      snapshot_id: clean(row.snapshot_id),
      canonical_content_sha256: clean(row.canonical_content_sha256),
      cloned_job_id: clonedJob.jobId,
      room_state: this.snapshotState(),
    };
  }

  async applyDeterministicStateUpdate(text = '', { acknowledgement = '' } = {}) {
    if (!this.runtime) await this.initialize();
    const message = clean(text);
    const response = clean(acknowledgement) || '반영했습니다.';
    const runtimeCore = this.runtime.runtimeCore;
    let jobId = this._currentJobId();
    if (!jobId) throw new Error('Deterministic state update requires an active Room job');
    const jobDir = runtimeCore.jobs.jobDir(jobId);
    try { recordUserFactEvents(jobDir, message, { source: 'room_journey_deterministic_state_update', timestamp: nowIso() }); } catch {}
    appendRoomConversationExchange({
      jobDir,
      chatSessionStore: runtimeCore.chatSessionStore,
      chatId: this.chatId,
      userId: this.userId,
      userText: message,
      assistantText: response,
      source: 'room_journey_deterministic_state_update',
      provider: 'deterministic',
      model: 'none',
      route: 'state_update',
      jobId,
    });
    return {
      ok: true,
      output: response,
      full_user_response: response,
      orchestration_transcript: '',
      execution_mode: 'deterministic_state_update',
      provider_call_count: 0,
      events: [],
      room_state: this.snapshotState(),
    };
  }

  async sendMessage(text = '', messageOptions = {}) {
    if (!this.runtime) await this.initialize();
    const originalMessage = clean(text);
    const authoritativeContextManifest = asObject(messageOptions.authoritativeContextManifest);
    const message = renderAuthoritativeContextEnvelope(originalMessage, authoritativeContextManifest);
    if (!message) return { ok: false, output: '', error: 'empty_message' };
    const mark = this.runtime.bot.mark();
    const beforeCount = this.events.length;
    const inputKind = clean(messageOptions.kind || messageOptions.inputKind || 'normal') || 'normal';
    let teamConfig = messageOptions.teamConfig && typeof messageOptions.teamConfig === 'object' ? messageOptions.teamConfig : null;
    if (!teamConfig && ['team_task', 'team_loop_task'].includes(inputKind)) {
      const roomProfile = getAgentRoomProfile(this.runtime.runtimeCore.chatSessionStore, this.chatId) || {};
      teamConfig = buildRoomFirstTeamConfiguration({
        taskText: message,
        workMode: inputKind,
        roomProfile,
        chatId: this.chatId,
        runtime: null,
        source: 'headless_room_journey_profile_materialization',
      });
    }
    const accepted = await this.runtime.chatRunManager.handleIncoming({
      chatId: this.chatId,
      userId: this.userId,
      text: message,
      kind: inputKind,
      forceMode: clean(messageOptions.forceMode || messageOptions.force_mode || 'normal') || 'normal',
      teamConfig,
      chatInfo: { chat_id: this.chatId, title: 'Headless Room Journey', type: 'private' },
    });
    await this._waitForIdle();
    const freshEvents = this._collectRuntimeEvents();
    const runEvents = this.events.slice(beforeCount);
    const terminal = [...runEvents].reverse().find((event) => eventType(event) === 'run.finish');
    const status = clean(eventPayload(terminal).status || '').toLowerCase();
    const capturedOutput = this._capturedOutput(mark);
    const runSummary = eventOutput(terminal);
    const lastRunResult = this.runtime?.getLastRunResult?.(this.chatId) || {};
    const finalUserResponse = clean(lastRunResult?.replyText || lastRunResult?.reply_text || lastRunResult?.finalAssistantText || lastRunResult?.final_assistant_text || '');
    const output = finalUserResponse || capturedOutput || runSummary;
    return {
      ok: Boolean(terminal) ? status !== 'error' : Boolean(output),
      accepted,
      output,
      run_summary: runSummary,
      full_user_response: finalUserResponse || capturedOutput || '',
      orchestration_transcript: capturedOutput || '',
      run_id: clean(terminal?.run_id),
      job_id: this._currentJobId(),
      events: freshEvents,
      assistant_messages: this.runtime.bot.messagesSince(mark, this.chatId),
      authoritative_context_manifest: clean(authoritativeContextManifest.manifest_id) ? authoritativeContextManifest : null,
      authoritative_context_delivery: clean(authoritativeContextManifest.manifest_id) ? {
        manifest_id: clean(authoritativeContextManifest.manifest_id),
        sha256: clean(authoritativeContextManifest.sha256),
        execution_message_contains_manifest: message.includes(clean(authoritativeContextManifest.manifest_id)),
      } : null,
      room_state: this.snapshotState(),
    };
  }


  async clearTransientConversationContext() {
    if (!this.runtime) await this.initialize();
    const store = this.runtime.runtimeCore.chatSessionStore;
    const session = store.get(this.chatId) || {};
    const jobId = this._currentJobId();
    let jobDir = '';
    try { jobDir = jobId ? this.runtime.runtimeCore.jobs.jobDir(jobId) : ''; } catch {}
    store.upsert(this.chatId, {
      ...session,
      recent_room_turns: [],
      last_room_turn: null,
      recent_agent_turns: [],
    });
    for (const relative of [
      'local_memory/turns.jsonl',
      'local_memory/room_turn_ledger.jsonl',
      'local_memory/summary.md',
      'local_memory/iteration_delta.md',
      'local_memory/role_summaries',
      'shared/room_turn_ledger.jsonl',
      'conversation.jsonl',
      'user_facts.jsonl',
    ]) {
      if (!jobDir) continue;
      try { fs.rmSync(path.join(jobDir, relative), { recursive: true, force: true }); } catch {}
    }
    return { ok: true, action: 'clear_transient_conversation_context', room_state: this.snapshotState() };
  }

  async sendCommand(commandText = '') {
    if (!this.runtime) await this.initialize();
    const command = clean(commandText);
    if (!command.startsWith('/')) throw new Error(`Headless Room command must start with /: ${command}`);
    const mark = this.runtime.bot.mark();
    const commandResult = await this.runtime.handleRoomCommand({
      text: command,
      chatId: this.chatId,
      userId: this.userId,
    });
    const freshEvents = this._collectRuntimeEvents();
    const normalized = asObject(commandResult);
    return {
      ...normalized,
      ok: normalized.ok !== false,
      handled: normalized.ok !== false,
      output: this._capturedOutput(mark),
      events: freshEvents,
      room_state: this.snapshotState(),
    };
  }
}

export class GocRoomJourneyTransport {
  constructor({ client = null, threadId = '', chatId = '', userId = '', pollIntervalMs = 1000, commandTimeoutMs = 10 * 60 * 1000, responseTimeoutMs = 10 * 60 * 1000 } = {}) {
    this.client = client || new GocClient();
    this.threadId = clean(threadId);
    this.chatId = clean(chatId);
    this.userId = clean(userId || chatId);
    this.pollIntervalMs = clamp(pollIntervalMs, 1000, 100, 10000);
    this.commandTimeoutMs = clamp(commandTimeoutMs, 10 * 60 * 1000, 1000, 60 * 60 * 1000);
    this.responseTimeoutMs = clamp(responseTimeoutMs, 10 * 60 * 1000, 1000, 60 * 60 * 1000);
    this.cursor = '';
    this.events = [];
  }

  async initialize() {
    if (!this.threadId || !this.chatId) throw new Error('GoC Room journey transport requires threadId and chatId');
    const current = await this.client.listRuntimeEvents({ threadId: this.threadId, limit: 1 });
    this.cursor = clean(current?.next_cursor || asArray(current?.items)[0]?.event_id || '');
    return { cursor: this.cursor };
  }

  async _readDelta() {
    const result = await this.client.listRuntimeEvents({ threadId: this.threadId, afterEventId: this.cursor, limit: 300 });
    const items = asArray(result?.items);
    if (items.length) {
      this.cursor = clean(result?.next_cursor || items[items.length - 1]?.event_id || this.cursor);
      this.events.push(...items);
    }
    return items;
  }

  async _waitCommand(commandId) {
    const started = Date.now();
    while (Date.now() - started < this.commandTimeoutMs) {
      const command = await this.client.getRuntimeCommand(commandId);
      if (terminalCommandStatus(command?.status)) return command;
      await sleep(this.pollIntervalMs);
    }
    throw new Error(`Runtime command timed out: ${commandId}`);
  }

  async _waitRun({ sentAt = '', message = '' } = {}) {
    const started = Date.now();
    const sentAtMs = Date.parse(sentAt) || started;
    let runId = '';
    const collected = [];
    while (Date.now() - started < this.responseTimeoutMs) {
      const delta = await this._readDelta();
      collected.push(...delta);
      if (!runId) {
        const start = collected.find((event) => {
          if (!['run.start', 'run.started'].includes(eventType(event))) return false;
          if (eventAt(event) < sentAtMs - 120000) return false;
          const text = clean(eventPayload(event).userText || eventPayload(event).user_text || eventPayload(event).message || '');
          return !message || !text || text === message || text.includes(message.slice(0, 120));
        });
        runId = clean(start?.run_id);
      }
      if (runId) {
        const terminal = collected.find((event) => clean(event.run_id) === runId && ['run.finish', 'run.completed', 'run.failed'].includes(eventType(event)));
        if (terminal) return { run_id: runId, output: eventOutput(terminal), terminal_event: terminal, events: collected.filter((event) => clean(event.run_id) === runId) };
      }
      await sleep(this.pollIntervalMs);
    }
    return { run_id: runId, output: '', timed_out: true, events: collected };
  }

  async submit({ commandType, payload, commandId = '' } = {}) {
    const id = clean(commandId) || `cmd_room_journey_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const sentAt = nowIso();
    const created = await this.client.createRuntimeCommand({
      command_id: id,
      command_type: commandType,
      thread_id: this.threadId,
      aggregate_type: 'room',
      aggregate_id: this.threadId,
      payload: { ...asObject(payload), chat_id: this.chatId, user_id: this.userId, source: 'room_journey_benchmark', client_request_id: id },
    });
    const command = asObject(created?.command || created);
    const completed = await this._waitCommand(clean(command.command_id || id));
    return { command_id: id, sent_at: sentAt, created: command, completed };
  }

  async sendMessage(text = '') {
    const message = clean(text);
    const command = await this.submit({ commandType: 'room_message', payload: { message } });
    if (clean(command.completed?.status).toLowerCase() !== 'applied') return { ...command, ok: false, output: '', events: [] };
    const run = await this._waitRun({ sentAt: command.sent_at, message });
    return { ...command, ...run, ok: !run.timed_out && eventType(run.terminal_event) !== 'run.failed' };
  }

  async sendCommand(commandText = '') {
    const command = clean(commandText);
    const result = await this.submit({ commandType: 'room_command', payload: { command } });
    await sleep(Math.min(1500, this.pollIntervalMs));
    const events = await this._readDelta();
    return { ...result, ok: clean(result.completed?.status).toLowerCase() === 'applied', output: clean(result.completed?.result?.summary || result.completed?.result?.message || ''), events };
  }
}

function resolveTemplate(template = '', step = {}, arm = {}) {
  return clean(template)
    .replaceAll('{{provider}}', clean(step.provider || arm.provider))
    .replaceAll('{{model}}', clean(step.model || arm.model))
    .replaceAll('{{profile}}', clean(step.profile || arm.collaboration_profile))
    .replaceAll('{{source}}', clean(step.source || step.path));
}

async function executeStep({ step, arm, transport, options }) {
  const action = clean(step.action).toLowerCase();
  if (action === 'send_message') {
    const isTargetStep = clean(options?.targetStepId) && clean(step?.id) === clean(options.targetStepId);
    const executionMode = clean(arm?.metadata?.execution_mode || arm?.metadata?.executionMode).toLowerCase();
    if (isTargetStep && executionMode === 'deterministic_state_update') {
      if (typeof transport.applyDeterministicStateUpdate !== 'function') return { ok: false, error: 'transport_does_not_support_deterministic_state_update' };
      return await transport.applyDeterministicStateUpdate(step.text, {
        acknowledgement: clean(step.deterministic_ack_text || step.deterministicAckText || arm?.metadata?.deterministic_ack_text || arm?.metadata?.deterministicAckText),
      });
    }
    return await transport.sendMessage(step.text, {
      kind: clean(step.input_kind || step.inputKind || arm.input_kind || 'normal') || 'normal',
      forceMode: clean(step.force_mode || step.forceMode || arm.force_mode || 'normal') || 'normal',
      teamConfig: step.team_config || step.teamConfig || null,
      authoritativeContextManifest: isTargetStep ? asObject(options?.authoritativeContextManifest) : null,
    });
  }
  if (['room_command', 'inspect', 'branch', 'generate_memory_candidates', 'approve_memory', 'reject_memory', 'set_collaboration_profile'].includes(action)) {
    let command = clean(step.command || step.text);
    if (action === 'branch' && !command.startsWith('/branch')) command = `/branch ${command}`;
    if (action === 'generate_memory_candidates') command = command || '/memory idle';
    if (action === 'approve_memory') command = command || '/memory approve latest';
    if (action === 'reject_memory') command = command || '/memory reject latest benchmark rejection';
    if (action === 'set_collaboration_profile') command = `/collab use ${clean(step.profile || arm.collaboration_profile)}`;
    return await transport.sendCommand(command);
  }
  if (action === 'clear_transient_conversation_context') {
    if (typeof transport.clearTransientConversationContext !== 'function') return { ok: false, error: 'transport_does_not_support_transient_context_clear' };
    return await transport.clearTransientConversationContext();
  }
  if (action === 'restart_service') return await runShell(resolveTemplate(options.restartCommand, step, arm), options);
  if (action === 'switch_model') return await runShell(resolveTemplate(options.switchModelCommand, step, arm), options);
  if (action === 'replace_source') return await runShell(resolveTemplate(options.replaceSourceCommand, step, arm), options);
  if (action === 'shell') return await runShell(resolveTemplate(step.command, step, arm), options);
  if (action === 'wait') { await sleep(clamp(step.ms, 1000, 0, 600000)); return { ok: true, waited_ms: clamp(step.ms, 1000, 0, 600000) }; }
  throw new Error(`Unsupported Room journey action: ${action}`);
}

function matchingTraceEvents(trace = [], assertion = {}) {
  const type = clean(assertion.event_type || assertion.eventType).toLowerCase();
  return asArray(trace).filter((event) => !type || eventType(event) === type);
}

function assertionApplies(assertion = {}, armId = '') {
  const id = clean(armId);
  const only = asArray(assertion.arms || assertion.only_arms || assertion.onlyArms).map(clean).filter(Boolean);
  const excluded = asArray(assertion.exclude_arms || assertion.excludeArms).map(clean).filter(Boolean);
  if (only.length && !only.includes(id)) return false;
  if (excluded.includes(id)) return false;
  return true;
}

function isLocalCliEvent(event = {}) {
  const channel = clean(eventPayload(event).execution_channel).toLowerCase();
  return channel === 'local_cli' || channel.endsWith('_cli') || channel === 'cli';
}

function isProviderDefaultModelAlias(value = '') {
  return ['default', '@provider_default', 'provider_default', 'provider-default', 'auto'].includes(clean(value).toLowerCase());
}

function normalizedResolvedModel(payload = {}) {
  const explicit = clean(payload.resolved_model || payload.resolvedModel);
  if (explicit && !isProviderDefaultModelAlias(explicit)) return explicit;
  const model = clean(payload.model);
  if (model && !isProviderDefaultModelAlias(model)) return model;
  const requested = clean(payload.requested_model || payload.requestedModel);
  if (requested && !isProviderDefaultModelAlias(requested)) return requested;
  return '';
}

function isValidRoleFinish(event = {}) {
  if (eventType(event) !== 'run.agent_finish' || !isLocalCliEvent(event)) return false;
  return eventPayload(event).role_output_valid !== false;
}

function modelNodeKey(payload = {}) {
  const provider = clean(payload.provider).toLowerCase();
  const model = normalizedResolvedModel(payload);
  return provider ? `${provider}:${model || '@provider_default_unresolved'}` : '';
}

function assertionStepIds(assertion = {}) {
  return [...new Set([
    clean(assertion.step_id || assertion.stepId),
    ...asArray(assertion.step_ids || assertion.stepIds).map(clean),
  ].filter(Boolean))];
}

export function runtimeEventsForAssertion(context = {}, assertion = {}) {
  const ids = assertionStepIds(assertion);
  const runtimeEvents = asArray(context.runtimeEvents);
  if (!ids.length) return runtimeEvents;
  const steps = asObject(context.stepsById);
  const scoped = [];
  const seen = new Set();
  for (const id of ids) {
    const row = steps[id];
    const direct = asArray(row?.result?.events);
    if (direct.length) {
      for (const event of direct) {
        const key = runtimeEventKey(event, clean(event?.run_id));
        if (seen.has(key)) continue;
        seen.add(key);
        scoped.push(event);
      }
      continue;
    }
    const startMs = Date.parse(row?.started_at || '') || 0;
    const endMs = Date.parse(row?.completed_at || '') || 0;
    if (!startMs || !endMs) continue;
    for (const event of runtimeEvents) {
      const at = eventAt(event);
      if (!at || at < startMs || at > endMs) continue;
      const key = runtimeEventKey(event, clean(event?.run_id));
      if (seen.has(key)) continue;
      seen.add(key);
      scoped.push(event);
    }
  }
  return scoped;
}

function assertionResult(assertion = {}, context = {}) {
  const type = clean(assertion.type).toLowerCase();
  const steps = asObject(context.stepsById);
  const scopedRuntimeEvents = runtimeEventsForAssertion(context, assertion);
  let passed = false; let observed = null;
  if (type === 'step_ok') {
    const row = steps[clean(assertion.step_id)]; observed = row?.result?.ok === true; passed = observed;
  } else if (type === 'response_regex' || type === 'response_not_regex') {
    const stepResult = steps[clean(assertion.step_id)]?.result;
    const text = clean(stepResult?.output);
    const regex = new RegExp(assertion.pattern, assertion.flags || 'i');
    const matched = regex.test(text);
    const eligible = stepResult?.ok === true && (assertion.allow_empty === true || text.length > 0);
    observed = { eligible, step_ok: stepResult?.ok === true, matched, preview: text.slice(0, 240) };
    passed = eligible && (type === 'response_regex' ? matched : !matched);
  } else if (type === 'trace_event_count') {
    const count = matchingTraceEvents(context.trace, assertion).length;
    const min = Number.isFinite(Number(assertion.min)) ? Number(assertion.min) : 1;
    const max = Number.isFinite(Number(assertion.max)) ? Number(assertion.max) : Number.POSITIVE_INFINITY;
    observed = count; passed = count >= min && count <= max;
  } else if (type === 'memory_commit_count') {
    const count = matchingTraceEvents(context.trace, { event_type: 'memory.committed' }).length;
    observed = count; passed = count >= Number(assertion.min ?? 1) && count <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'provider_role_count') {
    const starts = scopedRuntimeEvents.filter((event) => eventType(event) === 'run.agent_start');
    const roles = new Set(starts.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean));
    observed = [...roles]; passed = roles.size >= Number(assertion.min ?? 1) && roles.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'successful_provider_role_count') {
    const finishes = scopedRuntimeEvents.filter((event) => isValidRoleFinish(event));
    const roles = new Set(finishes.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean));
    observed = [...roles]; passed = roles.size >= Number(assertion.min ?? 1) && roles.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'successful_model_roles_include') {
    const finishes = scopedRuntimeEvents.filter((event) => isValidRoleFinish(event));
    const roles = new Set(finishes.map((event) => clean(eventPayload(event).model_role).toLowerCase()).filter(Boolean));
    const expected = asArray(assertion.values || assertion.roles || assertion.expected).map((row) => clean(row).toLowerCase()).filter(Boolean);
    const missing = expected.filter((role) => !roles.has(role));
    observed = { expected, actual: [...roles], missing };
    passed = expected.length > 0 && missing.length === 0;
  } else if (type === 'distinct_lane_count') {
    const finishes = scopedRuntimeEvents.filter((event) => isValidRoleFinish(event));
    const lanes = new Set(finishes.map((event) => {
      const payload = eventPayload(event);
      return clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id || payload?.collaborationLane?.laneId);
    }).filter(Boolean));
    observed = [...lanes];
    passed = lanes.size >= Number(assertion.min ?? 1) && lanes.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_provider_count') {
    const providers = new Set(scopedRuntimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish'].includes(eventType(event))).map((event) => clean(eventPayload(event).provider)).filter(Boolean));
    observed = [...providers]; passed = providers.size >= Number(assertion.min ?? 1) && providers.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_model_count') {
    const models = new Set(scopedRuntimeEvents.filter((event) => isValidRoleFinish(event)).map((event) => normalizedResolvedModel(eventPayload(event))).filter(Boolean));
    observed = [...models]; passed = models.size >= Number(assertion.min ?? 1) && models.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_model_node_count') {
    const nodes = new Set(scopedRuntimeEvents
      .filter((event) => isValidRoleFinish(event))
      .map((event) => modelNodeKey(eventPayload(event)))
      .filter(Boolean));
    observed = [...nodes]; passed = nodes.size >= Number(assertion.min ?? 1) && nodes.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'approved_memory_projected') {
    const committed = new Set(matchingTraceEvents(context.trace, { event_type: 'memory.committed' }).map((event) => clean(eventPayload(event).memory_id)).filter(Boolean));
    const projected = new Set(matchingTraceEvents(context.trace, { event_type: 'context.projection_compiled' }).flatMap((event) => asArray(eventPayload(event).approved_memory_ids || eventPayload(event).approved_memory_ids_used)).map(clean).filter(Boolean));
    observed = { committed: [...committed], projected: [...projected] };
    passed = [...committed].some((id) => projected.has(id));
  } else if (type === 'no_unapproved_memory_commit') {
    const commits = matchingTraceEvents(context.trace, { event_type: 'memory.committed' }).length;
    observed = commits; passed = commits === 0;
  } else if (type === 'runtime_event_count') {
    const rows = scopedRuntimeEvents.filter((event) => !assertion.event_type || eventType(event) === clean(assertion.event_type).toLowerCase());
    observed = rows.length; passed = rows.length >= Number(assertion.min ?? 1);
  } else if (type === 'cli_call_count') {
    const rows = scopedRuntimeEvents.filter((event) => {
      if (eventType(event) !== 'run.agent_start') return false;
      const channel = clean(eventPayload(event).execution_channel).toLowerCase();
      return channel === 'local_cli' || channel.endsWith('_cli') || channel === 'cli';
    });
    observed = rows.map((event) => ({
      provider: clean(eventPayload(event).provider),
      model: clean(eventPayload(event).model),
      role: clean(eventPayload(event).model_role || eventPayload(event).role_id),
    }));
    passed = rows.length >= Number(assertion.min ?? 1) && rows.length <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'cli_success_count' || type === 'cli_failure_count' || type === 'cli_recovered_failure_count') {
    const outcomes = classifyCliExecutionOutcomes(scopedRuntimeEvents);
    const rows = type === 'cli_success_count'
      ? outcomes.finishes
      : (type === 'cli_recovered_failure_count' ? outcomes.recoveredErrors : outcomes.terminalErrors);
    observed = rows.map((event) => ({
      provider: clean(eventPayload(event).provider),
      model: clean(eventPayload(event).model),
      role: clean(eventPayload(event).model_role || eventPayload(event).role_id),
      error: type !== 'cli_success_count' ? clean(eventPayload(event).error).slice(0, 240) : undefined,
    }));
    passed = rows.length >= Number(assertion.min ?? (type === 'cli_failure_count' ? 0 : 1))
      && rows.length <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'model_role_map_alignment') {
    const modelPolicy = clean(context.arm?.model_policy || context.arm?.modelPolicy).toLowerCase();
    const armId = clean(context.arm?.id).toLowerCase();
    if (modelPolicy === 'strongest_suitable_single' || armId === 'solo') {
      observed = { skipped: true, reason: 'solo_baseline_uses_single_model_policy' };
      passed = true;
      return {
        id: clean(assertion.id || type),
        type,
        required: assertion.required !== false,
        quality_metric: false,
        passed,
        observed,
        description: clean(assertion.description || assertion.label),
      };
    }
    const assignments = asObject(context.modelRoleMap?.assignments || context.modelRoleMap);
    const finishes = scopedRuntimeEvents.filter((event) => isValidRoleFinish(event));
    const rows = finishes.map((event) => {
      const payload = eventPayload(event);
      const role = clean(payload.model_role).toLowerCase();
      const expected = asObject(assignments[role]);
      const actual = {
        provider: clean(payload.provider).toLowerCase(),
        model: clean(payload.model),
      };
      const hasAssignment = Boolean(role && Object.keys(expected).length);
      const providerMatches = !clean(expected.provider) || clean(expected.provider).toLowerCase() === actual.provider;
      const modelMatches = !clean(expected.model) || clean(expected.model) === actual.model;
      return { role, expected, actual, has_assignment: hasAssignment, matched: hasAssignment && providerMatches && modelMatches };
    });
    const requiredMin = Number(assertion.min ?? 1);
    observed = rows;
    passed = rows.length >= requiredMin && rows.every((row) => row.matched);
  } else if (type === 'memory_candidate_shape') {
    const rows = matchingTraceEvents(context.trace, { event_type: 'memory.candidate_created' });
    const valid = rows.filter((event) => {
      const payload = eventPayload(event);
      return Boolean(clean(payload.candidate_id))
        && Boolean(clean(payload.observation_type))
        && Boolean(clean(payload.status))
        && typeof payload.review_required === 'boolean';
    });
    observed = { total: rows.length, structurally_valid: valid.length };
    const min = Number(assertion.min ?? 1);
    passed = rows.length >= min && valid.length === rows.length;
  } else if (type === 'memory_commit_shape') {
    const rows = matchingTraceEvents(context.trace, { event_type: 'memory.committed' });
    const valid = rows.filter((event) => {
      const payload = eventPayload(event);
      return Boolean(clean(payload.memory_id))
        && Boolean(clean(payload.type))
        && Boolean(clean(payload.status))
        && Boolean(clean(payload.source_candidate_id));
    });
    observed = { total: rows.length, structurally_valid: valid.length };
    const min = Number(assertion.min ?? 1);
    passed = rows.length >= min && valid.length === rows.length;
  } else if (type === 'room_rule_count') {
    const snapshot = clean(assertion.step_id)
      ? asObject(steps[clean(assertion.step_id)]?.result?.room_state)
      : asObject(context.latestRoomState);
    const count = asArray(snapshot.runtime_rules).length;
    observed = { count, rules: asArray(snapshot.runtime_rules) };
    passed = count >= Number(assertion.min ?? 1) && count <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'collaboration_profile_is') {
    const snapshot = clean(assertion.step_id)
      ? asObject(steps[clean(assertion.step_id)]?.result?.room_state)
      : asObject(context.latestRoomState);
    const actual = clean(snapshot.collaboration_profile_id || 'auto');
    const expected = clean(assertion.value || assertion.profile || assertion.expected);
    observed = { actual, expected };
    passed = Boolean(expected) && actual === expected;
  } else if (type === 'multiturn_message_count') {
    const count = Object.values(steps).filter((row) => clean(row?.step?.action).toLowerCase() === 'send_message' && row?.result?.ok === true).length;
    observed = count;
    passed = count >= Number(assertion.min ?? 2) && count <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else {
    observed = 'unsupported_assertion'; passed = false;
  }
  return {
    id: clean(assertion.id || type),
    type,
    required: assertion.required !== false,
    quality_metric: assertion.quality_metric !== false,
    passed,
    observed,
    description: clean(assertion.description || assertion.label),
  };
}

function extractJsonObject(value = '') {
  const text = clean(value);
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function roomJourneyOutcomeEvaluationScope(scenario = {}) {
  const targetStepId = comparisonTargetStepId(scenario);
  return targetStepId ? { mode: 'target_only', target_step_id: targetStepId } : { mode: 'full_journey', target_step_id: null };
}

function buildRoomJourneyJudgePrompt({ scenario = {}, arm = {}, stepRows = [], assertions = [] } = {}) {
  const scope = roomJourneyOutcomeEvaluationScope(scenario);
  const messageRows = stepRows.filter((row) => clean(row.step?.action) === 'send_message');
  if (scope.mode === 'target_only') {
    const targetIndex = messageRows.findIndex((row) => clean(row.step?.id) === clean(scope.target_step_id));
    const targetRow = targetIndex >= 0 ? messageRows[targetIndex] : null;
    const requiredContextIds = routingRequiredContextStepIds(scenario);
    const contextRows = requiredContextIds.length
      ? requiredContextIds.map((id) => messageRows.find((row) => clean(row.step?.id) === id)).filter(Boolean)
      : messageRows.slice(0, Math.max(0, targetIndex));
    const scopedAssertions = assertions.filter((row) => {
      const assertion = asArray(scenario.assertions).find((candidate) => clean(candidate?.id || candidate?.type) === clean(row.id));
      const stepId = clean(assertion?.step_id || assertion?.stepId);
      return !stepId || stepId === clean(scope.target_step_id);
    });
    return [
      'Evaluate only the target-turn user-visible outcome. This is a topology-blind outcome-quality judgment.',
      'Use the supplied authoritative prior USER context as source material. Do not evaluate prior assistant behavior, number of agents, provider count, collaboration topology, cost, or latency.',
      'Do not reward or penalize collaboration by itself. Judge correctness, fact fidelity, instruction adherence, completeness, decision quality, uncertainty calibration, and usefulness according to the rubric.',
      'Return JSON only with: passed(boolean), score(number 0..1), summary(string), rubric(array of {id,score,reason}), findings(array of strings).',
      '',
      'SCENARIO', JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, rubric: scenario.semantic_rubric || scenario.rubric || [], evaluation_scope: scope }, null, 2),
      '',
      'AUTHORITATIVE PRIOR USER CONTEXT', JSON.stringify(contextRows.map((row) => ({ step_id: row.step.id, user: clean(row.step.text) })), null, 2),
      '',
      'TARGET TURN', JSON.stringify({ step_id: targetRow?.step?.id || scope.target_step_id, user: clean(targetRow?.step?.text), assistant: clean(targetRow?.result?.output) }, null, 2),
      '',
      'TARGET-SCOPED DETERMINISTIC ASSERTIONS', JSON.stringify(scopedAssertions.map((row) => ({ id: row.id, passed: row.passed, observed: row.observed })), null, 2),
    ].join('\n');
  }
  const transcript = messageRows.map((row) => ({ step_id: row.step.id, user: clean(row.step.text), assistant: clean(row.result?.output) }));
  return [
    'Evaluate this AI Room user journey using only the supplied transcript, deterministic assertions, and outcome-quality rubric.',
    'Do not reward extra agents or extra models by themselves. Process assurance and execution efficiency are measured separately from this score.',
    'Return JSON only with: passed(boolean), score(number 0..1), summary(string), rubric(array of {id,score,reason}), findings(array of strings).',
    '',
    'SCENARIO', JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, rubric: scenario.semantic_rubric || scenario.rubric || [], evaluation_scope: scope }, null, 2),
    '',
    'TRANSCRIPT', JSON.stringify(transcript, null, 2),
    '',
    'DETERMINISTIC ASSERTIONS', JSON.stringify(assertions.map((row) => ({ id: row.id, passed: row.passed, observed: row.observed })), null, 2),
  ].join('\n');
}

export async function judgeRoomJourneyRun({ scenario = {}, arm = {}, stepRows = [], assertions = [], runDir = '', provider = 'claude', model = '', reasoningEffort = 'high', timeoutMs = 180000, executor = null } = {}) {
  const prompt = buildRoomJourneyJudgePrompt({ scenario, arm, stepRows, assertions });
  const workspaceRoot = ensureDir(path.join(runDir, 'judge_workspace'));
  fs.writeFileSync(path.join(runDir, 'judge_prompt.txt'), prompt, 'utf8');
  let result;
  if (typeof executor === 'function') result = await executor({ provider, model, reasoningEffort, prompt, workspaceRoot });
  else if (provider === 'codex') result = await runCodexExec({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `room_journey_judge_${safe(scenario.id)}_${safe(arm.id)}`, model, reasoningEffort, sandboxMode: 'workspace-write', approvalPolicy: 'never', timeoutMs, surface: 'room_journey_judge' });
  else if (provider === 'antigravity') result = await runAntigravityPrompt({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `room_journey_judge_${safe(scenario.id)}_${safe(arm.id)}`, model, timeoutMs, surface: 'room_journey_judge' });
  else result = await runClaudeCliPrompt({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `room_journey_judge_${safe(scenario.id)}_${safe(arm.id)}`, model, effort: reasoningEffort, timeoutMs, surface: 'room_journey_judge' });
  const output = result?.stdout || result?.text || result?.output || '';
  fs.writeFileSync(path.join(runDir, 'judge_output.txt'), String(output), 'utf8');
  const parsed = extractJsonObject(output);
  return {
    provider,
    requested_model: clean(model) || null,
    reasoning_effort: clean(reasoningEffort) || null,
    ok: result?.ok === true && Boolean(parsed),
    exit_code: result?.exitCode ?? result?.exit_code ?? null,
    result: parsed,
    evaluation_scope: roomJourneyOutcomeEvaluationScope(scenario),
    judged_at: nowIso(),
  };
}

function cliExecutionKey(event = {}) {
  const payload = eventPayload(event);
  return [
    clean(payload.agent_id || payload.agentId),
    clean(payload.model_role || payload.modelRole || payload.role_id || payload.roleId),
    clean(payload.provider).toLowerCase(),
  ].join('|');
}

function classifyCliExecutionOutcomes(runtimeEvents = []) {
  const rows = runtimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish', 'run.agent_error'].includes(eventType(event)) && isLocalCliEvent(event));
  const allFinishes = rows.filter((event) => eventType(event) === 'run.agent_finish');
  const finishes = allFinishes.filter((event) => eventPayload(event).role_output_valid !== false);
  const invalidRoleFinishes = allFinishes.filter((event) => eventPayload(event).role_output_valid === false);
  const errors = rows.filter((event) => eventType(event) === 'run.agent_error');
  const recoveredErrors = [];
  const terminalErrors = [];
  for (let index = 0; index < rows.length; index += 1) {
    const event = rows[index];
    if (eventType(event) !== 'run.agent_error') continue;
    const key = cliExecutionKey(event);
    const recovered = rows.slice(index + 1).some((later) => eventType(later) === 'run.agent_finish' && cliExecutionKey(later) === key);
    (recovered ? recoveredErrors : terminalErrors).push(event);
  }
  return { finishes, invalidRoleFinishes, errors, recoveredErrors, terminalErrors };
}

function summarizeMetrics({ assertions = [], runtimeEvents = [], startedAt = '', finishedAt = '', semanticJudgment = null, arm = null, stepRows = [], processEvidenceRubric = [], targetStepId = '' } = {}) {
  const required = assertions.filter((row) => row.required !== false);
  const qualityAssertions = required.filter((row) => row.quality_metric !== false);
  const deterministicQuality = qualityAssertions.length ? qualityAssertions.filter((row) => row.passed).length / qualityAssertions.length : 0;
  const semanticScore = Number(semanticJudgment?.result?.score);
  const quality = Number.isFinite(semanticScore) ? Math.max(0, Math.min(1, semanticScore)) : deterministicQuality;
  const starts = runtimeEvents.filter((event) => eventType(event) === 'run.agent_start');
  const { finishes, invalidRoleFinishes, errors, recoveredErrors, terminalErrors } = classifyCliExecutionOutcomes(runtimeEvents);
  const attempts = starts.filter(isLocalCliEvent);
  const providers = [...new Set(finishes.map((event) => clean(eventPayload(event).provider)).filter(Boolean))];
  const models = [...new Set(finishes.map((event) => clean(eventPayload(event).model)).filter(Boolean))];
  const requestedModels = [...new Set(finishes.map((event) => clean(eventPayload(event).requested_model || eventPayload(event).requestedModel)).filter(Boolean))];
  const resolvedModels = [...new Set(finishes.map((event) => normalizedResolvedModel(eventPayload(event))).filter(Boolean))];
  const exactModelIdentityComplete = finishes.length > 0 && finishes.every((event) => Boolean(normalizedResolvedModel(eventPayload(event))));
  const modelNodes = [...new Set(finishes.map((event) => modelNodeKey(eventPayload(event))).filter(Boolean))];
  const roles = [...new Set(finishes.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean))];
  const collaborationProfile = clean(arm?.collaboration_profile || arm?.collaborationProfile || '');
  const deterministicExecutions = asArray(stepRows).filter((row) => clean(row?.result?.execution_mode) === 'deterministic_state_update');
  const deterministicExecutionValid = deterministicExecutions.length > 0 && deterministicExecutions.every((row) => row?.result?.ok === true);
  const executionPresent = finishes.length > 0 || deterministicExecutionValid;
  const laneIds = [...new Set(finishes.map((event) => clean(eventPayload(event).lane_id || eventPayload(event).laneId || eventPayload(event)?.collaboration_lane?.lane_id)).filter(Boolean))];
  const collaborationAssertionTypes = new Set([
    'successful_provider_role_count',
    'successful_model_roles_include',
    'distinct_model_node_count',
    'distinct_lane_count',
    'model_role_map_alignment',
  ]);
  const collaborationAssertions = required.filter((row) => collaborationAssertionTypes.has(clean(row.type).toLowerCase()));
  const collaborationRequired = Boolean(collaborationProfile && collaborationProfile !== 'solo' && collaborationProfile !== 'auto');
  const collaborationExecutionStatus = collaborationRequired
    ? (collaborationAssertions.length > 0 && collaborationAssertions.every((row) => row.passed)
      ? 'valid_collaboration_execution'
      : 'invalid_collaboration_execution')
    : 'not_applicable';
  const comparisonStepId = clean(targetStepId) || (asArray(stepRows).length ? clean(asArray(stepRows).at(-1)?.step?.id) : '');
  const targetStepRow = comparisonStepId ? [...asArray(stepRows)].reverse().find((row) => clean(row?.step?.id) === comparisonStepId) : null;
  const targetStepDurationMs = targetStepRow
    ? Math.max(0, (Date.parse(targetStepRow.completed_at || '') || 0) - (Date.parse(targetStepRow.started_at || '') || 0))
    : null;
  let tokens = 0; let cost = 0; let hasTokens = false; let hasCost = false;
  for (const event of runtimeEvents) {
    const payload = eventPayload(event);
    for (const key of ['total_tokens', 'tokens', 'token_count']) if (Number.isFinite(Number(payload[key]))) { tokens += Number(payload[key]); hasTokens = true; break; }
    for (const key of ['cost_usd', 'estimated_cost_usd']) if (Number.isFinite(Number(payload[key]))) { cost += Number(payload[key]); hasCost = true; break; }
  }
  return {
    quality_score: quality,
    deterministic_quality_score: deterministicQuality,
    semantic_score: Number.isFinite(semanticScore) ? Math.max(0, Math.min(1, semanticScore)) : null,
    semantic_judge_present: Boolean(semanticJudgment?.result),
    required_pass: required.filter((row) => row.passed).length,
    required_fail: required.filter((row) => !row.passed).length,
    quality_assertion_count: qualityAssertions.length,
    duration_ms: Math.max(0, (Date.parse(finishedAt) || Date.now()) - (Date.parse(startedAt) || Date.now())),
    target_step_duration_ms: Number.isFinite(targetStepDurationMs) ? targetStepDurationMs : null,
    comparison_duration_ms: Number.isFinite(targetStepDurationMs) ? targetStepDurationMs : Math.max(0, (Date.parse(finishedAt) || Date.now()) - (Date.parse(startedAt) || Date.now())),
    agent_call_count: starts.length,
    cli_attempt_count: attempts.length,
    cli_success_count: finishes.length,
    cli_failure_count: terminalErrors.length,
    role_output_invalid_count: invalidRoleFinishes.length,
    cli_recovered_failure_count: recoveredErrors.length,
    cli_raw_error_count: errors.length,
    execution_status: !executionPresent || terminalErrors.length > 0 || invalidRoleFinishes.length > 0
      ? 'invalid_execution'
      : (recoveredErrors.length > 0 ? 'valid_degraded_execution' : 'valid_execution'),
    execution_eligible: executionPresent && terminalErrors.length === 0 && invalidRoleFinishes.length === 0,
    outcome_quality_score: quality,
    outcome_evaluation_scope: semanticJudgment?.evaluation_scope || null,
    process_assurance: {
      rubric: asArray(processEvidenceRubric),
      semantic_score: null,
      collaboration_profile: collaborationProfile || null,
      successful_role_count: roles.length,
      lane_count: laneIds.length,
      reviewer_present: roles.includes('verifier_critic'),
      synthesizer_present: roles.includes('delivery_synthesizer'),
      exact_model_identity_complete: exactModelIdentityComplete,
      note: 'Process assurance is reported separately and is not included in outcome_quality_score.',
    },
    execution_efficiency: {
      duration_ms: Math.max(0, (Date.parse(finishedAt) || Date.now()) - (Date.parse(startedAt) || Date.now())),
      target_step_duration_ms: Number.isFinite(targetStepDurationMs) ? targetStepDurationMs : null,
      comparison_duration_ms: Number.isFinite(targetStepDurationMs) ? targetStepDurationMs : Math.max(0, (Date.parse(finishedAt) || Date.now()) - (Date.parse(startedAt) || Date.now())),
      agent_call_count: starts.length,
      cli_attempt_count: attempts.length,
      provider_call_count: attempts.length,
      deterministic_execution_count: deterministicExecutions.length,
      total_tokens: hasTokens ? tokens : null,
      cost_usd: hasCost ? cost : null,
    },
    collaboration_profile: collaborationProfile || null,
    collaboration_execution_status: collaborationExecutionStatus,
    collaboration_assertion_failures: collaborationAssertions.filter((row) => !row.passed).map((row) => row.id),
    provider_count: providers.length,
    providers,
    models,
    requested_models: requestedModels,
    resolved_models: resolvedModels,
    exact_model_identity_complete: exactModelIdentityComplete,
    model_nodes: modelNodes,
    model_node_count: modelNodes.length,
    model_roles: roles,
    total_tokens: hasTokens ? tokens : null,
    cost_usd: hasCost ? cost : null,
  };
}

export function evaluatePortfolioPromotion({ baseline = null, challenger = null, gate = {} } = {}) {
  if (!baseline || !challenger) return { status: 'insufficient_evidence', promote: false, reasons: ['baseline_or_challenger_missing'] };
  const invalidReasons = [];
  const baselineStatus = clean(baseline.execution_status);
  const challengerStatus = clean(challenger.execution_status);
  if (!['valid_execution', 'valid_degraded_execution'].includes(baselineStatus)) invalidReasons.push('baseline_invalid_execution');
  if (!['valid_execution', 'valid_degraded_execution'].includes(challengerStatus)) invalidReasons.push('challenger_invalid_execution');
  if (invalidReasons.length) {
    return {
      status: 'invalid_execution',
      promote: false,
      quality_uplift: null,
      cost_ratio: null,
      latency_ratio: null,
      reasons: invalidReasons,
    };
  }
  if (clean(challenger.collaboration_execution_status) === 'invalid_collaboration_execution') {
    return {
      status: 'invalid_collaboration_execution',
      promote: false,
      quality_uplift: null,
      cost_ratio: null,
      latency_ratio: null,
      reasons: ['challenger_collaboration_graph_not_materialized', ...asArray(challenger.collaboration_assertion_failures)],
    };
  }
  const minUplift = Number(gate.min_quality_uplift ?? 0.05);
  const maxCostRatio = Number(gate.max_cost_ratio ?? 3);
  const maxLatencyRatio = Number(gate.max_latency_ratio ?? 3);
  const qualityUplift = Number(challenger.outcome_quality_score ?? challenger.quality_score ?? 0) - Number(baseline.outcome_quality_score ?? baseline.quality_score ?? 0);
  const costRatio = baseline.cost_usd > 0 && challenger.cost_usd !== null ? challenger.cost_usd / baseline.cost_usd : null;
  const baselineDuration = Number(baseline.comparison_duration_ms ?? baseline.target_step_duration_ms ?? baseline.duration_ms);
  const challengerDuration = Number(challenger.comparison_duration_ms ?? challenger.target_step_duration_ms ?? challenger.duration_ms);
  const latencyRatio = baselineDuration > 0 && Number.isFinite(challengerDuration) ? challengerDuration / baselineDuration : null;
  const reasons = [];
  if (challenger.required_fail > 0) reasons.push('challenger_required_assertion_failed');
  if (qualityUplift < minUplift) reasons.push('quality_uplift_below_gate');
  if (costRatio !== null && costRatio > maxCostRatio) reasons.push('cost_ratio_above_gate');
  if (latencyRatio !== null && latencyRatio > maxLatencyRatio) reasons.push('latency_ratio_above_gate');
  if (gate.require_cost_evidence === true && costRatio === null) reasons.push('cost_evidence_missing');
  if (gate.require_semantic_evidence === true && (!baseline.semantic_judge_present || !challenger.semantic_judge_present)) reasons.push('semantic_evidence_missing');
  if (gate.require_exact_model_identity === true && (baseline.exact_model_identity_complete !== true || challenger.exact_model_identity_complete !== true)) reasons.push('exact_model_identity_missing');
  if (challengerStatus === 'valid_degraded_execution' && gate.allow_degraded_execution !== true) reasons.push('challenger_degraded_execution');
  const promote = reasons.length === 0;
  const insufficientEvidenceReasons = new Set(['cost_evidence_missing', 'semantic_evidence_missing', 'exact_model_identity_missing']);
  return { status: promote ? 'promotion_candidate' : (reasons.some((reason) => insufficientEvidenceReasons.has(reason)) ? 'insufficient_evidence' : 'not_promoted'), promote, quality_uplift: qualityUplift, cost_ratio: costRatio, latency_ratio: latencyRatio, reasons };
}


function parseRoleSummaryEntries(markdown = '', roleId = '') {
  const text = String(markdown || '');
  const sections = text.split(/^##\s+/m).slice(1);
  return sections.map((section, index) => {
    const headerEnd = section.indexOf('\n');
    const header = (headerEnd >= 0 ? section.slice(0, headerEnd) : section).trim();
    const body = headerEnd >= 0 ? section.slice(headerEnd + 1) : '';
    const goalMatch = body.match(/^- goal:\s*(.*)$/m);
    const outputMarker = body.indexOf('\n- output:');
    const outputStart = outputMarker >= 0 ? outputMarker + '\n- output:'.length : -1;
    const modelMarker = outputStart >= 0 ? body.indexOf('\n- model:', outputStart) : -1;
    const output = outputStart >= 0 ? body.slice(outputStart, modelMarker >= 0 ? modelMarker : undefined).trim() : '';
    const modelMatch = body.match(/^- model:\s*(.*)$/m);
    return {
      index,
      role_id: clean(roleId),
      header,
      goal: clean(goalMatch?.[1]),
      output,
      output_sha256: output ? stableSha256(output) : null,
      output_chars: output.length,
      model: clean(modelMatch?.[1]) || null,
    };
  });
}

function currentHeadlessJobDir(transport = null) {
  try {
    const jobId = clean(transport?._currentJobId?.());
    if (!jobId) return '';
    return path.resolve(transport?.runtime?.runtimeCore?.jobs?.jobDir?.(jobId) || '');
  } catch {
    return '';
  }
}

function captureRoleSummaryCursor(transport = null) {
  const jobDir = currentHeadlessJobDir(transport);
  const roleDir = jobDir ? path.join(jobDir, 'local_memory', 'role_summaries') : '';
  const counts = {};
  if (!roleDir || !fs.existsSync(roleDir)) return { job_dir: jobDir || null, counts };
  for (const name of fs.readdirSync(roleDir).filter((value) => value.endsWith('.md')).sort()) {
    const roleId = path.basename(name, '.md');
    counts[roleId] = parseRoleSummaryEntries(fs.readFileSync(path.join(roleDir, name), 'utf8'), roleId).length;
  }
  return { job_dir: jobDir, counts };
}

function processTokens(value = '') {
  return new Set(String(value || '').toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || []);
}

function tokenJaccardDistance(left = '', right = '') {
  const a = processTokens(left);
  const b = processTokens(right);
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union > 0 ? 1 - (intersection / union) : 0;
}

function tokenJaccardSimilarity(left = '', right = '') {
  return 1 - tokenJaccardDistance(left, right);
}

function collectCollaborationProcessEvidence({ transport = null, cursor = null, targetEvents = [], targetOutput = '', targetStepId = '' } = {}) {
  const jobDir = currentHeadlessJobDir(transport);
  const roleDir = jobDir ? path.join(jobDir, 'local_memory', 'role_summaries') : '';
  if (!roleDir || !fs.existsSync(roleDir)) return null;
  const baselineCounts = asObject(cursor?.counts);
  const entriesByRole = new Map();
  const artifacts = [];
  for (const name of fs.readdirSync(roleDir).filter((value) => value.endsWith('.md')).sort()) {
    const file = path.join(roleDir, name);
    const roleId = path.basename(name, '.md');
    const allEntries = parseRoleSummaryEntries(fs.readFileSync(file, 'utf8'), roleId);
    const baseline = Math.max(0, Number(baselineCounts[roleId] || 0));
    const freshEntries = allEntries.slice(baseline);
    entriesByRole.set(roleId, [...freshEntries]);
    artifacts.push({
      role_id: roleId,
      relative_path: path.relative(jobDir, file).replaceAll('\\', '/'),
      sha256: fileSha256(file),
      size_bytes: fs.statSync(file).size,
      baseline_entry_count: baseline,
      target_entry_count: freshEntries.length,
    });
  }
  const starts = asArray(targetEvents).filter((event) => eventType(event) === 'run.agent_start' && isLocalCliEvent(event));
  const roleOffsets = new Map();
  const executions = starts.map((event, index) => {
    const payload = eventPayload(event);
    const roleId = clean(payload.role_id) || clean(payload.model_role);
    const roleEntries = entriesByRole.get(roleId) || [];
    const offset = Number(roleOffsets.get(roleId) || 0);
    roleOffsets.set(roleId, offset + 1);
    const entry = roleEntries[offset] || null;
    const goal = clean(payload.goal);
    return {
      order: index + 1,
      agent_id: clean(payload.agent_id) || null,
      role_id: roleId || null,
      model_role: clean(payload.model_role) || null,
      lane_id: clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id) || null,
      provider: clean(payload.provider) || null,
      requested_model: clean(payload.requested_model || payload.requestedModel || payload.model) || null,
      goal_sha256: goal ? stableSha256(goal) : null,
      role_summary_entry_index: entry ? entry.index : null,
      role_summary_output_sha256: entry?.output_sha256 || null,
      role_summary_output_chars: Number(entry?.output_chars || 0),
      role_summary_model: entry?.model || null,
      _output: entry?.output || '',
    };
  });
  const laneOutputs = executions.filter((row) => row.lane_id && row._output);
  const pairwiseDistances = [];
  for (let i = 0; i < laneOutputs.length; i += 1) {
    for (let j = i + 1; j < laneOutputs.length; j += 1) {
      pairwiseDistances.push(tokenJaccardDistance(laneOutputs[i]._output, laneOutputs[j]._output));
    }
  }
  const finalText = String(targetOutput || '').trim();
  const finalOverlaps = laneOutputs.map((row) => ({
    lane_id: row.lane_id,
    final_lexical_jaccard_similarity: Number(tokenJaccardSimilarity(row._output, finalText).toFixed(6)),
  }));
  return {
    schema_version: 'ddalggak.collaboration_process_evidence/v1',
    target_step_id: clean(targetStepId) || null,
    evidence_scope: 'target_execution_only',
    outcome_score_inclusion: false,
    lineage_granularity: 'role_and_lane_output',
    role_summary_artifacts: artifacts,
    executions: executions.map(({ _output, ...row }) => row),
    lane_output_lineage: laneOutputs.map((row) => ({
      lane_id: row.lane_id,
      agent_id: row.agent_id,
      role_id: row.role_id,
      model_role: row.model_role,
      output_sha256: row.role_summary_output_sha256,
      output_chars: row.role_summary_output_chars,
    })),
    lane_output_count: laneOutputs.length,
    distinct_lane_output_hash_count: new Set(laneOutputs.map((row) => row.role_summary_output_sha256).filter(Boolean)).size,
    mean_pairwise_lane_lexical_distance: pairwiseDistances.length
      ? Number((pairwiseDistances.reduce((sum, value) => sum + value, 0) / pairwiseDistances.length).toFixed(6))
      : null,
    final_response_sha256: finalText ? stableSha256(finalText) : null,
    final_response_chars: finalText.length,
    final_lane_overlap_proxy: finalOverlaps,
    note: 'This process evidence preserves target-stage role/lane lineage separately from outcome quality. Lexical distance/overlap are diagnostics, not semantic quality scores.',
  };
}

function buildCliCallRows(runtimeEvents = []) {
  const calls = [];
  const openByAgent = new Map();
  for (const event of runtimeEvents) {
    const type = eventType(event);
    if (!['run.agent_start', 'run.agent_finish', 'run.agent_error'].includes(type) || !isLocalCliEvent(event)) continue;
    const payload = eventPayload(event);
    const key = [clean(payload.agent_id), clean(payload.runtime_instance_id), clean(payload.slot_id), clean(payload.scope_id)].join(':');
    if (type === 'run.agent_start') {
      const row = {
        call_id: clean(event.event_id) || `${key}:${calls.length + 1}`,
        agent_id: clean(payload.agent_id),
        role_id: clean(payload.role_id),
        model_role: clean(payload.model_role),
        lane_id: clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id),
        provider: clean(payload.provider),
        model: clean(payload.model),
        model_node: modelNodeKey(payload),
        execution_channel: clean(payload.execution_channel),
        goal: clean(payload.goal),
        started_at: clean(event.occurred_at || event.ts),
        status: 'attempted',
      };
      calls.push(row);
      openByAgent.set(key, row);
      continue;
    }
    const row = openByAgent.get(key) || {
      call_id: clean(event.event_id) || `${key}:${calls.length + 1}`,
      agent_id: clean(payload.agent_id),
      role_id: clean(payload.role_id),
      model_role: clean(payload.model_role),
      lane_id: clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id),
      provider: clean(payload.provider),
      model: clean(payload.model),
      model_node: modelNodeKey(payload),
      execution_channel: clean(payload.execution_channel),
      started_at: '',
    };
    if (!calls.includes(row)) calls.push(row);
    row.status = type === 'run.agent_finish'
      ? (payload.role_output_valid === false ? 'invalid_role_output' : 'succeeded')
      : 'failed';
    row.finished_at = clean(event.occurred_at || event.ts);
    row.output_chars = Number(payload.output_chars || 0);
    row.error = type === 'run.agent_error' ? clean(payload.error) : '';
    row.provider_execution_success = payload.provider_execution_success === true;
    row.role_output_valid = payload.role_output_valid === false ? false : (type === 'run.agent_finish' ? true : null);
    row.role_output_validation_reason = clean(payload.role_output_validation_reason);
    row.provider = clean(payload.provider || row.provider);
    row.model = clean(payload.model || row.model);
    row.requested_model = clean(payload.requested_model || row.requested_model);
    row.resolved_model = normalizedResolvedModel(payload) || normalizedResolvedModel(row);
    row.model_node = modelNodeKey({ provider: row.provider, model: row.model, requested_model: row.requested_model, resolved_model: row.resolved_model });
    const startMs = Date.parse(row.started_at || '');
    const endMs = Date.parse(row.finished_at || '');
    row.duration_ms = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : null;
    openByAgent.delete(key);
  }
  return calls;
}

function writeTraceViews(runDir, trace, runtimeEvents, steps) {
  const cliCalls = buildCliCallRows(runtimeEvents);
  const categories = {
    'memory_candidates.jsonl': trace.filter((row) => eventType(row) === 'memory.candidate_created'),
    'memory_decisions.jsonl': trace.filter((row) => eventType(row) === 'memory.decision'),
    'memory_commits.jsonl': trace.filter((row) => eventType(row) === 'memory.committed'),
    'context_projections.jsonl': trace.filter((row) => eventType(row) === 'context.projection_compiled'),
    'provider_invocations.jsonl': runtimeEvents.filter((row) => ['run.agent_start', 'run.agent_finish', 'run.agent_error'].includes(eventType(row))),
    'cli_calls.jsonl': cliCalls,
  };
  for (const [name, rows] of Object.entries(categories)) fs.writeFileSync(path.join(runDir, name), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(runDir, 'runtime_events.jsonl'), runtimeEvents.map((row) => JSON.stringify(row)).join('\n') + (runtimeEvents.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(runDir, 'turns.jsonl'), steps.filter((row) => clean(row.step?.action) === 'send_message').map((row) => JSON.stringify({ step_id: row.step.id, user: row.step.text, assistant: row.result?.output || '', run_id: row.result?.run_id || '' })).join('\n') + '\n', 'utf8');
  const roomStates = steps
    .filter((row) => row?.result?.room_state && typeof row.result.room_state === 'object')
    .map((row) => ({ step_id: row.step.id, action: row.step.action, completed_at: row.completed_at, ...row.result.room_state }));
  fs.writeFileSync(path.join(runDir, 'room_state_snapshots.jsonl'), roomStates.map((row) => JSON.stringify(row)).join('\n') + (roomStates.length ? '\n' : ''), 'utf8');
  writeJson(path.join(runDir, 'room_configuration.json'), roomStates.length ? roomStates[roomStates.length - 1] : {});
  writeJson(path.join(runDir, 'memory_structure.json'), {
    schema_version: 'ddalggak.room_journey_memory_structure/v1',
    candidate_ids: trace.filter((row) => eventType(row) === 'memory.candidate_created').map((row) => clean(eventPayload(row).candidate_id)).filter(Boolean),
    committed_memory_ids: trace.filter((row) => eventType(row) === 'memory.committed').map((row) => clean(eventPayload(row).memory_id)).filter(Boolean),
    projection_ids: trace.filter((row) => eventType(row) === 'context.projection_compiled').map((row) => clean(eventPayload(row).projection_id)).filter(Boolean),
    approved_memory_ids_used: [...new Set(trace.filter((row) => eventType(row) === 'context.projection_compiled').flatMap((row) => asArray(eventPayload(row).approved_memory_ids)).map(clean).filter(Boolean))],
    pending_candidate_ids_suppressed: [...new Set(trace.filter((row) => eventType(row) === 'context.projection_compiled').flatMap((row) => asArray(eventPayload(row).pending_memory_candidate_ids)).map(clean).filter(Boolean))],
  });
}

export async function buildFrozenPreTargetRoomSnapshot({ scenario = {}, transport, outputRoot = '', options = {} } = {}) {
  const targetStepId = comparisonTargetStepId(scenario);
  if (!targetStepId || typeof transport?.exportFrozenSnapshot !== 'function') return null;
  const targetIndex = asArray(scenario.steps).findIndex((step) => clean(step?.id) === targetStepId);
  if (targetIndex <= 0) return null;
  await transport.initialize?.();
  const routing = routingExperimentConfig(scenario);
  const experiment = asObject(scenario.experiment);
  const commonProfile = clean(routing.common_buildup_collaboration_profile || routing.commonBuildupCollaborationProfile || experiment.common_buildup_collaboration_profile || experiment.commonBuildupCollaborationProfile || 'solo');
  if (commonProfile) await transport.sendCommand?.(`/collab use ${commonProfile}`);
  const seedArm = normalizeArm({ id: '__frozen_seed__', title: 'Frozen pre-target Room seed', collaboration_profile: commonProfile, input_kind: 'normal' }, '__frozen_seed__');
  const stepRows = [];
  for (const step of asArray(scenario.steps).slice(0, targetIndex)) {
    const stepStarted = nowIso();
    let result;
    try { result = await executeStep({ step, arm: seedArm, transport, options: { ...options, targetStepId: '' } }); }
    catch (error) { result = { ok: false, error: String(error?.message || error) }; }
    if ((!result?.room_state || typeof result.room_state !== 'object') && typeof transport.snapshotState === 'function') {
      try { result = { ...asObject(result), room_state: transport.snapshotState() }; } catch {}
    }
    const row = { step, started_at: stepStarted, completed_at: nowIso(), result };
    stepRows.push(row);
    if (step.stop_on_failure !== false && result?.ok === false) throw new Error(`Frozen pre-target buildup failed at ${clean(step.id)}`);
  }
  const authoritativeContextManifest = authoritativeContextManifestFromScenario(scenario, targetStepId);
  const snapshot = await transport.exportFrozenSnapshot({
    destinationRoot: path.join(path.resolve(outputRoot), '_frozen_snapshots'),
    scenarioId: scenario.id,
    targetStepId,
    authoritativeContextManifest,
    buildupSteps: stepRows,
  });
  const withBuildup = { ...snapshot, buildup_steps: stepRows, common_buildup_collaboration_profile: commonProfile };
  writeJson(path.join(snapshot.snapshot_root, 'snapshot.json'), withBuildup);
  writeJsonlRows(path.join(snapshot.snapshot_root, 'buildup_steps.jsonl'), stepRows);
  return withBuildup;
}

export async function runRoomJourneyScenario({ scenario, arm = null, outputRoot = 'experiments/room_journeys', transport, execute = false, traceRoot = '', options = {}, frozenPreTargetSnapshot = null } = {}) {
  const selectedArm = arm || scenarioArms(scenario)[0];
  const runId = `${safe(scenario.id)}__${safe(selectedArm.id)}__${Date.now().toString(36)}`;
  const runDir = ensureDir(path.resolve(outputRoot, runId));
  const startedAt = nowIso();
  writeJson(path.join(runDir, 'scenario.json'), scenario);
  writeJson(path.join(runDir, 'arm.json'), selectedArm);
  if (!execute) {
    const plan = { schema_version: 'ddalggak.room_journey_run/v1', run_id: runId, status: 'planned', scenario_id: scenario.id, arm: selectedArm, steps: scenario.steps };
    writeJson(path.join(runDir, 'summary.json'), plan);
    return { runDir, summary: plan };
  }
  await transport.initialize?.();
  const targetStepId = comparisonTargetStepId(scenario);
  if (frozenPreTargetSnapshot && typeof transport.restoreFrozenSnapshot === 'function') {
    await transport.restoreFrozenSnapshot(frozenPreTargetSnapshot);
  }
  if (selectedArm.collaboration_profile) await transport.sendCommand(`/collab use ${selectedArm.collaboration_profile}`);
  for (const command of selectedArm.setup_commands) await transport.sendCommand(command);
  const armPreTargetRoomState = frozenPreTargetSnapshot && typeof transport.snapshotState === 'function' ? transport.snapshotState() : null;
  const processEvidenceCursor = captureRoleSummaryCursor(transport);
  const stepRows = frozenPreTargetSnapshot ? deepClone(asArray(frozenPreTargetSnapshot.buildup_steps)) : [];
  if (frozenPreTargetSnapshot) {
    for (const row of stepRows) appendJsonl(path.join(runDir, 'steps.jsonl'), {
      ...row,
      reused_from_frozen_snapshot: true,
      frozen_snapshot_id: clean(frozenPreTargetSnapshot.snapshot_id),
    });
  }
  const stepsToExecute = frozenPreTargetSnapshot && targetStepId
    ? asArray(scenario.steps).slice(Math.max(0, asArray(scenario.steps).findIndex((step) => clean(step?.id) === targetStepId)))
    : asArray(scenario.steps);
  for (const step of stepsToExecute) {
    const stepStarted = nowIso();
    let result;
    try { result = await executeStep({
      step,
      arm: selectedArm,
      transport,
      options: {
        ...options,
        targetStepId,
        authoritativeContextManifest: frozenPreTargetSnapshot?.authoritative_context_manifest || null,
      },
    }); }
    catch (error) { result = { ok: false, error: String(error?.message || error) }; }
    if (clean(step?.id) === targetStepId && armPreTargetRoomState) result = { ...asObject(result), pre_target_room_state: armPreTargetRoomState };
    if ((!result?.room_state || typeof result.room_state !== 'object') && typeof transport.snapshotState === 'function') {
      try { result = { ...asObject(result), room_state: transport.snapshotState() }; } catch {}
    }
    const row = { step, started_at: stepStarted, completed_at: nowIso(), result };
    stepRows.push(row);
    appendJsonl(path.join(runDir, 'steps.jsonl'), row);
    if (step.stop_on_failure !== false && result?.ok === false) break;
  }
  const traceChatId = clean(options.chatId || transport?.chatId || selectedArm.metadata?.chat_id || selectedArm.metadata?.chatId);
  const trace = readRoomJourneyTrace({ chatId: traceChatId, traceRoot, afterTs: startedAt });
  const runtimeEvents = asArray(transport.events);
  const stepsById = Object.fromEntries(stepRows.map((row) => [row.step.id, row]));
  const latestRoomState = [...stepRows].reverse().find((row) => row?.result?.room_state)?.result?.room_state || null;
  const targetStepRow = targetStepId ? stepsById[targetStepId] : null;
  const targetProcessEvents = targetStepId ? runtimeEventsForAssertion({ runtimeEvents, stepsById }, { step_id: targetStepId }) : runtimeEvents;
  const collaborationProcessEvidence = collectCollaborationProcessEvidence({
    transport,
    cursor: processEvidenceCursor,
    targetEvents: targetProcessEvents,
    targetOutput: clean(targetStepRow?.result?.output),
    targetStepId,
  });
  const assertions = asArray(scenario.assertions)
    .filter((assertion) => assertionApplies(assertion, selectedArm.id))
    .map((assertion) => assertionResult(assertion, {
      trace,
      runtimeEvents,
      stepsById,
      latestRoomState,
      modelRoleMap: options.modelRoleMap || null,
      arm: selectedArm,
    }));
  const executionFinishedAt = nowIso();
  let semanticJudgment = null;
  if (clean(options.judgeProvider) && scenario.semantic_judge !== false) {
    try {
      semanticJudgment = await judgeRoomJourneyRun({
        scenario,
        arm: selectedArm,
        stepRows,
        assertions,
        runDir,
        provider: clean(options.judgeProvider),
        model: clean(options.judgeModel),
        reasoningEffort: clean(options.judgeReasoningEffort || 'high'),
        timeoutMs: Number(options.judgeTimeoutMs || 180000),
        executor: options.judgeExecutor,
      });
    } catch (error) {
      semanticJudgment = { provider: clean(options.judgeProvider), ok: false, result: null, error: String(error?.message || error), judged_at: nowIso() };
    }
    const judgeRequired = asObject(scenario.semantic_judge).required === true;
    assertions.push({
      id: 'semantic_judge',
      type: 'semantic_judge',
      required: judgeRequired,
      quality_metric: true,
      passed: semanticJudgment?.result?.passed === true,
      observed: semanticJudgment?.result || { error: semanticJudgment?.error || 'judge_result_unavailable' },
      description: 'Semantic judge assessment of the end-to-end Room journey',
    });
  }
  const finishedAt = nowIso();
  const metrics = summarizeMetrics({
    assertions,
    runtimeEvents,
    startedAt,
    finishedAt: executionFinishedAt,
    semanticJudgment,
    arm: selectedArm,
    stepRows,
    processEvidenceRubric: asArray(scenario.process_evidence_rubric || scenario.processEvidenceRubric),
    targetStepId,
  });
  metrics.evaluation_duration_ms = Math.max(0, (Date.parse(finishedAt) || Date.now()) - (Date.parse(executionFinishedAt) || Date.now()));
  const summary = {
    schema_version: 'ddalggak.room_journey_run/v1',
    run_id: runId,
    scenario_id: scenario.id,
    scenario_title: scenario.title || scenario.id,
    arm: selectedArm,
    status: assertions.some((row) => row.required !== false && !row.passed) ? 'failed' : 'passed',
    started_at: startedAt,
    execution_finished_at: executionFinishedAt,
    finished_at: finishedAt,
    metrics,
    assertions,
    semantic_judgment: semanticJudgment,
    collaboration_process_evidence: collaborationProcessEvidence,
    transport: {
      type: transport instanceof HeadlessRoomJourneyTransport ? 'headless' : 'goc',
      thread_id: clean(transport?.threadId) || null,
      room_id: clean(transport?.chatId) || null,
      user_id: clean(transport?.userId) || null,
      runtime_root: clean(transport?.runtimeRoot) || null,
    },
    frozen_pre_target_snapshot: frozenPreTargetSnapshot ? {
      snapshot_mode: clean(frozenPreTargetSnapshot.snapshot_mode),
      snapshot_id: clean(frozenPreTargetSnapshot.snapshot_id),
      canonical_content_sha256: clean(frozenPreTargetSnapshot.canonical_content_sha256),
      target_step_id: clean(frozenPreTargetSnapshot.target_step_id),
      common_buildup_collaboration_profile: clean(frozenPreTargetSnapshot.common_buildup_collaboration_profile),
      authoritative_context_manifest_id: clean(frozenPreTargetSnapshot?.authoritative_context_manifest?.manifest_id) || null,
    } : null,
    trace_contract: {
      raw_provider_prompts_saved: true,
      raw_provider_prompt_scope: 'local_debug_runtime',
      raw_provider_prompt_location: '_runtime/<job-id>/llm_traces/<trace-id>/prompt.txt',
      raw_room_transcript_saved: true,
      identifiers_hashes_and_redacted_previews_only: false,
      sensitive_debug_artifacts_present: true,
      external_share_requires_review: true,
      retention_note: 'Raw prompts and test transcripts are intentionally retained for debugging until the benchmark is stabilized.',
    },
  };
  writeTraceViews(runDir, trace, runtimeEvents, stepRows);
  writeJson(path.join(runDir, 'assertions.json'), assertions);
  if (collaborationProcessEvidence) writeJson(path.join(runDir, 'collaboration_process_evidence.json'), collaborationProcessEvidence);
  writeJson(path.join(runDir, 'summary.json'), summary);
  return { runDir, summary, steps: stepRows, trace, runtimeEvents };
}


const DEFAULT_CONCIERGE_EXECUTION_SHAPE_ORDER = Object.freeze([
  'state_update',
  'direct_answer',
  'single_agent',
  'single_agent_with_retrieval',
  'single_agent_search',
  'builder_reviewer',
  'parallel_ideation',
  'evidence_panel',
  'bounded_loop_team',
]);

function routingExperimentConfig(scenario = {}) {
  return asObject(scenario.routing_experiment || scenario.routingExperiment);
}

function routingTargetStepId(scenario = {}) {
  const config = routingExperimentConfig(scenario);
  return clean(config.target_step_id || config.targetStepId);
}

function comparisonTargetStepId(scenario = {}) {
  const routingTarget = routingTargetStepId(scenario);
  if (routingTarget) return routingTarget;
  const experiment = asObject(scenario.experiment);
  return clean(experiment.target_step_id || experiment.targetStepId || experiment.comparison_target_step_id || experiment.comparisonTargetStepId);
}

function shouldUseFrozenPreTargetFork(scenario = {}, execute = false) {
  if (!execute || !comparisonTargetStepId(scenario)) return false;
  const experiment = asObject(scenario.experiment);
  const routing = routingExperimentConfig(scenario);
  if (experiment.pre_target_fork === false || experiment.preTargetFork === false) return false;
  if (routing.pre_target_fork === false || routing.preTargetFork === false) return false;
  return true;
}

function routingExecutionShape(scenario = {}, arm = {}) {
  const config = routingExperimentConfig(scenario);
  const candidates = asObject(config.candidate_shapes || config.candidateShapes);
  return clean(candidates[clean(arm?.id)] || arm?.metadata?.execution_shape || arm?.metadata?.executionShape || (
    clean(arm?.id) === 'solo' ? 'single_agent' : clean(arm?.collaboration_profile || arm?.id)
  ));
}

function routingShapeOrder(scenario = {}) {
  const configured = asArray(routingExperimentConfig(scenario).shape_complexity_order || routingExperimentConfig(scenario).shapeComplexityOrder)
    .map((value) => clean(value).toLowerCase())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_CONCIERGE_EXECUTION_SHAPE_ORDER];
}

function routingShapeRank(shape = '', scenario = {}) {
  const normalized = clean(shape).toLowerCase();
  const order = routingShapeOrder(scenario);
  const index = order.indexOf(normalized);
  return index >= 0 ? index : order.length + 10;
}

function coarseConciergeRouteForExecutionShape(shape = '') {
  const value = clean(shape).toLowerCase();
  if (['direct_answer', 'single_agent', 'single_agent_with_retrieval'].includes(value)) return 'concierge_direct_answer';
  if (value === 'single_agent_search') return 'concierge_search_answer';
  if (['builder_reviewer', 'parallel_ideation', 'evidence_panel', 'bounded_loop_team'].includes(value)) return 'team_orchestration';
  return null;
}

function roomComplexitySnapshot(roomState = {}) {
  const state = asObject(roomState);
  return {
    recent_room_turn_count: Number(state.recent_room_turn_count || 0),
    runtime_rule_count: asArray(state.runtime_rules).length,
    memory_candidate_count: asArray(state.memory_candidates).length,
    room_memory_item_count: asArray(state.room_memory_items).length,
    pending_approval: state.pending_approval === true,
    collaboration_profile_id: clean(state.collaboration_profile_id || 'auto') || 'auto',
  };
}

function labelSafeRoomSnapshot(roomState = {}) {
  const snapshot = roomComplexitySnapshot(roomState);
  const { collaboration_profile_id: _candidateSpecificProfile, ...labelSafe } = snapshot;
  return labelSafe;
}

function routingMeasurementPolicy(scenario = {}) {
  const config = routingExperimentConfig(scenario);
  const raw = asObject(config.measurement_policy || config.measurementPolicy);
  return {
    label_status: clean(raw.label_status || raw.labelStatus || raw.status || 'active').toLowerCase() || 'active',
    quarantine_reason: clean(raw.quarantine_reason || raw.quarantineReason),
    require_context_parity: raw.require_context_parity === true || raw.requireContextParity === true,
    require_context_coverage_evidence: raw.require_context_coverage_evidence === true || raw.requireContextCoverageEvidence === true,
    require_frozen_pre_target_snapshot: raw.require_frozen_pre_target_snapshot === true || raw.requireFrozenPreTargetSnapshot === true,
    require_runtime_shape_evidence: raw.require_runtime_shape_evidence === true || raw.requireRuntimeShapeEvidence === true,
  };
}

function routingRequiredContextStepIds(scenario = {}) {
  const config = routingExperimentConfig(scenario);
  const experiment = asObject(scenario.experiment);
  const configured = asArray(config.required_context_step_ids || config.requiredContextStepIds);
  const fallback = asArray(experiment.required_context_step_ids || experiment.requiredContextStepIds || experiment.evaluation_context_step_ids || experiment.evaluationContextStepIds);
  return [...new Set((configured.length ? configured : fallback).map(clean).filter(Boolean))];
}

function preRouteExperimentInputSnapshot(scenario = {}, targetStepId = '') {
  const steps = asArray(scenario.steps);
  const targetIndex = steps.findIndex((step) => clean(step?.id) === clean(targetStepId));
  if (targetIndex < 0) return null;
  const inputs = steps.slice(0, targetIndex).map((step) => ({
    id: clean(step?.id),
    action: clean(step?.action),
    input_kind: clean(step?.input_kind || step?.inputKind),
    text: clean(step?.text),
    command: clean(step?.command),
    profile: clean(step?.profile),
  }));
  const canonical = { scenario_id: clean(scenario.id), target_step_id: clean(targetStepId), steps: inputs };
  return {
    snapshot_mode: 'independent_arm_replay',
    source: 'scenario_steps_before_target',
    step_ids: inputs.map((step) => step.id).filter(Boolean),
    step_count: inputs.length,
    sha256: stableSha256(canonical),
  };
}

function traceEventsWithinStep(trace = [], stepRow = {}) {
  const start = Date.parse(stepRow?.started_at || '');
  const end = Date.parse(stepRow?.completed_at || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  return asArray(trace).filter((event) => {
    const at = Date.parse(event?.ts || event?.occurred_at || event?.ingested_at || '');
    return Number.isFinite(at) && at >= start && at <= end;
  });
}

function contextProjectionEvidence({ trace = [], targetRow = {}, targetEvents = [], requiredContextStepIds = [] } = {}) {
  const projections = traceEventsWithinStep(trace, targetRow).filter((event) => eventType(event) === 'context.projection_compiled');
  const payloads = projections.map((event) => eventPayload(event));
  const runtimeSourceStepIds = [...new Set(payloads.flatMap((payload) => [
    ...asArray(payload.selected_source_step_ids || payload.selectedSourceStepIds),
    ...asArray(payload.source_step_ids || payload.sourceStepIds),
    ...asArray(payload.selected_atoms).map((atom) => clean(atom?.source_step_id || atom?.sourceStepId)),
  ]).map(clean).filter(Boolean))];
  const required = [...new Set(asArray(requiredContextStepIds).map(clean).filter(Boolean))];
  const manifest = asObject(targetRow?.result?.authoritative_context_manifest);
  const manifestStepIds = [...new Set(asArray(manifest.items).map((item) => clean(item?.source_step_id)).filter(Boolean))];
  const manifestMissing = required.filter((id) => !manifestStepIds.includes(id));
  const manifestId = clean(manifest.manifest_id);
  const roleStarts = asArray(targetEvents).filter((event) => eventType(event) === 'run.agent_start' && isLocalCliEvent(event));
  const roleDeliveries = roleStarts.map((event) => {
    const payload = eventPayload(event);
    const goal = clean(payload.goal);
    const deliveredSourceStepIds = required.filter((id) => goal.includes(`source_step_id=${id}`));
    const missingSourceStepIds = required.filter((id) => !deliveredSourceStepIds.includes(id));
    const manifestMarkerPresent = Boolean(manifestId && goal.includes(manifestId));
    return {
      agent_id: clean(payload.agent_id),
      role_id: clean(payload.role_id),
      model_role: clean(payload.model_role),
      lane_id: clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id) || null,
      manifest_id: manifestId || null,
      manifest_marker_present: manifestMarkerPresent,
      delivered_source_step_ids: deliveredSourceStepIds,
      missing_source_step_ids: missingSourceStepIds,
      complete: manifestMarkerPresent && missingSourceStepIds.length === 0,
    };
  });
  const roleDeliveryComplete = roleDeliveries.length > 0 && roleDeliveries.every((row) => row.complete === true);
  let coverageStatus = 'not_declared';
  let coverageSource = 'none';
  if (required.length) {
    if (!manifestId || manifest.complete !== true) {
      coverageStatus = 'missing_authoritative_manifest';
      coverageSource = 'benchmark_authoritative_context_manifest';
    } else if (manifestMissing.length) {
      coverageStatus = 'incomplete';
      coverageSource = 'benchmark_authoritative_context_manifest';
    } else if (!roleDeliveries.length) {
      coverageStatus = clean(targetRow?.result?.execution_mode) === 'deterministic_state_update' ? 'verified' : 'missing_role_delivery_evidence';
      coverageSource = 'benchmark_authoritative_context_manifest';
    } else if (!roleDeliveryComplete) {
      coverageStatus = 'incomplete_role_delivery';
      coverageSource = 'benchmark_authoritative_context_manifest';
    } else {
      coverageStatus = 'verified';
      coverageSource = 'benchmark_authoritative_context_manifest';
    }
  } else if (runtimeSourceStepIds.length) {
    coverageStatus = 'runtime_projection_observed';
    coverageSource = 'runtime_context_projection';
  }
  return {
    projection_count: projections.length,
    projection_ids: [...new Set(payloads.map((payload) => clean(payload.projection_id)).filter(Boolean))],
    substrate_snapshot_ids: [...new Set(payloads.map((payload) => clean(payload.snapshot_id)).filter(Boolean))],
    role_ids: [...new Set(payloads.map((payload) => clean(payload.role_id)).filter(Boolean))],
    model_nodes: [...new Set(payloads.map((payload) => clean(payload.model_node)).filter(Boolean))],
    selected_atom_ids: [...new Set(payloads.flatMap((payload) => asArray(payload.selected_atom_ids)).map(clean).filter(Boolean))],
    selected_atom_types: [...new Set(payloads.flatMap((payload) => asArray(payload.selected_atom_types)).map(clean).filter(Boolean))],
    approved_memory_ids: [...new Set(payloads.flatMap((payload) => asArray(payload.approved_memory_ids)).map(clean).filter(Boolean))],
    required_context_step_ids: required,
    runtime_projection_source_step_ids: runtimeSourceStepIds,
    authoritative_manifest_id: manifestId || null,
    authoritative_manifest_sha256: clean(manifest.sha256) || null,
    authoritative_manifest_source_step_ids: manifestStepIds,
    missing_required_context_step_ids: manifestMissing,
    role_delivery_evidence: roleDeliveries,
    role_delivery_complete: roleDeliveryComplete || (required.length === 0),
    common_evidence_hash: clean(manifest.sha256) || null,
    coverage_source: coverageSource,
    coverage_status: coverageStatus,
    provenance_complete: coverageStatus === 'verified',
  };
}

function targetExecutionEvidence(successfulFinishes = []) {
  const payloads = asArray(successfulFinishes).map((event) => eventPayload(event));
  const providers = [...new Set(payloads.map((payload) => clean(payload.provider).toLowerCase()).filter(Boolean))];
  const modelRoles = [...new Set(payloads.map((payload) => clean(payload.model_role || payload.role_id).toLowerCase()).filter(Boolean))];
  const modelNodes = [...new Set(payloads.map((payload) => modelNodeKey(payload)).filter(Boolean))];
  const requestedModels = [...new Set(payloads.map((payload) => clean(payload.requested_model || payload.requestedModel)).filter(Boolean))];
  const resolvedModels = [...new Set(payloads.map((payload) => normalizedResolvedModel(payload)).filter(Boolean))];
  const lanes = [...new Set(payloads.map((payload) => clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id || payload?.collaborationLane?.laneId)).filter(Boolean))];
  return {
    successful_role_count: modelRoles.length,
    model_roles: modelRoles,
    providers,
    requested_models: requestedModels,
    resolved_models: resolvedModels,
    exact_model_identity_complete: payloads.length > 0 && payloads.every((payload) => Boolean(normalizedResolvedModel(payload))),
    model_nodes: modelNodes,
    lane_ids: lanes,
    lane_count: lanes.length,
    agent_finish_count: successfulFinishes.length,
  };
}


function actualExecutionContract({ plannedShape = '', successfulFinishes = [], targetRow = {}, contextEvidence = {} } = {}) {
  const evidence = targetExecutionEvidence(successfulFinishes);
  const roles = asArray(evidence.model_roles);
  const deterministicStateUpdate = clean(targetRow?.result?.execution_mode) === 'deterministic_state_update';
  const hasReviewer = roles.includes('verifier_critic');
  const hasSynthesizer = roles.includes('delivery_synthesizer');
  const laneCount = Number(evidence.lane_count || 0);
  const shape = clean(plannedShape).toLowerCase();
  let contractMatch = false;
  if (shape === 'state_update') contractMatch = deterministicStateUpdate && Number(evidence.agent_finish_count || 0) === 0;
  else if (['direct_answer', 'single_agent', 'single_agent_with_retrieval', 'single_agent_search'].includes(shape)) contractMatch = !deterministicStateUpdate && Number(evidence.agent_finish_count || 0) >= 1 && laneCount <= 1;
  else if (shape === 'builder_reviewer') contractMatch = Number(evidence.agent_finish_count || 0) >= 3 && roles.includes('code_executor') && hasReviewer && hasSynthesizer;
  else if (['parallel_ideation', 'evidence_panel'].includes(shape)) contractMatch = Number(evidence.agent_finish_count || 0) >= 3 && roles.includes('source_grounder') && laneCount >= 2 && hasReviewer && hasSynthesizer;
  else if (shape === 'bounded_loop_team') contractMatch = Number(evidence.agent_finish_count || 0) >= 2;
  return {
    schema_version: 'ddalggak.actual_execution_contract/v1',
    planned_shape: shape || null,
    observed_shape: contractMatch ? shape : (deterministicStateUpdate ? 'state_update' : (laneCount >= 2 ? 'unclassified_multi_lane_team' : (evidence.agent_finish_count > 1 ? 'unclassified_team' : 'single_agent'))),
    contract_match: contractMatch,
    deterministic_state_update: deterministicStateUpdate,
    provider_call_count: Number(evidence.agent_finish_count || 0),
    model_roles: roles,
    providers: asArray(evidence.providers),
    model_nodes: asArray(evidence.model_nodes),
    lane_ids: asArray(evidence.lane_ids),
    lane_count: laneCount,
    reviewer_present: hasReviewer,
    synthesizer_present: hasSynthesizer,
    retrieval_or_context_projection_used: Number(contextEvidence?.projection_count || 0) > 0 || clean(contextEvidence?.coverage_status) === 'verified',
    common_evidence_hash: clean(contextEvidence?.common_evidence_hash) || null,
    common_evidence_delivery_complete: contextEvidence?.role_delivery_complete === true || deterministicStateUpdate,
    exact_model_identity_complete: deterministicStateUpdate ? true : evidence.exact_model_identity_complete === true,
    requested_models: asArray(evidence.requested_models),
    resolved_models: asArray(evidence.resolved_models),
  };
}

export function buildConciergeRoutingObservation({ scenario = {}, result = {} } = {}) {
  const config = routingExperimentConfig(scenario);
  const measurementPolicy = routingMeasurementPolicy(scenario);
  const targetStepId = routingTargetStepId(scenario);
  if (!targetStepId) return null;
  const steps = asArray(result.steps);
  const targetIndex = steps.findIndex((row) => clean(row?.step?.id) === targetStepId);
  if (targetIndex < 0) return null;
  const targetRow = steps[targetIndex];
  const previousRoomState = targetIndex > 0 ? asObject(steps[targetIndex - 1]?.result?.room_state) : {};
  const armPreTargetRoomState = asObject(targetRow?.result?.pre_target_room_state);
  const effectivePreTargetRoomState = Object.keys(armPreTargetRoomState).length ? armPreTargetRoomState : previousRoomState;
  const targetRoomState = asObject(targetRow?.result?.room_state);
  const stepsById = Object.fromEntries(steps.map((row) => [clean(row?.step?.id), row]).filter(([id]) => id));
  const targetEvents = runtimeEventsForAssertion({
    runtimeEvents: asArray(result.runtimeEvents),
    stepsById,
  }, { step_id: targetStepId });
  const outcomes = classifyCliExecutionOutcomes(targetEvents);
  const successfulFinishes = outcomes.finishes.filter((event) => isValidRoleFinish(event));
  const providerExecutionValid = targetRow?.result?.ok === true && outcomes.terminalErrors.length === 0;
  const roleOutputValid = outcomes.invalidRoleFinishes.length === 0;
  const requiredAssertionFailures = asArray(result?.summary?.assertions).filter((row) => row?.required !== false && row?.passed !== true && clean(row?.type) !== 'semantic_judge');
  const semanticScore = Number(result?.summary?.metrics?.semantic_score);
  const semanticJudgePresent = result?.summary?.metrics?.semantic_judge_present === true && Number.isFinite(semanticScore);
  const targetDurationMs = Math.max(0, (Date.parse(targetRow?.completed_at || '') || 0) - (Date.parse(targetRow?.started_at || '') || 0));
  const targetText = clean(targetRow?.step?.text);
  const conciergeShadow = classifyRoomConciergeRoute({
    text: targetText,
    command: '/chat',
    pendingApproval: effectivePreTargetRoomState.pending_approval === true,
    roomFootprint: roomComplexitySnapshot(effectivePreTargetRoomState),
  });
  const turnRouterShadow = buildRoomTurnRoute({
    taskText: targetText,
    inputKind: '',
    chatId: clean(effectivePreTargetRoomState.chat_id || targetRoomState.chat_id),
    roomPackage: asObject(effectivePreTargetRoomState.agent_room_profile?.room_package || effectivePreTargetRoomState.agent_room_profile?.roomPackage),
    source: 'room_journey_concierge_shadow_probe',
  });
  const executionShape = routingExecutionShape(scenario, result?.summary?.arm || {});
  const runtimeDeclaredExecutionShape = clean(targetRoomState?.last_route?.execution_shape || targetRoomState?.lastRoute?.executionShape);
  const frozenSnapshot = asObject(result?.summary?.frozen_pre_target_snapshot);
  const fallbackInputSnapshot = preRouteExperimentInputSnapshot(scenario, targetStepId);
  const inputSnapshot = clean(frozenSnapshot.snapshot_id) ? {
    snapshot_mode: clean(frozenSnapshot.snapshot_mode),
    source: 'frozen_pre_target_room_snapshot',
    snapshot_id: clean(frozenSnapshot.snapshot_id),
    sha256: clean(frozenSnapshot.canonical_content_sha256),
    target_step_id: clean(frozenSnapshot.target_step_id),
  } : fallbackInputSnapshot;
  const roomSnapshot = clean(frozenSnapshot.snapshot_id) ? {
    snapshot_mode: clean(frozenSnapshot.snapshot_mode),
    snapshot_id: clean(frozenSnapshot.snapshot_id),
    canonical_content_sha256: clean(frozenSnapshot.canonical_content_sha256),
  } : labelSafeRoomSnapshot(effectivePreTargetRoomState);
  const projectionEvidence = contextProjectionEvidence({
    trace: asArray(result.trace),
    targetRow,
    targetEvents,
    requiredContextStepIds: routingRequiredContextStepIds(scenario),
  });
  const actualContract = actualExecutionContract({
    plannedShape: executionShape,
    successfulFinishes,
    targetRow,
    contextEvidence: projectionEvidence,
  });
  const collaborationShape = ['builder_reviewer', 'parallel_ideation', 'evidence_panel', 'bounded_loop_team'].includes(clean(executionShape).toLowerCase());
  const collaborationGraphValid = !collaborationShape || actualContract.contract_match === true;
  const targetExecutionValid = providerExecutionValid && roleOutputValid && collaborationGraphValid && requiredAssertionFailures.length === 0;
  const invalidReasons = [];
  if (!providerExecutionValid) invalidReasons.push('provider_execution_failed');
  if (!roleOutputValid) invalidReasons.push('role_output_invalid');
  if (!collaborationGraphValid) invalidReasons.push('collaboration_graph_failed');
  if (requiredAssertionFailures.length > 0) invalidReasons.push('required_assertion_failed');
  if (config.label_requires_semantic_judge !== false && !semanticJudgePresent) invalidReasons.push('semantic_evidence_missing');
  if (measurementPolicy.require_context_coverage_evidence && projectionEvidence.coverage_status !== 'verified') invalidReasons.push('context_coverage_evidence_unverified');
  if (measurementPolicy.require_frozen_pre_target_snapshot && inputSnapshot?.snapshot_mode !== 'frozen_pre_target_room_fork') invalidReasons.push('frozen_pre_target_snapshot_unavailable');
  if (measurementPolicy.require_runtime_shape_evidence && actualContract.contract_match !== true) invalidReasons.push('runtime_shape_unverified');
  if (measurementPolicy.label_status === 'quarantine') invalidReasons.push('label_quarantined_by_experiment_policy');
  return {
    schema_version: 'ddalggak.concierge_routing_observation/v3',
    scenario_id: clean(scenario.id),
    target_step_id: targetStepId,
    arm_id: clean(result?.summary?.arm?.id),
    execution_shape: executionShape,
    execution_shape_source: 'experiment_plan_verified_by_runtime_contract',
    execution_shape_rank: routingShapeRank(executionShape, scenario),
    runtime_declared_execution_shape: runtimeDeclaredExecutionShape,
    target_text: targetText,
    target_step_duration_ms: targetDurationMs,
    target_step_ok: targetRow?.result?.ok === true,
    target_execution_valid: targetExecutionValid,
    provider_execution_valid: providerExecutionValid,
    role_output_valid: roleOutputValid,
    collaboration_graph_valid: collaborationGraphValid,
    required_assertion_failures: requiredAssertionFailures.map((row) => clean(row.id)).filter(Boolean),
    target_terminal_failure_count: outcomes.terminalErrors.length,
    target_invalid_role_output_count: outcomes.invalidRoleFinishes.length,
    target_recovered_failure_count: outcomes.recoveredErrors.length,
    semantic_judge_present: semanticJudgePresent,
    semantic_score: semanticJudgePresent ? semanticScore : null,
    pre_route_input_snapshot: inputSnapshot,
    pre_route_room_snapshot: roomSnapshot,
    pre_route_room_snapshot_sha256: clean(frozenSnapshot.canonical_content_sha256) || stableSha256(roomSnapshot),
    candidate_specific_pre_route_state: {
      collaboration_profile_id: clean(effectivePreTargetRoomState.collaboration_profile_id || 'auto') || 'auto',
    },
    room_complexity_before_target: roomComplexitySnapshot(effectivePreTargetRoomState),
    room_complexity_after_target: roomComplexitySnapshot(targetRoomState),
    context_projection_evidence: projectionEvidence,
    actual_execution: actualContract,
    provider_execution_evidence: targetExecutionEvidence(successfulFinishes),
    shadow_predictions: {
      room_concierge: {
        route: clean(conciergeShadow?.route),
        depth: clean(conciergeShadow?.depth),
        signals: asArray(conciergeShadow?.signals),
        blockers: asArray(conciergeShadow?.blockers),
        reasons: asArray(conciergeShadow?.reasons),
      },
      room_turn_router: {
        depth: clean(turnRouterShadow?.depth),
        execution_shape: clean(turnRouterShadow?.execution_shape),
        reason_codes: asArray(turnRouterShadow?.reason_codes),
      },
    },
    measurement_policy: measurementPolicy,
    measurement_validity: {
      execution_evidence_valid: targetExecutionValid,
      provider_execution_valid: providerExecutionValid,
      role_output_valid: roleOutputValid,
      collaboration_graph_valid: collaborationGraphValid,
      required_assertions_valid: requiredAssertionFailures.length === 0,
      semantic_evidence_valid: semanticJudgePresent,
      context_coverage_status: projectionEvidence.coverage_status,
      context_parity_status: 'pending_peer_comparison',
      snapshot_mode: inputSnapshot?.snapshot_mode || 'unavailable',
      runtime_shape_contract_valid: actualContract.contract_match === true,
      routing_comparison_valid: invalidReasons.length === 0,
      invalid_reasons: invalidReasons,
    },
    training_label_eligible: invalidReasons.length === 0,
    evidence_policy: {
      minimum_semantic_score: Number(config.minimum_semantic_score ?? config.minimumSemanticScore ?? 0.75),
      quality_tolerance: Number(config.quality_tolerance ?? config.qualityTolerance ?? 0.05),
      label_requires_semantic_judge: config.label_requires_semantic_judge !== false,
    },
  };
}

export function finalizeConciergeRoutingObservations({ scenario = {}, observations = [] } = {}) {
  const policy = routingMeasurementPolicy(scenario);
  const rows = asArray(observations);
  const inputHashes = [...new Set(rows.map((row) => clean(row?.pre_route_input_snapshot?.sha256)).filter(Boolean))];
  const roomHashes = [...new Set(rows.map((row) => clean(row?.pre_route_room_snapshot_sha256)).filter(Boolean))];
  const evidenceHashes = [...new Set(rows.map((row) => clean(row?.context_projection_evidence?.common_evidence_hash)).filter(Boolean))];
  const inputParity = rows.length > 0 && inputHashes.length === 1;
  const roomParity = rows.length > 0 && roomHashes.length === 1;
  const commonEvidenceRequired = routingRequiredContextStepIds(scenario).length > 0;
  const commonEvidenceParity = !commonEvidenceRequired || (rows.length > 0 && evidenceHashes.length === 1);
  const contextParityValid = inputParity && roomParity && commonEvidenceParity;
  const equivalenceGroupId = contextParityValid ? `ctxeq_${stableSha256({ inputHashes, roomHashes, evidenceHashes }).slice(0, 16)}` : '';
  return rows.map((row) => {
    const existing = asArray(row?.measurement_validity?.invalid_reasons).map(clean).filter(Boolean);
    const reasons = [...existing];
    if (policy.require_context_parity && !contextParityValid) reasons.push('context_parity_mismatch');
    const uniqueReasons = [...new Set(reasons)];
    return {
      ...row,
      context_equivalence_group_id: equivalenceGroupId || null,
      context_parity: {
        required: policy.require_context_parity,
        experiment_input_parity: inputParity,
        frozen_room_snapshot_parity: roomParity,
        common_authoritative_evidence_parity: commonEvidenceParity,
        valid: contextParityValid,
        input_snapshot_hashes: inputHashes,
        room_snapshot_hashes: roomHashes,
        common_evidence_hashes: evidenceHashes,
        note: rows.every((item) => clean(item?.pre_route_input_snapshot?.snapshot_mode) === 'frozen_pre_target_room_fork')
          ? 'All candidate arms were forked from the same immutable pre-target Room snapshot.'
          : 'At least one arm lacks a true frozen pre-target Room snapshot.',
      },
      measurement_validity: {
        ...asObject(row.measurement_validity),
        context_parity_status: contextParityValid ? 'matched' : 'mismatch',
        routing_comparison_valid: uniqueReasons.length === 0,
        invalid_reasons: uniqueReasons,
      },
      training_label_eligible: uniqueReasons.length === 0,
    };
  });
}

export function deriveConciergeRoutingLabel({ scenario = {}, observations = [] } = {}) {
  const config = routingExperimentConfig(scenario);
  const targetStepId = routingTargetStepId(scenario);
  if (!targetStepId) return null;
  const minimumSemanticScore = Number(config.minimum_semantic_score ?? config.minimumSemanticScore ?? 0.75);
  const qualityTolerance = Number(config.quality_tolerance ?? config.qualityTolerance ?? 0.05);
  const valid = asArray(observations).filter((row) => row?.training_label_eligible !== false
    && row?.measurement_validity?.routing_comparison_valid !== false
    && row?.target_execution_valid === true
    && row?.semantic_judge_present === true
    && Number.isFinite(Number(row?.semantic_score)));
  if (valid.length < 2) return null;
  const bestScore = Math.max(...valid.map((row) => Number(row.semantic_score)));
  const scoreFloor = Math.max(minimumSemanticScore, bestScore - qualityTolerance);
  const sufficient = valid
    .filter((row) => Number(row.semantic_score) >= scoreFloor)
    .sort((a, b) => Number(a.execution_shape_rank) - Number(b.execution_shape_rank)
      || Number(a.target_step_duration_ms) - Number(b.target_step_duration_ms));
  if (!sufficient.length) return null;
  const winner = sufficient[0];
  const targetRoute = coarseConciergeRouteForExecutionShape(winner.execution_shape);
  return {
    schema_version: 'ddalggak.concierge_routing_label/v3',
    scenario_id: clean(scenario.id),
    target_step_id: targetStepId,
    target_arm_id: clean(winner.arm_id),
    target_execution_shape: clean(winner.execution_shape),
    target_route: targetRoute,
    training_eligible_for_current_coarse_model: Boolean(targetRoute),
    label_basis: 'minimal_sufficient_execution_shape_within_target_only_outcome_quality_tolerance_after_measurement_validity_gate',
    evidence: {
      best_semantic_score: bestScore,
      minimum_semantic_score: minimumSemanticScore,
      quality_tolerance: qualityTolerance,
      sufficient_score_floor: scoreFloor,
      selected_outcome_quality_score: Number(winner.semantic_score),
      selected_semantic_score: Number(winner.semantic_score),
      selected_target_step_duration_ms: Number(winner.target_step_duration_ms),
      candidate_count: observations.length,
      measurement_valid_candidate_count: valid.length,
      sufficient_candidate_count: sufficient.length,
      context_equivalence_group_id: clean(winner.context_equivalence_group_id) || null,
    },
    input: {
      text: clean(winner.target_text),
      pre_route_room_snapshot: asObject(winner.pre_route_room_snapshot),
      pre_route_input_snapshot: asObject(winner.pre_route_input_snapshot),
      shadow_predictions: asObject(winner.shadow_predictions),
    },
    candidates: asArray(observations).map((row) => ({
      arm_id: clean(row.arm_id),
      execution_shape: clean(row.execution_shape),
      execution_shape_rank: Number(row.execution_shape_rank),
      target_execution_valid: row.target_execution_valid === true,
      semantic_judge_present: row.semantic_judge_present === true,
      semantic_score: row.semantic_score,
      target_step_duration_ms: Number(row.target_step_duration_ms || 0),
      training_label_eligible: row.training_label_eligible !== false,
      measurement_invalid_reasons: asArray(row?.measurement_validity?.invalid_reasons),
      exact_model_identity_complete: row?.actual_execution?.exact_model_identity_complete === true,
      runtime_execution_contract_match: row?.actual_execution?.contract_match === true,
      common_evidence_hash: clean(row?.context_projection_evidence?.common_evidence_hash) || null,
    })),
  };
}

function writeJsonlRows(file, rows = []) {
  const values = asArray(rows);
  fs.writeFileSync(file, values.map((row) => JSON.stringify(row)).join('\n') + (values.length ? '\n' : ''), 'utf8');
}


export async function runRoomJourneySuite({ suiteFile = '', scenarioFiles = [], outputRoot = 'experiments/room_journeys', transportFactory, execute = false, traceRoot = '', options = {}, syncGoc = false, gocClient = null } = {}) {
  const files = suiteFile ? loadRoomJourneySuite(suiteFile).scenario_files : scenarioFiles.map((file) => path.resolve(file));
  if (!files.length) throw new Error('No Room journey scenarios supplied');
  const results = [];
  const scenarioById = new Map();
  for (const file of files) {
    const scenario = loadRoomJourneyScenario(file);
    scenarioById.set(scenario.id, scenario);
    let frozenPreTargetSnapshot = null;
    if (shouldUseFrozenPreTargetFork(scenario, execute)) {
      const seedArm = normalizeArm({ id: '__frozen_seed__', title: 'Frozen pre-target Room seed', collaboration_profile: '' }, '__frozen_seed__');
      const seedTransport = await transportFactory({ scenario, arm: seedArm });
      frozenPreTargetSnapshot = await buildFrozenPreTargetRoomSnapshot({ scenario, transport: seedTransport, outputRoot, options });
    }
    for (const arm of scenarioArms(scenario)) {
      const transport = await transportFactory({ scenario, arm });
      const armOptions = {
        ...options,
        chatId: clean(transport?.chatId || arm.metadata?.chat_id || arm.metadata?.chatId || options.chatId),
        comparisonTargetStepId: comparisonTargetStepId(scenario),
      };
      results.push(await runRoomJourneyScenario({ scenario, arm, outputRoot, transport, execute, traceRoot, options: armOptions, frozenPreTargetSnapshot }));
    }
  }
  const byScenario = new Map();
  for (const result of results) {
    const key = result.summary.scenario_id;
    if (!byScenario.has(key)) byScenario.set(key, []);
    byScenario.get(key).push(result.summary);
  }
  const comparisons = [];
  for (const [scenarioId, rows] of byScenario.entries()) {
    const scenario = scenarioById.get(scenarioId);
    const experiment = asObject(scenario?.experiment);
    if (!experiment.baseline) continue;
    const baselineId = clean(experiment.baseline?.id || 'baseline');
    const baseline = rows.find((row) => row.arm.id === baselineId);
    for (const challenger of rows.filter((row) => row !== baseline)) {
      comparisons.push({ scenario_id: scenarioId, baseline_arm: baseline?.arm?.id || null, challenger_arm: challenger.arm.id, ...evaluatePortfolioPromotion({ baseline: baseline?.metrics, challenger: challenger.metrics, gate: asObject(experiment.promotion_gate) }) });
    }
  }
  const routingObservations = [];
  const routingLabels = [];
  const routingExperimentSummaries = [];
  for (const [scenarioId, scenario] of scenarioById.entries()) {
    if (!routingTargetStepId(scenario)) continue;
    const scenarioResults = results.filter((row) => clean(row?.summary?.scenario_id) === scenarioId);
    const observations = finalizeConciergeRoutingObservations({
      scenario,
      observations: scenarioResults
        .map((row) => buildConciergeRoutingObservation({ scenario, result: row }))
        .filter(Boolean),
    });
    routingObservations.push(...observations);
    const label = deriveConciergeRoutingLabel({ scenario, observations });
    if (label) routingLabels.push(label);
    routingExperimentSummaries.push({
      scenario_id: scenarioId,
      target_step_id: routingTargetStepId(scenario),
      observation_count: observations.length,
      evidence_sufficient_for_label: Boolean(label),
      selected_execution_shape: label?.target_execution_shape || null,
      selected_arm_id: label?.target_arm_id || null,
      best_semantic_score: label?.evidence?.best_semantic_score ?? null,
      measurement_valid_observation_count: observations.filter((row) => row.training_label_eligible === true).length,
      measurement_invalid_reasons: [...new Set(observations.flatMap((row) => asArray(row?.measurement_validity?.invalid_reasons)).map(clean).filter(Boolean))],
      context_parity_valid: observations.length > 0 && observations.every((row) => row?.context_parity?.valid === true),
      snapshot_mode: observations[0]?.pre_route_input_snapshot?.snapshot_mode || null,
    });
  }

  const summary = {
    schema_version: 'ddalggak.room_journey_suite_result/v1',
    suite_file: suiteFile ? path.resolve(suiteFile) : null,
    created_at: nowIso(),
    status: results.some((row) => row.summary.status === 'failed') ? 'completed_with_failures' : (execute ? 'completed' : 'planned'),
    run_count: results.length,
    passed: results.filter((row) => row.summary.status === 'passed').length,
    failed: results.filter((row) => row.summary.status === 'failed').length,
    results: results.map((row) => ({ run_dir: row.runDir, ...row.summary })),
    portfolio_comparisons: comparisons,
    concierge_routing_experiments: routingExperimentSummaries,
    concierge_routing_observation_count: routingObservations.length,
    concierge_routing_label_count: routingLabels.length,
    execution_environment: {
      transport: clean(options.transport || (execute ? 'custom' : 'plan')),
      session_id: clean(options.sessionId) || null,
      output_root: path.resolve(outputRoot),
      runtime_root: clean(options.runtimeRoot) ? path.resolve(options.runtimeRoot) : null,
      trace_root: clean(traceRoot) ? path.resolve(traceRoot) : null,
      telegram_required: false,
      goc_room_required: clean(options.transport).toLowerCase() === 'goc',
      model_role_policy: options.modelRoleMap || null,
      model_role_map: options.modelRoleMap || null,
      codex_skip_git_repo_check: execute && clean(options.transport).toLowerCase() === 'headless'
        ? { enabled: true, allowed_root: path.resolve(outputRoot), scope: 'headless_benchmark_only' }
        : { enabled: false },
    },
    trace_contract: {
      raw_provider_prompts_saved: execute === true,
      raw_provider_prompt_scope: execute ? 'local_debug_runtime' : 'not_executed',
      sensitive_debug_artifacts_present: execute === true,
      external_share_requires_review: execute === true,
    },
  };
  const root = ensureDir(path.resolve(outputRoot));
  if (routingObservations.length || routingExperimentSummaries.length) {
    writeJsonlRows(path.join(root, 'concierge_routing_observations.jsonl'), routingObservations);
    writeJsonlRows(path.join(root, 'concierge_routing_labels.jsonl'), routingLabels);
    writeJson(path.join(root, 'concierge_routing_experiments.json'), {
      schema_version: 'ddalggak.concierge_routing_experiment_summary/v1',
      created_at: nowIso(),
      experiments: routingExperimentSummaries,
      label_policy: {
        principle: 'keep_the_room_persistent_choose_the_minimum_sufficient_execution_shape_per_turn',
        labels_are_emitted_only_after_measurement_validity_gate: true,
        candidate_specific_room_state_is_excluded_from_label_input: true,
        comparison_scenarios_use_common_buildup_and_frozen_pre_target_fork_when_supported: true,
        frozen_snapshot_hashes_canonical_session_and_nonvolatile_job_state: true,
        authoritative_context_delivery_is_verified_per_target_role: true,
        independent_arm_replay_is_never_misrepresented_as_a_frozen_room_fork: true,
      },
    });
  }
  if (syncGoc && execute) {
    const client = gocClient || new GocClient();
    summary.goc_sync = await client.ingestHarnessEvaluationRun({ ...summary, suite: 'room_user_journey', evaluation_id: `room_journey_${Date.now().toString(36)}` });
  }
  writeJson(path.join(root, `suite_${Date.now().toString(36)}.json`), summary);
  return summary;
}
