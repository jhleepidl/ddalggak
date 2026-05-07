function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '', { lower = false, maxLen = 160 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function intValue(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}
function countRole(execution = null, role = '') {
  const target = clean(role, { lower: true });
  const rows = [
    ...asArray(asObject(execution).runtime_agents || asObject(execution).runtimeAgents),
    ...asArray(asObject(execution).agents),
    ...asArray(asObject(execution).participants),
    ...asArray(asObject(execution).results).map((r) => asObject(r)),
  ];
  return rows.filter((row) => clean(row.role_id || row.roleId || row.role || row.agent_id || row.agentId || row.id || '', { lower: true }) === target).length;
}

export function verifyExecutionAgainstWorkflowContract({ contract = null, plannerMetadata = null, execution = null, executionInsights = null } = {}) {
  const row = asObject(contract || asObject(plannerMetadata).team_workflow_contract || asObject(plannerMetadata).teamWorkflowContract);
  if (!Object.keys(row).length || clean(row.workflow_kind, { lower: true }) === 'single_task') {
    return { ok: true, quality_gap: 0, violations: [], tags: [] };
  }
  const planner = asObject(plannerMetadata);
  const insights = asObject(executionInsights?.execution || executionInsights);
  const exec = asObject(execution);
  const violations = [];
  const tags = [];
  const mode = clean(planner.execution_mode || planner.executionMode || exec.execution_mode || exec.executionMode || '', { lower: true });
  const planned = intValue(insights.planned_agent_count || insights.plannedAgentCount || planner.runtime_agent_count || planner.runtimeAgentCount || 0);
  const observed = intValue(insights.observed_agent_count || insights.observedAgentCount || planned || 0);
  const iterationCount = intValue(exec.iteration_count || exec.iterationCount || insights.iteration_count || insights.iterationCount || 1, 1);
  if (row.workflow_kind === 'bounded_continuous_loop' && iterationCount < intValue(row.min_iterations, 2)) {
    violations.push('loop_min_iterations_not_met');
    tags.push('missed_loop_contract');
  }
  if (row.workflow_kind === 'bounded_continuous_loop' && mode === 'single_compiled') {
    violations.push('loop_contract_routed_as_single_compiled');
    tags.push('missed_workflow_contract');
  }
  if (asArray(row.required_passes).includes('review') && countRole(exec, 'reviewer') === 0 && planned <= 1 && observed <= 1) {
    violations.push('review_pass_missing');
    tags.push('review_missing');
  }
  if (row.approval_boundary && asArray(row.approval_required_for).length > 0 && exec.high_risk_change === true && exec.pendingApproval !== true && exec.pending_approval !== true) {
    violations.push('approval_gate_missing_for_high_risk_change');
    tags.push('approval_gate_missing');
  }
  if (asArray(row.required_passes).includes('stop_condition_evaluation') && exec.stop_condition_evaluated !== true && exec.stopConditionEvaluated !== true && row.workflow_kind === 'bounded_continuous_loop') {
    violations.push('stop_condition_not_evaluated');
    tags.push('stop_condition_missing');
  }
  return {
    ok: violations.length === 0,
    quality_gap: Math.min(8, violations.length),
    violations,
    tags,
  };
}
