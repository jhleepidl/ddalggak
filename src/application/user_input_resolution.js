import { normalizeInputRequest } from '../shared/input_request_schema.js';

function clean(value = '') {
  return String(value || '').trim();
}

function cleanKey(value = '') {
  return clean(value).toLowerCase();
}

function clip(text = '', max = 220) {
  const src = clean(text);
  if (!src) return '';
  if (src.length <= max) return src;
  return `${src.slice(0, Math.max(1, max - 1))}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function collectRequestText(request = {}, action = {}) {
  return [
    request?.request_kind,
    request?.category,
    request?.reason,
    request?.followup_hint,
    request?.prompt,
    action?.goal,
    action?.label,
    action?.type,
    action?.inputs?.final_synthesis === true ? 'final_synthesis' : '',
  ].map((part) => clean(part).toLowerCase()).filter(Boolean).join('\n');
}

function normalizeAgentRows(agents = []) {
  return (Array.isArray(agents) ? agents : [])
    .map((row) => ({
      raw: row && typeof row === 'object' ? row : {},
      id: cleanKey(row?.id || row?.agent_id),
      role: cleanKey(row?.role || row?.role_id || row?.roleId || row?.role_profile?.role),
      provider: cleanKey(row?.provider || row?.provider_spec?.provider),
      model: clean(row?.model || row?.provider_spec?.model),
      label: clean(row?.name || row?.label || row?.agent_id || row?.id),
    }))
    .filter((row) => row.id);
}

function isCriticalUserDecision({ request = {}, action = {} } = {}) {
  const category = cleanKey(request?.category);
  const requestKind = cleanKey(request?.request_kind);
  const text = collectRequestText(request, action);
  if (request?.human_required === true) return true;
  if (['credential_gap', 'policy_blocked', 'capability_gap'].includes(category)) return true;
  if (['credential_request', 'human_decision', 'capability_request'].includes(requestKind)) return true;
  const criticalPatterns = [
    /approval/,
    /approve/,
    /publish contract/,
    /final owner/,
    /artifact publisher/,
    /choose/,
    /which one/,
    /user decision required/,
    /confirm/,
    /credential/,
    /token/,
    /api key/,
    /권한/,
    /승인/,
    /선택/,
    /결정/,
    /최종 답변 담당/,
    /publish/,
  ];
  return criticalPatterns.some((pattern) => pattern.test(text));
}

function preferredRolesForRequest(request = {}) {
  const kind = cleanKey(request?.request_kind);
  const category = cleanKey(request?.category);
  if (kind === 'artifact_clarification') return ['synthesizer', 'reviewer', 'critic', 'researcher', 'builder'];
  if (kind === 'design_clarification') return ['reviewer', 'critic', 'architect', 'researcher', 'builder'];
  if (kind === 'context_resolution' || category === 'missing_context') return ['researcher', 'reviewer', 'analyst', 'builder', 'critic'];
  return ['researcher', 'reviewer', 'analyst', 'critic', 'builder'];
}

function pickDelegateAgents(agents = [], { excludeAgentId = '', request = {} } = {}) {
  const rows = normalizeAgentRows(agents);
  const exclude = cleanKey(excludeAgentId);
  const preferredRoleOrder = preferredRolesForRequest(request);
  const selected = [];
  const seen = new Set();
  for (const role of preferredRoleOrder) {
    for (const found of rows.filter((row) => row.id !== exclude && row.role === role)) {
      if (seen.has(found.id)) continue;
      seen.add(found.id);
      selected.push(found);
      if (selected.length >= 3) return selected;
    }
  }
  for (const row of rows) {
    if (row.id === exclude || seen.has(row.id)) continue;
    seen.add(row.id);
    selected.push(row);
    if (selected.length >= 3) break;
  }
  return selected;
}

export function resolveAwaitUserRequestHandling({ request = {}, action = {}, agents = [], currentAgentId = '' } = {}) {
  const normalizedRequest = normalizeInputRequest(request, {
    fallbackSourceAgentId: currentAgentId || action?.agent_id || action?.agent,
    fallbackActionType: action?.type,
    fallbackActionLabel: action?.label || action?.goal,
  });
  if (asArray(normalizedRequest.resolution_attempts).length >= 2) {
    return {
      resolution: 'ask_user',
      reason: 'delegate_attempt_budget_exhausted',
      request: normalizedRequest,
    };
  }
  if (isCriticalUserDecision({ request: normalizedRequest, action })) {
    return {
      resolution: 'ask_user',
      reason: 'critical_user_decision',
      request: normalizedRequest,
    };
  }
  const delegateAgents = pickDelegateAgents(agents, {
    excludeAgentId: currentAgentId || action?.agent_id || action?.agent,
    request: normalizedRequest,
  });
  if (delegateAgents.length === 0) {
    return {
      resolution: 'ask_user',
      reason: 'no_delegate_agent_available',
      request: normalizedRequest,
    };
  }
  return {
    resolution: 'delegate_agent',
    reason: 'delegate_reasoning_subtask',
    request: {
      ...normalizedRequest,
      candidate_resolver_agent_ids: delegateAgents.map((row) => row.id),
      resolution_strategy: 'delegate_then_user',
    },
    candidate_resolver_agent_ids: delegateAgents.map((row) => row.id),
    candidate_delegate_agents: delegateAgents,
    delegate_agent_id: delegateAgents[0].id,
    delegate_agent_role: delegateAgents[0].role || undefined,
    delegate_agent_label: delegateAgents[0].label || delegateAgents[0].id,
  };
}

export function buildDelegateAgentGoal({ request = {}, action = {}, sourceAgentId = '', delegateAgent = null } = {}) {
  const normalizedRequest = normalizeInputRequest(request, {
    fallbackSourceAgentId: sourceAgentId || action?.agent_id || action?.agent,
    fallbackActionType: action?.type,
    fallbackActionLabel: action?.label || action?.goal,
  });
  const reason = clip(normalizedRequest?.reason || normalizedRequest?.followup_hint || normalizedRequest?.prompt || '추가 정보가 필요합니다.', 220);
  const actionGoal = clip(action?.goal || action?.prompt || action?.label || '', 260);
  const requestId = clean(normalizedRequest.request_id || 'input_request');
  return [
    '현재 다른 agent가 작업 중 추가 정보가 필요하다고 보고했습니다.',
    '당신은 resolver agent로서 저장소/현재 문맥/이전 산출물만으로 답을 생성해야 합니다.',
    `request_id=${requestId}`,
    `source_agent=${cleanKey(sourceAgentId || normalizedRequest.source_agent_id || action?.agent_id || action?.agent) || 'unknown'}`,
    delegateAgent?.role ? `resolver_role=${cleanKey(delegateAgent.role)}` : '',
    normalizedRequest.request_kind ? `request_kind=${cleanKey(normalizedRequest.request_kind)}` : '',
    actionGoal ? `original_goal=${actionGoal}` : '',
    `question=${reason}`,
    '',
    '반드시 아래 형식으로 답하세요:',
    'RESOLUTION: AGENT_RESOLVED 또는 USER_REQUIRED',
    'ANSWER: 짧고 실행 가능한 답변',
    'CONFIDENCE: 0.0~1.0 숫자',
    'EVIDENCE: surface_or_file_1; surface_or_file_2',
    'RATIONALE: 왜 그렇게 판단했는지 한두 문장',
    '',
    '사용자 판단이나 외부 비밀정보가 필요하면 RESOLUTION: USER_REQUIRED 로 답하세요.',
  ].filter(Boolean).join('\n');
}

export function parseDelegateResolutionOutput({ request = {}, delegateOutput = '', delegateAgentId = '', delegateAgentRole = '' } = {}) {
  const normalizedRequest = normalizeInputRequest(request);
  const cleanOutput = clean(delegateOutput);
  const lines = cleanOutput.split(/\r?\n/).map((line) => clean(line)).filter(Boolean);
  const lineMap = new Map();
  for (const line of lines) {
    const match = line.match(/^([A-Z_]+)\s*:\s*(.*)$/i);
    if (match) lineMap.set(match[1].toUpperCase(), match[2].trim());
  }
  const resolutionRaw = String(lineMap.get('RESOLUTION') || '').trim().toUpperCase();
  const firstLine = lines[0] || '';
  const legacyUserRequired = /^USER_DECISION_REQUIRED\s*:/i.test(firstLine);
  const needsHuman = resolutionRaw === 'USER_REQUIRED' || legacyUserRequired;
  const answer = clip(
    lineMap.get('ANSWER')
      || (legacyUserRequired ? firstLine.replace(/^USER_DECISION_REQUIRED\s*:/i, '').trim() : cleanOutput)
      || normalizedRequest.followup_hint
      || normalizedRequest.reason,
    1200,
  );
  const confidenceValue = Number(lineMap.get('CONFIDENCE'));
  const confidence = Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : undefined;
  const evidenceRefs = String(lineMap.get('EVIDENCE') || '')
    .split(/[;,]/)
    .map((entry) => clip(entry, 120))
    .filter(Boolean)
    .slice(0, 8);
  const rationale = clip(lineMap.get('RATIONALE') || '', 400) || undefined;
  return {
    resolution_type: needsHuman ? 'user_required' : 'agent_resolved',
    status: needsHuman ? 'needs_human' : 'resolved',
    resolver_agent_id: cleanKey(delegateAgentId) || undefined,
    resolver_agent_role: cleanKey(delegateAgentRole) || undefined,
    answer: answer || undefined,
    rationale,
    confidence,
    evidence_refs: evidenceRefs,
    raw_output: cleanOutput || undefined,
  };
}

export function appendResolutionAttempt({ request = {}, resolution = {} } = {}) {
  const normalizedRequest = normalizeInputRequest(request);
  const attempt = {
    attempt_id: `ira_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    resolver_agent_id: cleanKey(resolution?.resolver_agent_id) || undefined,
    resolver_agent_role: cleanKey(resolution?.resolver_agent_role) || undefined,
    status: cleanKey(resolution?.status) || 'pending',
    resolution_type: cleanKey(resolution?.resolution_type) || undefined,
    answer: clip(resolution?.answer || '', 1200) || undefined,
    rationale: clip(resolution?.rationale || '', 400) || undefined,
    confidence: Number.isFinite(Number(resolution?.confidence)) ? Math.max(0, Math.min(1, Number(resolution.confidence))) : undefined,
    evidence_refs: asArray(resolution?.evidence_refs).map((entry) => clip(entry, 120)).filter(Boolean).slice(0, 8),
    created_at: new Date().toISOString(),
  };
  const nextAttempts = [...asArray(normalizedRequest.resolution_attempts), attempt];
  const humanRequired = normalizedRequest.human_required === true || attempt.resolution_type === 'user_required';
  return normalizeInputRequest({
    ...normalizedRequest,
    resolution_attempts: nextAttempts,
    resolution_status: attempt.resolution_type === 'agent_resolved'
      ? 'agent_resolved'
      : humanRequired
        ? 'awaiting_user'
        : 'delegated',
    human_required: humanRequired,
    followup_hint: attempt.resolution_type === 'user_required'
      ? clip(attempt.answer || normalizedRequest.followup_hint || normalizedRequest.reason || '', 220) || normalizedRequest.followup_hint
      : normalizedRequest.followup_hint,
  });
}

export function buildResolvedActionInputs({ actionInputs = {}, request = {}, resolution = {} } = {}) {
  const normalizedRequest = normalizeInputRequest(request);
  const resolvedInput = {
    request_id: normalizedRequest.request_id,
    request_kind: normalizedRequest.request_kind,
    category: normalizedRequest.category,
    source_agent_id: normalizedRequest.source_agent_id,
    resolution_type: cleanKey(resolution?.resolution_type) || 'agent_resolved',
    resolved_by_agent_id: cleanKey(resolution?.resolver_agent_id) || undefined,
    resolved_by_role: cleanKey(resolution?.resolver_agent_role) || undefined,
    answer: clip(resolution?.answer || '', 1200) || undefined,
    rationale: clip(resolution?.rationale || '', 400) || undefined,
    confidence: Number.isFinite(Number(resolution?.confidence)) ? Math.max(0, Math.min(1, Number(resolution.confidence))) : undefined,
    evidence_refs: asArray(resolution?.evidence_refs).map((entry) => clip(entry, 120)).filter(Boolean).slice(0, 8),
  };
  const existingInputs = actionInputs && typeof actionInputs === 'object' ? actionInputs : {};
  const existingResolvedInputs = asArray(existingInputs.resolved_inputs || existingInputs.resolvedInputs)
    .filter((entry) => entry && typeof entry === 'object');
  return {
    ...existingInputs,
    input_request: normalizedRequest,
    resolved_inputs: [...existingResolvedInputs, resolvedInput],
    input_resolution_context: {
      request_id: normalizedRequest.request_id,
      source_agent_id: normalizedRequest.source_agent_id,
      request_kind: normalizedRequest.request_kind,
      category: normalizedRequest.category,
      resolved_input: resolvedInput,
    },
    await_user_resolution_for_agent_id: normalizedRequest.source_agent_id || undefined,
    await_user_resolution_category: normalizedRequest.category || undefined,
  };
}

export function buildDelegatedDetailContext({ detailContext = '', request = {}, resolution = {} } = {}) {
  const normalizedRequest = normalizeInputRequest(request);
  const answer = clean(resolution?.answer || '');
  const evidenceRefs = asArray(resolution?.evidence_refs).map((entry) => clean(entry)).filter(Boolean);
  return [
    clean(detailContext),
    '[input_resolution]',
    `request_id=${clean(normalizedRequest.request_id) || 'unknown'}`,
    normalizedRequest.request_kind ? `request_kind=${cleanKey(normalizedRequest.request_kind)}` : '',
    normalizedRequest.category ? `category=${cleanKey(normalizedRequest.category)}` : '',
    normalizedRequest.source_agent_id ? `source_agent_id=${cleanKey(normalizedRequest.source_agent_id)}` : '',
    resolution?.resolver_agent_id ? `resolved_by_agent_id=${cleanKey(resolution.resolver_agent_id)}` : '',
    resolution?.resolver_agent_role ? `resolved_by_role=${cleanKey(resolution.resolver_agent_role)}` : '',
    answer ? `answer:\n${answer}` : '',
    resolution?.rationale ? `rationale:\n${clean(resolution.rationale)}` : '',
    evidenceRefs.length > 0 ? `evidence_refs=${evidenceRefs.join('; ')}` : '',
  ].filter(Boolean).join('\n\n');
}
