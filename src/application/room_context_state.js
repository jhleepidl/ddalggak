function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 400) {
  const text = clean(value);
  const n = Math.max(60, Math.floor(Number(max) || 400));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function uniquePush(list, value, max = 6) {
  const text = clean(value);
  if (!text) return;
  if (list.some((item) => clean(item).toLowerCase() === text.toLowerCase())) return;
  list.push(text);
  if (list.length > max) list.splice(0, list.length - max);
}

function matchAll(text = '', regex) {
  const out = [];
  const source = clean(text);
  if (!source || !(regex instanceof RegExp)) return out;
  const global = regex.global ? regex : new RegExp(regex.source, `${regex.flags || ''}g`);
  for (const match of source.matchAll(global)) {
    const value = clean(match[1] || match[0] || '');
    if (value) out.push(value);
  }
  return out;
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function observationText(observation = {}) {
  if (!observation || typeof observation !== 'object') return clean(observation);
  return clean(observation.text || observation.summary || observation.value || observation.label || observation.content || '');
}

function normalizeSemanticObservation(observation = {}, sourceTurn = {}) {
  const text = observationText(observation);
  if (!text) return null;
  const obj = observation && typeof observation === 'object' ? observation : {};
  return {
    type: clean(obj.type || obj.kind || 'context_observation'),
    text: clip(text, 260),
    confidence: clean(obj.confidence || '') || undefined,
    source_turn_id: clean(obj.source_turn_id || sourceTurn.turn_id || sourceTurn.turnId || sourceTurn.id) || undefined,
    source_role: clean(obj.source_role || sourceTurn.role) || undefined,
  };
}

function extractTurnSemanticObservations(turn = {}) {
  const out = [];
  for (const key of ['semantic_observations', 'semanticObservations', 'room_context_observations', 'roomContextObservations']) {
    for (const item of asList(turn?.[key])) {
      const normalized = normalizeSemanticObservation(item, turn);
      if (normalized) out.push(normalized);
    }
  }
  return out;
}

function turnKey(turn = {}) {
  const id = clean(turn.turn_id || turn.turnId || turn.id);
  if (id) return id;
  return `${clean(turn.role)}:${clean(turn.text).slice(0, 80)}`;
}

function isSystemLikeAssistantStatus(text = '') {
  const s = clean(text);
  return /^⚡\s*\/|^🧭\s*이번 턴 계획|^🧩\s*Agent 협업|^🤖\s*Research Lead 완료/.test(s);
}

function isAssistantRecommendation(turn = {}) {
  if (turn?.role !== 'assistant') return false;
  const text = clean(turn.text);
  return /추천|1픽|후보|메뉴|매장|식당|드실 수|먹기 좋|조합|세트|정식|덮밥|샐러드|소바|초밥|찌개/.test(text);
}

function extractRecommendations(text = '') {
  const out = [];
  const source = clean(text);
  if (!source) return out;
  for (const bold of matchAll(source, /\*\*([^*]{2,48})\*\*/g)) uniquePush(out, bold, 10);
  for (const item of matchAll(source, /(?:^|[\n\r]|\*|-|\d+\.)\s*([가-힣A-Za-z0-9&()·\-\s]{2,42}(?:점|집|식당|포케|샐러드|찌개|소바|초밥|덮밥|웜볼|샐러디|세트|정식|스프|메밀면))/g)) uniquePush(out, item, 10);
  return out;
}

function hasExternalEvidence(text = '') {
  const s = clean(text);
  return /https?:\/\//i.test(s) || /출처\s*[:：]|source\s*[:：]|검색 결과|공식|네이버지도|카카오맵|주소\s*[:：]|영업/.test(s);
}

function looksLikeVerificationRequest(text = '') {
  const s = clean(text);
  return /실제로|검증|확인|검색|진짜|실제 있는|시킬 수 있는|배달.*가능|배달.*되는|근거|출처/.test(s);
}

function looksLikeReferentialFollowup(text = '') {
  const s = clean(text);
  if (!s) return false;
  return looksLikeVerificationRequest(s)
    || /각각|그거|그게|그걸|그 메뉴|이거|이게|이걸|위에|방금|직전|앞서|추천.*메뉴|메뉴들|후보들|걔네|저것/.test(s)
    || /(?:맞아|맞나요|맞는지|야\?|인가\?|돼\?|될까\?|가능해\?)/.test(s);
}

function previousAssistantBeforeLatest(rows = [], latestUserText = '') {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const latest = clean(latestUserText);
  let latestIndex = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const turn = rows[i] || {};
    if (clean(turn.role).toLowerCase() === 'user' && (!latest || clean(turn.text) === latest)) {
      latestIndex = i;
      break;
    }
  }
  const stop = latestIndex >= 0 ? latestIndex - 1 : rows.length - 1;
  for (let i = stop; i >= 0; i -= 1) {
    const turn = rows[i] || {};
    if (clean(turn.role).toLowerCase() === 'assistant' && clean(turn.text) && !isSystemLikeAssistantStatus(turn.text)) return { turn, index: i };
  }
  return null;
}

function buildLatestReferent({ rows = [], latestUserText = '' } = {}) {
  if (!looksLikeReferentialFollowup(latestUserText)) return null;
  const prev = previousAssistantBeforeLatest(rows, latestUserText);
  if (!prev?.turn) return null;
  const turn = prev.turn;
  const text = clean(turn.text);
  const items = extractRecommendations(text);
  const isVerification = looksLikeVerificationRequest(latestUserText);
  const isRecommendation = isAssistantRecommendation(turn);
  return {
    kind: 'latest_dialogue_referent_v1',
    relation: isVerification ? 'verification_of_immediate_previous_assistant_answer' : 'followup_to_immediate_previous_assistant_answer',
    target: 'immediate_previous_assistant_answer',
    turn_id: clean(turn.turn_id || turn.turnId || turn.id) || undefined,
    route: clean(turn.route) || undefined,
    source: clean(turn.source) || undefined,
    text_excerpt: clip(text, 520),
    extracted_items: items.slice(-8),
    has_external_evidence: hasExternalEvidence(text),
    confidence: isVerification || isRecommendation ? 'high' : 'medium',
    policy: 'For this latest follow-up, resolve ambiguous objects against the immediate previous assistant answer before older room memories or recommendations.',
  };
}

function addUserContextStatement(state, turn = {}, index = 0, max = 8) {
  const text = clean(turn.text);
  if (!text) return;
  const statement = {
    turn_id: clean(turn.turn_id || turn.turnId || turn.id) || undefined,
    index,
    text: clip(text, 240),
  };
  const key = turnKey(turn);
  if (state.recent_user_context.some((item) => clean(item.key) === key)) return;
  state.recent_user_context.push({ key, ...statement });
  if (state.recent_user_context.length > max) state.recent_user_context.splice(0, state.recent_user_context.length - max);
}

function addSemanticObservation(state, observation = {}, max = 10) {
  const text = observationText(observation);
  if (!text) return;
  if (state.semantic_observations.some((item) => clean(item.text).toLowerCase() === text.toLowerCase())) return;
  state.semantic_observations.push(normalizeSemanticObservation(observation));
  if (state.semantic_observations.length > max) state.semantic_observations.splice(0, state.semantic_observations.length - max);
}

export function deriveRoomContextState({ turns = [], latestUserText = '', semanticObservations = [] } = {}) {
  const rows = Array.isArray(turns) ? turns.filter((turn) => turn && typeof turn === 'object') : [];
  const latestReferent = buildLatestReferent({ rows, latestUserText });
  const state = {
    kind: 'room_context_state_v2',
    semantic_strategy: 'schema_agnostic_agent_observations_plus_recent_user_context',
    semantic_observations: [],
    recent_user_context: [],
    recent_assistant_recommendations: [],
    externally_verified_recommendations: [],
    unverified_assistant_recommendations: [],
    latest_dialogue_referent: latestReferent || undefined,
    latest_user_requires_verification: looksLikeVerificationRequest(latestUserText),
    warnings: [],
  };

  for (const observation of (Array.isArray(semanticObservations) ? semanticObservations : [])) addSemanticObservation(state, observation, 10);

  rows.forEach((turn, index) => {
    const role = clean(turn.role).toLowerCase();
    const text = clean(turn.text);
    if (!text) return;
    for (const observation of extractTurnSemanticObservations(turn)) addSemanticObservation(state, observation, 10);
    if (role === 'user') addUserContextStatement(state, turn, index, 8);
    if (role === 'assistant' && isAssistantRecommendation(turn)) {
      const recs = extractRecommendations(text);
      for (const rec of recs) uniquePush(state.recent_assistant_recommendations, rec, 10);
      if (hasExternalEvidence(text) && (turn.route === 'concierge_search_answer' || turn.source === 'room_concierge_search_fast_path')) {
        for (const rec of recs) uniquePush(state.externally_verified_recommendations, rec, 10);
      } else {
        for (const rec of recs) uniquePush(state.unverified_assistant_recommendations, rec, 10);
      }
    }
  });

  if (state.latest_user_requires_verification && state.latest_dialogue_referent) {
    state.warnings.push('latest_verification_targets_immediate_previous_assistant_answer');
    if (!state.latest_dialogue_referent.has_external_evidence) state.warnings.push('dialogue_referent_has_no_external_evidence');
  } else if (state.latest_user_requires_verification && state.unverified_assistant_recommendations.length && !state.externally_verified_recommendations.length) {
    state.warnings.push('previous_assistant_recommendations_are_unverified');
  }
  if (!state.semantic_observations.length) {
    state.warnings.push('no_agent_semantic_observations_available_using_recent_user_context_quotes');
  }
  return state;
}

export function summarizeRoomContextState(state = {}, { maxItems = 5 } = {}) {
  const s = state && typeof state === 'object' ? state : {};
  const n = Math.max(1, Math.floor(Number(maxItems) || 5));
  const lines = ['[ROOM CONTEXT STATE]'];
  lines.push(`semantic_strategy: ${s.semantic_strategy || 'schema_agnostic_agent_observations_plus_recent_user_context'}`);
  const ref = s.latest_dialogue_referent && typeof s.latest_dialogue_referent === 'object' ? s.latest_dialogue_referent : null;
  if (s.latest_user_requires_verification) {
    lines.push('latest_user_requires_verification: true');
  }
  if (ref) {
    lines.push('[DIALOGUE REFERENCE TARGET]');
    lines.push(`target: ${ref.target || 'immediate_previous_assistant_answer'}`);
    lines.push(`relation: ${ref.relation || 'followup_to_immediate_previous_assistant_answer'}`);
    if (Array.isArray(ref.extracted_items) && ref.extracted_items.length) {
      lines.push(`target_items: ${ref.extracted_items.slice(-n).map((x) => clip(x, 80)).join(' / ')}`);
    }
    if (ref.text_excerpt) lines.push(`target_excerpt: ${clip(ref.text_excerpt, 360)}`);
    lines.push('target_policy: The latest user request refers to this immediate previous assistant answer. Do not substitute older recommendations unless the user explicitly asks for older context.');
    if (s.latest_user_requires_verification) {
      lines.push(`target_external_evidence: ${ref.has_external_evidence ? 'present_in_target' : 'not_present_in_target'}`);
      lines.push('verification_focus: verify or qualify the target_items above, not earlier recommendation sets.');
    }
  }
  if (Array.isArray(s.warnings) && s.warnings.length) {
    lines.push(`warnings: ${s.warnings.join(', ')}`);
  }
  if (Array.isArray(s.semantic_observations) && s.semantic_observations.length) {
    lines.push('[AGENT-EXTRACTED SEMANTIC OBSERVATIONS]');
    for (const obs of s.semantic_observations.slice(-n)) {
      lines.push(`- ${obs.type || 'context_observation'}: ${clip(obs.text, 110)}${obs.confidence ? ` (${obs.confidence})` : ''}`);
    }
  }
  if (Array.isArray(s.recent_user_context) && s.recent_user_context.length) {
    lines.push('[RECENT USER CONTEXT QUOTES]');
    for (const item of s.recent_user_context.slice(-n)) lines.push(`- ${clip(item.text, 120)}`);
  }
  if (!ref && Array.isArray(s.recent_assistant_recommendations) && s.recent_assistant_recommendations.length) {
    lines.push(`recent_assistant_recommendations: ${s.recent_assistant_recommendations.slice(-n).map((x) => clip(x, 80)).join(' / ')}`);
  }
  if (!ref && Array.isArray(s.externally_verified_recommendations) && s.externally_verified_recommendations.length) {
    lines.push(`verified_recommendations_with_evidence: ${s.externally_verified_recommendations.slice(-n).map((x) => clip(x, 80)).join(' / ')}`);
  }
  if (!ref && Array.isArray(s.unverified_assistant_recommendations) && s.unverified_assistant_recommendations.length) {
    lines.push(`unverified_assistant_recommendations: ${s.unverified_assistant_recommendations.slice(-n).map((x) => clip(x, 80)).join(' / ')}`);
  }
  if (!ref && s.latest_user_requires_verification) {
    lines.push('latest_user_requires_verification: true');
  }
  if (lines.length === 1) return '';
  return lines.join('\n');
}
