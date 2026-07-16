function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '', { lower = false, maxLen = 240 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function uniq(values = [], { max = 16 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const key = clean(value, { lower: true, maxLen: 80 });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

export function buildTeamWorkflowContract({ signals = null, goal = '', taskInterpretation = null } = {}) {
  const row = asObject(signals);
  const workflow = asObject(row.workflow_intent || row.workflowIntent);
  const pressure = asObject(row.pressure);
  const interpreted = asObject(taskInterpretation);
  const reviewNeedsWorkflow = workflow.review_required === true
    && (workflow.review_each_iteration === true || workflow.approval_boundary === true || workflow.implementation_allowed === true);
  const kind = workflow.continuous_loop ? 'bounded_continuous_loop'
    : reviewNeedsWorkflow || workflow.approval_boundary ? 'review_gated_pipeline'
      : workflow.compare_or_explore ? 'explore_then_synthesize'
        : 'single_task';
  const requiredPasses = [];
  if (kind === 'bounded_continuous_loop') requiredPasses.push('plan', 'implement_or_diagnose', 'verify', 'review', 'stop_condition_evaluation');
  else if (kind === 'review_gated_pipeline') requiredPasses.push('implement_or_diagnose', 'verify', 'review');
  else if (kind === 'explore_then_synthesize') requiredPasses.push('explore', 'evaluate', 'synthesize');
  const minIterations = kind === 'bounded_continuous_loop' ? 2 : 1;
  const maxIterations = kind === 'bounded_continuous_loop' ? 5 : 1;
  const approvalRequiredFor = [];
  if (workflow.approval_boundary || Number(pressure.risk || 0) >= 0.45) {
    approvalRequiredFor.push('large_change', 'destructive_write', 'deployment', 'credential_or_api_binding', 'financial_recommendation_logic', 'canonical_memory_switch');
  }
  const semanticIndexing = asObject(row.semantic_indexing || row.semanticIndexing);
  const semanticIndexingTargets = semanticIndexing.requested ? asArray(semanticIndexing.targets).filter(Boolean) : [];
  return {
    kind: 'team_workflow_contract_v1',
    workflow_kind: kind,
    goal_excerpt: clean(goal || interpreted.goal || '', { maxLen: 300 }),
    required_passes: requiredPasses,
    min_iterations: minIterations,
    max_iterations: maxIterations,
    review_each_iteration: workflow.review_each_iteration === true || (kind === 'bounded_continuous_loop' && workflow.review_required === true),
    approval_boundary: workflow.approval_boundary === true || approvalRequiredFor.length > 0,
    approval_required_for: approvalRequiredFor,
    stop_conditions: workflow.stop_condition_present
      ? ['user_stop', 'novel_and_sufficiently_complete', 'approval_required_for_high_risk_change', 'iteration_budget_exceeded', 'three_consecutive_failures']
      : (kind === 'bounded_continuous_loop' ? ['user_stop', 'iteration_budget_exceeded', 'three_consecutive_failures'] : []),
    recommended_roles: uniq(row.recommended_roles || row.recommendedRoles || [], { max: 8 }),
    execution_topology: kind === 'explore_then_synthesize' ? 'deliberation' : (kind === 'single_task' ? 'solo' : 'review_loop'),
    progress_visibility: 'quiet',
    progress_policy: {
      default_visibility: 'quiet',
      user_selectable: ['quiet', 'standard', 'debug'],
      notify_on: ['stage_started', 'blocking_issue_found', 'approval_required', 'run_completed', 'run_failed'],
    },
    memory_policy: {
      raw_trace: 'append_only',
      prompt_surface: 'compacted_working_projection',
      durable_promotion: 'proposal_only',
      compact_after_events: 80,
      compact_after_bytes: 48000,
    },
    semantic_indexing: {
      requested: semanticIndexing.requested === true,
      targets: uniq(semanticIndexingTargets, { max: 6 }),
      policy: semanticIndexing.requested ? 'canonical_registry_or_memory_module_plus_vector_index' : 'not_requested',
    },
    source_reasons: uniq(row.reasons || [], { max: 16 }),
  };
}

export function summarizeTeamWorkflowContract(contract = null) {
  const row = asObject(contract);
  return [
    row.workflow_kind || 'single_task',
    asArray(row.required_passes).length ? `passes=${asArray(row.required_passes).join('→')}` : '',
    Number(row.min_iterations || 0) > 1 ? `iterations>=${row.min_iterations}` : '',
    row.approval_boundary ? 'approval-gated' : '',
    row.review_each_iteration ? 'review-each-iteration' : '',
  ].filter(Boolean).join(' · ');
}
