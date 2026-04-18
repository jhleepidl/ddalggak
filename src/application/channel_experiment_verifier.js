import fs from 'node:fs';
import path from 'node:path';

import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';

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

function cleanId(value = '', fallback = 'stable') {
  const text = cleanText(value, { lower: true, maxLen: 64 });
  if (!text) return fallback;
  return text.replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function round1(value = 0) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function safeAppendJsonl(filePath = '', row = {}) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

function safeReadJson(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeReadJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function uniqTextList(values = [], { max = 16, lower = true } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(values)) {
    const text = cleanText(entry, { lower, maxLen: 96 });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function summarizeDecisionActions(runtimeSessionState = null) {
  const state = asObject(runtimeSessionState);
  const actions = {};
  const log = asArray(state.participant_decisions || state.participantDecisionLog || []);
  for (const row of log) {
    const action = cleanText(row?.action, { lower: true, maxLen: 64 });
    if (!action) continue;
    actions[action] = (actions[action] || 0) + 1;
  }
  return actions;
}

function extractDecisionLog(runtime = null) {
  const target = asObject(runtime);
  return asArray(target.participantContributionDecisionLog || target.participant_contribution_decision_log || target?.runtimeSessionState?.participant_decisions || []);
}

function classifyMotifRecommendation({ channel = 'stable', status = 'done', participationPct = 0, score = 0, selectedMotifIds = [], qualitySignals = null } = {}) {
  const cleanChannel = cleanId(channel, 'stable');
  const cleanStatus = cleanText(status, { lower: true, maxLen: 32 }) || 'done';
  const hasMotifs = asArray(selectedMotifIds).length > 0;
  if (cleanChannel === 'candidate') {
    if (hasMotifs && cleanStatus === 'done' && participationPct >= 75 && score >= 0.6) {
      return { recommendation: 'promote_to_stable', next_channel: 'stable', rationale: `done run with participation ${round1(participationPct)}% and score ${round1(score)}` };
    }
    if (cleanStatus === 'error' || participationPct < 45 || score < 0.2) {
      return { recommendation: 'rollback_candidate', next_channel: 'stable', rationale: `candidate motif underperformed (status=${cleanStatus}, participation=${round1(participationPct)}%, score=${round1(score)})` };
    }
    return { recommendation: 'hold_candidate', next_channel: 'candidate', rationale: `candidate motif needs more evidence (status=${cleanStatus}, participation=${round1(participationPct)}%, score=${round1(score)})` };
  }
  if (cleanStatus === 'error' && participationPct < 45) {
    return { recommendation: 'review_stable', next_channel: 'stable', rationale: `stable motif requires review after low participation ${round1(participationPct)}%` };
  }
  return { recommendation: 'keep_stable', next_channel: 'stable', rationale: `stable motif remains active (status=${cleanStatus}, participation=${round1(participationPct)}%, score=${round1(score)})` };
}

function classifyParticipantRecommendation({ channel = 'stable', status = 'done', foldedCount = 0, decisionLogSize = 0, surfacedCount = 0, surfacedSharePct = 0, signalKinds = [], qualitySignals = null } = {}) {
  const cleanChannel = cleanId(channel, 'stable');
  const cleanStatus = cleanText(status, { lower: true, maxLen: 32 }) || 'done';
  const hasUsefulKinds = asArray(signalKinds).some((kind) => ['critique', 'evidence', 'summary', 'conflict_flag', 'hint'].includes(cleanText(kind, { lower: true, maxLen: 64 })));
  if (cleanChannel === 'candidate') {
    if (cleanStatus === 'done' && foldedCount >= 1 && hasUsefulKinds && surfacedSharePct <= 35) {
      return { recommendation: 'promote_to_stable', next_channel: 'stable', rationale: `folded signals helped without over-surfacing (${foldedCount} folded, ${surfacedCount} surfaced)` };
    }
    if (cleanStatus === 'error' || surfacedSharePct >= 60) {
      return { recommendation: 'rollback_candidate', next_channel: 'stable', rationale: `candidate participant policy was too noisy or unstable (${surfacedSharePct}% surfaced share)` };
    }
    return { recommendation: 'hold_candidate', next_channel: 'candidate', rationale: `candidate participant policy needs more evidence (${decisionLogSize} decisions, ${foldedCount} folded)` };
  }
  if (cleanStatus === 'error' && surfacedSharePct >= 60) {
    return { recommendation: 'review_stable', next_channel: 'stable', rationale: `stable participant policy may be too noisy (${surfacedSharePct}% surfaced share)` };
  }
  return { recommendation: 'keep_stable', next_channel: 'stable', rationale: `stable participant policy remains active (${decisionLogSize} decisions)` };
}

export function buildChannelExperimentVerificationRecord({
  runId = '',
  goal = '',
  status = 'done',
  runtimePolicy = null,
  runtimeBehavior = null,
  plannerMetadata = null,
  runtimeTeamSnapshot = null,
  executionInsights = null,
  executionFeedback = null,
  executionQualitySignals = null,
  runtimeSessionState = null,
  runtime = null,
} = {}) {
  const behavior = runtimeBehavior && typeof runtimeBehavior === 'object'
    ? runtimeBehavior
    : ensureRuntimeBehavior({}, { runtimePolicy: runtimePolicy || runtime || null });
  const planner = asObject(plannerMetadata || runtimeTeamSnapshot?.team_plan?.planner_metadata || runtimeTeamSnapshot?.team_plan?.plannerMetadata || {});
  const sessionState = asObject(runtimeSessionState || runtime?.runtimeSessionState || runtime?.runtime_session_state || {});
  const execution = asObject(executionInsights?.execution);
  const feedbackSummary = asObject(executionFeedback?.summary);
  const patternSummary = asObject(asArray(feedbackSummary.patterns)[0]);
  const decisionLog = extractDecisionLog(runtime);
  const observability = asObject(sessionState.observability_state || sessionState.observabilityState);
  const participantSurface = asObject(observability.participant_surface || observability.participantSurface);
  const actionCounts = summarizeDecisionActions({ participant_decisions: decisionLog });
  const surfacedCount = Number(actionCounts.surface_to_human || 0) + Number(actionCounts.surface_reply_only || 0) + Number(actionCounts.surface_to_runtime || 0);
  const decisionLogSize = decisionLog.length || Number(sessionState?.participant_state?.decision_log_size || sessionState?.participantState?.decisionLogSize || 0) || 0;
  const foldedCount = Number(participantSurface.last_folded_count || 0);
  const signalKinds = uniqTextList(decisionLog.map((row) => row?.kind || ''), { max: 12, lower: true });
  const participationPct = Number(execution.participation_pct || execution.participationPct || patternSummary.avg_participation_pct || 0);
  const score = cleanText(status, { lower: true, maxLen: 32 }) === 'done'
    ? round1((Math.min(1, Math.max(0, participationPct / 100)) * 0.6) + 0.4)
    : cleanText(status, { lower: true, maxLen: 32 }) === 'await_user'
      ? round1((Math.min(1, Math.max(0, participationPct / 100)) * 0.5) + 0.1)
      : round1(Math.min(1, Math.max(0, participationPct / 100)) * 0.2);
  const surfacedSharePct = decisionLogSize > 0 ? round1((surfacedCount / decisionLogSize) * 100) : 0;
  const motifChannel = cleanId(behavior?.motif?.channel || planner.motif_channel || planner.motifChannel || 'stable', 'stable');
  const participantChannel = cleanId(behavior?.participant?.policy_channel || 'stable', 'stable');
  const selectedMotifIds = uniqTextList(planner.selected_motif_ids || planner.selectedMotifIds || [], { max: 12, lower: true });
  const qualitySignals = asObject(
    executionQualitySignals
    || executionFeedback?.summary?.quality_signals
    || executionFeedback?.quality_signals
    || sessionState?.execution_state?.adaptive_execution?.last_quality_signals
    || sessionState?.executionState?.adaptiveExecution?.lastQualitySignals
  );
  const executionMode = cleanId(planner.execution_mode || planner.executionMode || 'single_compiled', 'single_compiled');
  const taskType = cleanId(planner.task_type || planner.taskType || '', '');
  const deliverableType = cleanId(planner.deliverable_type || planner.deliverableType || '', '');
  const taskFamilyKey = cleanText(
    planner.task_family_key
      || planner.taskFamilyKey
      || (taskType && deliverableType ? `${taskType}::${deliverableType}` : (taskType || deliverableType || '')),
    { lower: true, maxLen: 120 },
  ) || undefined;
  const motifDecision = classifyMotifRecommendation({
    channel: motifChannel,
    status,
    participationPct,
    score,
    selectedMotifIds,
    qualitySignals,
  });
  const participantDecision = classifyParticipantRecommendation({
    channel: participantChannel,
    status,
    foldedCount,
    decisionLogSize,
    surfacedCount,
    surfacedSharePct,
    signalKinds,
    qualitySignals,
  });
  const overallRecommendation = [motifDecision.recommendation, participantDecision.recommendation].includes('rollback_candidate')
    ? 'rollback_candidate'
    : [motifDecision.recommendation, participantDecision.recommendation].includes('promote_to_stable')
      ? 'promote_to_stable'
      : [motifDecision.recommendation, participantDecision.recommendation].includes('review_stable')
        ? 'review_stable'
        : 'hold';
  return {
    ts: new Date().toISOString(),
    run_id: cleanText(runId, { maxLen: 128 }) || undefined,
    goal_excerpt: cleanText(goal, { maxLen: 280 }) || undefined,
    status: cleanText(status, { lower: true, maxLen: 32 }) || 'done',
    execution_mode: executionMode,
    task_type: taskType || undefined,
    deliverable_type: deliverableType || undefined,
    task_family_key: taskFamilyKey,
    execution_pattern: cleanText(executionInsights?.execution_pattern || runtimeTeamSnapshot?.execution_graph?.pattern || '', { lower: true, maxLen: 64 }) || undefined,
    participation_pct: participationPct,
    score,
    quality_signals: qualitySignals,
    motif: {
      channel: motifChannel,
      selected_motif_ids: selectedMotifIds,
      motif_feedback_run_count: Number(planner.motif_feedback_run_count || planner.motifFeedbackRunCount || 0) || 0,
      registry_motif_count: Number(planner.registry_motif_count || planner.registryMotifCount || 0) || 0,
      recommendation: motifDecision.recommendation,
      next_channel: motifDecision.next_channel,
      rationale: motifDecision.rationale,
    },
    participant_policy: {
      channel: participantChannel,
      decision_log_size: decisionLogSize,
      folded_count: foldedCount,
      surfaced_count: surfacedCount,
      surfaced_share_pct: surfacedSharePct,
      signal_kinds: signalKinds,
      recommendation: participantDecision.recommendation,
      next_channel: participantDecision.next_channel,
      rationale: participantDecision.rationale,
    },
    overall_recommendation: overallRecommendation,
  };
}

export function summarizeChannelExperimentVerifications(records = []) {
  const rows = asArray(records).filter((row) => row && typeof row === 'object');
  const summary = {
    updated_at: new Date().toISOString(),
    run_count: rows.length,
    overall_counts: {},
    motif: {
      stable: { run_count: 0, recommendations: {} },
      candidate: { run_count: 0, recommendations: {} },
    },
    participant_policy: {
      stable: { run_count: 0, recommendations: {} },
      candidate: { run_count: 0, recommendations: {} },
    },
    latest: null,
    recommended_promotions: {
      motif: [],
      participant_policy: [],
    },
  };
  for (const row of rows) {
    const overall = cleanId(row.overall_recommendation || 'hold', 'hold');
    summary.overall_counts[overall] = (summary.overall_counts[overall] || 0) + 1;
    const motifChannel = cleanId(row?.motif?.channel || 'stable', 'stable');
    const motifRecommendation = cleanId(row?.motif?.recommendation || 'keep_stable', 'keep_stable');
    summary.motif[motifChannel].run_count += 1;
    summary.motif[motifChannel].recommendations[motifRecommendation] = (summary.motif[motifChannel].recommendations[motifRecommendation] || 0) + 1;
    const participantChannel = cleanId(row?.participant_policy?.channel || 'stable', 'stable');
    const participantRecommendation = cleanId(row?.participant_policy?.recommendation || 'keep_stable', 'keep_stable');
    summary.participant_policy[participantChannel].run_count += 1;
    summary.participant_policy[participantChannel].recommendations[participantRecommendation] = (summary.participant_policy[participantChannel].recommendations[participantRecommendation] || 0) + 1;
    if (motifRecommendation === 'promote_to_stable') {
      summary.recommended_promotions.motif.push({
        run_id: row.run_id,
        selected_motif_ids: asArray(row?.motif?.selected_motif_ids).slice(0, 12),
        rationale: row?.motif?.rationale,
      });
    }
    if (participantRecommendation === 'promote_to_stable') {
      summary.recommended_promotions.participant_policy.push({
        run_id: row.run_id,
        channel: participantChannel,
        rationale: row?.participant_policy?.rationale,
      });
    }
  }
  summary.latest = rows.length > 0 ? rows[rows.length - 1] : null;
  summary.recommended_promotions.motif = summary.recommended_promotions.motif.slice(-8);
  summary.recommended_promotions.participant_policy = summary.recommended_promotions.participant_policy.slice(-8);
  return summary;
}

export function channelExperimentVerificationPaths({ runsDir = '', jobDir = '' } = {}) {
  const cleanRunsDir = cleanText(runsDir, { maxLen: 512 });
  const cleanJobDir = cleanText(jobDir, { maxLen: 512 });
  return {
    globalJsonl: cleanRunsDir ? path.join(cleanRunsDir, 'channel_experiment_verifier.jsonl') : '',
    globalSummary: cleanRunsDir ? path.join(cleanRunsDir, 'channel_experiment_verifier_summary.json') : '',
    jobJsonl: cleanJobDir ? path.join(cleanJobDir, 'channel_experiment_verifier.jsonl') : '',
    jobSummary: cleanJobDir ? path.join(cleanJobDir, 'channel_experiment_verifier_summary.json') : '',
  };
}

export function loadChannelExperimentVerificationSummary({ runsDir = '', jobDir = '' } = {}) {
  const paths = channelExperimentVerificationPaths({ runsDir, jobDir });
  return safeReadJson(paths.jobSummary) || safeReadJson(paths.globalSummary) || null;
}

export async function emitChannelExperimentVerificationEvent(runEventSink = null, record = null, { jobId = '' } = {}) {
  const sink = runEventSink && typeof runEventSink.recordAgentEvent === 'function' ? runEventSink : null;
  if (!sink || !record) return false;
  await sink.recordAgentEvent('channel.verifier_decision', record, { jobId });
  return true;
}

export function recordChannelExperimentVerification({
  runsDir = '',
  jobDir = '',
  runEventSink = null,
  jobId = '',
  ...inputs
} = {}) {
  const record = buildChannelExperimentVerificationRecord(inputs);
  const paths = channelExperimentVerificationPaths({ runsDir, jobDir });
  if (paths.jobJsonl) {
    safeAppendJsonl(paths.jobJsonl, record);
    try {
      fs.writeFileSync(paths.jobSummary, JSON.stringify(summarizeChannelExperimentVerifications(safeReadJsonl(paths.jobJsonl)), null, 2), 'utf8');
    } catch {}
  }
  let globalSummary = null;
  if (paths.globalJsonl) {
    safeAppendJsonl(paths.globalJsonl, record);
    globalSummary = summarizeChannelExperimentVerifications(safeReadJsonl(paths.globalJsonl));
    try {
      fs.writeFileSync(paths.globalSummary, JSON.stringify(globalSummary, null, 2), 'utf8');
    } catch {}
  }
  void emitChannelExperimentVerificationEvent(runEventSink, record, { jobId }).catch(() => {});
  return {
    record,
    summary: globalSummary || (paths.jobSummary ? safeReadJson(paths.jobSummary) : null),
  };
}
