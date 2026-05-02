function clip(text = '', max = 220) {
  const src = String(text || '').trim();
  if (!src) return '';
  if (src.length <= max) return src;
  return `${src.slice(0, Math.max(1, max - 1))}…`;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function textFromAction(action = {}) {
  const row = asObject(action);
  const inputs = asObject(row.inputs);
  const pieces = [
    row.type,
    row.goal,
    row.prompt,
    row.label,
    row.summary,
    inputs.command,
    inputs.shell,
    inputs.path,
    inputs.files,
    inputs.tool_id,
    inputs.required_tool,
    inputs.required_tools,
    inputs.required_credentials,
    inputs.required_capabilities,
  ];
  return pieces
    .flatMap((part) => Array.isArray(part) ? part : [part])
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

function matchAny(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

const CAPACITY_EXHAUSTED_PATTERNS = [
  /MODEL_CAPACITY_EXHAUSTED/i,
  /No capacity available for model/i,
  /capacity_exhausted/i,
  /capacity circuit/i,
  /RESOURCE_EXHAUSTED/i,
];

const TRANSIENT_PATTERNS = [
  /429/,
  /rate limit/,
  /timeout/,
  /timed out/,
  /temporar(?:y|ily)/,
  /capacity/,
  /try again/,
  /connection reset/,
  /econnreset/,
  /eai_again/,
  /service unavailable/,
  /overloaded/,
  /network/i,
];

const CREDENTIAL_PATTERNS = [
  /api[_ -]?key/,
  /access token/,
  /missing.*credential/,
  /credential.*(?:missing|required|not set|invalid|expired|unavailable|denied)/,
  /unauthorized/,
  /forbidden/,
  /auth(?:entication|orization)? failed/,
  /missing.*(?:key|token|credential)/,
  /not set/,
  /please provide .*key/,
  /invalid api key/,
  /permission denied/,
];

const CAPABILITY_PATTERNS = [
  /callback is missing/,
  /not implemented/,
  /tool .* unavailable/,
  /workspace_fs/,
  /required tool/,
  /required capability/,
  /cannot find tool/,
  /memory_mode=goc/,
  /goc .* unavailable/,
  /no such file or directory/,
];

const AMBIGUITY_PATTERNS = [
  /need more detail/,
  /additional input/,
  /ambiguous/,
  /unclear/,
  /which (?:one|file|path|option)/,
  /missing requirement/,
  /followup needed/,
  /user input required/,
];

const IMPLEMENTATION_PATTERNS = [
  /test(?:s)? failed/,
  /verification failed/,
  /assert(?:ion)?/,
  /traceback/,
  /syntaxerror/,
  /typeerror/,
  /referenceerror/,
  /module not found/,
  /cannot find module/,
  /compile(?:r)? error/,
  /build failed/,
  /lint(?:ing)? failed/,
  /import error/,
  /repair/,
];

const POLICY_PATTERNS = [
  /approval required/,
  /approval denied/,
  /authority approval/,
  /blocked by policy/,
  /verification blocked/,
  /publish contract blocked/,
  /final synthesis.*final_answer surface/,
  /final_answer_owner/,
  /declared .*publish surface/,
];


const INTERRUPT_PATTERNS = [
  /\[aborted\]/,
  /cancelled/,
  /canceled/,
  /interrupt(?:ed|ion)?/,
  /superseded by replan/,
  /user requested stop/,
  /stopped by user/,
];

export function classifyExecutionFailure({ error, action = {}, provider = '', runtimeExecutionPolicy = {}, agents = [] } = {}) {
  const message = String(error?.message ?? error ?? '').trim();
  const lower = message.toLowerCase();
  const actionType = String(action?.type || '').trim().toLowerCase();
  const actionText = textFromAction(action);
  const continuousImprovementEnabled = runtimeExecutionPolicy?.continuous_improvement?.enabled === true;
  const hasScout = findRecoveryScoutAgentId(agents, { excludeAgentId: String(action?.agent_id || '').trim().toLowerCase() }) !== '';

  let category = 'unknown_failure';
  let recoveryStrategy = 'stop';
  let summary = '실패 원인을 자동 분류하지 못해 이번 턴을 멈췄습니다.';
  let userMessage = '오류 로그를 확인하거나 요청을 조금 더 구체화해 다시 지시해 주세요.';
  let retryable = false;
  let userActionRequired = false;

  if (matchAny(lower, INTERRUPT_PATTERNS)) {
    category = 'user_interrupted';
    recoveryStrategy = 'stop';
    summary = '사용자 중단 또는 재계획 요청으로 현재 실행을 정리했습니다.';
    userMessage = '새 요청 기준으로 다시 이어서 진행하면 됩니다.';
  } else if (matchAny(lower, POLICY_PATTERNS)) {
    category = 'policy_blocked';
    recoveryStrategy = /publish contract/.test(lower) || /final_answer/.test(lower)
      ? 'await_user'
      : 'await_approval';
    summary = /publish contract/.test(lower) || /final_answer/.test(lower)
      ? '팀의 publish contract에 막혀 자동 진행하지 못했습니다.'
      : '정책/승인에 막혀 자동 진행하지 못했습니다.';
    userMessage = /publish contract/.test(lower) || /final_answer/.test(lower)
      ? '최종 답변 담당 또는 publish surface 선언을 조정해 주세요.'
      : '승인하거나 요청 범위를 낮춰 주세요.';
    userActionRequired = true;
  } else if (matchAny(message, CAPACITY_EXHAUSTED_PATTERNS) || matchAny(lower, CAPACITY_EXHAUSTED_PATTERNS)) {
    category = 'transient_infra';
    recoveryStrategy = 'stop';
    summary = 'Gemini 모델 capacity 부족 또는 429로 provider wrapper가 이미 모델 전환/재시도를 시도한 뒤 중단했습니다.';
    userMessage = '잠시 후 다시 시도하거나 더 가벼운 모델로 바꿔 주세요.';
    retryable = false;
  } else if (matchAny(lower, TRANSIENT_PATTERNS)) {
    category = 'transient_infra';
    recoveryStrategy = 'retry_once';
    summary = '일시적인 인프라/모델 호출 실패로 보입니다.';
    userMessage = '잠시 후 자동 재시도를 진행합니다.';
    retryable = true;
  } else if (matchAny(lower, CREDENTIAL_PATTERNS)) {
    category = 'credential_gap';
    recoveryStrategy = 'await_user';
    summary = '필요한 credential 또는 인증이 부족합니다.';
    userMessage = '필요한 credential을 bind/set 하거나 권한 범위를 조정해 주세요.';
    userActionRequired = true;
  } else if (matchAny(lower, CAPABILITY_PATTERNS)) {
    category = 'capability_gap';
    recoveryStrategy = 'await_user';
    summary = '필요한 tool/capability가 현재 runtime에 없습니다.';
    userMessage = '팀 구성을 바꾸거나 필요한 tool/capability를 설치해 주세요.';
    userActionRequired = true;
  } else if (matchAny(lower, AMBIGUITY_PATTERNS)) {
    category = 'missing_context';
    recoveryStrategy = 'await_user';
    summary = '요구사항이 모호하거나 추가 정보가 필요합니다.';
    userMessage = '원하는 산출물, 파일 위치, 성공 기준을 조금 더 구체적으로 알려 주세요.';
    userActionRequired = true;
  } else if (actionType === 'tool_proxy_call' || matchAny(lower, IMPLEMENTATION_PATTERNS)) {
    category = 'implementation_failure';
    recoveryStrategy = hasScout ? 'search_then_retry' : 'retry_once';
    summary = hasScout
      ? '구현/검증 실패라서 다른 agent가 원인을 찾은 뒤 다시 시도할 수 있습니다.'
      : '구현/검증 실패라서 같은 작업을 한 번 더 시도할 수 있습니다.';
    userMessage = '자동 복구 후에도 계속 실패하면 유저 재지시가 필요합니다.';
    retryable = true;
  } else if (continuousImprovementEnabled && hasScout && (actionType === 'run_agent' || actionType === 'spawn_agents')) {
    category = 'implementation_failure';
    recoveryStrategy = 'search_then_retry';
    summary = '반복 개선 모드에서 다른 agent의 진단 후 재시도할 수 있습니다.';
    userMessage = '자동 진단/재시도를 해보고, 계속 실패하면 추가 지시를 요청합니다.';
    retryable = true;
  }

  return {
    category,
    recovery_strategy: recoveryStrategy,
    summary,
    user_message: userMessage,
    retryable,
    user_action_required: userActionRequired,
    message: clip(message, 220),
    provider: String(provider || '').trim().toLowerCase(),
    action_type: actionType,
    action_preview: clip(actionText, 220),
  };
}

export function findRecoveryScoutAgentId(agents = [], { excludeAgentId = '' } = {}) {
  const excludeKey = String(excludeAgentId || '').trim().toLowerCase();
  const rows = Array.isArray(agents) ? agents : [];
  const preferred = [
    /researcher/,
    /scout/,
    /investigator/,
    /analyst/,
    /reviewer/,
  ];
  for (const pattern of preferred) {
    const found = rows.find((row) => {
      const id = String(row?.id || row?.agent_id || '').trim().toLowerCase();
      if (!id || id === excludeKey) return false;
      const text = [row?.id, row?.name, row?.role, row?.system_key, row?.provider].map((part) => String(part || '').trim().toLowerCase()).join(' ');
      return pattern.test(text);
    });
    const id = String(found?.id || found?.agent_id || '').trim().toLowerCase();
    if (id) return id;
  }
  return '';
}

export function buildFailureRecoveryScoutGoal({ action = {}, failure = {}, attempt = 1 } = {}) {
  const agentId = String(action?.agent_id || '').trim().toLowerCase();
  const goal = String(action?.goal || action?.prompt || '').trim();
  return [
    '방금 실패한 실행을 빠르게 진단해 주세요.',
    agentId ? `실패한 agent: ${agentId}` : '',
    goal ? `원래 목표: ${goal}` : '',
    failure?.category ? `실패 분류: ${failure.category}` : '',
    failure?.message ? `오류 요약: ${failure.message}` : '',
    `시도 번호: ${attempt}`,
    '다음 형식으로 답하세요:',
    '1) probable_cause: 한 줄',
    '2) fix_strategy: 한 줄',
    '3) retry_patch: 재시도 시 반영할 핵심 지시 3줄 이내',
  ].filter(Boolean).join('\n');
}

const CRITICAL_CODEX_PATTERNS = [
  /\brm\s+-rf\b/,
  /\bdelete\b/,
  /\bdrop table\b/,
  /\btruncate\b/,
  /\bmigration\b/,
  /\bschema\b/,
  /\bdeploy\b/,
  /\bproduction\b/,
  /\bprod\b/,
  /\bpublish\b/,
  /\brelease\b/,
  /\bsecret\b/,
  /\bcredential\b/,
  /\bapi[_ -]?key\b/,
  /\brotate\b/,
  /\bterraform apply\b/,
  /\bkubectl\b/,
  /\bsystemctl\b/,
  /\bsudo\b/,
];

function riskScore(raw = 'L0') {
  const key = String(raw || 'L0').trim().toUpperCase();
  if (key === 'L3') return 3;
  if (key === 'L2') return 2;
  if (key === 'L1') return 1;
  return 0;
}

export function resolveProviderActionRisk({ action = {}, provider = '', fallback = 'L1' } = {}) {
  const providerKey = String(provider || '').trim().toLowerCase();
  const currentRisk = String(action?.risk || fallback).trim().toUpperCase() || fallback;
  if (providerKey !== 'codex') return currentRisk;
  const actionText = textFromAction(action);
  const desiredRisk = matchAny(actionText, CRITICAL_CODEX_PATTERNS) ? 'L3' : 'L2';
  return riskScore(currentRisk) > riskScore(desiredRisk) ? desiredRisk : desiredRisk;
}


export function buildRecoveryAttemptEvent({ action = {}, failure = {}, attempt = 1, stage = 'classified', status = '', scoutAgentId = '', note = '' } = {}) {
  const resolvedStatus = String(status || '').trim().toLowerCase()
    || (failure?.user_action_required ? 'blocked' : failure?.retryable ? 'retrying' : 'classified');
  return {
    ts: new Date().toISOString(),
    attempt_no: Math.max(1, Number(attempt) || 1),
    stage: String(stage || 'classified').trim().toLowerCase() || 'classified',
    status: resolvedStatus,
    category: String(failure?.category || '').trim() || 'unknown_failure',
    recovery_strategy: String(failure?.recovery_strategy || '').trim() || 'stop',
    summary: clip(String(failure?.summary || '').trim(), 220),
    message: clip(String(failure?.message || '').trim(), 220),
    retryable: failure?.retryable === true,
    user_action_required: failure?.user_action_required === true,
    action_type: String(action?.type || '').trim().toLowerCase() || undefined,
    agent_id: String(action?.agent_id || action?.agentId || '').trim().toLowerCase() || undefined,
    provider: String(action?.provider || failure?.provider || '').trim().toLowerCase() || undefined,
    scout_agent_id: String(scoutAgentId || '').trim().toLowerCase() || undefined,
    note: clip(String(note || '').trim(), 220) || undefined,
  };
}
