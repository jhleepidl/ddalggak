function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanKey(value = '') {
  return clean(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clip(text = '', max = 220) {
  const src = clean(text);
  if (!src) return '';
  if (src.length <= max) return src;
  return `${src.slice(0, Math.max(1, max - 1))}…`;
}

function normalizeEvidenceRefs(value) {
  const list = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(/[;,\n]/) : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const entry = clip(raw, 120);
    if (!entry) continue;
    const key = entry.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= 8) break;
  }
  return out;
}

export function deriveInputRequestKind({ category = '', text = '' } = {}) {
  const key = cleanKey(category);
  const source = `${key}\n${clean(text).toLowerCase()}`;
  if (key === 'credential_gap' || /credential|token|api key|secret|로그인|인증/.test(source)) return 'credential_request';
  if (key === 'capability_gap' || /capability|filesystem|workspace|shell|network|tool|권한|도구/.test(source)) return 'capability_request';
  if (/design|trade-?off|architecture|schema|interface|contract|설계|구조|스키마/.test(source)) return 'design_clarification';
  if (/artifact|publish|final answer|wording|summary|brief|정리|최종 응답/.test(source)) return 'artifact_clarification';
  if (/file path|where|which file|repo|repository|코드|파일|경로|테스트|에러|구현/.test(source)) return 'context_resolution';
  if (key === 'missing_context' || key === 'implementation_failure') return 'context_resolution';
  if (/approval|confirm|choose|decision|승인|선택|결정/.test(source)) return 'human_decision';
  return 'context_resolution';
}

function normalizeResolutionAttempt(raw = {}) {
  const row = asObject(raw);
  const attemptId = clean(row.attempt_id || row.attemptId || row.id);
  const resolutionType = cleanKey(row.resolution_type || row.resolutionType || row.status || '');
  const status = cleanKey(row.status || (resolutionType === 'agent_resolved' ? 'resolved' : resolutionType === 'user_required' ? 'needs_human' : 'pending')) || 'pending';
  const confidenceValue = Number(row.confidence);
  return Object.fromEntries(Object.entries({
    attempt_id: attemptId || undefined,
    resolver_agent_id: cleanKey(row.resolver_agent_id || row.resolverAgentId || row.delegated_by_agent_id || row.delegatedByAgentId || row.agent_id || row.agentId) || undefined,
    resolver_agent_role: cleanKey(row.resolver_agent_role || row.resolverAgentRole || row.role) || undefined,
    status,
    resolution_type: resolutionType || undefined,
    answer: clip(row.answer || row.delegate_output || row.output || row.followup_hint || '', 1200) || undefined,
    rationale: clip(row.rationale || row.reason || '', 400) || undefined,
    confidence: Number.isFinite(confidenceValue) ? Math.max(0, Math.min(1, confidenceValue)) : undefined,
    evidence_refs: normalizeEvidenceRefs(row.evidence_refs || row.evidenceRefs || row.evidence || []),
    created_at: clean(row.created_at || row.createdAt) || undefined,
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0)));
}

function buildLegacyAttemptFromRequest(raw = {}) {
  const row = asObject(raw);
  const delegatedBy = cleanKey(row.delegated_by_agent_id || row.delegatedByAgentId);
  const delegateOutput = clip(row.delegate_output || '', 1200);
  const attempted = row.delegate_attempted === true || row.delegateAttempted === true;
  if (!attempted && !delegatedBy && !delegateOutput) return null;
  return normalizeResolutionAttempt({
    attempt_id: clean(row.legacy_attempt_id || 'legacy_attempt') || undefined,
    resolver_agent_id: delegatedBy || undefined,
    status: row.user_decision_required === true ? 'needs_human' : 'resolved',
    resolution_type: row.user_decision_required === true ? 'user_required' : 'agent_resolved',
    answer: delegateOutput || row.followup_hint || row.reason || undefined,
  });
}

export function normalizeInputRequest(raw = {}, { fallbackSourceAgentId = '', fallbackActionType = '', fallbackActionLabel = '' } = {}) {
  const row = asObject(raw);
  const explicitAttempts = asArray(row.resolution_attempts || row.resolutionAttempts).map(normalizeResolutionAttempt).filter((entry) => Object.keys(entry).length > 0);
  const legacyAttempt = buildLegacyAttemptFromRequest(row);
  const resolutionAttempts = explicitAttempts.length > 0
    ? explicitAttempts
    : (legacyAttempt ? [legacyAttempt] : []);
  const sourceAgentId = cleanKey(row.source_agent_id || row.sourceAgentId || row.await_user_resolution_for_agent_id || row.awaitUserResolutionForAgentId || fallbackSourceAgentId);
  const sourceActionType = cleanKey(row.source_action_type || row.sourceActionType || row.action_type || row.actionType || fallbackActionType);
  const sourceActionLabel = clip(row.source_action_label || row.sourceActionLabel || row.action_label || row.actionLabel || fallbackActionLabel, 200);
  const category = cleanKey(row.category || row.failure_category || 'unknown_failure') || 'unknown_failure';
  const prompt = clip(row.prompt || row.text || row.question || row.reason || '', 320);
  const reason = clip(row.reason || row.prompt || row.text || '', 220);
  const followupHint = clip(row.followup_hint || row.followupHint || row.human_prompt || row.humanPrompt || reason, 220);
  const requestKind = cleanKey(row.request_kind || row.requestKind) || deriveInputRequestKind({ category, text: [prompt, reason, followupHint].filter(Boolean).join('\n') });
  const candidateResolverAgentIds = [];
  const seenCandidates = new Set();
  for (const rawCandidate of asArray(row.candidate_resolver_agent_ids || row.candidateResolverAgentIds || row.delegate_agent_ids || row.delegateAgentIds || [row.delegate_agent_id || row.delegateAgentId])) {
    const id = cleanKey(rawCandidate);
    if (!id || seenCandidates.has(id)) continue;
    seenCandidates.add(id);
    candidateResolverAgentIds.push(id);
    if (candidateResolverAgentIds.length >= 6) break;
  }
  const lastAttempt = resolutionAttempts.length > 0 ? resolutionAttempts[resolutionAttempts.length - 1] : null;
  const humanRequired = row.human_required === true
    || row.user_decision_required === true
    || requestKind === 'human_decision'
    || category === 'credential_gap'
    || category === 'policy_blocked';
  const resolutionStatus = cleanKey(row.resolution_status || row.resolutionStatus)
    || (lastAttempt?.resolution_type === 'agent_resolved'
      ? 'agent_resolved'
      : humanRequired || lastAttempt?.resolution_type === 'user_required'
        ? 'awaiting_user'
        : resolutionAttempts.length > 0
          ? 'delegated'
          : 'pending');
  const resolutionStrategy = cleanKey(row.resolution_strategy || row.resolutionStrategy)
    || (humanRequired ? 'human_only' : 'delegate_then_user');
  return Object.fromEntries(Object.entries({
    request_id: clean(row.request_id || row.requestId || row.id) || undefined,
    type: cleanKey(row.type || 'await_user') || 'await_user',
    request_kind: requestKind,
    category,
    prompt: prompt || undefined,
    reason: reason || undefined,
    followup_hint: followupHint || undefined,
    source_agent_id: sourceAgentId || undefined,
    source_action_type: sourceActionType || undefined,
    source_action_label: sourceActionLabel || undefined,
    resolution_strategy: resolutionStrategy,
    resolution_status: resolutionStatus,
    candidate_resolver_agent_ids: candidateResolverAgentIds,
    resolution_attempts: resolutionAttempts,
    human_required: humanRequired,
    delegate_attempted: resolutionAttempts.length > 0,
    delegated_by_agent_id: lastAttempt?.resolver_agent_id || undefined,
    delegate_output: lastAttempt?.answer || undefined,
    user_decision_required: humanRequired || lastAttempt?.resolution_type === 'user_required',
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0)));
}

export function compactInputRequest(raw = {}) {
  const request = normalizeInputRequest(raw);
  return Object.fromEntries(Object.entries({
    request_id: request.request_id,
    type: request.type,
    request_kind: request.request_kind,
    category: request.category,
    prompt: clip(request.prompt || '', 320) || undefined,
    followup_hint: clip(request.followup_hint || '', 160) || undefined,
    reason: clip(request.reason || '', 160) || undefined,
    source_agent_id: request.source_agent_id || undefined,
    resolution_strategy: request.resolution_strategy || undefined,
    resolution_status: request.resolution_status || undefined,
    candidate_resolver_agent_ids: asArray(request.candidate_resolver_agent_ids).slice(0, 4),
    resolution_attempts: asArray(request.resolution_attempts).slice(0, 3).map((attempt) => Object.fromEntries(Object.entries({
      attempt_id: attempt.attempt_id,
      resolver_agent_id: attempt.resolver_agent_id,
      resolver_agent_role: attempt.resolver_agent_role,
      status: attempt.status,
      resolution_type: attempt.resolution_type,
      answer: clip(attempt.answer || '', 180) || undefined,
      confidence: attempt.confidence,
      evidence_refs: normalizeEvidenceRefs(attempt.evidence_refs || []),
    }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0)))),
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0)));
}

export function summarizeInputRequestForHuman(raw = {}) {
  const request = normalizeInputRequest(raw);
  return clip(request.followup_hint || request.reason || request.prompt || '추가 입력 필요', 160) || '추가 입력 필요';
}
