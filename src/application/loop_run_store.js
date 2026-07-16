import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  buildLoopRunSpec,
  createLoopKernelEvent,
  createLoopRunState,
  reduceLoopRunState,
} from './loop_execution_kernel.js';
import { appendRoomLoopEvent, buildRoomLoopEvent } from './room_loop_events.js';

function clean(value = '') { return String(value || '').trim(); }
function ensureDir(dir = '') { fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson(file = '') { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJsonAtomic(file = '', payload = {}) {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}
function appendJsonl(file = '', row = {}) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8'); }
function readJsonl(file = '') {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}
function sha256(value = '') { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

export function loopRunsRoot(jobDir = '') { return ensureDir(path.join(path.resolve(clean(jobDir)), 'local_memory', 'loop_runs')); }
export function loopRunDir(jobDir = '', loopId = '') { return ensureDir(path.join(loopRunsRoot(jobDir), clean(loopId))); }
export function loopRunPaths(jobDir = '', loopId = '') {
  const dir = loopRunDir(jobDir, loopId);
  return {
    dir,
    spec: path.join(dir, 'spec.json'),
    state: path.join(dir, 'state.json'),
    events: path.join(dir, 'events.jsonl'),
    active: path.join(loopRunsRoot(jobDir), 'active.json'),
    manifest: path.join(dir, 'manifest.json'),
    working_memory: path.join(dir, 'working_memory.json'),
  };
}

export function createLoopRun({ jobDir = '', spec = null, ...input } = {}) {
  if (!clean(jobDir)) throw new Error('jobDir is required');
  const normalizedSpec = spec?.kind === 'loop_run_spec_v1' ? spec : buildLoopRunSpec(input);
  const paths = loopRunPaths(jobDir, normalizedSpec.loop_id);
  const state = createLoopRunState(normalizedSpec);
  writeJsonAtomic(paths.spec, normalizedSpec);
  writeJsonAtomic(paths.state, state);
  writeJsonAtomic(paths.working_memory, {
    kind: 'loop_working_memory_v1',
    loop_id: normalizedSpec.loop_id,
    based_on_compaction: null,
    summary_markdown: [
      '# Loop Working Memory',
      '',
      `- objective: ${normalizedSpec.objective}`,
      `- topology: ${normalizedSpec.topology.label}`,
      `- current_stage: ${state.current_stage_id || ''}`,
      `- next_action: ${state.next_action || ''}`,
      '',
      '## Active constraints',
      ...(normalizedSpec.active_constraints.length ? normalizedSpec.active_constraints.map((row) => `- ${row}`) : ['- none']),
      '',
      '## Memory rule',
      '- Raw trace is audit evidence and is not injected wholesale.',
      '- Durable Room memory is proposal-only.',
    ].join('\n'),
    recent_event_ids: [],
    updated_at: state.updated_at,
  });
  writeJsonAtomic(paths.active, { loop_id: normalizedSpec.loop_id, state_path: paths.state, updated_at: state.updated_at });
  const start = createLoopKernelEvent({ loopId: normalizedSpec.loop_id, eventType: 'run_started', summary: normalizedSpec.objective, payload: { spec: normalizedSpec }, source: input.source || 'loop_run_store' });
  appendJsonl(paths.events, start);
  const reduced = reduceLoopRunState(state, start);
  writeJsonAtomic(paths.state, reduced);
  writeJsonAtomic(paths.manifest, {
    kind: 'loop_run_manifest_v1',
    loop_id: normalizedSpec.loop_id,
    spec_sha256: sha256(JSON.stringify(normalizedSpec)),
    created_at: state.created_at,
    raw_trace_policy: normalizedSpec.memory_policy.raw_trace,
    durable_promotion_policy: normalizedSpec.memory_policy.durable_promotion,
  });
  return { spec: normalizedSpec, state: reduced, paths, event: start };
}

export function readLoopRun({ jobDir = '', loopId = '', includeEvents = false } = {}) {
  const paths = loopRunPaths(jobDir, loopId);
  const state = readJson(paths.state);
  if (!state) return null;
  return { spec: readJson(paths.spec) || state.spec, state, paths, events: includeEvents ? readJsonl(paths.events) : undefined };
}

export function readActiveLoopRun({ jobDir = '', includeEvents = false } = {}) {
  if (!clean(jobDir)) return null;
  const activePath = path.join(loopRunsRoot(jobDir), 'active.json');
  const active = readJson(activePath);
  if (!active?.loop_id) return null;
  const run = readLoopRun({ jobDir, loopId: active.loop_id, includeEvents });
  if (!run || ['completed', 'cancelled', 'failed'].includes(clean(run.state?.status).toLowerCase())) return run ? { ...run, active: false } : null;
  return { ...run, active: true };
}

export function appendLoopRunEvent({ jobDir = '', loopId = '', event = null, eventType = '', actor = '', roleId = '', stageId = '', summary = '', payload = {}, source = '' } = {}) {
  const id = clean(loopId || event?.loop_id);
  if (!clean(jobDir) || !id) return null;
  const paths = loopRunPaths(jobDir, id);
  const current = readJson(paths.state);
  if (!current) return null;
  const normalized = event?.kind === 'loop_kernel_event_v1' ? event : createLoopKernelEvent({ loopId: id, eventType, actor, roleId, stageId, summary, payload, source });
  appendJsonl(paths.events, normalized);
  const next = reduceLoopRunState(current, normalized);
  writeJsonAtomic(paths.state, next);
  writeJsonAtomic(paths.active, { loop_id: id, state_path: paths.state, updated_at: next.updated_at, status: next.status });
  try {
    appendRoomLoopEvent({
      jobDir,
      event: buildRoomLoopEvent({
        eventType: ['run_completed', 'run_failed'].includes(normalized.event_type) ? 'loop_status_changed' : 'loop_trace',
        interruptType: 'status_update',
        loopId: id,
        source: 'loop_run_store_bridge',
        payload: {
          trace_ref: `local_memory/loop_runs/${id}/events.jsonl#${normalized.event_id}`,
          current_stage_id: next.current_stage_id,
          current_round: next.current_round,
          progress_visibility: next.progress_visibility,
          target_status: normalized.event_type === 'run_completed' ? 'completed' : normalized.event_type === 'run_failed' ? 'failed' : undefined,
        },
      }),
    });
  } catch {}
  return { event: normalized, state: next, paths };
}

export function recordActiveLoopAgentEvent({ jobDir = '', phase = 'started', agentId = '', roleId = '', summary = '', provider = '', model = '', finalSynthesis = false, completeRun = false, failed = false, traceRef = '' } = {}) {
  const run = readActiveLoopRun({ jobDir });
  if (!run?.state?.loop_id || run.active === false) return null;
  const previousStage = run.state.current_stage_id;
  const eventType = failed ? 'agent_failed' : phase === 'completed' ? 'agent_completed' : 'agent_started';
  const agentResult = appendLoopRunEvent({
    jobDir,
    loopId: run.state.loop_id,
    eventType,
    actor: agentId,
    roleId,
    summary,
    payload: { agent_id: agentId, role_id: roleId, provider, model, final_synthesis: finalSynthesis, complete_run: completeRun, trace_ref: traceRef || undefined },
    source: 'telegram_chat_execution',
  });
  let stageTransition = null;
  if (phase === 'started' && agentResult?.state?.current_stage_id && agentResult.state.current_stage_id !== previousStage) {
    stageTransition = appendLoopRunEvent({
      jobDir,
      loopId: run.state.loop_id,
      eventType: 'stage_started',
      stageId: agentResult.state.current_stage_id,
      summary: `Stage started: ${agentResult.state.current_stage_id}`,
      source: 'telegram_chat_execution',
    });
  }
  if (agentResult && finalSynthesis && completeRun && phase === 'completed') {
    const completed = appendLoopRunEvent({ jobDir, loopId: run.state.loop_id, eventType: 'run_completed', summary: 'Final synthesis delivered', source: 'telegram_chat_execution' });
    return { ...completed, agent_event: agentResult.event, stage_transition: stageTransition?.event || null };
  }
  return agentResult ? { ...agentResult, stage_transition: stageTransition?.event || null } : null;
}


export function recordActiveLoopIterationEvent({ jobDir = '', phase = 'started', iteration = 1, status = '', summary = '', stopReason = '', stopSignals = [], pendingApproval = false, source = 'watch_task_bridge' } = {}) {
  const run = readActiveLoopRun({ jobDir });
  if (!run?.state?.loop_id || run.active === false) return null;
  const normalizedPhase = clean(phase).toLowerCase();
  const eventType = normalizedPhase === 'completed' ? 'iteration_completed' : 'iteration_started';
  const result = appendLoopRunEvent({
    jobDir,
    loopId: run.state.loop_id,
    eventType,
    summary: summary || `Iteration ${iteration} ${normalizedPhase === 'completed' ? 'completed' : 'started'}`,
    payload: {
      iteration: Math.max(1, Number(iteration) || 1),
      status: clean(status) || (normalizedPhase === 'completed' ? 'next_iteration_ready' : 'running'),
      stop_reason: clean(stopReason) || undefined,
      stop_signals: Array.isArray(stopSignals) ? stopSignals : [],
      pending_approval: pendingApproval === true,
    },
    source,
  });
  if (result && normalizedPhase === 'completed' && (pendingApproval === true || clean(status).toLowerCase() === 'awaiting_approval')) {
    const approval = appendLoopRunEvent({
      jobDir,
      loopId: run.state.loop_id,
      eventType: 'approval_required',
      summary: 'Loop is waiting for user approval',
      payload: { iteration: Math.max(1, Number(iteration) || 1), stop_reason: clean(stopReason) || undefined },
      source,
    });
    return { ...approval, iteration_event: result.event };
  }
  return result;
}

export function applyActiveLoopUserControl({ jobDir = '', control = '', text = '', visibility = '', objective = '', source = 'loop_user_control' } = {}) {
  const run = readActiveLoopRun({ jobDir });
  if (!run?.state?.loop_id) return null;
  return appendLoopRunEvent({
    jobDir,
    loopId: run.state.loop_id,
    eventType: 'user_control',
    summary: text || control,
    payload: { control, text, visibility, objective },
    source,
  });
}

export function listLoopRuns({ jobDir = '', limit = 20 } = {}) {
  const root = loopRunsRoot(jobDir);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readLoopRun({ jobDir, loopId: entry.name }))
    .filter(Boolean)
    .sort((a, b) => String(b.state.updated_at).localeCompare(String(a.state.updated_at)))
    .slice(0, Math.max(1, Number(limit) || 20));
}

export default { createLoopRun, readLoopRun, readActiveLoopRun, appendLoopRunEvent, recordActiveLoopAgentEvent, recordActiveLoopIterationEvent, applyActiveLoopUserControl, listLoopRuns };
