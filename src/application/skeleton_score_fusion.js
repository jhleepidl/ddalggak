import { scoreSkeletonAdvisory, scorerConfigFromEnv } from './skeleton_advisory_scorer.js';
import { inferUserOrchestrationIntent, summarizeUserOrchestrationIntent, candidateSatisfiesUserOrchestrationIntent } from './team_user_orchestration_intent.js';
import { summarizeTaskAttemptPlan, candidateSatisfiesTaskAttempt } from './task_attempt_planner.js';
import { summarizeWorkModeConfig, candidateSatisfiesWorkMode } from './work_mode.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function clamp(value, min = -1, max = 1) { const n = Number(value); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : 0; }

export function fuseCandidateScoreWithAdvisory(candidate = {}, advisory = {}, { mode = 'shadow', request = '', userOrchestrationIntent = null, taskAttemptPlan = null } = {}) {
  const score = asObject(candidate.score);
  const baseUtility = clamp(score.utility ?? candidate.utility ?? 0, -1, 1);
  const axis = asObject(advisory.axis_scores);
  const userIntent = summarizeUserOrchestrationIntent(userOrchestrationIntent || candidate.user_orchestration_intent || inferUserOrchestrationIntent(request));
  const userIntentSatisfaction = candidateSatisfiesUserOrchestrationIntent(candidate, userIntent);
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || candidate.task_attempt_plan || {});
  const workMode = summarizeWorkModeConfig(candidate.work_mode || attemptPlan.work_mode || {});
  const workModeSatisfaction = candidateSatisfiesWorkMode(candidate, workMode);
  const attemptSatisfaction = candidateSatisfiesTaskAttempt(candidate, attemptPlan);
  const advisoryDelta = advisory.status === 'ok' ? clamp(axis.total ?? 0, -0.35, 0.35) : 0;
  const gatePenalty = candidate.gate?.executable === false ? -1 : 0;
  const rawDebtPenalty = advisory?.labels?.Y_DEBT === 'high' ? 0.18 : (advisory?.labels?.Y_DEBT === 'med' ? 0.06 : 0);
  const userRequestedOverhead = userIntent.team_intent === 'explicit' && userIntentSatisfaction.satisfied;
  const debtPenalty = userRequestedOverhead ? rawDebtPenalty * 0.3 : (userIntent.team_intent === 'preferred' && userIntentSatisfaction.satisfied ? rawDebtPenalty * 0.65 : rawDebtPenalty);
  const userIntentBonus = userIntent.team_intent === 'explicit'
    ? (userIntentSatisfaction.satisfied ? 0.08 : -0.16)
    : (userIntent.team_intent === 'preferred' ? (userIntentSatisfaction.satisfied ? 0.04 : -0.05) : (userIntent.team_intent === 'avoid' && !userIntentSatisfaction.satisfied ? -0.09 : 0));
  const attemptIntentBonus = ['branch', 'parallel_branch'].includes(attemptPlan.run_mode) || attemptPlan.target_team !== 'general'
    ? (attemptSatisfaction.satisfied ? 0.07 : -0.11)
    : 0;
  const memoryImportBonus = attemptPlan.memory_import?.import_intent === 'explicit'
    ? (attemptSatisfaction.satisfied ? 0.03 : -0.05)
    : 0;
  const workModeBonus = ['team_review', 'project_task', 'research_campaign', 'customize'].includes(workMode.work_mode)
    ? (workModeSatisfaction.satisfied ? (workMode.work_mode === 'research_campaign' ? 0.08 : 0.05) : -0.08)
    : (workMode.work_mode === 'quick_answer' && !workModeSatisfaction.satisfied && workMode.explicit ? -0.08 : 0);
  const fusedUtility = clamp(baseUtility + advisoryDelta - debtPenalty + userIntentBonus + attemptIntentBonus + memoryImportBonus + workModeBonus + gatePenalty, -1, 1);
  const capacityGaps = asArray(advisory.capacity_gaps);
  return {
    ...score,
    base_utility: Number(baseUtility.toFixed(3)),
    learned_delta: Number(advisoryDelta.toFixed(3)),
    learned_debt_penalty: Number(debtPenalty.toFixed(3)),
    user_intent_bonus: Number(userIntentBonus.toFixed(3)),
    user_intent_match: userIntentSatisfaction.satisfied,
    user_intent_reason: userIntentSatisfaction.reason,
    user_team_intent: userIntent.team_intent,
    user_team_style: userIntent.team_style,
    missing_user_required_roles: userIntentSatisfaction.missing_required_roles || [],
    user_requested_overhead_discount: Number((rawDebtPenalty - debtPenalty).toFixed(3)),
    task_attempt_match: attemptSatisfaction.satisfied,
    task_attempt_reason: attemptSatisfaction.reason,
    target_team: attemptPlan.target_team,
    candidate_target_team: attemptSatisfaction.candidate_target_team,
    run_mode: attemptPlan.run_mode,
    retry_reason: attemptPlan.retry_reason,
    previous_result_policy: attemptPlan.previous_result_policy,
    attempt_intent_bonus: Number(attemptIntentBonus.toFixed(3)),
    memory_import_intent: attemptPlan.memory_import?.import_intent || 'none',
    memory_import_profile: attemptPlan.memory_import?.projection_profile || 'general',
    memory_import_bonus: Number(memoryImportBonus.toFixed(3)),
    work_mode: workMode.work_mode,
    work_mode_match: workModeSatisfaction.satisfied,
    work_mode_reason: workModeSatisfaction.reason,
    work_mode_bonus: Number(workModeBonus.toFixed(3)),
    loop_budget: workMode.loop_budget,
    stop_condition: workMode.stop_condition,
    review_policy: workMode.review_policy,
    memory_mode: workMode.memory_mode,
    goc_mode: workMode.goc_mode,
    fused_utility: Number(fusedUtility.toFixed(3)),
    advisory_mode: mode,
    capacity_gap_count: capacityGaps.length,
  };
}

export function attachSkeletonAdvisoryToCandidates({ request = '', candidates = [], stress = {}, runtime = null, config = null, taskAttemptPlan = null } = {}) {
  const cfg = asObject(config || scorerConfigFromEnv());
  const mode = clean(cfg.mode || 'shadow').toLowerCase();
  if (mode === 'off') {
    return { mode, candidates: asArray(candidates), summary: { enabled: false, mode } };
  }
  const userIntent = summarizeUserOrchestrationIntent(inferUserOrchestrationIntent(request));
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || {});
  const next = asArray(candidates).map((candidate) => {
    const enrichedCandidate = { ...candidate, user_orchestration_intent: candidate.user_orchestration_intent || userIntent, task_attempt_plan: candidate.task_attempt_plan || attemptPlan, memory_import_intent: candidate.memory_import_intent || attemptPlan.memory_import, work_mode: candidate.work_mode || attemptPlan.work_mode };
    const advisory = scoreSkeletonAdvisory({ request, candidate: enrichedCandidate, stress, runtime, config: cfg });
    const fusedScore = fuseCandidateScoreWithAdvisory(enrichedCandidate, advisory, { mode, request, userOrchestrationIntent: userIntent, taskAttemptPlan: attemptPlan });
    return { ...enrichedCandidate, skeleton_advisory: advisory, score: fusedScore, user_intent_satisfaction: candidateSatisfiesUserOrchestrationIntent(enrichedCandidate, userIntent) };
  });
  const usable = next.filter((candidate) => candidate.skeleton_advisory?.status === 'ok').length;
  return {
    mode,
    candidates: next,
    summary: {
      enabled: true,
      mode,
      scorer_status: usable > 0 ? 'ok' : (next[0]?.skeleton_advisory?.status || 'unavailable'),
      usable_count: usable,
      candidate_count: next.length,
      rerank_active: mode === 'rerank' && usable > 0,
      user_orchestration_intent: userIntent,
      task_attempt_plan: attemptPlan,
      memory_import_intent: attemptPlan.memory_import,
      work_mode: attemptPlan.work_mode,
    },
  };
}

export function sortCandidatesWithAdvisory(candidates = [], { mode = 'shadow' } = {}) {
  const rows = [...asArray(candidates)];
  const useFused = clean(mode).toLowerCase() === 'rerank';
  return rows.sort((a, b) => {
    if (a.selected) return -1;
    if (b.selected) return 1;
    const au = Number(useFused ? a.score?.fused_utility : a.score?.utility || 0);
    const bu = Number(useFused ? b.score?.fused_utility : b.score?.utility || 0);
    if (Math.abs(bu - au) > 0.001) return bu - au;
    return Number(a.score?.estimated_cost || 0) - Number(b.score?.estimated_cost || 0);
  });
}
