import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { GocClient } from '../goc_client.js';
import { readRoomJourneyTrace } from '../application/room_journey_trace.js';
import { runCodexExec } from '../codex.js';
import { runClaudeCliPrompt } from '../claude_cli.js';
import { runAntigravityPrompt } from '../antigravity.js';

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
  if (action === 'send_message') return await transport.sendMessage(step.text);
  if (['room_command', 'inspect', 'branch', 'generate_memory_candidates', 'approve_memory', 'reject_memory', 'set_collaboration_profile'].includes(action)) {
    let command = clean(step.command || step.text);
    if (action === 'branch' && !command.startsWith('/branch')) command = `/branch ${command}`;
    if (action === 'generate_memory_candidates') command = command || '/memory idle';
    if (action === 'approve_memory') command = command || '/memory approve latest';
    if (action === 'reject_memory') command = command || '/memory reject latest benchmark rejection';
    if (action === 'set_collaboration_profile') command = `/collab use ${clean(step.profile || arm.collaboration_profile)}`;
    return await transport.sendCommand(command);
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

function assertionResult(assertion = {}, context = {}) {
  const type = clean(assertion.type).toLowerCase();
  const steps = asObject(context.stepsById);
  let passed = false; let observed = null;
  if (type === 'step_ok') {
    const row = steps[clean(assertion.step_id)]; observed = row?.result?.ok === true; passed = observed;
  } else if (type === 'response_regex' || type === 'response_not_regex') {
    const text = clean(steps[clean(assertion.step_id)]?.result?.output);
    const regex = new RegExp(assertion.pattern, assertion.flags || 'i');
    const matched = regex.test(text); observed = { matched, preview: text.slice(0, 240) }; passed = type === 'response_regex' ? matched : !matched;
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
  } else if (type === 'distinct_provider_count') {
    const providers = new Set(context.runtimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish'].includes(eventType(event))).map((event) => clean(eventPayload(event).provider)).filter(Boolean));
    observed = [...providers]; passed = providers.size >= Number(assertion.min ?? 1) && providers.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
  } else if (type === 'distinct_model_count') {
    const models = new Set(context.runtimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish'].includes(eventType(event))).map((event) => clean(eventPayload(event).model)).filter(Boolean));
    observed = [...models]; passed = models.size >= Number(assertion.min ?? 1) && models.size <= Number(assertion.max ?? Number.POSITIVE_INFINITY);
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

function summarizeMetrics({ assertions = [], runtimeEvents = [], startedAt = '', finishedAt = '', semanticJudgment = null } = {}) {
  const required = assertions.filter((row) => row.required !== false);
  const qualityAssertions = required.filter((row) => row.quality_metric !== false);
  const deterministicQuality = qualityAssertions.length ? qualityAssertions.filter((row) => row.passed).length / qualityAssertions.length : 0;
  const semanticScore = Number(semanticJudgment?.result?.score);
  const quality = Number.isFinite(semanticScore) ? Math.max(0, Math.min(1, semanticScore)) : deterministicQuality;
  const starts = runtimeEvents.filter((event) => eventType(event) === 'run.agent_start');
  const lifecycle = runtimeEvents.filter((event) => ['run.agent_start', 'run.agent_finish'].includes(eventType(event)));
  const providers = [...new Set(lifecycle.map((event) => clean(eventPayload(event).provider)).filter(Boolean))];
  const models = [...new Set(lifecycle.map((event) => clean(eventPayload(event).model)).filter(Boolean))];
  const roles = [...new Set(starts.map((event) => clean(eventPayload(event).model_role || eventPayload(event).role_id)).filter(Boolean))];
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
    provider_count: providers.length,
    providers,
    models,
    model_roles: roles,
    total_tokens: hasTokens ? tokens : null,
    cost_usd: hasCost ? cost : null,
  };
}

export function evaluatePortfolioPromotion({ baseline = null, challenger = null, gate = {} } = {}) {
  if (!baseline || !challenger) return { status: 'insufficient_evidence', promote: false, reasons: ['baseline_or_challenger_missing'] };
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
  const promote = reasons.length === 0;
  return { status: promote ? 'promotion_candidate' : (reasons.some((reason) => ['cost_evidence_missing', 'semantic_evidence_missing'].includes(reason)) ? 'insufficient_evidence' : 'not_promoted'), promote, quality_uplift: qualityUplift, cost_ratio: costRatio, latency_ratio: latencyRatio, reasons };
}

function writeTraceViews(runDir, trace, runtimeEvents, steps) {
  const categories = {
    'memory_candidates.jsonl': trace.filter((row) => eventType(row) === 'memory.candidate_created'),
    'memory_decisions.jsonl': trace.filter((row) => eventType(row) === 'memory.decision'),
    'memory_commits.jsonl': trace.filter((row) => eventType(row) === 'memory.committed'),
    'context_projections.jsonl': trace.filter((row) => eventType(row) === 'context.projection_compiled'),
    'provider_invocations.jsonl': runtimeEvents.filter((row) => ['run.agent_start', 'run.agent_finish', 'run.agent_error'].includes(eventType(row))),
  };
  for (const [name, rows] of Object.entries(categories)) fs.writeFileSync(path.join(runDir, name), rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(runDir, 'runtime_events.jsonl'), runtimeEvents.map((row) => JSON.stringify(row)).join('\n') + (runtimeEvents.length ? '\n' : ''), 'utf8');
  fs.writeFileSync(path.join(runDir, 'turns.jsonl'), steps.filter((row) => clean(row.step?.action) === 'send_message').map((row) => JSON.stringify({ step_id: row.step.id, user: row.step.text, assistant: row.result?.output || '', run_id: row.result?.run_id || '' })).join('\n') + '\n', 'utf8');
}

export async function runRoomJourneyScenario({ scenario, arm = null, outputRoot = 'runs/room_journeys', transport, execute = false, traceRoot = '', options = {} } = {}) {
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
    const row = { step, started_at: stepStarted, completed_at: nowIso(), result };
    stepRows.push(row);
    appendJsonl(path.join(runDir, 'steps.jsonl'), row);
    if (step.stop_on_failure !== false && result?.ok === false) break;
  }
  const traceChatId = clean(options.chatId || transport?.chatId || selectedArm.metadata?.chat_id || selectedArm.metadata?.chatId);
  const trace = readRoomJourneyTrace({ chatId: traceChatId, traceRoot, afterTs: startedAt });
  const runtimeEvents = asArray(transport.events);
  const stepsById = Object.fromEntries(stepRows.map((row) => [row.step.id, row]));
  const assertions = asArray(scenario.assertions)
    .filter((assertion) => assertionApplies(assertion, selectedArm.id))
    .map((assertion) => assertionResult(assertion, { trace, runtimeEvents, stepsById }));
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
  const metrics = summarizeMetrics({ assertions, runtimeEvents, startedAt, finishedAt: executionFinishedAt, semanticJudgment });
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
    trace_contract: {
      raw_provider_prompts_saved: false,
      raw_private_transcript_exported: false,
      identifiers_hashes_and_redacted_previews_only: true,
    },
  };
  writeTraceViews(runDir, trace, runtimeEvents, stepRows);
  writeJson(path.join(runDir, 'assertions.json'), assertions);
  writeJson(path.join(runDir, 'summary.json'), summary);
  return { runDir, summary, steps: stepRows, trace, runtimeEvents };
}

export async function runRoomJourneySuite({ suiteFile = '', scenarioFiles = [], outputRoot = 'runs/room_journeys', transportFactory, execute = false, traceRoot = '', options = {}, syncGoc = false, gocClient = null } = {}) {
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
  };
  const root = ensureDir(path.resolve(outputRoot));
  if (syncGoc && execute) {
    const client = gocClient || new GocClient();
    summary.goc_sync = await client.ingestHarnessEvaluationRun({ ...summary, suite: 'room_user_journey', evaluation_id: `room_journey_${Date.now().toString(36)}` });
  }
  writeJson(path.join(root, `suite_${Date.now().toString(36)}.json`), summary);
  return summary;
}
