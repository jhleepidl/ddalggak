import { readRoomConversationLedger } from './room_conversation_ledger.js';
import { deriveRoomContextState, summarizeRoomContextState } from './room_context_state.js';
import { readRoomSemanticObservations } from './room_semantic_observation_log.js';
import { deriveActiveRoomLoop, formatActiveRoomLoopProjectionBlock, readRoomLoopEvents } from './room_loop_events.js';
import { deriveRoomCompanionState, formatRoomCompanionProjectionBlock, readRoomCompanionEvents } from './room_companions.js';
import { normalizeRoomMemoryItem } from './room_memory_view.js';
import { readLoopWorkingMemory, formatLoopWorkingMemoryProjection } from './loop_memory_manager.js';

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

function asArray(value) { return Array.isArray(value) ? value : []; }

function tokenSet(value = '') {
  return new Set(clean(value).toLowerCase().match(/[a-z0-9가-힣_]{2,}/g) || []);
}

function approvedRoomMemories(session = {}) {
  return asArray(session?.room_memory_items || session?.roomMemoryItems)
    .map(normalizeRoomMemoryItem)
    .filter(Boolean)
    .filter((item) => clean(item.status || 'active').toLowerCase() === 'active');
}

function scoreApprovedMemory(item = {}, latest = '') {
  const query = tokenSet(latest);
  const memory = tokenSet([item.type, item.title, item.summary, item.content].filter(Boolean).join(' '));
  let overlap = 0;
  for (const token of query) if (memory.has(token)) overlap += 1;
  const type = clean(item.type).toLowerCase();
  const durableBoost = /preference|boundary|exclusion|protocol|rule|correction/.test(type) ? 1.5 : 0;
  const recency = Date.parse(item.updated_at || item.created_at || '') || 0;
  const recencyBoost = recency ? Math.min(1, Math.max(0, (recency - (Date.now() - 90 * 86400000)) / (90 * 86400000))) : 0;
  return overlap * 3 + durableBoost + recencyBoost + Math.min(1, Number(item.usage_count || 0) / 10);
}

export function selectApprovedRoomMemories({ session = {}, latestUserText = '', limit = 8 } = {}) {
  const max = Math.max(1, Math.min(20, Math.floor(Number(limit) || 8)));
  return approvedRoomMemories(session)
    .map((item) => ({ ...item, projection_score: scoreApprovedMemory(item, latestUserText) }))
    .sort((a, b) => b.projection_score - a.projection_score || clean(b.updated_at || b.created_at).localeCompare(clean(a.updated_at || a.created_at)))
    .slice(0, max);
}

function renderApprovedMemory(item = {}, { maxChars = 260 } = {}) {
  const owners = asArray(item.owner_companion_ids).filter(Boolean).join(',');
  const meta = [item.memory_id, item.type, owners ? `owners=${owners}` : '', item.source_turn_id ? `source=${item.source_turn_id}` : ''].filter(Boolean).join(' · ');
  return `- ${meta}: ${clip(item.summary || item.content || item.title, maxChars)}`;
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
  const approvedMemories = selectApprovedRoomMemories({ session: session || {}, latestUserText: cleanLatest, limit: 12 });
  const seed = JSON.stringify({
    latest: cleanLatest,
    last: sliced.slice(-6).map((turn) => [turn.role, turn.text, turn.command, turn.route]),
    room: roomSelection?.room_id || roomSelection?.execution_room || roomSelection?.roomId || '',
    team: teamSelection?.execution_mode || teamSelection?.mode || '',
    memories: approvedMemories.map((item) => item.memory_id),
  });
  const semanticObservations = readRoomSemanticObservations({ jobDir, limit: 24 });
  const contextState = deriveRoomContextState({ turns: sliced, latestUserText: cleanLatest, semanticObservations });
  const companionEvents = readRoomCompanionEvents({ jobDir, session, limit: 80 });
  const companionState = deriveRoomCompanionState({ events: companionEvents, session });
  const loopEvents = readRoomLoopEvents({ jobDir, session, limit: 80 });
  const activeLoop = deriveActiveRoomLoop({ events: loopEvents, session });
  const loopWorkingMemory = activeLoop?.loop_id ? readLoopWorkingMemory({ jobDir, loopId: activeLoop.loop_id }) : null;
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
    approved_room_memories: approvedMemories,
    room_loop_events: loopEvents,
    active_room_loop: activeLoop || undefined,
    loop_working_memory: loopWorkingMemory || undefined,
    substrates: ['room_turn_ledger', 'session_recent_room_turns', ...(approvedMemories.length ? ['approved_room_memory'] : []), ...(semanticObservations.length ? ['room_semantic_observations'] : []), ...(companionEvents.length || companionState ? ['room_companion_events'] : []), ...(activeLoop ? ['room_loop_events'] : []), ...(loopWorkingMemory ? ['loop_working_memory_projection'] : [])],
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
  const memoryLimit = projectionTier === 'micro' ? 2 : projectionTier === 'search' ? 3 : projectionTier === 'team' ? 6 : 5;
  const approvedMemories = asArray(snap.approved_room_memories).slice(0, memoryLimit);
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
    snap.room_profile?.preset_id
      ? `default_room_preset: ${snap.room_profile.preset_id}`
      : '',
    Array.isArray(snap.room_profile?.default_agents) && snap.room_profile.default_agents.length
      ? `room_roles: ${snap.room_profile.default_agents.slice(0, 8).join(', ')}`
      : '',
    Array.isArray(snap.room_profile?.installed_skills) && snap.room_profile.installed_skills.length
      ? `room_skills: ${snap.room_profile.installed_skills.slice(0, 12).join(', ')}`
      : '',
    Array.isArray(snap.room_profile?.memory_hierarchy) && snap.room_profile.memory_hierarchy.length
      ? `memory_hierarchy: ${snap.room_profile.memory_hierarchy.slice(0, 12).join(' -> ')}`
      : '',
    Array.isArray(snap.room_profile?.memory_schema?.object_types) && snap.room_profile.memory_schema.object_types.length
      ? `memory_schema: ${snap.room_profile.memory_schema.object_types.slice(0, 10).join(', ')}`
      : '',
    snap.room_profile?.loop_policy?.default_iterations
      ? `loop_policy: default_iterations=${snap.room_profile.loop_policy.default_iterations}; verify_each_iteration=${snap.room_profile.loop_policy.verify_each_iteration !== false}`
      : '',
    snap.room_profile
      ? 'room_profile_policy: Use this room profile to shape continuity and companion routing. Do not use it as a fixed per-user prompt template; latest user request remains authoritative.'
      : '',
    (projectionTier === 'search' && snap.context_state?.latest_user_requires_verification)
      ? 'verification_policy: Do not present prior assistant recommendations as verified external facts unless the context state shows verified evidence or this run produces explicit source evidence. If a DIALOGUE REFERENCE TARGET is present, verify that target rather than older recommendations.'
      : '',
    approvedMemories.length ? '[APPROVED ROOM MEMORY — USER GOVERNED]' : '',
    approvedMemories.length ? 'memory_policy: These entries were explicitly approved. Apply only when relevant; latest user correction or request overrides them. Do not expose hidden provenance or unrelated memories.' : '',
    ...approvedMemories.map((item) => renderApprovedMemory(item, { maxChars: projectionTier === 'micro' ? 140 : projectionTier === 'search' ? 180 : 220 })),
    summarizeRoomContextState(snap.context_state || deriveRoomContextState({ turns: allTurns, latestUserText: latest, semanticObservations: snap.semantic_observations || [] }), { maxItems: projectionTier === 'micro' ? 4 : 6 }),
    formatRoomCompanionProjectionBlock({ state: snap.companion_state || deriveRoomCompanionState({ events: snap.companion_events || [] }), maxChars: projectionTier === 'micro' ? 760 : 1200 }),
    snap.active_room_loop ? formatActiveRoomLoopProjectionBlock({ loop: snap.active_room_loop, maxChars: projectionTier === 'micro' ? 760 : 1200 }) : '',
    snap.loop_working_memory ? '[LOOP WORKING MEMORY — COMPACTED PROMPT SURFACE]' : '',
    snap.loop_working_memory ? 'loop_memory_policy: Treat this compact projection as the current working context. Raw trace remains audit evidence and must not be injected wholesale.' : '',
    snap.loop_working_memory ? formatLoopWorkingMemoryProjection({ workingMemory: snap.loop_working_memory, maxChars: projectionTier === 'micro' ? 900 : projectionTier === 'team' ? 2600 : 1600 }) : '',
    turns.length ? '[RECENT SAME-ROOM TURNS]' : '',
    ...turns.map((turn) => renderTurn(turn, { turnChars: defaults.turnChars })),
  ].filter(Boolean);
  const text = clip(lines.join('\n'), charBudget);
  const approvedMemoryIdsUsed = approvedMemories
    .map((item) => item.memory_id)
    .filter(Boolean)
    .filter((memoryId) => text.includes(`- ${memoryId} ·`) || text.includes(`- ${memoryId}:`));
  return {
    kind: 'budgeted_room_context_projection_v1',
    snapshot_id: snap.snapshot_id || 'roomctx_unknown',
    projection_tier: projectionTier,
    max_chars: charBudget,
    turn_limit: maxTurnCount,
    turns_used: turns.length,
    approved_memory_ids_used: approvedMemoryIdsUsed,
    approved_memory_count: approvedMemoryIdsUsed.length,
    text,
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
