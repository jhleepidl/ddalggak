import fs from 'node:fs';
import path from 'node:path';

import { loadTeamMotifFeedbackSummary } from './team_motif_feedback.js';
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

function cleanId(value = '', fallback = '') {
  const text = cleanText(value, { lower: true, maxLen: 96 });
  if (!text) return fallback;
  return text.replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, '') || fallback;
}

function uniq(values = [], { lower = true, max = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(values)) {
    const text = cleanText(entry, { lower, maxLen: 120 });
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
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

function findMotifDescriptors(summary = null, motifIds = []) {
  const row = asObject(summary);
  const allRows = [
    ...asArray(row.stable_motifs),
    ...asArray(row.candidate_motifs),
    ...asArray(row.recommended_motifs),
    ...asArray(row.motifs),
  ];
  const byId = new Map();
  for (const item of allRows) {
    const cleanMotifId = cleanId(item?.motif_id || item?.motifId || '');
    if (cleanMotifId && !byId.has(cleanMotifId)) byId.set(cleanMotifId, item);
  }
  return uniq(motifIds, { lower: true, max: 16 }).map((motifId) => {
    const item = asObject(byId.get(cleanId(motifId, '')));
    if (!item || !cleanId(item?.motif_id || item?.motifId || '')) return null;
    return {
      motif_id: cleanId(item.motif_id || item.motifId || ''),
      pattern: cleanId(item.pattern || 'sequential', 'sequential') || 'sequential',
      role_ids: uniq(item.role_ids || item.roleIds || [], { lower: true, max: 8 }),
      task_types: uniq(item.task_types || item.taskTypes || [], { lower: true, max: 8 }),
      deliverable_types: uniq(item.deliverable_types || item.deliverableTypes || [], { lower: true, max: 8 }),
      default_weight: Number.isFinite(Number(item.default_weight || item.defaultWeight)) ? Number(item.default_weight || item.defaultWeight) : 1.0,
      recommendation: cleanId(item.recommendation || 'neutral', 'neutral'),
      run_count: Number(item.run_count || item.runCount || 0),
      success_rate_pct: Number(item.success_rate_pct || item.successRatePct || 0),
      avg_score: Number(item.avg_score || item.avgScore || 0),
    };
  }).filter(Boolean);
}

function buildParticipantPolicySnapshot({ runtimeBehavior = null, verificationRecord = null } = {}) {
  const behavior = runtimeBehavior && typeof runtimeBehavior === 'object' ? runtimeBehavior : { participant: {} };
  const participant = asObject(behavior.participant);
  const verifier = asObject(verificationRecord?.participant_policy);
  if (cleanId(verifier.recommendation || '') !== 'promote_to_stable') return null;
  return {
    source_channel: cleanId(verifier.channel || participant.policy_channel || 'candidate', 'candidate') || 'candidate',
    promoted_at: new Date().toISOString(),
    policy_channel: 'stable',
    open_participation_enabled: participant.open_participation_enabled !== false,
    default_visibility: cleanText(participant.default_visibility || 'internal_only', { lower: true, maxLen: 64 }) || 'internal_only',
    surface_threshold: Number.isFinite(Number(participant.surface_threshold)) ? Number(participant.surface_threshold) : 0.82,
    max_surface_per_turn: Number.isFinite(Number(participant.max_surface_per_turn)) ? Number(participant.max_surface_per_turn) : 1,
    allowed_participant_types: uniq(participant.allowed_participant_types || [], { lower: true, max: 16 }),
    allowed_modalities: uniq(participant.allowed_modalities || [], { lower: true, max: 8 }),
    surface_candidate_kinds: uniq(participant.surface_candidate_kinds || [], { lower: true, max: 16 }),
    require_provenance: participant.require_provenance !== false,
    rationale: cleanText(verifier.rationale || verificationRecord?.overall_recommendation || '', { maxLen: 240 }) || undefined,
  };
}

export function channelPromotionPaths({ runsDir = '', jobDir = '' } = {}) {
  const cleanRunsDir = cleanText(runsDir, { maxLen: 512 });
  const cleanJobDir = cleanText(jobDir, { maxLen: 512 });
  return {
    globalJsonl: cleanRunsDir ? path.join(cleanRunsDir, 'channel_promotions.jsonl') : '',
    globalSummary: cleanRunsDir ? path.join(cleanRunsDir, 'channel_promotions_summary.json') : '',
    jobJsonl: cleanJobDir ? path.join(cleanJobDir, 'channel_promotions.jsonl') : '',
    jobSummary: cleanJobDir ? path.join(cleanJobDir, 'channel_promotions_summary.json') : '',
  };
}

export function buildChannelPromotionRecord({
  verificationRecord = null,
  motifFeedbackSummary = null,
  runtimeBehavior = null,
} = {}) {
  const verification = asObject(verificationRecord);
  const motifDecision = asObject(verification.motif);
  const participantDecision = asObject(verification.participant_policy);
  const promotedMotifIds = cleanId(motifDecision.recommendation || '') === 'promote_to_stable'
    ? uniq((motifDecision.selected_motif_ids || []).map((entry) => cleanId(entry, '')), { lower: true, max: 16 })
    : [];
  const rolledBackMotifIds = cleanId(motifDecision.recommendation || '') === 'rollback_candidate'
    ? uniq((motifDecision.selected_motif_ids || []).map((entry) => cleanId(entry, '')), { lower: true, max: 16 })
    : [];
  const motifDescriptors = findMotifDescriptors(motifFeedbackSummary, [...promotedMotifIds, ...rolledBackMotifIds]);
  const participantPolicySnapshot = buildParticipantPolicySnapshot({ runtimeBehavior, verificationRecord: verification });
  const hasAction = promotedMotifIds.length > 0 || rolledBackMotifIds.length > 0 || !!participantPolicySnapshot;
  return {
    ts: new Date().toISOString(),
    run_id: cleanText(verification.run_id || '', { maxLen: 128 }) || undefined,
    overall_recommendation: cleanId(verification.overall_recommendation || 'hold', 'hold'),
    status: cleanId(verification.status || 'done', 'done'),
    execution_mode: cleanId(verification.execution_mode || verification.executionMode || 'single_compiled', 'single_compiled'),
    task_type: cleanId(verification.task_type || verification.taskType || '', '' ) || undefined,
    deliverable_type: cleanId(verification.deliverable_type || verification.deliverableType || '', '' ) || undefined,
    task_family_key: cleanText(verification.task_family_key || verification.taskFamilyKey || '', { lower: true, maxLen: 120 }) || undefined,
    quality_signals: asObject(verification.quality_signals || verification.qualitySignals),
    applied: hasAction,
    goal_excerpt: cleanText(verification.goal_excerpt || '', { maxLen: 280 }) || undefined,
    motif: {
      channel: cleanId(motifDecision.channel || 'stable', 'stable'),
      recommendation: cleanId(motifDecision.recommendation || 'keep_stable', 'keep_stable'),
      next_channel: cleanId(motifDecision.next_channel || motifDecision.channel || 'stable', 'stable'),
      promoted_motif_ids: promotedMotifIds,
      rolled_back_motif_ids: rolledBackMotifIds,
      descriptors: motifDescriptors,
      rationale: cleanText(motifDecision.rationale || '', { maxLen: 240 }) || undefined,
    },
    participant_policy: {
      channel: cleanId(participantDecision.channel || 'stable', 'stable'),
      recommendation: cleanId(participantDecision.recommendation || 'keep_stable', 'keep_stable'),
      next_channel: cleanId(participantDecision.next_channel || participantDecision.channel || 'stable', 'stable'),
      snapshot: participantPolicySnapshot,
      rationale: cleanText(participantDecision.rationale || '', { maxLen: 240 }) || undefined,
    },
  };
}


function summarizeTaskFamilyModeProfiles(rows = []) {
  const buckets = Object.create(null);
  for (const raw of asArray(rows)) {
    const row = asObject(raw);
    const key = cleanText(row.task_family_key || row.taskFamilyKey || '', { lower: true, maxLen: 120 });
    const mode = cleanId(row.execution_mode || row.executionMode || '', '');
    if (!key || !mode) continue;
    const overall = cleanId(row.overall_recommendation || 'hold', 'hold');
    const status = cleanId(row.status || 'done', 'done');
    const qualityHealth = Number.isFinite(Number(row?.quality_signals?.quality_health_score || row?.qualitySignals?.qualityHealthScore))
      ? Math.max(0, Math.min(1, Number(row?.quality_signals?.quality_health_score || row?.qualitySignals?.qualityHealthScore)))
      : 0;
    let weight = overall === 'promote_to_stable' ? 2 : (overall === 'keep_stable' || overall === 'review_stable' ? 1.2 : (row.applied === true ? 0.75 : 0.35));
    if (status === 'error') weight *= 0.25;
    if (status === 'await_user') weight *= 0.7;
    weight += qualityHealth * 0.5;
    if (!buckets[key]) {
      buckets[key] = {
        task_family_key: key,
        task_type: cleanId(row.task_type || row.taskType || '', '') || undefined,
        deliverable_type: cleanId(row.deliverable_type || row.deliverableType || '', '') || undefined,
        run_count: 0,
        mode_weights: Object.create(null),
        mode_counts: Object.create(null),
        quality_sum: 0,
      };
    }
    const bucket = buckets[key];
    bucket.run_count += 1;
    bucket.quality_sum += qualityHealth;
    bucket.mode_weights[mode] = (bucket.mode_weights[mode] || 0) + weight;
    bucket.mode_counts[mode] = (bucket.mode_counts[mode] || 0) + 1;
  }
  const out = Object.create(null);
  for (const [key, bucket] of Object.entries(buckets)) {
    const entries = Object.entries(bucket.mode_weights || {});
    if (!entries.length) continue;
    entries.sort((a, b) => b[1] - a[1]);
    const total = entries.reduce((acc, [, value]) => acc + Number(value || 0), 0) || 1;
    const [mode, support] = entries[0];
    out[key] = {
      task_family_key: key,
      task_type: bucket.task_type,
      deliverable_type: bucket.deliverable_type,
      recommended_mode: mode,
      stable_default_mode: mode,
      confidence: Math.round((support / total) * 1000) / 1000,
      mode_support: Math.round(support * 1000) / 1000,
      sample_size: bucket.run_count,
      avg_quality_health_score: Math.round(((bucket.quality_sum / Math.max(1, bucket.run_count)) || 0) * 1000) / 1000,
      mode_counts: bucket.mode_counts,
      mode_weights: Object.fromEntries(entries.map(([entryMode, value]) => [entryMode, Math.round(Number(value || 0) * 1000) / 1000])),
      source: 'channel_promotion_summary',
    };
  }
  return out;
}

export function summarizeChannelPromotions(records = []) {
  const rows = asArray(records).filter((row) => row && typeof row === 'object');
  const stableMotifs = [];
  const stableSeen = new Set();
  const rolledBack = [];
  const rollbackSeen = new Set();
  let latestParticipantPolicySnapshot = null;
  const counts = { applied: 0, promoted_motif: 0, rolled_back_motif: 0, promoted_participant_policy: 0 };
  for (const row of rows) {
    if (row.applied === true) counts.applied += 1;
    for (const item of asArray(row?.motif?.descriptors)) {
      const motifId = cleanId(item?.motif_id || item?.motifId || '');
      if (!motifId) continue;
      if (asArray(row?.motif?.promoted_motif_ids).map((entry) => cleanId(entry)).includes(motifId)) {
        if (!stableSeen.has(motifId)) {
          stableSeen.add(motifId);
          stableMotifs.push(item);
        }
      }
      if (asArray(row?.motif?.rolled_back_motif_ids).map((entry) => cleanId(entry)).includes(motifId)) {
        if (!rollbackSeen.has(motifId)) {
          rollbackSeen.add(motifId);
          rolledBack.push(item);
        }
      }
    }
    if (asArray(row?.motif?.promoted_motif_ids).length > 0) counts.promoted_motif += asArray(row?.motif?.promoted_motif_ids).length;
    if (asArray(row?.motif?.rolled_back_motif_ids).length > 0) counts.rolled_back_motif += asArray(row?.motif?.rolled_back_motif_ids).length;
    const snapshot = asObject(row?.participant_policy?.snapshot);
    if (snapshot && Object.keys(snapshot).length > 0) {
      latestParticipantPolicySnapshot = snapshot;
      counts.promoted_participant_policy += 1;
    }
  }
  const taskFamilyModeProfiles = summarizeTaskFamilyModeProfiles(rows);
  return {
    updated_at: new Date().toISOString(),
    run_count: rows.length,
    promotion_counts: counts,
    task_family_mode_profiles: taskFamilyModeProfiles,
    stable_registry: {
      motif_ids: stableMotifs.map((item) => cleanId(item.motif_id || '')),
      motifs: stableMotifs,
    },
    rolled_back_registry: {
      motif_ids: rolledBack.map((item) => cleanId(item.motif_id || '')),
      motifs: rolledBack,
    },
    latest_participant_policy_snapshot: latestParticipantPolicySnapshot,
    latest: rows.length > 0 ? rows[rows.length - 1] : null,
  };
}

export function loadChannelPromotionSummary({ runsDir = '', jobDir = '' } = {}) {
  const paths = channelPromotionPaths({ runsDir, jobDir });
  return safeReadJson(paths.jobSummary) || safeReadJson(paths.globalSummary) || null;
}

export async function emitChannelPromotionEvent(runEventSink = null, record = null, { jobId = '' } = {}) {
  const sink = runEventSink && typeof runEventSink.recordAgentEvent === 'function' ? runEventSink : null;
  if (!sink || !record || record.applied !== true) return false;
  await sink.recordAgentEvent('channel.promotion_applied', record, { jobId });
  return true;
}

export function recordChannelPromotion({
  runsDir = '',
  jobDir = '',
  runEventSink = null,
  jobId = '',
  verificationRecord = null,
  verificationSummary = null,
  runtimeBehavior = null,
  motifFeedbackSummary = null,
} = {}) {
  const feedbackSummary = motifFeedbackSummary || loadTeamMotifFeedbackSummary({ runsDir, jobDir });
  const behavior = runtimeBehavior && typeof runtimeBehavior === 'object' ? runtimeBehavior : ensureRuntimeBehavior({}, {});
  const record = buildChannelPromotionRecord({
    verificationRecord,
    motifFeedbackSummary: feedbackSummary,
    runtimeBehavior: behavior,
  });
  const paths = channelPromotionPaths({ runsDir, jobDir });
  if (paths.jobJsonl) {
    safeAppendJsonl(paths.jobJsonl, record);
    try {
      fs.writeFileSync(paths.jobSummary, JSON.stringify(summarizeChannelPromotions(safeReadJsonl(paths.jobJsonl)), null, 2), 'utf8');
    } catch {}
  }
  let globalSummary = null;
  if (paths.globalJsonl) {
    safeAppendJsonl(paths.globalJsonl, record);
    globalSummary = summarizeChannelPromotions(safeReadJsonl(paths.globalJsonl));
    try {
      fs.writeFileSync(paths.globalSummary, JSON.stringify(globalSummary, null, 2), 'utf8');
    } catch {}
  }
  void emitChannelPromotionEvent(runEventSink, record, { jobId }).catch(() => {});
  return {
    record,
    summary: globalSummary || (paths.jobSummary ? safeReadJson(paths.jobSummary) : null) || verificationSummary || null,
  };
}
