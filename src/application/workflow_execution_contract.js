import { normalizeRuntimeExecutionPolicy } from './runtime_execution_policy.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 160 } = {}) {
  const text = String(value || '').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function intValue(value, fallback = 0, { min = 0, max = 24 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniq(values = [], { max = 16 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const clean = cleanText(value, { lower: true, maxLen: 96 });
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
    if (out.length >= max) break;
  }
  return out;
}

export function isWorkflowContractRequired(contract = null) {
  const row = asObject(contract);
  const kind = cleanText(row.workflow_kind || row.workflowKind, { lower: true, maxLen: 80 });
  return Boolean(kind && kind !== 'single_task');
}

export function buildWorkflowRuntimeExecutionPatch(contract = null, baseRuntimeExecution = null) {
  const row = asObject(contract);
  if (!isWorkflowContractRequired(row)) return null;
  const normalizedBase = normalizeRuntimeExecutionPolicy(baseRuntimeExecution || {});
  const workflowKind = cleanText(row.workflow_kind || row.workflowKind, { lower: true, maxLen: 80 });
  const requiredPasses = uniq(row.required_passes || row.requiredPasses || [], { max: 12 });
  const minIterations = intValue(row.min_iterations ?? row.minIterations, workflowKind === 'bounded_continuous_loop' ? 2 : 1, { min: 1, max: 12 });
  const maxIterations = intValue(row.max_iterations ?? row.maxIterations, workflowKind === 'bounded_continuous_loop' ? Math.max(3, minIterations) : 1, { min: minIterations, max: 24 });
  const stopSignals = uniq([
    ...(row.stop_conditions || row.stopConditions || []),
    ...(workflowKind === 'bounded_continuous_loop' ? ['user_stop', 'approval_required', 'iteration_budget_exceeded', 'three_consecutive_failures'] : []),
  ], { max: 16 });
  const isBoundedLoop = workflowKind === 'bounded_continuous_loop';
  return {
    ...normalizedBase,
    execution_mode: isBoundedLoop ? 'task_loop' : (normalizedBase.execution_mode || 'review_loop'),
    workspace_write: isBoundedLoop ? 'allowed_in_workspace' : (normalizedBase.workspace_write || 'only_when_explicit'),
    artifact_delivery: isBoundedLoop ? 'allowed_when_task_requires' : (normalizedBase.artifact_delivery || 'only_when_explicit'),
    legacy_manual_fallback: isBoundedLoop ? 'disabled' : (normalizedBase.legacy_manual_fallback || 'disabled'),
    approval_boundary: row.approval_boundary === true || row.approvalBoundary === true || normalizedBase.approval_boundary === true,
    task_loop: {
      ...(normalizedBase.task_loop || {}),
      execution_mode: isBoundedLoop ? 'task_loop' : (normalizedBase.task_loop?.execution_mode || normalizedBase.execution_mode || 'review_loop'),
      workspace_write: isBoundedLoop ? 'allowed_in_workspace' : (normalizedBase.task_loop?.workspace_write || normalizedBase.workspace_write || 'only_when_explicit'),
      artifact_delivery: isBoundedLoop ? 'allowed_when_task_requires' : (normalizedBase.task_loop?.artifact_delivery || normalizedBase.artifact_delivery || 'only_when_explicit'),
      legacy_manual_fallback: isBoundedLoop ? 'disabled' : (normalizedBase.task_loop?.legacy_manual_fallback || normalizedBase.legacy_manual_fallback || 'disabled'),
      approval_boundary: row.approval_boundary === true || row.approvalBoundary === true || normalizedBase.approval_boundary === true,
    },
    approval_matrix: {
      ...(normalizedBase.approval_matrix || {}),
      workspace_write: isBoundedLoop ? 'allow' : normalizedBase.approval_matrix?.workspace_write,
      codex_exec: isBoundedLoop ? 'allow' : normalizedBase.approval_matrix?.codex_exec,
      verification: isBoundedLoop ? 'allow' : normalizedBase.approval_matrix?.verification,
      shell_exec: normalizedBase.approval_matrix?.shell_exec || (isBoundedLoop ? 'ask' : undefined),
    },
    continuous_improvement: {
      ...normalizedBase.continuous_improvement,
      enabled: workflowKind === 'bounded_continuous_loop' ? true : normalizedBase.continuous_improvement.enabled === true,
      mode: workflowKind === 'bounded_continuous_loop' ? 'bounded_watch_loop' : (normalizedBase.continuous_improvement.mode || workflowKind || 'review_gated_pipeline'),
      min_turns: Math.max(normalizedBase.continuous_improvement.min_turns || 1, minIterations),
      max_turns: Math.max(normalizedBase.continuous_improvement.max_turns || 1, maxIterations),
      max_total_actions: Math.max(normalizedBase.continuous_improvement.max_total_actions || 1, maxIterations * Math.max(4, requiredPasses.length + 2)),
      progress_report_each_turn: true,
      stop_signals: stopSignals.length > 0 ? stopSignals : normalizedBase.continuous_improvement.stop_signals,
      self_refine_prompt: normalizedBase.continuous_improvement.self_refine_prompt || (workflowKind === 'bounded_continuous_loop'
        ? 'Run bounded review-improve-verify iterations until the stop condition is met or approval/user input is required.'
        : ''),
    },
    work_mode: row.work_mode || normalizedBase.work_mode || normalizedBase.workMode,
    cycle_policy: row.cycle_policy || normalizedBase.cycle_policy || normalizedBase.cyclePolicy,
    workflow_contract: {
      ...row,
      enforced: true,
      enforcement_level: workflowKind === 'bounded_continuous_loop' ? 'hard_loop_contract' : (workflowKind === 'staged_research_campaign' ? 'hard_stage_checkpoint_contract' : 'hard_review_contract'),
    },
  };
}

export function installWorkflowExecutionContract(runtime = null, contract = null, { source = 'workflow_contract' } = {}) {
  if (!runtime || typeof runtime !== 'object' || !isWorkflowContractRequired(contract)) {
    return { changed: false, runtime, runtime_execution_patch: null };
  }
  const base = runtime.runtime_execution || runtime.runtimeExecution || runtime.runtime_execution_policy || runtime.runtimeExecutionPolicy || runtime.execution_policy || runtime.executionPolicy || {};
  const patch = buildWorkflowRuntimeExecutionPatch(contract, base);
  if (!patch) return { changed: false, runtime, runtime_execution_patch: null };
  runtime.runtime_execution = patch;
  runtime.runtimeExecution = patch;
  runtime.runtime_execution_policy = patch;
  runtime.runtimeExecutionPolicy = patch;
  runtime.team_workflow_contract = { ...asObject(contract), enforced: true, source };
  runtime.teamWorkflowContract = runtime.team_workflow_contract;
  runtime.workflow_contract_enforced = true;
  runtime.workflowContractEnforced = true;
  return { changed: true, runtime, runtime_execution_patch: patch };
}

export function buildWorkflowContractExecutionMetadata(contract = null, runtimeExecutionPatch = null) {
  const row = asObject(contract);
  if (!isWorkflowContractRequired(row)) return null;
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecutionPatch || {});
  return {
    workflow_kind: cleanText(row.workflow_kind || row.workflowKind, { lower: true, maxLen: 80 }),
    hard_contract: true,
    execution_mode: policy.execution_mode,
    workspace_write: policy.workspace_write,
    artifact_delivery: policy.artifact_delivery,
    legacy_manual_fallback: policy.legacy_manual_fallback,
    continuous_improvement_enabled: policy.continuous_improvement.enabled === true,
    continuous_mode: policy.continuous_improvement.mode,
    min_turns: policy.continuous_improvement.min_turns,
    max_turns: policy.continuous_improvement.max_turns,
    required_passes: uniq(row.required_passes || row.requiredPasses || [], { max: 12 }),
    approval_boundary: row.approval_boundary === true || row.approvalBoundary === true,
    stop_conditions: uniq(row.stop_conditions || row.stopConditions || [], { max: 12 }),
  };
}
