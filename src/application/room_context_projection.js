import { readRoomConversationLedger } from './room_conversation_ledger.js';
import { deriveRoomContextState, summarizeRoomContextState } from './room_context_state.js';
import { readRoomSemanticObservations } from './room_semantic_observation_log.js';
import { deriveActiveRoomLoop, formatActiveRoomLoopProjectionBlock, readRoomLoopEvents } from './room_loop_events.js';
import { deriveRoomCompanionState, formatRoomCompanionProjectionBlock, readRoomCompanionEvents } from './room_companions.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 4000) {
  const text = String(value || '').trim();
  const n = Math.max(80, Math.floor(Number(max) || 4000));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

const TIER_DEFAULTS = Object.freeze({
  micro: { turnLimit: 4, maxChars: 1200, turnChars: 220 },
  search: { turnLimit: 6, maxChars: 1800, turnChars: 260 },
  agent: { turnLimit: 8, maxChars: 2600, turnChars: 320 },
  team: { turnLimit: 12, maxChars: 4200, turnChars: 360 },
});

export function normalizeProjectionTier(tier = '') {
  const key = clean(tier).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIER_DEFAULTS, key)) return key;
  return 'agent';
}

function normalizeTurn(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const role = clean(row.role || row.author).toLowerCase();
  const text = clean(row.text || row.content || row.message || '');
  if (!['user', 'assistant', 'system'].includes(role) || !text) return null;
  if (text.includes('�')) return null;
  return {
    turn_id: clean(row.turn_id || row.turnId || row.id) || undefined,
    ts: clean(row.ts || row.created_at || row.createdAt) || '',
    role,
    text,
    command: clean(row.command || row.source_command || row.sourceCommand) || undefined,
    route: clean(row.route) || undefined,
    source: clean(row.source) || undefined,
    semantic_observations: Array.isArray(row.semantic_observations || row.semanticObservations) ? (row.semantic_observations || row.semanticObservations).filter(Boolean).slice(-12) : undefined,
  };
}

export function createRoomContextSnapshot({
  jobDir = '',
  session = null,
  latestUserText = '',
  command = '',
  route = '',
  roomSelection = null,
  teamSelection = null,
  roomProfile = null,
  maxTurns = 24,
} = {}) {
  const ledgerTurns = readRoomConversationLedger({ jobDir, session, limit: Math.max(4, Math.floor(Number(maxTurns) || 24)) })
    .map(normalizeTurn)
    .filter(Boolean);
  const cleanLatest = clean(latestUserText);
  const turns = [...ledgerTurns];
  if (cleanLatest) {
    const lastUser = [...turns].reverse().find((turn) => turn.role === 'user');
    if (!lastUser || clean(lastUser.text) !== cleanLatest) {
      turns.push({
        turn_id: `current_user_${tinyHash(`${command}\n${cleanLatest}`)}`,
        ts: new Date().toISOString(),
        role: 'user',
        text: cleanLatest,
        command: clean(command) || undefined,
        route: clean(route) || undefined,
        source: 'current_turn',
      });
    }
  }
  const sliced = turns.slice(-Math.max(1, Math.floor(Number(maxTurns) || 24)));
  const seed = JSON.stringify({
    latest: cleanLatest,
    last: sliced.slice(-6).map((turn) => [turn.role, turn.text, turn.command, turn.route]),
    room: roomSelection?.room_id || roomSelection?.execution_room || roomSelection?.roomId || '',
    team: teamSelection?.execution_mode || teamSelection?.mode || '',
  });
  const semanticObservations = readRoomSemanticObservations({ jobDir, limit: 24 });
  const contextState = deriveRoomContextState({ turns: sliced, latestUserText: cleanLatest, semanticObservations });
  const companionEvents = readRoomCompanionEvents({ jobDir, session, limit: 80 });
  const companionState = deriveRoomCompanionState({ events: companionEvents, session });
  const loopEvents = readRoomLoopEvents({ jobDir, session, limit: 80 });
  const activeLoop = deriveActiveRoomLoop({ events: loopEvents, session });
  return {
    kind: 'room_context_snapshot_v1',
    snapshot_id: `roomctx_${tinyHash(seed)}`,
    latest_user_request: cleanLatest,
    command: clean(command) || undefined,
    route: clean(route) || undefined,
    room_selection: roomSelection || undefined,
    team_selection: teamSelection || undefined,
    room_profile: roomProfile || undefined,
    turns: sliced,
    context_state: contextState,
    companion_events: companionEvents,
    companion_state: companionState,
    semantic_observations: semanticObservations,
    room_loop_events: loopEvents,
    active_room_loop: activeLoop || undefined,
    substrates: ['room_turn_ledger', 'session_recent_room_turns', ...(semanticObservations.length ? ['room_semantic_observations'] : []), ...(companionEvents.length || companionState ? ['room_companion_events'] : []), ...(activeLoop ? ['room_loop_events'] : [])],
    created_at: new Date().toISOString(),
  };
}

function renderTurn(turn = {}, { turnChars = 260 } = {}) {
  const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'system' ? 'system' : 'user';
  const meta = [turn.command, turn.route].filter(Boolean).join(' · ');
  return `- ${role}${meta ? ` (${meta})` : ''}: ${clip(turn.text, turnChars)}`;
}

function sameTurnIdentity(a = {}, b = {}) {
  const aId = clean(a.turn_id || a.turnId || a.id);
  const bId = clean(b.turn_id || b.turnId || b.id);
  if (aId && bId && aId === bId) return true;
  return clean(a.text) && clean(a.text) === clean(b.text) && clean(a.role) === clean(b.role);
}

function focusTurnsForDialogueReferent(turns = [], contextState = {}, tier = 'agent') {
  const rows = Array.isArray(turns) ? turns : [];
  const ref = contextState?.latest_dialogue_referent;
  const shouldFocus = ref
    && (tier === 'micro' || tier === 'search')
    && (contextState.latest_user_requires_verification || /followup_to_immediate_previous/.test(String(ref.relation || '')));
  if (!shouldFocus) return rows;
  const refTurn = { role: 'assistant', turn_id: ref.turn_id, text: ref.text_excerpt };
  let refIndex = -1;
  if (ref.turn_id) refIndex = rows.findIndex((turn) => sameTurnIdentity(turn, refTurn));
  if (refIndex < 0 && ref.text_excerpt) {
    const excerpt = clean(ref.text_excerpt).slice(0, 80);
    refIndex = rows.findIndex((turn) => turn.role === 'assistant' && clean(turn.text).includes(excerpt));
  }
  if (refIndex < 0) return rows;
  const start = Math.max(0, refIndex - 1);
  return rows.slice(start);
}

export function buildBudgetedRoomContextProjection({
  snapshot = null,
  tier = 'agent',
  maxChars = null,
  turnLimit = null,
  includePolicy = true,
} = {}) {
  const projectionTier = normalizeProjectionTier(tier);
  const defaults = TIER_DEFAULTS[projectionTier];
  const charBudget = Math.max(360, Math.floor(Number(maxChars || defaults.maxChars) || defaults.maxChars));
  const maxTurnCount = Math.max(1, Math.floor(Number(turnLimit || defaults.turnLimit) || defaults.turnLimit));
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : createRoomContextSnapshot({});
  const allTurns = Array.isArray(snap.turns) ? snap.turns.map(normalizeTurn).filter(Boolean) : [];
  const focusedTurns = focusTurnsForDialogueReferent(allTurns, snap.context_state || {}, projectionTier);
  const turns = focusedTurns.slice(-maxTurnCount);
  const latest = clean(snap.latest_user_request) || clean([...turns].reverse().find((turn) => turn.role === 'user')?.text || '');
  const dialogueRef = snap.context_state?.latest_dialogue_referent;
  const lines = [
    '[ROOM CONTEXT SNAPSHOT]',
    `snapshot_id: ${snap.snapshot_id || 'roomctx_unknown'}`,
    `projection_tier: ${projectionTier}`,
    `substrates: ${(Array.isArray(snap.substrates) && snap.substrates.length ? snap.substrates : ['room_turn_ledger']).join(', ')}`,
    latest ? `latest_user_request: ${clip(latest, projectionTier === 'micro' ? 280 : 520)}` : '',
    includePolicy ? 'policy: Use the same room substrate for every route. Older turns are context only; the latest user request is authoritative.' : '',
    includePolicy && (projectionTier === 'micro' || projectionTier === 'search')
      ? 'carry_forward: If the latest turn omits an object, constraint, preference, or other referent, use schema-agnostic room context state first, then recent turns, unless contradicted.'
      : '',
    includePolicy && dialogueRef
      ? 'referent_resolution_policy: If the latest user request is a follow-up, bind ambiguous phrases to the DIALOGUE REFERENCE TARGET before older room memories.'
      : '',
    snap.room_profile
      ? '[ROOM PROFILE — TELEGRAM DOORWAY]'
      : '',
    snap.room_profile
      ? `room_name: ${clip(snap.room_profile.name || snap.room_profile.room_name || snap.room_profile.current_goal || 'AI Room', 160)}`
      : '',
    snap.room_profile?.domain_label
      ? `domain_label: ${snap.room_profile.domain_label}`
      : '',
    Array.isArray(snap.room_profile?.default_agents) && snap.room_profile.default_agents.length
      ? `room_roles: ${snap.room_profile.default_agents.slice(0, 8).join(', ')}`
      : '',
    Array.isArray(snap.room_profile?.memory_schema?.object_types) && snap.room_profile.memory_schema.object_types.length
      ? `memory_schema: ${snap.room_profile.memory_schema.object_types.slice(0, 10).join(', ')}`
      : '',
    snap.room_profile
      ? 'room_profile_policy: Use this room profile to shape continuity and companion routing. Do not use it as a fixed per-user prompt template; latest user request remains authoritative.'
      : '',
    (projectionTier === 'search' && snap.context_state?.latest_user_requires_verification)
      ? 'verification_policy: Do not present prior assistant recommendations as verified external facts unless the context state shows verified evidence or this run produces explicit source evidence. If a DIALOGUE REFERENCE TARGET is present, verify that target rather than older recommendations.'
      : '',
    summarizeRoomContextState(snap.context_state || deriveRoomContextState({ turns: allTurns, latestUserText: latest, semanticObservations: snap.semantic_observations || [] }), { maxItems: projectionTier === 'micro' ? 4 : 6 }),
    formatRoomCompanionProjectionBlock({ state: snap.companion_state || deriveRoomCompanionState({ events: snap.companion_events || [] }), maxChars: projectionTier === 'micro' ? 760 : 1200 }),
    snap.active_room_loop ? formatActiveRoomLoopProjectionBlock({ loop: snap.active_room_loop, maxChars: projectionTier === 'micro' ? 760 : 1200 }) : '',
    turns.length ? '[RECENT SAME-ROOM TURNS]' : '',
    ...turns.map((turn) => renderTurn(turn, { turnChars: defaults.turnChars })),
  ].filter(Boolean);
  return {
    kind: 'budgeted_room_context_projection_v1',
    snapshot_id: snap.snapshot_id || 'roomctx_unknown',
    projection_tier: projectionTier,
    max_chars: charBudget,
    turn_limit: maxTurnCount,
    turns_used: turns.length,
    text: clip(lines.join('\n'), charBudget),
  };
}

export function formatRoomContextProjectionBlock(options = {}) {
  const projection = buildBudgetedRoomContextProjection(options);
  return projection.text;
}

export function resolveProjectionTierForRoute(route = '', fallback = 'agent') {
  const key = clean(route).toLowerCase();
  if (key === 'concierge_direct_answer') return 'micro';
  if (key === 'concierge_search_answer') return 'search';
  if (key === 'team_orchestration') return 'team';
  return normalizeProjectionTier(fallback);
}
