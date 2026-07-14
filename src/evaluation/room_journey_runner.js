import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { GocClient } from '../goc_client.js';
import { readRoomJourneyTrace } from '../application/room_journey_trace.js';
import { runCodexExec } from '../codex.js';
import { runClaudeCliPrompt } from '../claude_cli.js';
import { runAntigravityPrompt } from '../antigravity.js';
import { createHeadlessRoomRuntime } from './headless_room_runtime.js';
import { getAgentRoomProfile, upsertAgentRoomProfile } from '../application/agent_room_profile.js';
import { buildRoomFirstTeamConfiguration } from '../application/ai_room_runtime_selection.js';

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

  async sendMessage(text = '', messageOptions = {}) {
    if (!this.runtime) await this.initialize();
    const message = clean(text);
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
    return await transport.sendMessage(step.text, {
      kind: clean(step.input_kind || step.inputKind || arm.input_kind || 'normal') || 'normal',
      forceMode: clean(step.force_mode || step.forceMode || arm.force_mode || 'normal') || 'normal',
      teamConfig: step.team_config || step.teamConfig || null,
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

function assertionResult(assertion = {}, context = {}) {
  const type = clean(assertion.type).toLowerCase();
  const steps = asObject(context.stepsById);
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
    const starts = context.runtimeEvents.filter((event) => eventType(event) === 'run.agent_start');
    const roles = new Set(starts.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean));
    observed = [...roles]; passed = roles.size >= Number(assertion.min ?? 1) && roles.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'successful_provider_role_count') {
    const finishes = context.runtimeEvents.filter((event) => isValidRoleFinish(event));
    const roles = new Set(finishes.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean));
    observed = [...roles]; passed = roles.size >= Number(assertion.min ?? 1) && roles.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'successful_model_roles_include') {
    const finishes = context.runtimeEvents.filter((event) => isValidRoleFinish(event));
    const roles = new Set(finishes.map((event) => clean(eventPayload(event).model_role).toLowerCase()).filter(Boolean));
    const expected = asArray(assertion.values || assertion.roles || assertion.expected).map((row) => clean(row).toLowerCase()).filter(Boolean);
    const missing = expected.filter((role) => !roles.has(role));
    observed = { expected, actual: [...roles], missing };
    passed = expected.length > 0 && missing.length === 0;
  } else if (type === 'distinct_lane_count') {
    const finishes = context.runtimeEvents.filter((event) => isValidRoleFinish(event));
    const lanes = new Set(finishes.map((event) => {
      const payload = eventPayload(event);
      return clean(payload.lane_id || payload.laneId || payload?.collaboration_lane?.lane_id || payload?.collaborationLane?.laneId);
    }).filter(Boolean));
    observed = [...lanes];
    passed = lanes.size >= Number(assertion.min ?? 1) && lanes.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_provider_count') {
    const providers = new Set(context.runtimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish'].includes(eventType(event))).map((event) => clean(eventPayload(event).provider)).filter(Boolean));
    observed = [...providers]; passed = providers.size >= Number(assertion.min ?? 1) && providers.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_model_count') {
    const models = new Set(context.runtimeEvents.filter((event) => isValidRoleFinish(event)).map((event) => normalizedResolvedModel(eventPayload(event))).filter(Boolean));
    observed = [...models]; passed = models.size >= Number(assertion.min ?? 1) && models.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_model_node_count') {
    const nodes = new Set(context.runtimeEvents
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
    const rows = context.runtimeEvents.filter((event) => !assertion.event_type || eventType(event) === clean(assertion.event_type).toLowerCase());
    observed = rows.length; passed = rows.length >= Number(assertion.min ?? 1);
  } else if (type === 'cli_call_count') {
    const rows = context.runtimeEvents.filter((event) => {
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
    const outcomes = classifyCliExecutionOutcomes(context.runtimeEvents);
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
    const finishes = context.runtimeEvents.filter((event) => isValidRoleFinish(event));
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

function buildRoomJourneyJudgePrompt({ scenario = {}, arm = {}, stepRows = [], assertions = [] } = {}) {
  const transcript = stepRows
    .filter((row) => clean(row.step?.action) === 'send_message')
    .map((row) => ({ step_id: row.step.id, user: clean(row.step.text), assistant: clean(row.result?.output) }));
  return [
    'Evaluate this AI Room user journey. Use only the supplied transcript, deterministic assertions, and rubric.',
    'Judge continuity, correction uptake, relevance of remembered context, task quality, and whether collaboration added useful independent value.',
    'Do not reward extra agents or extra models by themselves. Penalize repetition, stale-memory use, unsupported claims, privacy leakage, and needless cost/latency.',
    'Return JSON only with: passed(boolean), score(number 0..1), summary(string), rubric(array of {id,score,reason}), findings(array of strings).',
    '',
    'SCENARIO', JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, rubric: scenario.semantic_rubric || scenario.rubric || [] }, null, 2),
    '',
    'EXPERIMENT ARM', JSON.stringify({ id: arm.id, title: arm.title, collaboration_profile: arm.collaboration_profile, model_policy: arm.model_policy }, null, 2),
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
  const finishes = rows.filter((event) => eventType(event) === 'run.agent_finish' && eventPayload(event).role_output_valid !== false);
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
  return { finishes, errors, recoveredErrors, terminalErrors };
}

function summarizeMetrics({ assertions = [], runtimeEvents = [], startedAt = '', finishedAt = '', semanticJudgment = null, arm = null } = {}) {
  const required = assertions.filter((row) => row.required !== false);
  const qualityAssertions = required.filter((row) => row.quality_metric !== false);
  const deterministicQuality = qualityAssertions.length ? qualityAssertions.filter((row) => row.passed).length / qualityAssertions.length : 0;
  const semanticScore = Number(semanticJudgment?.result?.score);
  const quality = Number.isFinite(semanticScore) ? Math.max(0, Math.min(1, semanticScore)) : deterministicQuality;
  const starts = runtimeEvents.filter((event) => eventType(event) === 'run.agent_start');
  const { finishes, errors, recoveredErrors, terminalErrors } = classifyCliExecutionOutcomes(runtimeEvents);
  const attempts = starts.filter(isLocalCliEvent);
  const providers = [...new Set(finishes.map((event) => clean(eventPayload(event).provider)).filter(Boolean))];
  const models = [...new Set(finishes.map((event) => clean(eventPayload(event).model)).filter(Boolean))];
  const modelNodes = [...new Set(finishes.map((event) => modelNodeKey(eventPayload(event))).filter(Boolean))];
  const roles = [...new Set(finishes.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean))];
  const collaborationProfile = clean(arm?.collaboration_profile || arm?.collaborationProfile || '');
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
    agent_call_count: starts.length,
    cli_attempt_count: attempts.length,
    cli_success_count: finishes.length,
    cli_failure_count: terminalErrors.length,
    cli_recovered_failure_count: recoveredErrors.length,
    cli_raw_error_count: errors.length,
    execution_status: finishes.length === 0 || terminalErrors.length > 0
      ? 'invalid_execution'
      : (recoveredErrors.length > 0 ? 'valid_degraded_execution' : 'valid_execution'),
    execution_eligible: finishes.length > 0 && terminalErrors.length === 0,
    collaboration_profile: collaborationProfile || null,
    collaboration_execution_status: collaborationExecutionStatus,
    collaboration_assertion_failures: collaborationAssertions.filter((row) => !row.passed).map((row) => row.id),
    provider_count: providers.length,
    providers,
    models,
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
  const qualityUplift = Number(challenger.quality_score || 0) - Number(baseline.quality_score || 0);
  const costRatio = baseline.cost_usd > 0 && challenger.cost_usd !== null ? challenger.cost_usd / baseline.cost_usd : null;
  const latencyRatio = baseline.duration_ms > 0 ? challenger.duration_ms / baseline.duration_ms : null;
  const reasons = [];
  if (challenger.required_fail > 0) reasons.push('challenger_required_assertion_failed');
  if (qualityUplift < minUplift) reasons.push('quality_uplift_below_gate');
  if (costRatio !== null && costRatio > maxCostRatio) reasons.push('cost_ratio_above_gate');
  if (latencyRatio !== null && latencyRatio > maxLatencyRatio) reasons.push('latency_ratio_above_gate');
  if (gate.require_cost_evidence === true && costRatio === null) reasons.push('cost_evidence_missing');
  if (gate.require_semantic_evidence === true && (!baseline.semantic_judge_present || !challenger.semantic_judge_present)) reasons.push('semantic_evidence_missing');
  if (challengerStatus === 'valid_degraded_execution' && gate.allow_degraded_execution !== true) reasons.push('challenger_degraded_execution');
  const promote = reasons.length === 0;
  return { status: promote ? 'promotion_candidate' : (reasons.some((reason) => ['cost_evidence_missing', 'semantic_evidence_missing'].includes(reason)) ? 'insufficient_evidence' : 'not_promoted'), promote, quality_uplift: qualityUplift, cost_ratio: costRatio, latency_ratio: latencyRatio, reasons };
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

export async function runRoomJourneyScenario({ scenario, arm = null, outputRoot = 'experiments/room_journeys', transport, execute = false, traceRoot = '', options = {} } = {}) {
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
  if (selectedArm.collaboration_profile) await transport.sendCommand(`/collab use ${selectedArm.collaboration_profile}`);
  for (const command of selectedArm.setup_commands) await transport.sendCommand(command);
  const stepRows = [];
  for (const step of scenario.steps) {
    const stepStarted = nowIso();
    let result;
    try { result = await executeStep({ step, arm: selectedArm, transport, options }); }
    catch (error) { result = { ok: false, error: String(error?.message || error) }; }
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
  const metrics = summarizeMetrics({ assertions, runtimeEvents, startedAt, finishedAt: executionFinishedAt, semanticJudgment, arm: selectedArm });
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
    transport: {
      type: transport instanceof HeadlessRoomJourneyTransport ? 'headless' : 'goc',
      thread_id: clean(transport?.threadId) || null,
      room_id: clean(transport?.chatId) || null,
      user_id: clean(transport?.userId) || null,
      runtime_root: clean(transport?.runtimeRoot) || null,
    },
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
  writeJson(path.join(runDir, 'summary.json'), summary);
  return { runDir, summary, steps: stepRows, trace, runtimeEvents };
}

export async function runRoomJourneySuite({ suiteFile = '', scenarioFiles = [], outputRoot = 'experiments/room_journeys', transportFactory, execute = false, traceRoot = '', options = {}, syncGoc = false, gocClient = null } = {}) {
  const files = suiteFile ? loadRoomJourneySuite(suiteFile).scenario_files : scenarioFiles.map((file) => path.resolve(file));
  if (!files.length) throw new Error('No Room journey scenarios supplied');
  const results = [];
  const scenarioById = new Map();
  for (const file of files) {
    const scenario = loadRoomJourneyScenario(file);
    scenarioById.set(scenario.id, scenario);
    for (const arm of scenarioArms(scenario)) {
      const transport = await transportFactory({ scenario, arm });
      const armOptions = { ...options, chatId: clean(transport?.chatId || arm.metadata?.chat_id || arm.metadata?.chatId || options.chatId) };
      results.push(await runRoomJourneyScenario({ scenario, arm, outputRoot, transport, execute, traceRoot, options: armOptions }));
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
  if (syncGoc && execute) {
    const client = gocClient || new GocClient();
    summary.goc_sync = await client.ingestHarnessEvaluationRun({ ...summary, suite: 'room_user_journey', evaluation_id: `room_journey_${Date.now().toString(36)}` });
  }
  writeJson(path.join(root, `suite_${Date.now().toString(36)}.json`), summary);
  return summary;
}
