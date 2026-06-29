import { readRoomConversationLedger } from './room_conversation_ledger.js';

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
  return {
    turn_id: clean(row.turn_id || row.turnId || row.id) || undefined,
    ts: clean(row.ts || row.created_at || row.createdAt) || '',
    role,
    text,
    command: clean(row.command || row.source_command || row.sourceCommand) || undefined,
    route: clean(row.route) || undefined,
    source: clean(row.source) || undefined,
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
  return {
    kind: 'room_context_snapshot_v1',
    snapshot_id: `roomctx_${tinyHash(seed)}`,
    latest_user_request: cleanLatest,
    command: clean(command) || undefined,
    route: clean(route) || undefined,
    room_selection: roomSelection || undefined,
    team_selection: teamSelection || undefined,
    turns: sliced,
    substrates: ['room_turn_ledger', 'session_recent_room_turns'],
    created_at: new Date().toISOString(),
  };
}

function renderTurn(turn = {}, { turnChars = 260 } = {}) {
  const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'system' ? 'system' : 'user';
  const meta = [turn.command, turn.route].filter(Boolean).join(' · ');
  return `- ${role}${meta ? ` (${meta})` : ''}: ${clip(turn.text, turnChars)}`;
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
  const turns = Array.isArray(snap.turns) ? snap.turns.map(normalizeTurn).filter(Boolean).slice(-maxTurnCount) : [];
  const latest = clean(snap.latest_user_request) || clean([...turns].reverse().find((turn) => turn.role === 'user')?.text || '');
  const lines = [
    '[ROOM CONTEXT SNAPSHOT]',
    `snapshot_id: ${snap.snapshot_id || 'roomctx_unknown'}`,
    `projection_tier: ${projectionTier}`,
    `substrates: ${(Array.isArray(snap.substrates) && snap.substrates.length ? snap.substrates : ['room_turn_ledger']).join(', ')}`,
    latest ? `latest_user_request: ${clip(latest, projectionTier === 'micro' ? 280 : 520)}` : '',
    includePolicy ? 'policy: Use the same room substrate for every route. Older turns are context only; the latest user request is authoritative.' : '',
    includePolicy && (projectionTier === 'micro' || projectionTier === 'search')
      ? 'carry_forward: If the latest turn omits a nearby location/object/preference, use the most recent same-room turn unless contradicted.'
      : '',
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
