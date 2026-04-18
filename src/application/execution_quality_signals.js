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
function clampInt(value, { min = 0, max = 16, fallback = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}
function round1(value = 0) {
  return Math.round(Number(value || 0) * 10) / 10;
}
function collectParticipantKinds(runtime = null) {
  const target = asObject(runtime);
  const history = asArray(target.participantContributionHistory || target.participant_contribution_history || target.participantContributionDecisionLog || target.participant_contribution_decision_log);
  const out = [];
  for (const row of history.slice(-16)) {
    const kind = cleanText(row?.contribution?.kind || row?.kind || '', { lower: true, maxLen: 64 });
    if (kind) out.push(kind);
  }
  return out;
}
function countMatching(values = [], matcher = () => false) {
  let count = 0;
  for (const value of asArray(values)) if (matcher(value)) count += 1;
  return count;
}
function detectRetryCount(execution = null) {
  const row = asObject(execution);
  return asArray(row.results).filter((item) => {
    const label = cleanText(item?.label || '', { lower: true, maxLen: 160 });
    const note = cleanText(item?.note || '', { lower: true, maxLen: 220 });
    return /retry/.test(label) || /retry/.test(note) || /recovered/.test(note);
  }).length;
}
function extractQualityTags(routePlan = null, execution = null) {
  const route = asObject(routePlan);
  const outcome = asObject(execution);
  const tags = [];
  const push = (value) => {
    const clean = cleanText(value, { lower: true, maxLen: 64 });
    if (clean && !tags.includes(clean)) tags.push(clean);
  };
  for (const entry of [
    ...(asArray(route.quality_signals || route.qualitySignals)),
    ...(asArray(route.route_signals || route.routeSignals)),
    ...(asArray(outcome.quality_signals || outcome.qualitySignals)),
  ]) push(entry);
  return tags.slice(0, 12);
}
export function buildExecutionQualitySignals({
  status = 'done',
  routePlan = null,
  execution = null,
  executionInsights = null,
  executionFeedback = null,
  runtime = null,
  runtimeSessionState = null,
  capabilityGapCount = 0,
} = {}) {
  const cleanStatus = cleanText(status, { lower: true, maxLen: 32 }) || 'done';
  const route = asObject(routePlan);
  const outcome = asObject(execution);
  const insights = asObject(executionInsights?.execution || executionInsights);
  const feedbackSummary = asObject(executionFeedback?.summary || executionFeedback);
  const feedbackPattern = asObject(asArray(feedbackSummary.patterns)[0]);
  const state = asObject(runtimeSessionState || runtime?.runtimeSessionState || runtime?.runtime_session_state);
  const participantSurface = asObject(state?.observability_state?.participant_surface || state?.observabilityState?.participantSurface);
  const participantKinds = collectParticipantKinds(runtime);
  const contradictionPressure = countMatching(participantKinds, (kind) => ['critique', 'conflict_flag', 'vote'].includes(cleanText(kind, { lower: true, maxLen: 64 })))
    + Math.min(2, clampInt(participantSurface.last_folded_count, { max: 8 }));
  const retryCount = detectRetryCount(outcome);
  const missingAgentCount = clampInt(insights.missing_agent_count || insights.missingAgentCount || feedbackPattern.avg_missing_agents || 0, { max: 8 });
  const pendingApproval = outcome.pendingApproval != null || outcome.pending_approval != null;
  const userFollowupRequired = cleanStatus === 'await_user' || route.await_user === true || route.awaitUser === true || pendingApproval;
  const followupBurden = clampInt((userFollowupRequired ? 1 : 0) + (pendingApproval ? 1 : 0), { max: 4 });
  const qualityTags = extractQualityTags(routePlan, execution);
  const qualityGap = clampInt(
    capabilityGapCount
      + retryCount
      + missingAgentCount
      + (qualityTags.some((tag) => ['needs_more_research', 'needs_more_revision', 'quality_gap_remaining', 'evidence_gap_remaining', 'verification_failed', 'not_ready_yet'].includes(tag)) ? 1 : 0)
      + (userFollowupRequired ? 1 : 0),
    { max: 12 }
  );
  const participationPct = Number(insights.participation_pct || insights.participationPct || feedbackPattern.avg_participation_pct || 0);
  const contradictionResolved = contradictionPressure > 0 && cleanStatus === 'done' && qualityGap === 0 && capabilityGapCount === 0;
  const qualityHealthScore = clamp01(
    (Math.max(0, Math.min(100, participationPct)) / 100) * 0.6
      + (cleanStatus === 'done' ? 0.25 : cleanStatus === 'await_user' ? 0.1 : 0)
      - Math.min(0.35, qualityGap * 0.08)
      - Math.min(0.2, followupBurden * 0.08),
    0,
  );
  return {
    status: cleanStatus,
    participation_pct: round1(participationPct),
    user_followup_required: userFollowupRequired,
    pending_approval: pendingApproval,
    followup_burden: followupBurden,
    contradiction_pressure: contradictionPressure,
    contradiction_resolved: contradictionResolved,
    retry_count: retryCount,
    missing_agent_count: missingAgentCount,
    capability_gap_count: clampInt(capabilityGapCount, { max: 16 }),
    quality_gap: qualityGap,
    quality_health_score: round1(qualityHealthScore),
    quality_tags: qualityTags,
  };
}
