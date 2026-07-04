function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 500) {
  const text = clean(value);
  const n = Math.max(60, Math.floor(Number(max) || 500));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeRole(value = '') {
  return clean(value).toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9가-힣_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function roleToCompanionId(role = '') {
  const key = normalizeRole(role);
  if (!key) return '';
  const tokens = new Set(key.split(/[_-]+/).filter(Boolean));
  if (tokens.has('critic') || tokens.has('reviewer') || tokens.has('risk') || tokens.has('검토') || tokens.has('리뷰어')) return 'critic';
  if (tokens.has('builder') || tokens.has('implementation') || tokens.has('implementer') || tokens.has('code') || tokens.has('verifier')) return 'implementation';
  if (tokens.has('product') || tokens.has('ux') || tokens.has('planner') || tokens.has('synthesizer')) return 'product';
  if (tokens.has('personal') || tokens.has('preference') || tokens.has('history') || tokens.has('tracker') || tokens.has('context')) return 'personal';
  if (tokens.has('researcher') || tokens.has('research') || tokens.has('scout') || tokens.has('paper') || tokens.has('market')) return 'research';
  return '';
}

const DURABILITY_CUES = [
  '앞으로', '다음부터', '항상', '계속', '기억해', '저장해', '반복', '매번', 'whenever', 'from now', 'next time', 'always', 'remember', 'keep in mind', 'going forward',
];
const BOUNDARY_CUES = [
  '절대', '싫', '안할', '안 할', '하지마', '하지 마', '하지 말', '하지말', '피해', '빼줘', '제외', '금지', 'never', 'do not', "don't", 'avoid', 'refuse', 'not want',
];
const PREFERENCE_CUES = [
  '선호', '좋아', '좋음', '싫어', '관심', '원해', '하고 싶', '배우고 싶', 'prefer', 'like', 'dislike', 'interested', 'want', 'would like',
];
const SELF_CONTEXT_CUES = [
  '나는', '제가', '저는', '내가', '저의', '나의', '키', '몸무게', '사는', '근처', 'my ', 'i am', "i'm", 'i have', 'i live', 'near me',
];
const PROTOCOL_CUES = [
  '할 때는', '물어보면', '요청하면', '경우에는', '방식으로', '순서', '프로토콜', '루틴', 'when i ask', 'if i ask', 'when we', 'routine', 'protocol', 'workflow',
];

function includesCue(text = '', cues = []) {
  const lower = clean(text).toLowerCase();
  return cues.some((cue) => lower.includes(String(cue || '').toLowerCase()));
}

function inferObservationType(text = '') {
  const lower = clean(text).toLowerCase();
  const hasBoundary = includesCue(lower, BOUNDARY_CUES);
  const hasDurability = includesCue(lower, DURABILITY_CUES);
  const hasPreference = includesCue(lower, PREFERENCE_CUES);
  const hasSelf = includesCue(lower, SELF_CONTEXT_CUES);
  const hasProtocol = includesCue(lower, PROTOCOL_CUES);
  if (hasBoundary) return 'user_boundary_or_exclusion';
  if (hasProtocol && hasDurability) return 'room_protocol_hint';
  if (hasPreference || hasDurability) return 'stable_preference_candidate';
  if (hasSelf) return 'personal_context_candidate';
  if (hasProtocol) return 'room_protocol_hint';
  return '';
}

function selectTargetCompanions({ observationType = '', roomProfile = null, activeCompanionId = '' } = {}) {
  const out = [];
  const add = (id) => {
    const cleanId = clean(id).toLowerCase();
    if (cleanId && ['research', 'implementation', 'product', 'critic', 'personal', 'concierge'].includes(cleanId) && !out.includes(cleanId)) out.push(cleanId);
  };
  add(activeCompanionId);
  const roles = asArray(asObject(roomProfile).default_agents || asObject(roomProfile).agent_roles || asObject(roomProfile).defaultAgents);
  for (const role of roles) add(roleToCompanionId(role));
  if (observationType === 'user_boundary_or_exclusion') add('critic');
  if (observationType === 'stable_preference_candidate' || observationType === 'personal_context_candidate') add('personal');
  if (observationType === 'room_protocol_hint') add('concierge');
  add('concierge');
  return out.slice(0, 4);
}

export function normalizeRoomIdleMemoryCandidate(candidate = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const quote = clip(candidate.source_quote || candidate.quote || candidate.text || '', 700);
  const observationType = clean(candidate.observation_type || candidate.observationType || inferObservationType(quote));
  if (!quote || !observationType) return null;
  const sourceTurnId = clean(candidate.source_turn_id || candidate.sourceTurnId || candidate.turn_id || candidate.turnId);
  const id = clean(candidate.candidate_id || candidate.candidateId) || `rim_${tinyHash(`${sourceTurnId}\n${observationType}\n${quote}`)}`;
  const targetCompanions = asArray(candidate.target_companion_ids || candidate.targetCompanionIds)
    .map((x) => clean(x).toLowerCase())
    .filter(Boolean)
    .filter((x, index, arr) => arr.indexOf(x) === index)
    .slice(0, 5);
  return {
    kind: 'room_idle_memory_candidate_v1',
    candidate_id: id,
    status: clean(candidate.status || 'pending').toLowerCase() || 'pending',
    observation_type: observationType,
    memory_summary: clip(candidate.memory_summary || candidate.memorySummary || `Review whether this user-authored observation should become room memory: ${quote}`, 700),
    source_turn_id: sourceTurnId || undefined,
    source_ts: clean(candidate.source_ts || candidate.sourceTs || candidate.ts) || undefined,
    source_role: clean(candidate.source_role || candidate.sourceRole || 'user').toLowerCase() || 'user',
    source_quote: quote,
    target_companion_ids: targetCompanions,
    room_default_roles: asArray(candidate.room_default_roles || candidate.roomDefaultRoles).map(normalizeRole).filter(Boolean).slice(0, 12),
    review_required: candidate.review_required !== false,
    canonical_write_enabled: false,
    generated_during_idle: candidate.generated_during_idle !== false,
    rationale: clip(candidate.rationale || 'Detected from recent user-authored room turns during idle structuring. This is a reviewable candidate only; it is not a fixed route, fixed prompt, or canonical memory write.', 700),
    created_at: clean(candidate.created_at || candidate.createdAt) || new Date().toISOString(),
  };
}

export function deriveRoomIdleMemoryCandidates({ turns = [], roomProfile = null, activeCompanionId = '', maxCandidates = 6 } = {}) {
  const room = asObject(roomProfile);
  const roomDefaultRoles = asArray(room.default_agents || room.agent_roles || room.defaultAgents).map(normalizeRole).filter(Boolean).slice(0, 12);
  const rows = asArray(turns);
  const out = [];
  const seen = new Set();
  for (const turn of rows) {
    const role = clean(turn?.role || turn?.author).toLowerCase();
    if (role && role !== 'user') continue;
    const text = clean(turn?.text || turn?.content || turn?.message || '');
    if (!text || text.includes('�')) continue;
    const observationType = inferObservationType(text);
    if (!observationType) continue;
    const sourceTurnId = clean(turn?.turn_id || turn?.turnId || turn?.id) || `turn_${tinyHash(`${text}\n${turn?.ts || ''}`)}`;
    const targetCompanions = selectTargetCompanions({ observationType, roomProfile: room, activeCompanionId });
    const candidate = normalizeRoomIdleMemoryCandidate({
      observation_type: observationType,
      source_turn_id: sourceTurnId,
      source_ts: turn?.ts || turn?.created_at || turn?.createdAt || '',
      source_quote: text,
      target_companion_ids: targetCompanions,
      room_default_roles: roomDefaultRoles,
      memory_summary: `${observationType}: ${clip(text, 560)}`,
      rationale: 'Generic idle structuring cue from a recent user turn. It only creates a reviewable candidate; no route prompt or canonical memory is changed.',
    });
    if (!candidate || seen.has(candidate.candidate_id)) continue;
    seen.add(candidate.candidate_id);
    out.push(candidate);
    if (out.length >= Math.max(1, Math.floor(Number(maxCandidates) || 6))) break;
  }
  return out;
}

function existingCandidateIds(session = {}, companionState = null) {
  const ids = new Set();
  const fromSession = asArray(session.room_idle_memory_candidates || session.roomIdleMemoryCandidates || session.idle_memory_observations || []);
  const fromState = asArray(companionState?.idle_memory_observations || []);
  for (const row of [...fromSession, ...fromState]) {
    const id = clean(row?.candidate_id || row?.candidateId || row?.payload?.candidate_id || row?.payload?.candidateId);
    if (id) ids.add(id);
  }
  return ids;
}

export function buildRoomIdleMemoryObservationEvent({ candidate = null, source = 'room_idle_memory_maintenance' } = {}) {
  const c = normalizeRoomIdleMemoryCandidate(candidate || {});
  if (!c) return null;
  return {
    event_type: 'room_idle_memory_observation_proposed',
    status: c.status || 'pending',
    summary: c.memory_summary,
    memory_summary: c.memory_summary,
    source,
    payload: {
      ...c,
      approval_required: true,
      silent_promotion: false,
      canonical_write_enabled: false,
    },
  };
}

export function runRoomIdleMemoryStructuring({ chatSessionStore = null, chatId = '', roomProfile = null, companionState = null, appendEvent = null, force = false, source = 'idle_after_room_turn', minIntervalMs = null, maxCandidates = 4 } = {}) {
  const store = chatSessionStore;
  const session = store && typeof store.get === 'function' ? (store.get(chatId) || {}) : {};
  const now = Date.now();
  const interval = Number.isFinite(Number(minIntervalMs))
    ? Math.max(0, Number(minIntervalMs))
    : Math.max(0, Number(process.env.DDALGGAK_ROOM_IDLE_MEMORY_MIN_INTERVAL_MS || 90 * 1000));
  const prev = asObject(session.room_idle_memory_maintenance || session.roomIdleMemoryMaintenance);
  const lastRun = Date.parse(String(prev.last_run_at || '')) || 0;
  if (!force && lastRun && interval > 0 && now - lastRun < interval) {
    return { ok: true, skipped: true, reason: 'interval', next_after_ms: interval - (now - lastRun), candidates_created: 0, candidates: [] };
  }
  const turns = asArray(session.recent_room_turns || session.recentRoomTurns || []).slice(-24);
  const activeCompanionId = clean(companionState?.active_companion?.id || session.room_companion_state?.active_companion?.id || '');
  const candidatePool = deriveRoomIdleMemoryCandidates({ turns, roomProfile: roomProfile || session.agent_room_profile || null, activeCompanionId, maxCandidates: Math.max(1, Number(maxCandidates) || 4) * 2 });
  const ids = existingCandidateIds(session, companionState || session.room_companion_state || null);
  const created = [];
  for (const candidate of candidatePool) {
    if (ids.has(candidate.candidate_id)) continue;
    ids.add(candidate.candidate_id);
    created.push(candidate);
    if (created.length >= Math.max(1, Math.floor(Number(maxCandidates) || 4))) break;
  }
  const events = created.map((candidate) => buildRoomIdleMemoryObservationEvent({ candidate, source })).filter(Boolean);
  if (typeof appendEvent === 'function') {
    for (const event of events) appendEvent(event);
  }
  if (store && typeof store.upsert === 'function') {
    store.upsert(chatId, (current = {}) => {
      const existing = asArray(current.room_idle_memory_candidates || current.roomIdleMemoryCandidates || []).map(normalizeRoomIdleMemoryCandidate).filter(Boolean);
      const mergedMap = new Map(existing.map((row) => [row.candidate_id, row]));
      for (const candidate of created) mergedMap.set(candidate.candidate_id, candidate);
      const candidates = Array.from(mergedMap.values()).slice(-30);
      return {
        ...current,
        room_idle_memory_candidates: candidates,
        room_idle_memory_maintenance: {
          kind: 'room_idle_memory_maintenance_v1',
          last_run_at: new Date().toISOString(),
          last_source: source,
          last_candidate_count: created.length,
          last_turn_count: turns.length,
          skipped: false,
          candidate_only: true,
          generalization_policy: 'schema_agnostic_idle_structuring_no_fixed_prompt_routes',
        },
      };
    });
  }
  return { ok: true, skipped: false, candidates_created: created.length, candidates: created, events };
}

export function formatRoomIdleMemoryStructuringResultForTelegram(result = {}) {
  const rows = asArray(result.candidates || []);
  if (result.skipped) {
    return [
      '🧠 Room idle memory structuring',
      `- skipped: ${result.reason || 'unknown'}`,
      result.next_after_ms ? `- next_after_ms: ${result.next_after_ms}` : '',
    ].filter(Boolean).join('\n');
  }
  const lines = [
    '🧠 Room idle memory structuring',
    '- mode: candidate-only, review-required',
    '- policy: schema-agnostic idle structuring; no fixed prompt route or canonical write',
    `- new candidates: ${Number(result.candidates_created || rows.length || 0)}`,
  ];
  rows.forEach((candidate, index) => {
    const c = normalizeRoomIdleMemoryCandidate(candidate);
    if (!c) return;
    lines.push('', `${index + 1}. ${c.observation_type}`);
    lines.push(`   summary: ${c.memory_summary}`);
    lines.push(`   targets: ${c.target_companion_ids.join(', ') || '-'}`);
    lines.push(`   source: ${clip(c.source_quote, 220)}`);
  });
  lines.push('', '다음: /inbox 에서 pending room decisions를 확인하세요. 승인 없이는 canonical memory가 바뀌지 않습니다.');
  return lines.join('\n');
}
