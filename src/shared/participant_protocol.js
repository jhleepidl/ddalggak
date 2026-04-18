import { randomUUID } from 'node:crypto';
import { asObject, normalizeStringList } from './normalize.js';

export const OPENHARNESS_PARTICIPANT_SCHEMA_VERSION = 'openharness.participant/v1';
export const OPENHARNESS_CONTRIBUTION_SCHEMA_VERSION = 'openharness.contribution/v1';

const PARTICIPANT_TYPES = new Set([
  'human', 'small_llm', 'llm', 'vlm', 'tool', 'service', 'device_scout', 'verifier', 'observer', 'other',
]);
const CHANNEL_MODES = new Set(['foreground', 'ambient', 'sidecar']);
const VISIBILITY_MODES = new Set(['internal_only', 'fold_into_reply', 'may_surface', 'always_surface']);
const PRIVACY_SCOPES = new Set(['local_only', 'summary_only', 'sync_allowed']);
const CONTRIBUTION_KINDS = new Set([
  'hint', 'critique', 'evidence', 'summary', 'answer_draft', 'question', 'tool_result', 'conflict_flag', 'vote', 'observation', 'other',
]);
const TRUST_TIERS = new Set(['trusted', 'verified', 'unverified']);
const MODALITIES = new Set(['text', 'image', 'audio', 'video', 'sensor', 'file', 'structured']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 240 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function cleanId(value = '', { maxLen = 128 } = {}) {
  return cleanText(value, { lower: true, maxLen })
    .replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampRatio(value, fallback = 0.5) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(1, num));
}

function clampNonNegativeInt(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.floor(num));
}

function normalizeEnum(value = '', allowed = new Set(), fallback = '') {
  const key = cleanText(value, { lower: true, maxLen: 64 });
  if (key && allowed.has(key)) return key;
  return fallback;
}

function normalizeModalities(values = []) {
  const out = [];
  const seen = new Set();
  for (const row of normalizeStringList(values, { max: 8, lower: true })) {
    const value = MODALITIES.has(row) ? row : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function normalizeParticipantDescriptor(raw = {}, { fallbackType = 'other' } = {}) {
  const row = asObject(raw);
  const type = normalizeEnum(
    row.participant_type || row.participantType || row.kind || row.type,
    PARTICIPANT_TYPES,
    fallbackType,
  ) || fallbackType;
  const transport = cleanText(row.transport || row.execution_channel || row.executionChannel || row.interface || '', { lower: true, maxLen: 64 });
  const humanSpecial = row.human_special === true
    || row.humanSpecial === true
    || type === 'human'
    || transport === 'telegram';
  const participantId = cleanId(
    row.participant_id
      || row.participantId
      || row.id
      || row.agent_id
      || row.agentId
      || `${type}:${row.label || row.name || transport || 'participant'}`,
  ) || `participant_${randomUUID()}`;
  const visibilityDefault = normalizeEnum(
    row.visibility_default || row.visibilityDefault || row.default_visibility || row.defaultVisibility,
    VISIBILITY_MODES,
    humanSpecial ? 'always_surface' : 'internal_only',
  ) || (humanSpecial ? 'always_surface' : 'internal_only');
  const channelMode = normalizeEnum(
    row.channel_mode || row.channelMode || row.interaction_mode || row.interactionMode,
    CHANNEL_MODES,
    humanSpecial ? 'foreground' : 'ambient',
  ) || (humanSpecial ? 'foreground' : 'ambient');
  const modalities = normalizeModalities(
    row.modalities
      || row.modality
      || row.inputs
      || row.input_modalities
      || row.inputModalities
      || (type === 'vlm' ? ['text', 'image'] : ['text'])
  );
  const privacyScope = normalizeEnum(
    row.privacy_scope || row.privacyScope || row.sync_preference || row.syncPreference,
    PRIVACY_SCOPES,
    humanSpecial ? 'sync_allowed' : 'summary_only',
  ) || (humanSpecial ? 'sync_allowed' : 'summary_only');
  return {
    schema_version: OPENHARNESS_PARTICIPANT_SCHEMA_VERSION,
    participant_id: participantId,
    participant_type: type,
    label: cleanText(row.label || row.name || row.title || participantId, { maxLen: 160 }) || participantId,
    role_id: cleanId(row.role_id || row.roleId || row.role || (humanSpecial ? 'human' : 'observer')) || (humanSpecial ? 'human' : 'observer'),
    transport: transport || undefined,
    provider: cleanText(row.provider || '', { lower: true, maxLen: 64 }) || undefined,
    model: cleanText(row.model || '', { maxLen: 160 }) || undefined,
    capabilities: normalizeStringList(row.capabilities || row.capability_ids || row.capabilityIds || [], { max: 24, lower: true }),
    modalities,
    channel_mode: channelMode,
    visibility_default: visibilityDefault,
    human_special: humanSpecial,
    trust_tier: normalizeEnum(row.trust_tier || row.trustTier, TRUST_TIERS, humanSpecial ? 'trusted' : 'unverified') || (humanSpecial ? 'trusted' : 'unverified'),
    privacy_scope: privacyScope,
    status: cleanText(row.status || 'online', { lower: true, maxLen: 32 }) || 'online',
    meta: asObject(row.meta || row.metadata),
  };
}

export function normalizeContributionEvent(raw = {}, { participant = null, defaults = {} } = {}) {
  const row = asObject(raw);
  const descriptor = participant ? normalizeParticipantDescriptor(participant) : normalizeParticipantDescriptor({ participant_type: 'other' });
  const visibilityDefault = normalizeEnum(
    row.visibility_default || row.visibilityDefault || row.surface_preference || row.surfacePreference,
    VISIBILITY_MODES,
    descriptor.visibility_default,
  ) || descriptor.visibility_default;
  const privacyScope = normalizeEnum(
    row.privacy_scope || row.privacyScope,
    PRIVACY_SCOPES,
    descriptor.privacy_scope,
  ) || descriptor.privacy_scope;
  return {
    schema_version: OPENHARNESS_CONTRIBUTION_SCHEMA_VERSION,
    contribution_id: cleanId(row.contribution_id || row.contributionId || row.id || randomUUID(), { maxLen: 160 }) || randomUUID(),
    participant_id: cleanId(row.participant_id || row.participantId || descriptor.participant_id) || descriptor.participant_id,
    session_id: cleanText(row.session_id || row.sessionId || defaults.session_id || defaults.sessionId || '', { maxLen: 128 }) || undefined,
    thread_id: cleanText(row.thread_id || row.threadId || defaults.thread_id || defaults.threadId || '', { maxLen: 128 }) || undefined,
    turn_id: cleanText(row.turn_id || row.turnId || defaults.turn_id || defaults.turnId || '', { maxLen: 128 }) || undefined,
    kind: normalizeEnum(row.contribution_kind || row.contributionKind || row.kind, CONTRIBUTION_KINDS, 'other') || 'other',
    content: cleanText(row.content || row.text || row.message || '', { maxLen: 8000 }),
    summary: cleanText(row.summary || '', { maxLen: 1200 }) || undefined,
    confidence: clampRatio(row.confidence, descriptor.human_special ? 1 : 0.5),
    novelty: clampRatio(row.novelty, 0.5),
    cost: clampNonNegativeInt(row.cost, 0),
    latency_ms: clampNonNegativeInt(row.latency_ms || row.latencyMs, 0),
    modalities: normalizeModalities(row.modalities || row.modality || descriptor.modalities),
    visibility_default: visibilityDefault,
    privacy_scope: privacyScope,
    surface_hint: cleanText(row.surface_hint || row.surfaceHint || '', { lower: true, maxLen: 64 }) || undefined,
    references: normalizeStringList(row.references || [], { max: 12, lower: false }),
    meta: asObject(row.meta || row.metadata),
  };
}

export function buildContributionDigest(contribution = {}, { maxLen = 240 } = {}) {
  const row = asObject(contribution);
  const header = cleanText(row.kind || 'note', { lower: true, maxLen: 32 }) || 'note';
  const text = cleanText(row.summary || row.content || '', { maxLen });
  return text ? `${header}: ${text}` : header;
}
