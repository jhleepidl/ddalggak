import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function clip(value = '', max = 240) {
  const text = clean(value);
  const n = Math.max(80, Math.floor(Number(max) || 240));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}
function ensureDir(dir = '') { if (dir) fs.mkdirSync(dir, { recursive: true }); return dir; }
function appendJsonl(filePath = '', row = {}) {
  if (!filePath || !row || typeof row !== 'object') return false;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return true;
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' ? value : {}; }

export function buildRoomSelectionDecision({
  text = '',
  command = '/chat',
  chatId = '',
  roomProfile = null,
  session = {},
  candidateRooms = [],
} = {}) {
  const profile = asObject(roomProfile || session?.agent_room_profile || session?.room_profile || session?.roomProfile);
  const name = clean(profile.name || profile.room_name || profile.title || 'current_room') || 'current_room';
  const roomId = clean(profile.room_id || profile.id || profile.package_id || chatId || 'current_room') || 'current_room';
  const query = clean(text).toLowerCase();
  const explicitRoomHint = /(room|룸|방|프로젝트|논문|paper|메뉴|코드|source|bundle)/i.test(text);
  const correctionHint = /(아니|정정|그게 아니라|전에는|어제|오늘|방금|전에)/i.test(text);
  const persistenceHint = /(기억|저장|앞으로|계속|규칙|반영|package|패키지)/i.test(text);
  const candidates = asArray(candidateRooms).map((row, index) => ({
    room_id: clean(row.room_id || row.id || row.package_id || `candidate_${index + 1}`),
    name: clean(row.name || row.room_name || row.title || `candidate_${index + 1}`),
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
    reason: clip(row.reason || '', 180) || undefined,
  })).filter((row) => row.room_id || row.name).slice(0, 8);
  const currentConfidence = persistenceHint ? 0.74 : (explicitRoomHint || correctionHint ? 0.68 : 0.58);
  const action = candidates.length > 0 && Number(candidates[0].confidence || 0) >= 0.84
    ? 'use_candidate_room'
    : (candidates.length > 0 && Number(candidates[0].confidence || 0) >= 0.55 ? 'shadow_candidate_room' : 'use_current_or_inbox_room');
  return {
    kind: 'room_selection_decision',
    version: 1,
    command: clean(command) || '/chat',
    query_excerpt: clip(text, 220),
    execution_room: {
      room_id: action === 'use_candidate_room' ? candidates[0].room_id : roomId,
      name: action === 'use_candidate_room' ? candidates[0].name : name,
      source: action === 'use_candidate_room' ? 'candidate_room' : 'current_or_inbox_room',
      confidence: action === 'use_candidate_room' ? Number(candidates[0].confidence || 0.84) : currentConfidence,
    },
    candidate_rooms: candidates,
    room_action: action,
    persistence_mode: persistenceHint ? 'possible_memory_update' : 'ephemeral_or_turn_scoped',
    ask_user: action === 'shadow_candidate_room' && persistenceHint,
    signals: [
      explicitRoomHint ? 'explicit_room_hint' : '',
      correctionHint ? 'correction_or_temporal_reference' : '',
      persistenceHint ? 'persistence_hint' : '',
      query.includes('전에') || query.includes('방금') ? 'recent_context_reference' : '',
    ].filter(Boolean),
  };
}

export function buildTeamSelectionDecision({ text = '', command = '/chat', conciergeDecision = {}, teamState = {}, roomSelection = null } = {}) {
  const decision = asObject(conciergeDecision);
  const route = clean(decision.route || 'standard_workbench');
  const activeTeam = asObject(teamState.active_team || teamState.activeTeam);
  const pendingTeam = asObject(teamState.pending_team || teamState.pendingTeam);
  const textValue = clean(text);
  let executionMode = 'standard_ai_room_workbench';
  if (route === 'concierge_direct_answer') executionMode = 'single_model_direct_answer';
  else if (route === 'concierge_search_answer') executionMode = 'bounded_search_answer';
  else if (route === 'team_orchestration') executionMode = 'team_orchestration';
  else if (/\b(team|review|토론|검토|비평|multi-agent)\b/i.test(textValue)) executionMode = 'team_review_orchestration';
  const selectedTeam = Object.keys(activeTeam).length > 0 ? activeTeam : (Object.keys(pendingTeam).length > 0 ? pendingTeam : null);
  return {
    kind: 'team_selection_decision',
    version: 1,
    command: clean(command) || '/chat',
    query_excerpt: clip(text, 220),
    execution_mode: executionMode,
    route,
    selected_team: selectedTeam ? {
      team_name: clean(selectedTeam.team_name || selectedTeam.name || 'configured_team'),
      agent_count: asArray(selectedTeam.agents).length,
      source: Object.keys(activeTeam).length > 0 ? 'active_team' : 'pending_team',
    } : null,
    team_action: selectedTeam ? 'use_configured_team' : (executionMode.startsWith('single_model') ? 'skip_team_for_direct_answer' : 'build_room_first_ephemeral_team'),
    room_action: roomSelection?.room_action || undefined,
    show_internal_trace: executionMode.includes('team') || executionMode.includes('workbench'),
  };
}

export function appendRoomSelectionRouteEvent({ jobDir = '', chatId = '', userId = '', roomSelection = null, teamSelection = null, conciergeDecision = null, source = 'room_concierge' } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const row = {
    ts: new Date().toISOString(),
    event: 'room_and_team_selection',
    source: clean(source) || 'room_concierge',
    chat_id: clean(chatId) || undefined,
    user_id: clean(userId) || undefined,
    room_selection: roomSelection || undefined,
    team_selection: teamSelection || undefined,
    concierge_route: conciergeDecision?.route || undefined,
    concierge_depth: conciergeDecision?.depth || undefined,
  };
  appendJsonl(path.join(cleanJobDir, 'local_memory', 'room_selection_events.jsonl'), row);
  appendJsonl(path.join(cleanJobDir, 'shared', 'room_selection_events.jsonl'), row);
  return row;
}
