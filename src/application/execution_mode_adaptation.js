import { readHarnessExecutionModePolicy } from './harness_runtime_behavior.js';
import { syncRuntimeExecutionState } from './runtime_session_state.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 160 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function cleanMode(value = '', fallback = 'single_compiled') {
  const mode = cleanText(value, { lower: true, maxLen: 64 });
  if (mode === 'single_compiled' || mode === 'hybrid_sidecar' || mode === 'multi_motif') return mode;
  return fallback;
}

function modeLevel(mode = 'single_compiled') {
  if (mode === 'multi_motif') return 2;
  if (mode === 'hybrid_sidecar') return 1;
  return 0;
}

function levelMode(level = 0) {
  if (Number(level) >= 2) return 'multi_motif';
  if (Number(level) >= 1) return 'hybrid_sidecar';
  return 'single_compiled';
}

function clampInt(value, { min = 0, max = 8, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function uniqueRoleIds(slots = []) {
  return Array.from(new Set(asArray(slots).map((slot) => cleanText(slot?.role_id || slot?.roleId || slot?.role || '', { lower: true, maxLen: 64 })).filter(Boolean)));
}

function collectParticipantSignalKinds(runtime = null) {
  const target = asObject(runtime);
  const history = asArray(target.participantContributionHistory || target.participant_contribution_history);
  const out = [];
  for (const row of history.slice(-12)) {
    const kind = cleanText(row?.contribution?.kind || row?.kind || '', { lower: true, maxLen: 64 });
    if (kind) out.push(kind);
  }
  return out;
}

function countKinds(kinds = []) {
  const counts = Object.create(null);
  for (const kind of asArray(kinds)) {
    const key = cleanText(kind, { lower: true, maxLen: 64 });
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function hasExplicitMultiIntent({ goal = '', message = '', taskInterpretation = null } = {}) {
  const interpreted = asObject(taskInterpretation);
  if (cleanText(interpreted.parallelism_preference || interpreted.parallelismPreference, { lower: true }) === 'parallel') return true;
  const text = `${goal || ''}\n${message || ''}`.toLowerCase();
  return /(parallel|multi-agent|multi agent|team of agents|split the task|나눠서|병렬|여러 에이전트|멀티 에이전트|팀으로)/i.test(text);
}


function hasExplicitHybridIntent({ goal = '', message = '', taskInterpretation = null } = {}) {
  const interpreted = asObject(taskInterpretation);
  const requested = cleanMode(interpreted.execution_mode_request || interpreted.executionModeRequest || interpreted.execution_mode_hint || interpreted.executionModeHint || '', '');
  if (requested === 'hybrid_sidecar') return true;
  const text = `${goal || ''}\n${message || ''}`.toLowerCase();
  return /(review with another|second opinion|double-check|double check|critic sidecar|verifier sidecar|보조 에이전트|사이드카)/i.test(text);
}

function detectExplicitModeRequest({ goal = '', message = '', taskInterpretation = null } = {}) {
  const interpreted = asObject(taskInterpretation);
  const requested = cleanMode(interpreted.execution_mode_request || interpreted.executionModeRequest || interpreted.execution_mode_hint || interpreted.executionModeHint || interpreted.execution_mode || interpreted.executionMode || '', '');
  if (requested) return requested;
  const text = `${goal || ''}\n${message || ''}`.toLowerCase();
  if (/(single agent|single-agent|solo agent|혼자|단일 에이전트)/i.test(text)) return 'single_compiled';
  if (/(hybrid|sidecar|critic sidecar|verifier sidecar|보조|사이드카)/i.test(text)) return 'hybrid_sidecar';
  if (/(parallel|multi-agent|multi agent|team of agents|split the task|병렬|여러 에이전트|멀티 에이전트|팀으로)/i.test(text)) return 'multi_motif';
  return '';
}

function buildTaskFamilyKey(taskInterpretation = null) {
  const interpreted = asObject(taskInterpretation);
  const taskType = cleanText(interpreted.task_type || interpreted.taskType || '', { lower: true, maxLen: 64 });
  const deliverableType = cleanText(interpreted.deliverable_type || interpreted.deliverableType || '', { lower: true, maxLen: 64 });
  if (taskType && deliverableType) return `${taskType}::${deliverableType}`;
  return taskType || deliverableType || '';
}

function resolveTaskFamilyModeHint({ promotionSummary = null, taskInterpretation = null } = {}) {
  const summary = asObject(promotionSummary);
  const key = buildTaskFamilyKey(taskInterpretation);
  if (!key) return null;
  const profiles = asObject(summary.task_family_mode_profiles || summary.taskFamilyModeProfiles);
  const row = asObject(profiles[key]);
  const mode = cleanMode(row.recommended_mode || row.recommendedMode || row.stable_default_mode || row.stableDefaultMode || '', '');
  if (!mode) return null;
  return {
    task_family_key: key,
    mode,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : 0,
    sample_size: clampInt(row.sample_size || row.sampleSize || row.run_count || row.runCount || 0, { max: 9999 }),
    mode_support: clampInt(row.mode_support || row.modeSupport || 0, { max: 9999 }),
    source: cleanText(row.source || 'promotion_summary', { lower: true, maxLen: 64 }) || 'promotion_summary',
  };
}

function buildDecomposabilityScore({ taskInterpretation = null, routePlan = null } = {}) {
  const interpreted = asObject(taskInterpretation);
  const slots = asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots);
  const uniqueRoles = uniqueRoleIds(slots);
  const routeActions = asArray(asObject(routePlan).actions);
  let score = Math.max(0, uniqueRoles.length - 1) * 0.9;
  if (cleanText(interpreted.parallelism_preference || interpreted.parallelismPreference, { lower: true }) === 'parallel') score += 1.2;
  if (cleanText(interpreted.review_policy || interpreted.reviewPolicy, { lower: true }) === 'required') score += 0.9;
  if (cleanText(interpreted.deliverable_type || interpreted.deliverableType, { lower: true }).includes('brief')) score += 0.3;
  if (routeActions.some((action) => cleanText(action?.type, { lower: true }) === 'spawn_parallel')) score += 1.1;
  return {
    score,
    unique_role_count: uniqueRoles.length,
    slot_count: slots.length,
    role_ids: uniqueRoles,
  };
}


function round1(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.round(n * 10) / 10;
}

function uniqueTexts(values = [], { max = 8 } = {}) {
  return Array.from(new Set(asArray(values).map((entry) => cleanText(entry, { maxLen: 120 })).filter(Boolean))).slice(0, max);
}

function isCodeLikeTask(taskInterpretation = null) {
  const interpreted = asObject(taskInterpretation);
  const taskType = cleanText(interpreted.task_type || interpreted.taskType || '', { lower: true, maxLen: 64 });
  const deliverableType = cleanText(interpreted.deliverable_type || interpreted.deliverableType || '', { lower: true, maxLen: 64 });
  return ['code_change', 'implementation', 'workspace_change'].includes(taskType)
    || deliverableType.includes('patch')
    || deliverableType.includes('code')
    || deliverableType.includes('diff');
}

function hasPersistentReviewNeed(taskInterpretation = null) {
  const interpreted = asObject(taskInterpretation);
  const reviewPolicy = cleanText(interpreted.review_policy || interpreted.reviewPolicy || '', { lower: true, maxLen: 32 });
  if (reviewPolicy === 'required' || reviewPolicy === 'code_default') return true;
  const roles = new Set(uniqueRoleIds(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots));
  return roles.has('reviewer') && isCodeLikeTask(interpreted);
}

function summarizeCurrentQualitySignals(signals = null, qualitySignals = null, capabilityGaps = []) {
  const source = asObject(qualitySignals);
  const fallback = asObject(signals?.last_quality_signals || signals?.lastQualitySignals);
  const merged = Object.keys(source).length > 0 ? source : fallback;
  return {
    followup_burden: clampInt(merged.followup_burden || merged.followupBurden || signals?.followup_burden_runs, { max: 8 }),
    quality_gap: clampInt(merged.quality_gap || merged.qualityGap || signals?.quality_gap_runs, { max: 16 }),
    contradiction_pressure: clampInt(merged.contradiction_pressure || merged.contradictionPressure || signals?.contradiction_pressure_runs, { max: 16 }),
    quality_health_score: Number.isFinite(Number(merged.quality_health_score || merged.qualityHealthScore))
      ? Math.max(0, Math.min(1, Number(merged.quality_health_score || merged.qualityHealthScore)))
      : Math.max(0, Math.min(1, Number(signals?.last_quality_health_score || 0))),
    capability_gap_count: clampInt(merged.capability_gap_count || merged.capabilityGapCount || asArray(capabilityGaps).length, { max: 16 }),
  };
}

function buildAugmentationAssessment({ signals = null, taskInterpretation = null, qualitySignals = null, capabilityGaps = [] } = {}) {
  const interpreted = asObject(taskInterpretation);
  const quality = summarizeCurrentQualitySignals(signals, qualitySignals, capabilityGaps);
  let score = 0;
  const reasons = [];
  if (quality.capability_gap_count > 0) {
    score += Math.min(2.2, quality.capability_gap_count * 1.1);
    reasons.push('missing_capability_or_skill');
  }
  if (quality.quality_gap >= 1) {
    score += Math.min(1.8, 0.8 + quality.quality_gap * 0.5);
    reasons.push('quality_gap_present');
  }
  if (quality.followup_burden >= 1) {
    score += Math.min(1.6, 0.7 + quality.followup_burden * 0.4);
    reasons.push('followup_burden_present');
  }
  if (quality.contradiction_pressure >= 1) {
    score += Math.min(1.4, 0.5 + quality.contradiction_pressure * 0.3);
    reasons.push('contradiction_requires_better_context');
  }
  if (quality.quality_health_score > 0 && quality.quality_health_score < 0.7) {
    score += quality.quality_health_score < 0.45 ? 1.2 : 0.7;
    reasons.push('quality_health_low');
  }
  if (Number(signals?.participant_pressure || 0) >= 2) {
    score += 0.4;
    reasons.push('participant_noise_prefers_context_first');
  }
  if (cleanText(interpreted.review_policy || interpreted.reviewPolicy || '', { lower: true, maxLen: 32 }) === 'code_default' && isCodeLikeTask(interpreted)) {
    score += 0.4;
    reasons.push('code_task_can_start_with_inline_review_context');
  }
  return {
    score: round1(score),
    reasons: uniqueTexts(reasons),
    quality,
  };
}

function buildRoleSeparationAssessment({ signals = null, taskInterpretation = null } = {}) {
  const interpreted = asObject(taskInterpretation);
  const reviewPolicy = cleanText(interpreted.review_policy || interpreted.reviewPolicy || '', { lower: true, maxLen: 32 });
  const parallelPreference = cleanText(interpreted.parallelism_preference || interpreted.parallelismPreference || '', { lower: true, maxLen: 32 });
  const uniqueRoleCount = clampInt(signals?.unique_role_count, { max: 12 });
  let score = 0;
  const reasons = [];
  if (signals?.explicit_multi_intent === true) {
    score += 4.2;
    reasons.push('explicit_multi_intent');
  }
  if (signals?.explicit_hybrid_intent === true) {
    score += 2.4;
    reasons.push('explicit_hybrid_intent');
  }
  if (parallelPreference === 'parallel' && uniqueRoleCount >= 3) {
    score += 2.2;
    reasons.push('parallel_branching_value');
  }
  if (Number(signals?.decomposability_score || 0) >= 2.4) {
    score += 1.6;
    reasons.push('high_decomposability');
  } else if (Number(signals?.decomposability_score || 0) >= 1.6) {
    score += 0.9;
    reasons.push('moderate_decomposability');
  }
  if (reviewPolicy === 'required') {
    score += 1.6;
    reasons.push('independent_review_required');
  } else if (reviewPolicy === 'code_default' && isCodeLikeTask(interpreted)) {
    score += 1.1;
    reasons.push('code_review_benefits_from_sidecar');
  }
  if (uniqueRoleCount >= 3) {
    score += 0.8;
    reasons.push('multiple_durable_role_candidates');
  } else if (uniqueRoleCount >= 2) {
    score += 0.4;
    reasons.push('secondary_role_candidate_exists');
  }
  if (Number(signals?.contradiction_pressure_runs || 0) >= 2 && hasPersistentReviewNeed(interpreted)) {
    score += 0.8;
    reasons.push('independent_verification_is_worthwhile');
  }
  const independentReviewNeeded = reviewPolicy === 'required' || (reviewPolicy === 'code_default' && isCodeLikeTask(interpreted));
  const persistentSplitNeeded = parallelPreference === 'parallel' && uniqueRoleCount >= 3;
  return {
    score: round1(score),
    reasons: uniqueTexts(reasons),
    independent_review_needed: independentReviewNeeded,
    persistent_split_needed: persistentSplitNeeded,
  };
}

export function assessExecutionStrategy({
  goal = '',
  message = '',
  taskInterpretation = null,
  routePlan = null,
  runtime = null,
  runtimeSessionState = null,
  signals = null,
  qualitySignals = null,
  capabilityGaps = [],
} = {}) {
  const computedSignals = signals && typeof signals === 'object'
    ? { ...signals }
    : buildAdaptiveExecutionSignals({ goal, message, taskInterpretation, routePlan, runtime, runtimeSessionState });
  const augmentation = buildAugmentationAssessment({ signals: computedSignals, taskInterpretation, qualitySignals, capabilityGaps });
  const roleSeparation = buildRoleSeparationAssessment({ signals: computedSignals, taskInterpretation });
  let recommendation = 'keep_single';
  const rationale = [];
  if (roleSeparation.score >= 4.2 && (roleSeparation.persistent_split_needed || Number(computedSignals.failure_streak || 0) >= 1 || augmentation.quality.quality_gap >= 2)) {
    recommendation = 'expand_team';
    rationale.push('persistent_role_separation_has_clear_value');
  } else if (roleSeparation.score >= 2.6 && (roleSeparation.independent_review_needed || augmentation.quality.quality_gap >= 1 || augmentation.quality.contradiction_pressure >= 1 || augmentation.quality.capability_gap_count >= 1)) {
    recommendation = 'expand_team';
    rationale.push('independent_sidecar_is_justified');
  } else if (augmentation.score >= 1.2) {
    recommendation = 'augment_context';
    rationale.push('prefer_memory_skill_context_augmentation');
  } else {
    rationale.push('single_agent_path_is_adequate');
  }
  if (augmentation.score > roleSeparation.score + 0.7 && recommendation === 'expand_team') {
    recommendation = 'augment_context';
    rationale.length = 0;
    rationale.push('augmentation_outweighs_role_split');
  }
  return {
    signals: computedSignals,
    augmentation: {
      ...augmentation,
      preferred_action: 'augment_context',
    },
    role_separation: {
      ...roleSeparation,
      preferred_action: 'expand_team',
    },
    recommendation,
    rationale: uniqueTexts(rationale),
  };
}

export function buildAdaptiveExecutionSignals({
  goal = '',
  message = '',
  taskInterpretation = null,
  routePlan = null,
  runtime = null,
  runtimeSessionState = null,
} = {}) {
  const state = asObject(runtimeSessionState || runtime?.runtimeSessionState || runtime?.runtime_session_state);
  const adaptive = asObject(state.execution_state?.adaptive_execution || state.executionState?.adaptiveExecution);
  const participantSurface = asObject(state.observability_state?.participant_surface || state.observabilityState?.participantSurface);
  const participantKinds = countKinds(collectParticipantSignalKinds(runtime));
  const decomposability = buildDecomposabilityScore({ taskInterpretation, routePlan });
  const critiqueCount = Number(participantKinds.critique || 0) + Number(participantKinds.conflict_flag || 0) + Number(participantKinds.vote || 0);
  const participantPressure = critiqueCount + Math.min(3, clampInt(participantSurface.last_folded_count, { max: 8 })) + Math.min(2, clampInt(participantSurface.decision_log_size, { max: 24 }) > 2 ? 1 : 0);
  const latestQuality = asObject(adaptive.last_quality_signals || adaptive.lastQualitySignals);
  const modeHistoryTail = asArray(adaptive.mode_history || adaptive.modeHistory).slice(-5).map((entry) => {
    const item = asObject(entry);
    return {
      mode: cleanMode(item.mode || '', ''),
      status: cleanText(item.status || '', { lower: true, maxLen: 32 }) || undefined,
      followup_burden: clampInt(item.followup_burden || item.followupBurden, { max: 8 }),
      quality_gap: clampInt(item.quality_gap || item.qualityGap, { max: 16 }),
      contradiction_pressure: clampInt(item.contradiction_pressure || item.contradictionPressure, { max: 16 }),
      quality_health_score: Number.isFinite(Number(item.quality_health_score || item.qualityHealthScore)) ? Math.max(0, Math.min(1, Number(item.quality_health_score || item.qualityHealthScore))) : 0,
    };
  }).filter((entry) => entry.mode);
  return {
    explicit_multi_intent: hasExplicitMultiIntent({ goal, message, taskInterpretation }),
    explicit_hybrid_intent: hasExplicitHybridIntent({ goal, message, taskInterpretation }),
    explicit_mode_request: detectExplicitModeRequest({ goal, message, taskInterpretation }),
    task_family_key: buildTaskFamilyKey(taskInterpretation),
    decomposability_score: decomposability.score,
    unique_role_count: decomposability.unique_role_count,
    role_ids: decomposability.role_ids,
    participant_pressure: participantPressure,
    critique_signal_count: critiqueCount,
    failure_streak: clampInt(adaptive.failure_streak, { max: 8 }),
    success_streak: clampInt(adaptive.success_streak, { max: 8 }),
    capability_gap_runs: clampInt(adaptive.capability_gap_runs, { max: 8 }),
    await_user_streak: clampInt(adaptive.await_user_streak, { max: 8 }),
    followup_burden_runs: clampInt(adaptive.followup_burden_runs || adaptive.followupBurdenRuns, { max: 8 }),
    quality_gap_runs: clampInt(adaptive.quality_gap_runs || adaptive.qualityGapRuns, { max: 8 }),
    contradiction_pressure_runs: clampInt(adaptive.contradiction_pressure_runs || adaptive.contradictionPressureRuns, { max: 8 }),
    contradiction_resolved_runs: clampInt(adaptive.contradiction_resolved_runs || adaptive.contradictionResolvedRuns, { max: 8 }),
    last_quality_health_score: Number.isFinite(Number(latestQuality.quality_health_score || latestQuality.qualityHealthScore)) ? Math.max(0, Math.min(1, Number(latestQuality.quality_health_score || latestQuality.qualityHealthScore))) : 0,
    last_quality_signals: latestQuality,
    mode_history_tail: modeHistoryTail,
    current_mode: cleanMode(adaptive.current_mode || adaptive.currentMode || state.planner_state?.execution_mode || state.plannerState?.executionMode || 'single_compiled'),
    run_count: clampInt(adaptive.run_count || adaptive.runCount, { max: 99999 }),
  };
}

function choosePrimaryRole(taskInterpretation = null, preferredRoles = []) {
  const interpreted = asObject(taskInterpretation);
  const slots = asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots);
  const preferred = asArray(preferredRoles).map((entry) => cleanText(entry, { lower: true, maxLen: 64 })).filter(Boolean);
  const roleIds = uniqueRoleIds(slots);
  const roleSet = new Set(roleIds);
  for (const role of preferred) {
    if (roleSet.has(role)) return role;
  }
  const priority = ['builder', 'researcher', 'reviewer', 'synthesizer', 'operator'];
  for (const role of priority) {
    if (roleSet.has(role)) return role;
  }
  return roleIds[0] || 'researcher';
}

function buildSingleCompiledSlots(taskInterpretation = null, preferredRoles = []) {
  const interpreted = asObject(taskInterpretation);
  const slots = asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots);
  const primaryRole = choosePrimaryRole(interpreted, preferredRoles);
  const existing = slots.find((slot) => cleanText(slot?.role_id || slot?.roleId || slot?.role || '', { lower: true }) === primaryRole);
  return [
    existing
      ? { ...existing, selection_reason: cleanText(existing.selection_reason || existing.selectionReason || `execution_mode:${primaryRole}`, { maxLen: 160 }) || `execution_mode:${primaryRole}` }
      : { role_id: primaryRole, purpose: primaryRole, selection_reason: `execution_mode:${primaryRole}` },
  ];
}

function buildHybridSlots(taskInterpretation = null, preferredRoles = [], signals = null) {
  const interpreted = asObject(taskInterpretation);
  const primary = buildSingleCompiledSlots(interpreted, preferredRoles)[0];
  const slots = [primary];
  const roleIds = new Set(uniqueRoleIds(asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots)));
  const reviewPolicy = cleanText(interpreted.review_policy || interpreted.reviewPolicy, { lower: true });
  const sidecarRole = (
    (signals?.critique_signal_count || 0) > 0 || reviewPolicy === 'required' || reviewPolicy === 'code_default'
      ? (roleIds.has('reviewer') ? 'reviewer' : 'synthesizer')
      : (signals?.decomposability_score || 0) >= 1.2
        ? (roleIds.has('researcher') && cleanText(primary.role_id, { lower: true }) !== 'researcher' ? 'researcher' : (roleIds.has('synthesizer') ? 'synthesizer' : 'reviewer'))
        : ''
  );
  if (sidecarRole && cleanText(primary.role_id, { lower: true }) !== sidecarRole) {
    const existing = asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots)
      .find((slot) => cleanText(slot?.role_id || slot?.roleId || slot?.role || '', { lower: true }) === sidecarRole);
    slots.push(existing
      ? { ...existing, selection_reason: cleanText(existing.selection_reason || existing.selectionReason || `execution_mode_sidecar:${sidecarRole}`, { maxLen: 160 }) || `execution_mode_sidecar:${sidecarRole}` }
      : { role_id: sidecarRole, purpose: sidecarRole, selection_reason: `execution_mode_sidecar:${sidecarRole}` });
  }
  return slots.slice(0, 2);
}

function shouldDirectHybridStart({
  taskInterpretation = null,
  signals = null,
} = {}) {
  const interpreted = asObject(taskInterpretation);
  const reviewPolicy = cleanText(interpreted.review_policy || interpreted.reviewPolicy || '', { lower: true });
  const taskType = cleanText(interpreted.task_type || interpreted.taskType || '', { lower: true });
  const roleIds = new Set(uniqueRoleIds(asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots)));
  if (!roleIds.has('reviewer')) return false;
  if (reviewPolicy === 'code_default') return true;
  if (taskType === 'code_change' && (signals?.decomposability_score || 0) >= 0.9) return true;
  return false;
}

export function selectAdaptiveExecutionMode({
  goal = '',
  message = '',
  taskInterpretation = null,
  routePlan = null,
  preferredRoles = [],
  maxAgents = 6,
  runtime = null,
  runtimeBehavior = null,
  runtimePolicy = null,
  runtimeSessionState = null,
  promotionSummary = null,
} = {}) {
  const policy = readHarnessExecutionModePolicy(runtimeBehavior || runtimePolicy || runtime || null);
  const signals = buildAdaptiveExecutionSignals({ goal, message, taskInterpretation, routePlan, runtime, runtimeSessionState });
  const strategyAssessment = assessExecutionStrategy({ goal, message, taskInterpretation, routePlan, runtime, runtimeSessionState, signals });
  const enrichedSignals = {
    ...signals,
    augmentation_score: strategyAssessment.augmentation.score,
    augmentation_reasons: strategyAssessment.augmentation.reasons,
    role_separation_score: strategyAssessment.role_separation.score,
    role_separation_reasons: strategyAssessment.role_separation.reasons,
    strategy_recommendation: strategyAssessment.recommendation,
    independent_review_needed: strategyAssessment.role_separation.independent_review_needed,
    persistent_split_needed: strategyAssessment.role_separation.persistent_split_needed,
  };
  const taskFamilyModeHint = resolveTaskFamilyModeHint({ promotionSummary, taskInterpretation });
  const currentLevel = modeLevel(signals.current_mode || policy.default_mode);
  let nextLevel = modeLevel(policy.default_mode);
  const reasons = [];
  const initialStart = signals.run_count <= 0 && asArray(signals.mode_history_tail).length === 0;
  const explicitModeRequest = cleanMode(signals.explicit_mode_request || '', '');

  if (explicitModeRequest === 'multi_motif' && policy.respect_explicit_multi_intent && policy.allow_direct_multi_start) {
    nextLevel = 2;
    reasons.push('explicit_mode_request_multi');
  } else if (explicitModeRequest === 'hybrid_sidecar' && policy.respect_explicit_hybrid_intent && policy.allow_direct_hybrid_start) {
    nextLevel = 1;
    reasons.push('explicit_mode_request_hybrid');
  } else if (explicitModeRequest === 'single_compiled') {
    nextLevel = 0;
    reasons.push('explicit_mode_request_single');
  } else if (signals.explicit_multi_intent && policy.respect_explicit_multi_intent && policy.allow_direct_multi_start) {
    nextLevel = 2;
    reasons.push('explicit_multi_intent');
  } else if (signals.explicit_hybrid_intent && policy.respect_explicit_hybrid_intent && policy.allow_direct_hybrid_start && initialStart) {
    nextLevel = 1;
    reasons.push('explicit_hybrid_intent');
  } else if (initialStart && taskFamilyModeHint && policy.respect_task_family_default && Number(taskFamilyModeHint.confidence || 0) >= Number(policy.task_family_confidence_threshold || 0.62)) {
    nextLevel = modeLevel(taskFamilyModeHint.mode);
    reasons.push('task_family_default_mode');
  } else if (!policy.auto_escalation_enabled) {
    nextLevel = modeLevel(policy.default_mode);
    reasons.push('auto_escalation_disabled');
  } else {
    nextLevel = currentLevel;
    const highFailure = signals.failure_streak >= policy.failure_streak_threshold;
    const highGap = signals.capability_gap_runs >= policy.capability_gap_threshold;
    const highParticipant = signals.participant_pressure >= policy.participant_pressure_threshold;
    const highDecomp = signals.decomposability_score >= policy.decomposability_threshold;
    const moderateDecomp = signals.decomposability_score >= Math.max(0.8, policy.decomposability_threshold - 0.8);
    const highFollowup = signals.followup_burden_runs >= policy.followup_burden_threshold;
    const highQualityGap = signals.quality_gap_runs >= policy.quality_gap_threshold || (signals.last_quality_health_score > 0 && signals.last_quality_health_score < policy.min_quality_health_score);
    const highContradiction = signals.contradiction_pressure_runs >= policy.contradiction_pressure_threshold;

    if (currentLevel <= 0) {
      if (initialStart && policy.allow_direct_multi_start && highDecomp && signals.unique_role_count >= 3 && cleanText(taskInterpretation?.parallelism_preference || taskInterpretation?.parallelismPreference, { lower: true }) === 'parallel') {
        nextLevel = 2;
        reasons.push('direct_multi_start_structure');
      } else if (initialStart && policy.allow_direct_hybrid_start && shouldDirectHybridStart({ taskInterpretation, signals })) {
        nextLevel = Math.max(nextLevel, 1);
        reasons.push('direct_hybrid_start_review_policy');
      } else if (initialStart && policy.allow_direct_hybrid_start && signals.explicit_hybrid_intent && policy.respect_explicit_hybrid_intent) {
        nextLevel = Math.max(nextLevel, 1);
        reasons.push('direct_hybrid_start_structure');
      }
      if (highFailure || highGap || highParticipant || highFollowup || highQualityGap || highContradiction) {
        nextLevel = Math.max(nextLevel, 1);
        reasons.push('single_to_hybrid_pressure');
      }
      if (highFailure && (highParticipant || highDecomp || highGap || highQualityGap || highFollowup)) {
        nextLevel = 2;
        reasons.push('direct_multi_escalation');
      }
    } else if (currentLevel === 1) {
      if (highFailure || (highParticipant && highDecomp) || (highGap && moderateDecomp) || (highQualityGap && (highDecomp || highContradiction || highParticipant)) || (highFollowup && (highParticipant || highDecomp))) {
        nextLevel = 2;
        reasons.push('hybrid_to_multi_pressure');
      } else if (policy.auto_deescalation_enabled && signals.success_streak >= policy.success_cooldown_turns && !highParticipant && !highGap && !highFollowup && !highQualityGap && !highContradiction) {
        nextLevel = 0;
        reasons.push('hybrid_deescalation_after_success');
      }
    } else if (currentLevel >= 2) {
      if (policy.auto_deescalation_enabled && signals.success_streak >= policy.success_cooldown_turns && !highFailure && !highGap && !highFollowup && !highQualityGap && signals.participant_pressure < policy.participant_pressure_threshold) {
        nextLevel = 1;
        reasons.push('multi_to_hybrid_cooldown');
      }
    }
    if (reasons.length === 0) reasons.push('keep_current_mode');
  }

  const mode = levelMode(nextLevel);
  let shapedSlots = asArray(taskInterpretation?.candidate_capability_slots || taskInterpretation?.candidateCapabilitySlots);
  let shapedMaxAgents = Math.max(1, Math.floor(Number(maxAgents) || 6));
  if (mode === 'single_compiled') {
    shapedSlots = buildSingleCompiledSlots(taskInterpretation, preferredRoles);
    shapedMaxAgents = 1;
  } else if (mode === 'hybrid_sidecar') {
    shapedSlots = buildHybridSlots(taskInterpretation, preferredRoles, signals);
    shapedMaxAgents = Math.min(Math.max(2, shapedSlots.length), Math.max(2, Math.floor(Number(maxAgents) || 6), 2));
    shapedMaxAgents = Math.min(shapedMaxAgents, 3);
  }

  return {
    ok: true,
    mode,
    escalation_level: nextLevel,
    policy,
    signals: enrichedSignals,
    reasons,
    history_tail: asArray(signals.mode_history_tail).slice(-5),
    quality_signals: asObject(signals.last_quality_signals),
    strategy_assessment: strategyAssessment,
    task_family_mode_hint: taskFamilyModeHint,
    max_agents: shapedMaxAgents,
    shaped_candidate_capability_slots: shapedSlots,
  };
}

export function applyAdaptiveExecutionModeToTaskInterpretation(taskInterpretation = null, selection = null) {
  const interpreted = asObject(taskInterpretation);
  const row = asObject(selection);
  const mode = cleanMode(row.mode || interpreted.execution_mode || interpreted.executionMode || 'single_compiled');
  const slots = asArray(row.shaped_candidate_capability_slots).length > 0
    ? asArray(row.shaped_candidate_capability_slots)
    : asArray(interpreted.candidate_capability_slots || interpreted.candidateCapabilitySlots);
  const next = {
    ...interpreted,
    candidate_capability_slots: slots,
    execution_mode: mode,
    execution_mode_reason: asArray(row.reasons).join(',') || undefined,
  };
  if (mode === 'single_compiled') {
    next.parallelism_preference = 'serial';
  } else if (mode === 'hybrid_sidecar' && !cleanText(next.parallelism_preference, { lower: true })) {
    next.parallelism_preference = 'serial';
  }
  return next;
}

function summarizeModeSignals(signals = null) {
  const row = asObject(signals);
  return {
    participant_pressure: clampInt(row.participant_pressure, { max: 32 }),
    critique_signal_count: clampInt(row.critique_signal_count, { max: 32 }),
    failure_streak: clampInt(row.failure_streak, { max: 32 }),
    success_streak: clampInt(row.success_streak, { max: 32 }),
    capability_gap_runs: clampInt(row.capability_gap_runs, { max: 32 }),
    followup_burden_runs: clampInt(row.followup_burden_runs || row.followupBurdenRuns, { max: 32 }),
    quality_gap_runs: clampInt(row.quality_gap_runs || row.qualityGapRuns, { max: 32 }),
    contradiction_pressure_runs: clampInt(row.contradiction_pressure_runs || row.contradictionPressureRuns, { max: 32 }),
    last_quality_health_score: Number.isFinite(Number(row.last_quality_health_score || row.lastQualityHealthScore)) ? Math.round(Math.max(0, Math.min(1, Number(row.last_quality_health_score || row.lastQualityHealthScore))) * 10) / 10 : 0,
    decomposability_score: Number.isFinite(Number(row.decomposability_score)) ? Math.round(Number(row.decomposability_score) * 10) / 10 : 0,
    augmentation_score: Number.isFinite(Number(row.augmentation_score || row.augmentationScore)) ? Math.round(Number(row.augmentation_score || row.augmentationScore) * 10) / 10 : 0,
    role_separation_score: Number.isFinite(Number(row.role_separation_score || row.roleSeparationScore)) ? Math.round(Number(row.role_separation_score || row.roleSeparationScore) * 10) / 10 : 0,
    strategy_recommendation: cleanText(row.strategy_recommendation || row.strategyRecommendation || '', { lower: true, maxLen: 64 }) || undefined,
    explicit_multi_intent: row.explicit_multi_intent === true,
    explicit_hybrid_intent: row.explicit_hybrid_intent === true,
    task_family_key: cleanText(row.task_family_key || row.taskFamilyKey || '', { lower: true, maxLen: 96 }) || undefined,
  };
}

export function recordAdaptiveExecutionOutcome({
  runtime = null,
  status = 'done',
  plannerMetadata = null,
  capabilityGapCount = 0,
  qualitySignals = null,
} = {}) {
  const target = asObject(runtime);
  const planner = asObject(plannerMetadata || target.plannerMetadata || target.planner_metadata || target.runtimeSessionState?.planner_state || {});
  const state = asObject(target.runtimeSessionState || target.runtime_session_state);
  const current = asObject(state.execution_state?.adaptive_execution || state.executionState?.adaptiveExecution);
  const mode = cleanMode(planner.execution_mode || planner.executionMode || current.current_mode || 'single_compiled');
  const lastSignals = summarizeModeSignals(planner.execution_mode_signals || planner.executionModeSignals || current.last_signals || {});
  const quality = asObject(qualitySignals);
  const strategyAssessment = assessExecutionStrategy({
    taskInterpretation: asObject(target.runtimeTeamSnapshot?.team_plan?.task_interpretation || target.runtime_team_snapshot?.team_plan?.task_interpretation || planner.task_interpretation || planner.taskInterpretation),
    runtime: target,
    runtimeSessionState: state,
    signals: { ...lastSignals, current_mode: mode, failure_streak: current.failure_streak, followup_burden_runs: current.followup_burden_runs, quality_gap_runs: current.quality_gap_runs, contradiction_pressure_runs: current.contradiction_pressure_runs, explicit_multi_intent: lastSignals.explicit_multi_intent, explicit_hybrid_intent: lastSignals.explicit_hybrid_intent, unique_role_count: current.unique_role_count || lastSignals.unique_role_count, decomposability_score: lastSignals.decomposability_score },
    qualitySignals: quality,
    capabilityGaps: Array.from({ length: clampInt(quality.capability_gap_count || quality.capabilityGapCount || capabilityGapCount, { max: 8 }) }, (_, idx) => ({ kind: `gap_${idx + 1}` })),
  });
  const summarizedQuality = {
    followup_burden: clampInt(quality.followup_burden || quality.followupBurden, { max: 8 }),
    quality_gap: clampInt(quality.quality_gap || quality.qualityGap, { max: 16 }),
    contradiction_pressure: clampInt(quality.contradiction_pressure || quality.contradictionPressure, { max: 16 }),
    contradiction_resolved: quality.contradiction_resolved === true || quality.contradictionResolved === true,
    quality_health_score: Number.isFinite(Number(quality.quality_health_score || quality.qualityHealthScore)) ? Math.max(0, Math.min(1, Number(quality.quality_health_score || quality.qualityHealthScore))) : 0,
    retry_count: clampInt(quality.retry_count || quality.retryCount, { max: 16 }),
    capability_gap_count: clampInt(quality.capability_gap_count || quality.capabilityGapCount || capabilityGapCount, { max: 16 }),
    quality_tags: asArray(quality.quality_tags || quality.qualityTags).map((entry) => cleanText(entry, { lower: true, maxLen: 64 })).filter(Boolean).slice(0, 12),
  };
  const currentHistory = asArray(current.mode_history || current.modeHistory).filter((entry) => entry && typeof entry === 'object').slice(-7);
  const next = {
    current_mode: mode,
    last_mode: cleanMode(current.current_mode || current.currentMode || mode),
    escalation_level: modeLevel(mode),
    last_status: cleanText(status, { lower: true, maxLen: 32 }) || 'done',
    last_signals: { ...lastSignals, augmentation_score: strategyAssessment.augmentation.score, role_separation_score: strategyAssessment.role_separation.score, strategy_recommendation: strategyAssessment.recommendation },
    last_quality_signals: { ...summarizedQuality, strategy_recommendation: strategyAssessment.recommendation },
    failure_streak: clampInt(current.failure_streak, { max: 16 }),
    success_streak: clampInt(current.success_streak, { max: 16 }),
    capability_gap_runs: clampInt(current.capability_gap_runs, { max: 16 }),
    await_user_streak: clampInt(current.await_user_streak, { max: 16 }),
    followup_burden_runs: clampInt(current.followup_burden_runs || current.followupBurdenRuns, { max: 16 }),
    quality_gap_runs: clampInt(current.quality_gap_runs || current.qualityGapRuns, { max: 16 }),
    contradiction_pressure_runs: clampInt(current.contradiction_pressure_runs || current.contradictionPressureRuns, { max: 16 }),
    contradiction_resolved_runs: clampInt(current.contradiction_resolved_runs || current.contradictionResolvedRuns, { max: 16 }),
    run_count: clampInt(current.run_count, { max: 9999 }) + 1,
    mode_history: currentHistory,
  };
  if (status === 'done') {
    next.success_streak += 1;
    next.failure_streak = 0;
    next.await_user_streak = 0;
    next.capability_gap_runs = summarizedQuality.capability_gap_count > 0 ? Math.min(16, next.capability_gap_runs + 1) : 0;
  } else if (status === 'await_user') {
    next.await_user_streak += 1;
    next.success_streak = 0;
    next.failure_streak = 0;
    next.capability_gap_runs = summarizedQuality.capability_gap_count > 0 ? Math.min(16, next.capability_gap_runs + 1) : next.capability_gap_runs;
  } else {
    next.failure_streak += 1;
    next.success_streak = 0;
    next.await_user_streak = 0;
    next.capability_gap_runs = summarizedQuality.capability_gap_count > 0 ? Math.min(16, next.capability_gap_runs + 1) : next.capability_gap_runs;
  }
  next.followup_burden_runs = summarizedQuality.followup_burden > 0 ? Math.min(16, next.followup_burden_runs + 1) : 0;
  next.quality_gap_runs = summarizedQuality.quality_gap > 0 ? Math.min(16, next.quality_gap_runs + 1) : 0;
  next.contradiction_pressure_runs = summarizedQuality.contradiction_pressure > 0 && !summarizedQuality.contradiction_resolved ? Math.min(16, next.contradiction_pressure_runs + 1) : 0;
  next.contradiction_resolved_runs = summarizedQuality.contradiction_resolved ? Math.min(16, next.contradiction_resolved_runs + 1) : 0;
  next.mode_history = [...currentHistory, {
    ts: new Date().toISOString(),
    mode,
    status: cleanText(status, { lower: true, maxLen: 32 }) || 'done',
    followup_burden: summarizedQuality.followup_burden,
    quality_gap: summarizedQuality.quality_gap,
    contradiction_pressure: summarizedQuality.contradiction_pressure,
    quality_health_score: summarizedQuality.quality_health_score,
  }].slice(-8);
  syncRuntimeExecutionState(target, {
    adaptive_execution: next,
  });
  return target.runtimeSessionState?.execution_state?.adaptive_execution || target.runtime_session_state?.execution_state?.adaptive_execution || next;
}
