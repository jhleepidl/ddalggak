import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { maxLen = 400, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function intValue(value, fallback = 0, { min = 0, max = 1000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function ensureDir(dir = '') {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(filePath = '', fallback = null) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath = '', value = {}) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath = '', row = {}) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath = '', { limit = 200 } = {}) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const selected = lines.slice(-Math.max(1, limit));
    return selected.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

export function watchTaskPaths(jobDir = '') {
  const base = path.join(String(jobDir || ''), 'local_memory');
  return {
    base,
    contract: path.join(base, 'watch_task_contract.json'),
    state: path.join(base, 'watch_task_state.json'),
    iterations: path.join(base, 'watch_iterations.jsonl'),
    events: path.join(base, 'watch_task_events.jsonl'),
  };
}

export function isWatchWorkflowContract(contract = null) {
  const row = asObject(contract);
  const kind = cleanText(row.workflow_kind || row.workflowKind, { lower: true, maxLen: 80 });
  return kind === 'bounded_continuous_loop' || row.loop_required === true || row.loopRequired === true;
}

export function buildWatchTaskContract({
  jobId = '',
  threadId = '',
  userText = '',
  workflowContract = null,
  runtimeExecutionPolicy = null,
  source = 'workflow_contract',
} = {}) {
  const contract = asObject(workflowContract);
  const runtime = asObject(runtimeExecutionPolicy);
  const continuous = asObject(runtime.continuous_improvement || runtime.continuousImprovement);
  const minIterations = intValue(contract.min_iterations ?? contract.minIterations ?? continuous.min_turns ?? continuous.minTurns, 2, { min: 1, max: 24 });
  const maxIterations = intValue(contract.max_iterations ?? contract.maxIterations ?? continuous.max_turns ?? continuous.maxTurns, Math.max(3, minIterations), { min: minIterations, max: 24 });
  const requiredPasses = asArray(contract.required_passes || contract.requiredPasses);
  const stopConditions = asArray(contract.stop_conditions || contract.stopConditions || continuous.stop_signals || continuous.stopSignals);
  const now = new Date().toISOString();
  return {
    contract_id: `watch_${String(jobId || 'job').replace(/[^a-zA-Z0-9_-]+/g, '_')}`,
    kind: 'watch_task_contract',
    workflow_kind: cleanText(contract.workflow_kind || contract.workflowKind || 'bounded_continuous_loop', { lower: true, maxLen: 80 }),
    status: 'active',
    source,
    job_id: String(jobId || ''),
    thread_id: String(threadId || ''),
    goal: cleanText(userText, { maxLen: 800 }),
    min_iterations: minIterations,
    max_iterations: maxIterations,
    current_iteration: 0,
    required_passes: requiredPasses.length > 0 ? requiredPasses : ['review', 'implementation', 'verification', 'stop_condition_evaluation'],
    approval_boundary: contract.approval_boundary === true || contract.approvalBoundary === true,
    approval_required_for: asArray(contract.approval_required_for || contract.approvalRequiredFor),
    stop_conditions: stopConditions.length > 0 ? stopConditions : ['quality_threshold_met', 'novel_and_sufficiently_complete', 'approval_required', 'user_stop'],
    pause_resume_supported: true,
    user_stop_supported: true,
    created_at: now,
    updated_at: now,
    raw_workflow_contract: contract,
  };
}

export function readWatchTaskState(jobDir = '') {
  const paths = watchTaskPaths(jobDir);
  const contract = readJson(paths.contract, null);
  const state = readJson(paths.state, null);
  const iterations = readJsonl(paths.iterations, { limit: 100 });
  return {
    contract,
    state,
    iterations,
    latest_iteration: iterations.length > 0 ? iterations[iterations.length - 1] : null,
    paths,
  };
}

export function ensureWatchTaskContract({ jobDir = '', jobId = '', threadId = '', userText = '', workflowContract = null, runtimeExecutionPolicy = null, source = 'workflow_contract' } = {}) {
  if (!jobDir || !isWatchWorkflowContract(workflowContract)) return { changed: false, contract: null, state: null };
  const paths = watchTaskPaths(jobDir);
  const existing = readJson(paths.contract, null);
  const now = new Date().toISOString();
  const base = buildWatchTaskContract({ jobId, threadId, userText, workflowContract, runtimeExecutionPolicy, source });
  const contract = existing && typeof existing === 'object'
    ? {
        ...existing,
        ...base,
        contract_id: existing.contract_id || base.contract_id,
        created_at: existing.created_at || base.created_at,
        current_iteration: intValue(existing.current_iteration, 0, { min: 0, max: base.max_iterations }),
        status: ['paused', 'stopped', 'completed', 'awaiting_approval'].includes(cleanText(existing.status, { lower: true }))
          ? existing.status
          : 'active',
        updated_at: now,
      }
    : base;
  writeJson(paths.contract, contract);
  const state = {
    contract_id: contract.contract_id,
    status: contract.status || 'active',
    current_iteration: intValue(contract.current_iteration, 0, { min: 0, max: contract.max_iterations || 24 }),
    max_iterations: contract.max_iterations,
    last_event: existing ? 'contract_refreshed' : 'contract_created',
    updated_at: now,
  };
  writeJson(paths.state, state);
  appendJsonl(paths.events, {
    ts: now,
    event: existing ? 'watch_contract_refreshed' : 'watch_contract_created',
    contract_id: contract.contract_id,
    job_id: jobId,
    workflow_kind: contract.workflow_kind,
    min_iterations: contract.min_iterations,
    max_iterations: contract.max_iterations,
    required_passes: contract.required_passes,
  });
  return { changed: !existing, contract, state, paths };
}

export function startWatchIteration({ jobDir = '', contract = null, userText = '', routePlan = null } = {}) {
  if (!jobDir || !contract) return null;
  const paths = watchTaskPaths(jobDir);
  const current = readWatchTaskState(jobDir);
  const now = new Date().toISOString();
  const currentIteration = intValue(current.state?.current_iteration ?? contract.current_iteration, 0, { min: 0, max: contract.max_iterations || 24 });
  const iterationNumber = currentIteration + 1;
  const row = {
    ts: now,
    event: 'watch_iteration_started',
    contract_id: contract.contract_id,
    iteration: iterationNumber,
    status: 'running',
    user_text: cleanText(userText, { maxLen: 600 }),
    route_reason: cleanText(routePlan?.reason || '', { maxLen: 240 }),
    execution_mode: cleanText(routePlan?.execution_mode || routePlan?.planner_metadata?.execution_mode || '', { lower: true, maxLen: 80 }),
    action_count: Array.isArray(routePlan?.actions) ? routePlan.actions.length : 0,
    required_passes: asArray(contract.required_passes),
  };
  appendJsonl(paths.iterations, row);
  appendJsonl(paths.events, { ...row, event: 'watch_iteration_started' });
  const nextContract = { ...asObject(contract), current_iteration: iterationNumber, status: 'active', updated_at: now };
  writeJson(paths.contract, nextContract);
  writeJson(paths.state, {
    contract_id: contract.contract_id,
    status: 'running',
    current_iteration: iterationNumber,
    max_iterations: contract.max_iterations,
    active_iteration: iterationNumber,
    last_event: 'iteration_started',
    updated_at: now,
  });
  return row;
}

export function completeWatchIteration({ jobDir = '', contract = null, iteration = null, execution = null, routePlan = null, stopReason = '', stopSignals = [], nextStatus = '' } = {}) {
  if (!jobDir || !contract) return null;
  const paths = watchTaskPaths(jobDir);
  const now = new Date().toISOString();
  const iterationNumber = intValue(iteration?.iteration ?? iteration?.iteration_number ?? contract.current_iteration, 1, { min: 1, max: contract.max_iterations || 24 });
  const outputs = asArray(execution?.outputs);
  const results = asArray(execution?.results);
  const maxIterations = intValue(contract.max_iterations, 1, { min: 1, max: 24 });
  const minIterations = intValue(contract.min_iterations, 1, { min: 1, max: maxIterations });
  const pendingApproval = Boolean(execution?.pendingApproval || execution?.pending_approval);
  const normalizedStopSignals = asArray(stopSignals).map((row) => cleanText(row, { lower: true, maxLen: 80 })).filter(Boolean);
  let status = cleanText(nextStatus, { lower: true, maxLen: 80 });
  if (!status) {
    if (pendingApproval || stopReason === 'pending_approval') status = 'awaiting_approval';
    else if (stopReason === 'continuous_goal_met' || (iterationNumber >= minIterations && normalizedStopSignals.length > 0)) status = 'completed';
    else if (iterationNumber >= maxIterations || stopReason === 'max_turns') status = 'completed';
    else if (stopReason === 'await_user') status = 'paused';
    else status = 'next_iteration_ready';
  }
  const row = {
    ts: now,
    event: 'watch_iteration_completed',
    contract_id: contract.contract_id,
    iteration: iterationNumber,
    status,
    stop_reason: cleanText(stopReason, { lower: true, maxLen: 80 }),
    stop_signals: normalizedStopSignals,
    result_count: results.length,
    output_count: outputs.length,
    pending_approval: pendingApproval,
    route_done: routePlan?.done === true,
    route_await_user: routePlan?.await_user === true,
  };
  appendJsonl(paths.iterations, row);
  appendJsonl(paths.events, row);
  const nextContract = { ...asObject(contract), current_iteration: iterationNumber, status, updated_at: now };
  writeJson(paths.contract, nextContract);
  writeJson(paths.state, {
    contract_id: contract.contract_id,
    status,
    current_iteration: iterationNumber,
    max_iterations: maxIterations,
    active_iteration: null,
    last_event: 'iteration_completed',
    stop_reason: row.stop_reason,
    stop_signals: normalizedStopSignals,
    updated_at: now,
  });
  return row;
}

export function setWatchTaskStatus({ jobDir = '', status = '', reason = '', actor = '' } = {}) {
  if (!jobDir) return { ok: false, reason: 'missing_job_dir' };
  const paths = watchTaskPaths(jobDir);
  const contract = readJson(paths.contract, null);
  if (!contract) return { ok: false, reason: 'missing_watch_contract' };
  const cleanStatus = cleanText(status, { lower: true, maxLen: 80 });
  if (!['active', 'paused', 'stopped', 'completed', 'awaiting_approval', 'next_iteration_ready'].includes(cleanStatus)) {
    return { ok: false, reason: 'invalid_status' };
  }
  const now = new Date().toISOString();
  const nextContract = { ...contract, status: cleanStatus, updated_at: now };
  writeJson(paths.contract, nextContract);
  const state = {
    ...(readJson(paths.state, {}) || {}),
    contract_id: nextContract.contract_id,
    status: cleanStatus,
    last_event: `watch_${cleanStatus}`,
    reason: cleanText(reason, { maxLen: 240 }),
    updated_at: now,
  };
  writeJson(paths.state, state);
  appendJsonl(paths.events, {
    ts: now,
    event: `watch_${cleanStatus}`,
    contract_id: nextContract.contract_id,
    actor: cleanText(actor, { maxLen: 120 }),
    reason: cleanText(reason, { maxLen: 240 }),
  });
  return { ok: true, contract: nextContract, state };
}

export function summarizeWatchTaskState(jobDir = '') {
  const { contract, state, iterations } = readWatchTaskState(jobDir);
  if (!contract) return null;
  const completed = iterations.filter((row) => row.event === 'watch_iteration_completed');
  const started = iterations.filter((row) => row.event === 'watch_iteration_started');
  return {
    contract_id: contract.contract_id,
    workflow_kind: contract.workflow_kind,
    status: state?.status || contract.status || 'active',
    current_iteration: intValue(state?.current_iteration ?? contract.current_iteration, 0, { min: 0, max: contract.max_iterations || 24 }),
    min_iterations: intValue(contract.min_iterations, 1, { min: 1, max: 24 }),
    max_iterations: intValue(contract.max_iterations, 1, { min: 1, max: 24 }),
    started_count: started.length,
    completed_count: completed.length,
    required_passes: asArray(contract.required_passes),
    approval_boundary: contract.approval_boundary === true,
    stop_conditions: asArray(contract.stop_conditions),
    latest_iteration: iterations.length > 0 ? iterations[iterations.length - 1] : null,
  };
}
