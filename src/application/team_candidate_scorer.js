import { inferUserOrchestrationIntent, summarizeUserOrchestrationIntent, candidateSatisfiesUserOrchestrationIntent } from './team_user_orchestration_intent.js';
import { summarizeTaskAttemptPlan, candidateSatisfiesTaskAttempt } from './task_attempt_planner.js';
import { summarizeWorkModeConfig, candidateSatisfiesWorkMode } from './work_mode.js';
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }
function clamp(value, min = 0, max = 1) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : min; }

function roles(candidate = {}) {
  return asArray(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((a) => a.role)).map(cleanId).filter(Boolean);
}

function hasRole(candidate, role) {
  return roles(candidate).includes(cleanId(role));
}

export function scoreTeamCandidate(candidate = {}, { stress = {}, gate = null, request = '', userOrchestrationIntent = null, taskAttemptPlan = null } = {}) {
  const s = asObject(stress);
  const g = asObject(gate || candidate.gate);
  const r = roles(candidate);
  const agentCount = Number(candidate.agent_count || candidate.team?.agents?.length || r.length || 1);
  const coordinationCost = Number(candidate.coordination_cost ?? Math.max(0, agentCount - 1));
  const userIntent = summarizeUserOrchestrationIntent(userOrchestrationIntent || candidate.user_orchestration_intent || inferUserOrchestrationIntent(request));
  const userIntentSatisfaction = candidateSatisfiesUserOrchestrationIntent(candidate, userIntent);
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || candidate.task_attempt_plan || {});
  const workMode = summarizeWorkModeConfig(candidate.work_mode || attemptPlan.work_mode || {});
  const workModeSatisfaction = candidateSatisfiesWorkMode(candidate, workMode);
  const attemptSatisfaction = candidateSatisfiesTaskAttempt(candidate, attemptPlan);
  let expectedSuccess = 0.45;
  if (hasRole(candidate, 'builder') && (Number(s.artifact_pressure || 0) >= 0.45 || Number(s.workspace_mutation || 0) >= 0.45)) expectedSuccess += 0.18;
  if (hasRole(candidate, 'reviewer') && Number(s.verification_need || 0) >= 0.45) expectedSuccess += 0.14;
  if (hasRole(candidate, 'researcher') && Number(s.current_info_need || 0) >= 0.45) expectedSuccess += 0.1;
  if (hasRole(candidate, 'synthesizer') && agentCount >= 2) expectedSuccess += 0.08;
  if (agentCount === 1 && Number(s.overall || 0) < 0.35) expectedSuccess += 0.12;
  if (agentCount === 1 && Number(s.overall || 0) >= 0.65) expectedSuccess -= 0.18;
  expectedSuccess += Number(candidate.prior_weight || candidate.default_weight || 1) * 0.04;
  let workModeBonus = 0;
  let workModePenalty = 0;
  if (['team_task', 'team_loop_task'].includes(workMode.work_mode)) {
    if (workModeSatisfaction.satisfied) workModeBonus = workMode.work_mode === 'team_loop_task' ? 0.14 : 0.09;
    else workModePenalty = workMode.work_mode === 'team_loop_task' ? 0.2 : 0.12;
  } else if (workMode.work_mode === 'ask' && !workModeSatisfaction.satisfied) {
    workModePenalty = workMode.explicit ? 0.18 : 0.04;
  }
  expectedSuccess += workModeBonus - workModePenalty;
  let attemptIntentBonus = 0;
  let attemptIntentPenalty = 0;
  if (['branch', 'parallel_branch'].includes(attemptPlan.run_mode) || attemptPlan.target_team !== 'general') {
    if (attemptSatisfaction.satisfied) attemptIntentBonus = 0.11;
    else attemptIntentPenalty = attemptPlan.run_mode === 'branch' ? 0.18 : 0.1;
  }
  if (attemptPlan.previous_result_policy === 'exclude' && String(candidate.source || '').includes('task_attempt_branch')) attemptIntentBonus += 0.035;
  if (String(candidate.source || '').includes('task_attempt_branch')) attemptIntentBonus += 0.16;
  expectedSuccess += attemptIntentBonus - attemptIntentPenalty;
  let userIntentBonus = 0;
  let userIntentPenalty = 0;
  if (userIntent.team_intent === 'explicit') {
    if (userIntentSatisfaction.satisfied) userIntentBonus = 0.13;
    else userIntentPenalty = 0.24;
  } else if (userIntent.team_intent === 'preferred') {
    if (userIntentSatisfaction.satisfied) userIntentBonus = 0.07;
    else userIntentPenalty = 0.08;
  } else if (userIntent.team_intent === 'avoid' && !userIntentSatisfaction.satisfied) {
    userIntentPenalty = 0.16;
  }
  expectedSuccess += userIntentBonus - userIntentPenalty;
  expectedSuccess = clamp(expectedSuccess, 0, 1);

  const userOverheadDiscount = userIntent.team_intent === 'explicit' && userIntentSatisfaction.satisfied ? 0.45 : (userIntent.team_intent === 'preferred' && userIntentSatisfaction.satisfied ? 0.25 : 0);
  const overheadMultiplier = 1 - userOverheadDiscount;
  const costPenalty = clamp(((agentCount - 1) * 0.055 + coordinationCost * 0.025) * overheadMultiplier, 0, 0.45);
  const latencyPenalty = clamp(((agentCount - 1) * 0.045 + (candidate.pattern === 'parallel' ? 0.02 : 0.04)) * overheadMultiplier, 0, 0.35);
  const riskPenalty = clamp((asArray(g.violations || g.blocking_reason_codes).length * 0.25) + (asArray(g.warnings || g.degrade_reason_codes).length * 0.04), 0, 0.9);
  const verificationBonus = hasRole(candidate, 'reviewer') && Number(s.verification_need || 0) >= 0.45 ? 0.08 : 0;
  const privacyBonus = asArray(candidate.tags || candidate.coverage_tags).some((tag) => /local|private|privacy/.test(cleanId(tag))) ? 0.04 : 0;
  const artifactBonus = hasRole(candidate, 'builder') && Number(s.artifact_pressure || 0) >= 0.6 ? 0.08 : 0;
  const utility = clamp(expectedSuccess - costPenalty - latencyPenalty - riskPenalty + verificationBonus + privacyBonus + artifactBonus, -1, 1);
  const userIntentRequired = ['explicit', 'preferred'].includes(userIntent.team_intent);
  const sufficient = g.executable === true && utility >= 0.42 && expectedSuccess >= 0.52 && (!userIntentRequired || userIntentSatisfaction.satisfied);
  return {
    expected_success: Number(expectedSuccess.toFixed(3)),
    estimated_cost: Number((agentCount + coordinationCost * 0.35).toFixed(3)),
    estimated_latency: Number((1 + (candidate.pattern === 'parallel' ? 0.55 : 0.85) * Math.max(0, agentCount - 1)).toFixed(3)),
    coordination_cost: coordinationCost,
    cost_penalty: Number(costPenalty.toFixed(3)),
    latency_penalty: Number(latencyPenalty.toFixed(3)),
    risk_penalty: Number(riskPenalty.toFixed(3)),
    utility: Number(utility.toFixed(3)),
    user_intent_match: userIntentSatisfaction.satisfied,
    user_intent_reason: userIntentSatisfaction.reason,
    missing_user_required_roles: userIntentSatisfaction.missing_required_roles || [],
    user_intent_bonus: Number(userIntentBonus.toFixed(3)),
    user_intent_penalty: Number(userIntentPenalty.toFixed(3)),
    user_requested_overhead_discount: Number(userOverheadDiscount.toFixed(3)),
    task_attempt_match: attemptSatisfaction.satisfied,
    task_attempt_reason: attemptSatisfaction.reason,
    target_team: attemptPlan.target_team,
    candidate_target_team: attemptSatisfaction.candidate_target_team,
    run_mode: attemptPlan.run_mode,
    retry_reason: attemptPlan.retry_reason,
    previous_result_policy: attemptPlan.previous_result_policy,
    attempt_intent_bonus: Number(attemptIntentBonus.toFixed(3)),
    attempt_intent_penalty: Number(attemptIntentPenalty.toFixed(3)),
    work_mode: workMode.work_mode,
    work_mode_match: workModeSatisfaction.satisfied,
    work_mode_reason: workModeSatisfaction.reason,
    work_mode_bonus: Number(workModeBonus.toFixed(3)),
    work_mode_penalty: Number(workModePenalty.toFixed(3)),
    loop_budget: workMode.loop_budget,
    stop_condition: workMode.stop_condition,
    review_policy: workMode.review_policy,
    memory_mode: workMode.memory_mode,
    goc_mode: workMode.goc_mode,
    memory_import_profile: attemptPlan.memory_import?.projection_profile || 'general',
    memory_import_intent: attemptPlan.memory_import?.import_intent || 'none',
    user_team_intent: userIntent.team_intent,
    user_team_style: userIntent.team_style,
    sufficient,
  };
}

function candidateUtility(candidate = {}) {
  const score = candidate.score || {};
  return Number(score.advisory_mode === 'rerank' ? (score.fused_utility ?? score.utility ?? 0) : (score.utility ?? 0));
}

export function selectTeamCandidate(candidates = [], { policy = 'cheapest_sufficient' } = {}) {
  const rows = asArray(candidates).filter(Boolean);
  if (rows.length === 0) return null;
  const executable = rows.filter((c) => c.gate?.executable === true);
  const pool = executable.length > 0 ? executable : rows;
  if (policy === 'max_utility') {
    return [...pool].sort((a, b) => candidateUtility(b) - candidateUtility(a))[0] || null;
  }
  const sufficient = pool.filter((c) => c.score?.sufficient === true);
  if (sufficient.length > 0) {
    return [...sufficient].sort((a, b) => {
      const costDelta = Number(a.score?.estimated_cost || 0) - Number(b.score?.estimated_cost || 0);
      if (Math.abs(costDelta) > 0.001) return costDelta;
      return candidateUtility(b) - candidateUtility(a);
    })[0] || null;
  }
  return [...pool].sort((a, b) => candidateUtility(b) - candidateUtility(a))[0] || null;
}
