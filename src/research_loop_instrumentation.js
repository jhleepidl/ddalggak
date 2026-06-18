function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value, maxLen = 512) {
  return String(value || '').trim().slice(0, maxLen);
}

function cleanList(value, maxLen = 32) {
  return asArray(value)
    .map((item) => cleanText(item, 128))
    .filter(Boolean)
    .slice(0, maxLen);
}

function inferDepth({ taskAttemptPlan = {}, workMode = {}, teamCandidate = {} } = {}) {
  const plan = asObject(taskAttemptPlan);
  const wm = asObject(workMode || plan.work_mode);
  const candidate = asObject(teamCandidate);
  const explicit = cleanText(plan.depth || wm.depth || wm.work_depth || candidate.depth, 64).toLowerCase();
  if (['ask', 'single', 'single_pass', 'quick_answer'].includes(explicit)) return 'ask';
  if (['team', 'team_review'].includes(explicit)) return 'team';
  if (['loop', 'bounded_loop', 'project_task', 'research_campaign', 'customize'].includes(explicit)) return 'loop';
  const workModeName = cleanText(wm.work_mode || wm.mode || plan.work_mode, 64).toLowerCase();
  if (workModeName === 'quick_answer') return 'ask';
  if (workModeName === 'team_review') return 'team';
  if (['project_task', 'research_campaign', 'customize'].includes(workModeName)) return 'loop';
  if (['branch', 'retry', 'parallel_branch'].includes(cleanText(plan.run_mode, 64).toLowerCase())) return 'loop';
  return asArray(candidate.roles).length > 1 ? 'team' : 'ask';
}

export function buildLoopRecipeConfig({ taskAttemptPlan = {}, teamCandidate = {}, workMode = {}, memoryPolicy = {}, approvalPolicy = {} } = {}) {
  const plan = asObject(taskAttemptPlan);
  const candidate = asObject(teamCandidate);
  const wm = asObject(workMode || plan.work_mode);
  const approval = asObject(approvalPolicy);
  const memory = asObject(memoryPolicy || plan.context_policy);
  const skills = cleanList(candidate.skill_requirements || candidate.skills || plan.skills);
  const skeleton = cleanText(
    candidate.skeleton_motif
    || candidate.motif_id
    || candidate.team_skeleton
    || plan.team_skeleton
    || plan.target_team
    || 'single_agent',
    128,
  );
  const gates = cleanList(approval.gates || plan.gates || wm.gates || (wm.review_policy ? [wm.review_policy] : []));
  return {
    kind: 'loop_recipe_v1',
    depth: inferDepth({ taskAttemptPlan: plan, workMode: wm, teamCandidate: candidate }),
    run_mode: cleanText(plan.run_mode || 'new', 64),
    work_mode: cleanText(wm.work_mode || wm.mode || plan.work_mode || '', 64),
    target_team: cleanText(plan.target_team || candidate.target_team || 'general', 64),
    team_skeleton: skeleton,
    skills,
    memory_policy: {
      previous_result_policy: cleanText(plan.previous_result_policy || memory.previous_result_policy || 'optional', 64),
      include_memory_package: memory.include_memory_package === true,
      include_full_chat_tail: memory.include_full_chat_tail === true,
      projection_profile: cleanText(memory.projection_profile || memory.memory_projection_profile || '', 64),
    },
    gates,
    approval_policy: cleanText(approval.policy || wm.review_policy || plan.review_policy || 'optional', 64),
  };
}

export function buildMemoryTreatmentConfig({ treatmentType = '', memoryPackage = {}, contextPolicy = {}, roleId = '' } = {}) {
  const pkg = asObject(memoryPackage);
  const context = asObject(contextPolicy);
  let type = cleanText(treatmentType || pkg.treatment_type || pkg.type, 96).toLowerCase();
  if (!type) {
    if (pkg.ablation_of || pkg.minus_object_id) type = 'ablation';
    else if (pkg.stale === true || pkg.conflicting === true || cleanList(pkg.risk_labels).some((x) => ['stale', 'conflicting', 'poison'].includes(x))) type = 'stale_conflicting';
    else if (context.include_full_chat_tail === true) type = 'full_chat_tail';
    else if (context.include_memory_package === true || Object.keys(pkg).length) type = 'role_specific_package';
    else type = 'control_no_memory';
  }
  return {
    kind: 'memory_treatment_v1',
    type,
    role_id: cleanText(roleId || pkg.role_id || context.role_id, 128) || undefined,
    package_id: cleanText(pkg.package_id || pkg.id, 128) || undefined,
    included_memory_object_ids: cleanList(pkg.included_memory_object_ids || pkg.memory_object_ids || pkg.object_ids, 256),
    excluded_memory_object_ids: cleanList(pkg.excluded_memory_object_ids || pkg.blocked_memory_object_ids, 256),
    ablation_of: cleanText(pkg.ablation_of || pkg.minus_object_id, 128) || undefined,
    risk_labels: cleanList(pkg.risk_labels),
  };
}

export function buildContextBoundaryConfig({ mode = '', roleId = '', allowed = [], blocked = [], policyReasons = [], filters = {} } = {}) {
  const f = asObject(filters);
  return {
    kind: 'context_boundary_v1',
    mode: cleanText(mode || 'role_filtered', 64),
    role_id: cleanText(roleId, 128) || undefined,
    allowed_memory_object_ids: cleanList(allowed, 256),
    blocked_memory_object_ids: cleanList(blocked, 256),
    policy_reasons: cleanList(policyReasons),
    privacy_filter: f.privacy_filter !== false,
    stale_filter: f.stale_filter !== false,
    sufficiency_check: f.sufficiency_check !== false,
  };
}

export function buildResearchAttemptPayload({
  threadId = '',
  taskId = '',
  attemptId = '',
  parentAttemptId = '',
  taskText = '',
  taskAttemptPlan = {},
  teamCandidate = {},
  workMode = {},
  memoryPackage = {},
  contextPolicy = {},
  contextBoundary = {},
  approvalPolicy = {},
  result = {},
  createdBy = 'ddalggak',
} = {}) {
  const plan = asObject(taskAttemptPlan);
  const recipe = buildLoopRecipeConfig({ taskAttemptPlan: plan, teamCandidate, workMode, memoryPolicy: contextPolicy, approvalPolicy });
  const memoryTreatment = buildMemoryTreatmentConfig({ memoryPackage, contextPolicy, roleId: contextBoundary.role_id });
  const boundary = Object.keys(asObject(contextBoundary)).length
    ? { kind: 'context_boundary_v1', ...asObject(contextBoundary) }
    : buildContextBoundaryConfig({ mode: asObject(contextPolicy).visibility_mode || 'role_filtered' });
  return {
    thread_id: cleanText(threadId, 128),
    task_id: cleanText(taskId || plan.task_id, 128) || undefined,
    attempt_id: cleanText(attemptId, 128) || undefined,
    parent_attempt_id: cleanText(parentAttemptId || plan.parent_attempt_id, 128) || undefined,
    run_mode: cleanText(plan.run_mode || 'new', 64),
    target_team: cleanText(plan.target_team || recipe.target_team || 'general', 64),
    previous_result_policy: cleanText(plan.previous_result_policy || recipe.memory_policy.previous_result_policy || 'optional', 64),
    work_mode: recipe.work_mode || undefined,
    review_policy: recipe.approval_policy || undefined,
    memory_projection_profile: recipe.memory_policy.projection_profile || undefined,
    memory_package_id: memoryTreatment.package_id,
    task_text: cleanText(taskText || plan.task_text || plan.objective, 4000),
    context_policy: asObject(contextPolicy),
    memory_package: asObject(memoryPackage),
    candidate_snapshot: { team_candidate: asObject(teamCandidate), task_attempt_plan: plan },
    result: asObject(result),
    meta: {
      loop_recipe: recipe,
      memory_treatment: memoryTreatment,
      context_boundary: boundary,
      research_instrumentation: {
        kind: 'ddalggak_research_attempt_payload_v1',
        source: 'ddalggak',
      },
    },
    created_by: cleanText(createdBy, 64) || 'ddalggak',
  };
}

export function buildEvaluationPayload({ metrics = {}, evaluator = 'ddalggak', notes = '' } = {}) {
  return {
    actor: 'ddalggak',
    evaluator,
    metrics: asObject(metrics),
    notes: cleanText(notes, 1000) || undefined,
  };
}
