import { normalizeParticipantDescriptor } from '../shared/participant_protocol.js';
import { ensureRuntimeBehavior } from './runtime_behavior_resolver.js';
import { getRuntimeHarnessPolicy, syncRuntimeParticipantState } from './runtime_session_state.js';

const OPENHARNESS_PARTICIPANT_REGISTRY_SCHEMA_VERSION = 'openharness.participant_registry/v1';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '', { lower = false, maxLen = 128 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function normalizeTurnSurfaceCounters(raw = {}) {
  const row = asObject(raw);
  const out = {};
  for (const [turnId, countRaw] of Object.entries(row)) {
    const cleanTurnId = cleanText(turnId, { maxLen: 128 });
    if (!cleanTurnId) continue;
    const count = Number(countRaw);
    out[cleanTurnId] = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  }
  return out;
}

export function normalizeParticipantRegistry(raw = {}, { runtimePolicy = null } = {}) {
  const row = asObject(raw);
  const behavior = ensureRuntimeBehavior({}, { runtimePolicy: runtimePolicy || row.runtime_policy || row.runtimePolicy || null });
  const participantPolicy = behavior.participant;
  const humanPolicy = behavior.human_interface;
  const participants = [];
  const byId = {};
  for (const entry of asArray(row.participants || row.entries)) {
    const descriptor = normalizeParticipantDescriptor(entry);
    if (!descriptor.participant_id || byId[descriptor.participant_id]) continue;
    participants.push(descriptor);
    byId[descriptor.participant_id] = descriptor;
  }
  return {
    schema_version: OPENHARNESS_PARTICIPANT_REGISTRY_SCHEMA_VERSION,
    participants,
    by_id: byId,
    human_interface_participant_id: cleanText(row.human_interface_participant_id || row.humanInterfaceParticipantId || '', { lower: true, maxLen: 128 }) || undefined,
    participant_policy: participantPolicy,
    human_interface_policy: humanPolicy,
    surfaced_count_by_turn: normalizeTurnSurfaceCounters(row.surfaced_count_by_turn || row.surfacedCountByTurn),
  };
}

export function attachParticipantToRegistry(registry = {}, descriptor = {}, { setHumanInterface = false } = {}) {
  const normalized = normalizeParticipantRegistry(registry, { runtimePolicy: registry?.runtime_policy || registry?.runtimePolicy || null });
  const participant = normalizeParticipantDescriptor(descriptor);
  if (!normalized.by_id[participant.participant_id]) {
    normalized.participants = normalized.participants.concat([participant]);
  } else {
    normalized.participants = normalized.participants.map((entry) => entry.participant_id === participant.participant_id ? participant : entry);
  }
  normalized.by_id[participant.participant_id] = participant;
  if (setHumanInterface || participant.human_special === true) {
    normalized.human_interface_participant_id = participant.participant_id;
  }
  return normalized;
}

export function detachParticipantFromRegistry(registry = {}, participantId = '') {
  const normalized = normalizeParticipantRegistry(registry);
  const cleanId = cleanText(participantId, { lower: true, maxLen: 128 });
  if (!cleanId) return normalized;
  normalized.participants = normalized.participants.filter((entry) => entry.participant_id !== cleanId);
  delete normalized.by_id[cleanId];
  if (normalized.human_interface_participant_id === cleanId) normalized.human_interface_participant_id = undefined;
  return normalized;
}

export function resolveParticipantFromRegistry(registry = {}, participantId = '') {
  const normalized = normalizeParticipantRegistry(registry);
  const cleanId = cleanText(participantId, { lower: true, maxLen: 128 });
  if (!cleanId) return null;
  return normalized.by_id[cleanId] || null;
}

export function listParticipantsForRegistry(registry = {}, { channelMode = '', includeOffline = false } = {}) {
  const normalized = normalizeParticipantRegistry(registry);
  const wantedChannel = cleanText(channelMode, { lower: true, maxLen: 32 });
  return normalized.participants.filter((entry) => {
    if (!includeOffline && cleanText(entry.status, { lower: true, maxLen: 32 }) === 'offline') return false;
    if (wantedChannel && cleanText(entry.channel_mode, { lower: true, maxLen: 32 }) !== wantedChannel) return false;
    return true;
  });
}

export function ensureRuntimeParticipantRegistry(runtime = null, { runtimePolicy = null } = {}) {
  const target = asObject(runtime);
  const existing = target.participantRegistry || target.participant_registry || null;
  const normalized = normalizeParticipantRegistry(existing || {}, { runtimePolicy: getRuntimeHarnessPolicy(target, runtimePolicy || null) });
  target.participantRegistry = normalized;
  target.participant_registry = normalized;
  return normalized;
}

export function registerHumanInterfaceParticipant(runtime = null, {
  participantId = 'human.telegram',
  label = 'Human',
  transport = 'telegram',
  chatId = '',
  telegramUserId = '',
} = {}) {
  const registry = ensureRuntimeParticipantRegistry(runtime, { runtimePolicy: runtime?.harnessRuntimePolicy || runtime?.runtimePolicy || null });
  const descriptor = normalizeParticipantDescriptor({
    participant_id: participantId,
    participant_type: 'human',
    label,
    role_id: 'human',
    transport,
    visibility_default: 'always_surface',
    channel_mode: 'foreground',
    trust_tier: 'trusted',
    privacy_scope: 'sync_allowed',
    meta: {
      chat_id: cleanText(chatId, { maxLen: 128 }) || undefined,
      telegram_user_id: cleanText(telegramUserId, { maxLen: 128 }) || undefined,
    },
  });
  const next = attachParticipantToRegistry(registry, descriptor, { setHumanInterface: true });
  if (runtime && typeof runtime === 'object') {
    runtime.participantRegistry = next;
    runtime.participant_registry = next;
    syncRuntimeParticipantState(runtime, { registry: next });
  }
  return descriptor;
}

export function incrementSurfacedTurnCount(registry = {}, turnId = '', increment = 1) {
  const normalized = normalizeParticipantRegistry(registry);
  const cleanTurnId = cleanText(turnId, { maxLen: 128 });
  if (!cleanTurnId) return normalized;
  const next = { ...normalized.surfaced_count_by_turn };
  next[cleanTurnId] = Math.max(0, Math.floor(Number(next[cleanTurnId] || 0) + Number(increment || 0)));
  normalized.surfaced_count_by_turn = next;
  return normalized;
}
