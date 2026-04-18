import { buildContributionDigest } from '../shared/participant_protocol.js';
import { consumeFoldedParticipantContributions } from './runtime_participant_gateway.js';
import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';
import { syncRuntimeObservabilityState } from './runtime_session_state.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 240 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function clampRatio(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function formatConfidence(confidence = 0) {
  return `${Math.round(clampRatio(confidence, 0.5) * 100)}%`;
}

function normalizeKind(value = '') {
  return cleanText(value, { lower: true, maxLen: 64 }) || 'other';
}


function slugToken(value = '') {
  return normalizeKind(value).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'signal';
}

function classifyFoldedItems(items = []) {
  const buckets = {
    critique: [],
    evidence: [],
    summary: [],
    answer_draft: [],
    other: [],
  };
  for (const entry of asArray(items)) {
    const kind = normalizeKind(entry?.contribution?.kind);
    if (kind === 'critique' || kind === 'conflict_flag' || kind === 'vote') {
      buckets.critique.push(entry);
      continue;
    }
    if (kind === 'evidence' || kind === 'tool_result' || kind === 'observation') {
      buckets.evidence.push(entry);
      continue;
    }
    if (kind === 'summary' || kind === 'hint') {
      buckets.summary.push(entry);
      continue;
    }
    if (kind === 'answer_draft' || kind === 'question') {
      buckets.answer_draft.push(entry);
      continue;
    }
    buckets.other.push(entry);
  }
  return buckets;
}

function buildKindCounts(items = []) {
  const counts = {};
  for (const entry of asArray(items)) {
    const kind = normalizeKind(entry?.contribution?.kind);
    counts[kind] = (counts[kind] || 0) + 1;
  }
  return counts;
}

function summarizeEntry(entry = {}) {
  const participant = asObject(entry?.participant);
  const contribution = asObject(entry?.contribution);
  const label = cleanText(participant.label || participant.participant_id || 'participant', { maxLen: 120 }) || 'participant';
  const digest = cleanText(contribution.summary || contribution.content || '', { maxLen: 220 });
  const confidence = formatConfidence(contribution.confidence);
  const kind = normalizeKind(contribution.kind);
  return { label, digest, confidence, kind };
}

function selectSynthesisCandidates(envelopes = [], {
  allowedKinds = [],
  minConfidence = 0.55,
} = {}) {
  const allowed = new Set((Array.isArray(allowedKinds) ? allowedKinds : []).map((entry) => cleanText(entry, { lower: true, maxLen: 64 })).filter(Boolean));
  return asArray(envelopes)
    .filter((entry) => {
      const kind = cleanText(entry?.contribution?.kind, { lower: true, maxLen: 64 });
      const confidence = clampRatio(entry?.contribution?.confidence, 0.5);
      if (allowed.size > 0 && !allowed.has(kind)) return false;
      return confidence >= minConfidence;
    })
    .sort((left, right) => clampRatio(right?.contribution?.confidence, 0.5) - clampRatio(left?.contribution?.confidence, 0.5));
}

export function buildFoldedContributionPromptBlock(items = []) {
  const buckets = classifyFoldedItems(items);
  const sections = [];

  const pushSection = (title, guidance, entries = []) => {
    const rows = asArray(entries).map((entry, index) => {
      const row = summarizeEntry(entry);
      if (!row.digest) return '';
      return `- ${slugToken(title)}_${index + 1}: ${row.label} · conf=${row.confidence} · ${row.kind}: ${row.digest}`;
    }).filter(Boolean).slice(0, 4);
    if (rows.length === 0) return;
    sections.push([title + ':', guidance ? `  ${guidance}` : '', ...rows].filter(Boolean).join('\n'));
  };

  pushSection('Critiques and conflict checks', 'Use these to correct contradictions, overclaims, or risky statements before answering.', buckets.critique);
  pushSection('Evidence and observations', 'Use these as supporting evidence when they fit the current answer; do not present them as direct user quotes.', buckets.evidence);
  pushSection('Summaries and hints', 'Use these as lightweight background context or reminders.', buckets.summary);
  pushSection('Drafts and open questions', 'Use these only if they genuinely improve the final answer structure.', [...buckets.answer_draft, ...buckets.other]);

  if (sections.length === 0) return '';
  return [
    'Participant signals (internal hints to consider, not direct user-facing quotes):',
    ...sections,
  ].join('\n\n');
}

export function buildFoldedContributionDigestBlock(items = [], { heading = '참고 신호' } = {}) {
  const buckets = classifyFoldedItems(items);
  const sections = [];
  const push = (title, entries = []) => {
    const rows = asArray(entries).map((entry) => {
      const row = summarizeEntry(entry);
      if (!row.digest) return '';
      return `- ${row.label}: ${row.digest}`;
    }).filter(Boolean).slice(0, 3);
    if (rows.length === 0) return;
    sections.push([`${title}:`, ...rows].join('\n'));
  };
  push('검토/비판', buckets.critique);
  push('근거/관찰', buckets.evidence);
  push('요약/힌트', buckets.summary);
  push('초안/기타', [...buckets.answer_draft, ...buckets.other]);
  if (sections.length === 0) return '';
  return [heading, ...sections].join('\n');
}

export function collectFoldedParticipantSignals(runtime = null, { turnId = '', maxItems = null } = {}) {
  const target = asObject(runtime);
  const behavior = ensureRuntimeBehavior(target);
  const participantPolicy = asObject(behavior.participant);
  const humanPolicy = asObject(behavior.human_interface);
  const mode = cleanText(humanPolicy.external_contribution_mode || 'folded_only', { lower: true, maxLen: 64 }) || 'folded_only';
  if (mode === 'disabled' || participantPolicy.open_participation_enabled === false) {
    return {
      mode,
      items: [],
      prompt_block: '',
      digest_block: '',
    };
  }
  const budget = Number.isFinite(Number(maxItems))
    ? Math.max(1, Math.min(8, Math.floor(Number(maxItems))))
    : Math.max(1, Math.min(6, Number(participantPolicy.max_surface_per_turn || 1) + 2));
  const pulled = consumeFoldedParticipantContributions(target, { turnId, maxItems: budget });
  const selected = selectSynthesisCandidates(pulled, {
    allowedKinds: participantPolicy.surface_candidate_kinds,
    minConfidence: mode === 'always_append' ? 0.45 : 0.55,
  }).slice(0, budget);
  const promptBlock = buildFoldedContributionPromptBlock(selected);
  const digestBlock = buildFoldedContributionDigestBlock(selected);
  syncRuntimeObservabilityState(target, {
    participant_surface: {
      last_turn_id: cleanText(turnId || target.currentTurnId || target.current_turn_id || '', { maxLen: 128 }) || undefined,
      last_folded_count: selected.length,
      last_folded_labels: selected.map((entry) => cleanText(entry?.participant?.label || entry?.participant?.participant_id || '', { maxLen: 120 })).filter(Boolean).slice(0, 8),
    },
  });
  return {
    mode,
    items: selected,
    kind_counts: buildKindCounts(selected),
    prompt_block: promptBlock,
    digest_block: digestBlock,
  };
}

function buildFoldedSignalSignature(folded = null, { turnId = '' } = {}) {
  const row = asObject(folded);
  const items = asArray(row.items);
  const ids = items
    .map((entry) => cleanText(entry?.contribution?.contribution_id || '', { maxLen: 96 }))
    .filter(Boolean)
    .slice(0, 16);
  return cleanText(`${cleanText(turnId, { maxLen: 96 })}:${ids.join(',')}`, { maxLen: 256 });
}

export async function recordFoldedParticipantSignals(runtime = null, folded = null, {
  turnId = '',
  runEventSink = null,
  jobId = '',
} = {}) {
  const target = asObject(runtime);
  const row = asObject(folded);
  const items = asArray(row.items);
  if (items.length === 0) return false;
  const cleanTurnId = cleanText(turnId || target.currentTurnId || target.current_turn_id || '', { maxLen: 128 });
  const sink = runEventSink || target.runEventSink || target.run_event_sink || null;
  if (!sink || typeof sink.recordAgentEvent !== 'function') return false;
  const signature = buildFoldedSignalSignature(row, { turnId: cleanTurnId });
  const priorSignature = cleanText(
    target?.runtimeSessionState?.observability_state?.participant_surface?.last_digest_signature
      || target?.runtime_session_state?.observability_state?.participant_surface?.last_digest_signature
      || '',
    { maxLen: 256 }
  );
  const priorTurnId = cleanText(
    target?.runtimeSessionState?.observability_state?.participant_surface?.last_digest_turn_id
      || target?.runtime_session_state?.observability_state?.participant_surface?.last_digest_turn_id
      || '',
    { maxLen: 128 }
  );
  if (signature && signature === priorSignature && cleanTurnId && cleanTurnId === priorTurnId) return false;
  await sink.recordAgentEvent('participant.folded_digest', {
    turn_id: cleanTurnId || undefined,
    mode: cleanText(row.mode || 'folded_only', { lower: true, maxLen: 64 }) || 'folded_only',
    item_count: items.length,
    participant_labels: items
      .map((entry) => cleanText(entry?.participant?.label || entry?.participant?.participant_id || '', { maxLen: 120 }))
      .filter(Boolean)
      .slice(0, 8),
    participant_ids: items
      .map((entry) => cleanText(entry?.participant?.participant_id || '', { maxLen: 96 }))
      .filter(Boolean)
      .slice(0, 8),
    contribution_ids: items
      .map((entry) => cleanText(entry?.contribution?.contribution_id || '', { maxLen: 96 }))
      .filter(Boolean)
      .slice(0, 16),
    kinds: items
      .map((entry) => cleanText(entry?.contribution?.kind || '', { lower: true, maxLen: 64 }))
      .filter(Boolean)
      .slice(0, 8),
    kind_counts: buildKindCounts(items),
    prompt_block: row.prompt_block || undefined,
    digest_block: row.digest_block || undefined,
    signature: signature || undefined,
  }, { jobId });
  syncRuntimeObservabilityState(target, {
    participant_surface: {
      last_digest_turn_id: cleanTurnId || undefined,
      last_digest_signature: signature || undefined,
    },
  });
  return true;
}

export function appendFoldedContributionDigest(replyText = '', folded = null) {
  const base = cleanText(replyText, { maxLen: 12000 });
  const block = cleanText(asObject(folded).digest_block || '', { maxLen: 2400 });
  if (!block) return base;
  if (!base) return block;
  return `${base}\n\n${block}`;
}
