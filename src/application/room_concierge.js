import {
  applyLearnedRoomConciergeModel,
  extractRoomConciergeFeatureVector,
  scoreRoomConciergeRoutes,
} from './room_concierge_model.js';

function clean(value = '') {
  return String(value || '').trim();
}

function includesAny(text = '', needles = []) {
  const lower = clean(text).toLowerCase();
  return needles.some((needle) => lower.includes(String(needle || '').toLowerCase()));
}

function countHangulOrWordTokens(text = '') {
  const compact = clean(text);
  if (!compact) return 0;
  const words = compact.split(/\s+/).filter(Boolean).length;
  const chars = Array.from(compact).length;
  return Math.max(words, Math.ceil(chars / 12));
}

const DEFAULT_FAST_PATH_POLICY = Object.freeze({
  enabled: true,
  max_chars: 420,
  max_tokenish_units: 55,
  allow_followup_context: false,
});

const TEAM_OR_LOOP_NEEDLES = [
  '/team', '/loop', '팀', '여러 agent', '여러 에이전트', 'multi-agent', 'multi agent', '검토해', '리뷰해', '토론', '비판', '회의',
];

const WORKBENCH_NEEDLES = [
  '패치', '수정해', '구현', '테스트 돌', '테스트 실행', '파일', 'zip', '번들', '첨부', '소스', '코드', '리팩터', '배포',
  'pull request', 'commit', 'diff', 'repo', 'repository', 'workspace',
];

const ARTIFACT_REFERENCE_NEEDLES = [
  '업로드', '올렸', '올린', '메뉴 이미지', '메뉴 사진', '이미지', '사진', '캡처', '첨부한', '첨부', '파일', '전에 upload',
  'uploaded', 'upload', 'image', 'photo', 'screenshot', 'attachment', 'attached',
];

const SEARCH_NEEDLES = [
  '검색', '찾아봐', '찾아보고', '실제로', '최신', '현재', '공식', '메뉴판', '네이버', '인스타', '링크', '웹', '인터넷',
  'search', 'browse', 'lookup', 'latest', 'current', 'official', 'website',
];

const HIGH_RISK_NEEDLES = [
  '법률', '의학', '진단', '투자', '주식 추천', '세금', '계약서', '개인정보', '비밀번호', 'credential', 'secret',
  '법적', '의료', '처방', '금융',
];

const SIMPLE_QA_NEEDLES = [
  '추천', '설명', '요약', '정리', '차이', '뭐', '어떻게', '왜', '아이디어', '문장', '번역', '맛집', '메뉴',
  'recommend', 'explain', 'summarize', 'what', 'how', 'why', 'translate',
];

export function classifyRoomConciergeRoute({
  text = '',
  command = '/ask',
  hasAttachment = false,
  pendingApproval = false,
  busy = false,
  policy = {},
  learnedModel = null,
  roomFootprint = null,
  recentRouteStats = null,
} = {}) {
  const message = clean(text);
  const mergedPolicy = { ...DEFAULT_FAST_PATH_POLICY, ...(policy && typeof policy === 'object' ? policy : {}) };
  const reasons = [];
  const blockers = [];
  const signals = [];
  const tokenish = countHangulOrWordTokens(message);
  const charCount = Array.from(message).length;
  const lowerCommand = clean(command).toLowerCase() || '/ask';

  if (!message) blockers.push('empty_message');
  if (!['/ask', '/chat', '/c'].includes(lowerCommand)) blockers.push('not_conversational_command');
  if (hasAttachment) blockers.push('has_attachment');
  if (pendingApproval) blockers.push('pending_approval');
  if (busy) blockers.push('busy_chat');
  if (!mergedPolicy.enabled) blockers.push('fast_path_disabled');
  if (charCount > Number(mergedPolicy.max_chars || DEFAULT_FAST_PATH_POLICY.max_chars)) blockers.push('message_too_long');
  if (tokenish > Number(mergedPolicy.max_tokenish_units || DEFAULT_FAST_PATH_POLICY.max_tokenish_units)) blockers.push('message_too_complex');

  if (includesAny(message, HIGH_RISK_NEEDLES)) signals.push('high_risk_domain');
  if (includesAny(message, WORKBENCH_NEEDLES)) signals.push('workbench_intent');
  if (includesAny(message, TEAM_OR_LOOP_NEEDLES)) signals.push('team_or_review_intent');
  if (includesAny(message, SEARCH_NEEDLES)) signals.push('search_or_freshness_intent');
  if (includesAny(message, ARTIFACT_REFERENCE_NEEDLES)) signals.push('artifact_reference_intent');
  if (includesAny(message, SIMPLE_QA_NEEDLES)) signals.push('simple_qa_intent');

  if (signals.includes('team_or_review_intent')) blockers.push('needs_team_or_review');
  if (signals.includes('workbench_intent')) blockers.push('needs_workspace_or_artifact');
  if (signals.includes('artifact_reference_intent')) blockers.push('needs_artifact_context');
  if (signals.includes('high_risk_domain')) blockers.push('needs_standard_safety_context');

  let route = 'standard_workbench';
  let depth = 'workbench';
  let shouldBypassWorkbench = false;
  let shouldShowPlanPreview = true;
  let answerMode = 'standard_ai_room_pipeline';

  if (blockers.length === 0 && signals.includes('search_or_freshness_intent')) {
    route = 'concierge_search_answer';
    depth = 'single_agent_search';
    shouldBypassWorkbench = true;
    shouldShowPlanPreview = false;
    answerMode = 'bounded_search_minimal_prompt';
    reasons.push('freshness_or_search_requested');
  } else if (blockers.length === 0) {
    route = 'concierge_direct_answer';
    depth = 'direct_answer';
    shouldBypassWorkbench = true;
    shouldShowPlanPreview = false;
    answerMode = 'single_model_minimal_prompt';
    reasons.push(lowerCommand === '/ask' ? 'short_low_risk_ask' : 'short_low_risk_chat');
  } else if (signals.includes('team_or_review_intent')) {
    route = 'team_orchestration';
    depth = 'team';
    reasons.push('team_or_review_requested');
  } else {
    reasons.push('standard_pipeline_required');
  }

  const baseDecision = {
    kind: 'room_concierge_route_v1',
    route,
    depth,
    should_bypass_workbench: shouldBypassWorkbench,
    should_show_plan_preview: shouldShowPlanPreview,
    answer_mode: answerMode,
    reasons: [...new Set(reasons)],
    signals: [...new Set(signals)],
    blockers: [...new Set(blockers)],
    metrics: { char_count: charCount, tokenish_units: tokenish },
    policy: mergedPolicy,
  };

  if (learnedModel && typeof learnedModel === 'object') {
    const features = extractRoomConciergeFeatureVector({
      text: message,
      baseDecision,
      hasAttachment,
      pendingApproval,
      busy,
      roomFootprint,
      recentRouteStats,
    });
    const score = scoreRoomConciergeRoutes({ model: learnedModel, features, baseDecision });
    return applyLearnedRoomConciergeModel({ baseDecision: { ...baseDecision, features }, modelScore: score, model: learnedModel });
  }

  return baseDecision;
}

export function shouldUseDirectAskFastPath(decision = {}) {
  return decision?.route === 'concierge_direct_answer' && decision?.should_bypass_workbench === true;
}

export function shouldUseSearchAskPath(decision = {}) {
  return decision?.route === 'concierge_search_answer';
}

export function buildDirectAskPrompt({ question = '', locale = 'ko-KR', roomName = '', context = '' } = {}) {
  const q = clean(question);
  const roomLine = clean(roomName) ? `Room: ${clean(roomName)}` : '';
  const ctx = String(context || '').trim();
  return [
    'You are DdalGgak Room Concierge direct chat mode.',
    'Answer the user directly and briefly. Do not mention routing, agents, plans, traces, or internal memory.',
    'Use the provided room context snapshot only as lightweight continuity; do not treat it as a separate hidden conversation.',
    'LATEST TURN IS AUTHORITATIVE: answer only the user question below. Do not answer previous questions unless the user explicitly asks you to recall them.',
    'For casual recommendations, give practical choices. For uncertainty, say what is uncertain without over-explaining.',
    'Do not claim you searched the web unless the prompt explicitly includes search results.',
    `Locale: ${locale || 'ko-KR'}`,
    roomLine,
    ctx ? ctx : '',
    '',
    `User question:\n${q}`,
  ].filter(Boolean).join('\n');
}

export function buildSearchAskFallbackPrompt({ question = '', locale = 'ko-KR', maxSeconds = 20, context = '' } = {}) {
  const q = clean(question);
  const ctx = String(context || '').trim();
  return [
    'You are DdalGgak Room Concierge search-intent mode.',
    'The user requested fresh or external information. If no reliable source is available to you, say so clearly and ask for a link/photo/source rather than inventing details.',
    'Verification rule: previous assistant recommendations, direct-path guesses, and room continuity are NOT external evidence. Do not answer “yes, verified” unless the prompt includes explicit source evidence or your tool run produced it.',
    'Referent rule: if the context contains a DIALOGUE REFERENCE TARGET, the latest follow-up is about that immediate previous assistant answer. Verify or qualify those target items; do not switch to older recommendations just because they are also in room history.',
    'If the user asks whether prior suggestions are actually available/verified and you lack source evidence, answer that the referenced suggestions were prior recommendations, not verified results, then ask to run/search with a source-capable provider or request app screenshots/links.',
    'Use recent room continuity and room context state to resolve omitted referents, constraints, preferences, and user-provided facts. Do not rely on domain-specific slot guessing; use the schema-agnostic context observations and recent user context quotes.',
    `Keep the answer concise. Search budget expectation: ${Math.max(1, Number(maxSeconds || 20))} seconds.`,
    `Locale: ${locale || 'ko-KR'}`,
    ctx ? ctx : '',
    '',
    `User request:\n${q}`,
  ].filter(Boolean).join('\n');
}

export function formatRoomConciergeDebugLines(decision = {}) {
  const d = decision && typeof decision === 'object' ? decision : {};
  return [
    `route=${d.route || 'unknown'}`,
    `depth=${d.depth || 'unknown'}`,
    `signals=${Array.isArray(d.signals) && d.signals.length ? d.signals.join(',') : 'none'}`,
    `blockers=${Array.isArray(d.blockers) && d.blockers.length ? d.blockers.join(',') : 'none'}`,
    `reasons=${Array.isArray(d.reasons) && d.reasons.length ? d.reasons.join(',') : 'none'}`,
  ];
}
