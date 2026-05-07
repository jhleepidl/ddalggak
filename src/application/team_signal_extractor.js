function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function cleanText(value = '', { lower = false, maxLen = 800 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function uniq(values = [], { max = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const key = cleanText(value, { lower: true, maxLen: 80 });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}
function hit(text = '', patterns = []) {
  const src = cleanText(text, { lower: true, maxLen: 4000 });
  return asArray(patterns).some((pattern) => pattern instanceof RegExp ? pattern.test(src) : src.includes(cleanText(pattern, { lower: true })));
}
function hitCount(text = '', patterns = []) {
  const src = cleanText(text, { lower: true, maxLen: 4000 });
  let count = 0;
  for (const pattern of asArray(patterns)) {
    if (pattern instanceof RegExp ? pattern.test(src) : src.includes(cleanText(pattern, { lower: true }))) count += 1;
  }
  return count;
}
function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}
function confidenceFromHits(count = 0, denominator = 4) {
  return clamp01(Number(count || 0) / Math.max(1, Number(denominator || 4)));
}
function readExplicitTeamConfig(runtime = null, taskInterpretation = null) {
  const runtimeObj = asObject(runtime);
  const interpreted = asObject(taskInterpretation);
  const candidates = [
    runtimeObj.team_workflow_contract,
    runtimeObj.teamWorkflowContract,
    runtimeObj.team_config,
    runtimeObj.teamConfig,
    runtimeObj.activeTeam,
    runtimeObj.active_team,
    runtimeObj.runtimeSessionState?.team_config,
    runtimeObj.runtimeSessionState?.teamConfig,
    interpreted.team_config,
    interpreted.teamConfig,
    interpreted.workflow_contract,
    interpreted.workflowContract,
  ].map(asObject).filter((row) => Object.keys(row).length > 0);
  const explicitRoles = uniq([
    ...asArray(interpreted.preferred_roles || interpreted.preferredRoles),
    ...asArray(runtimeObj.preferredRoles || runtimeObj.preferred_roles),
    ...candidates.flatMap((row) => asArray(row.roles || row.role_ids || row.roleIds || row.preferred_roles || row.preferredRoles)),
  ], { max: 16 });
  return {
    configured: candidates.length > 0 || explicitRoles.length > 0,
    source_count: candidates.length,
    roles: explicitRoles,
  };
}

export function extractTeamCreationSignals({ request = '', goal = '', message = '', taskInterpretation = null, runtime = null, runtimeSessionState = null, executionFeedback = null, modelNodes = [] } = {}) {
  const text = cleanText([goal, message, request, asObject(taskInterpretation).goal].filter(Boolean).join('\n'), { maxLen: 4000 });
  const interpreted = asObject(taskInterpretation);
  const explicitConfig = readExplicitTeamConfig(runtime || runtimeSessionState, interpreted);

  const loopHits = hitCount(text, [
    /\b(loop|iterate|iteration|continuous|keep\s+(checking|improving)|watch|monitor|repeat|until)\b/i,
    /계속\s*(점검|개선|확인|수정)|반복|루프|주기적|모니터|중단\s*조건|완성될\s*때까지/i,
  ]);
  const reviewHits = hitCount(text, [
    /\b(review|verify|audit|test|qa|regression|double[- ]?check|critique)\b/i,
    /검토|검증|리뷰|테스트|회귀|품질|점검|비판/i,
  ]);
  const approvalHits = hitCount(text, [
    /\b(approval|approve|ask before|confirm before|risky|dangerous|large change|destructive)\b/i,
    /승인|허락|확인\s*받|큰\s*변경|위험|파괴적|삭제|배포|운영/i,
  ]);
  const stopHits = hitCount(text, [
    /\b(stop condition|stop when|until|done when|quality threshold|complete enough)\b/i,
    /중단\s*조건|멈추|충분히\s*완성|완성된|완료\s*조건|나올\s*때/i,
  ]);
  const explicitTeamHits = hitCount(text, [
    /\b(multi[- ]?agent|team of agents|agent team|parallel agents|split the task|use goC team)\b/i,
    /여러\s*에이전트|멀티\s*에이전트|agent\s*team|에이전트\s*팀|팀으로|분담|병렬/i,
  ]);
  const compareHits = hitCount(text, [
    /\b(compare|alternatives|options|tradeoff|choose best|explore)\b/i,
    /비교|대안|옵션|트레이드오프|최선|여러\s*안|탐색/i,
  ]);
  const implementHits = hitCount(text, [
    /\b(implement|build|create|code|patch|fix|refactor|website|app|repo)\b/i,
    /구현|만들|코드|패치|수정|고쳐|리팩터|웹사이트|앱|레포/i,
  ]);
  const evidenceHits = hitCount(text, [
    /\b(latest|current|today|news|stock|price|market|filing|earnings|source|citation|evidence|grounded)\b/i,
    /최신|오늘|뉴스|주식|가격|시장|공시|실적|출처|근거|인용/i,
  ]);
  const riskHits = hitCount(text, [
    /\b(finance|financial|stock|trade|investment|legal|medical|security|credential|deploy|migration|delete)\b/i,
    /금융|투자|주식|추천|매수|매도|법률|의료|보안|credential|배포|마이그레이션|삭제/i,
  ]);
  const memoryContextHits = hitCount(text, [
    /\b(memory|context|history|previous|remember|correction|retraction)\b/i,
    /메모리|컨텍스트|히스토리|이전|기억|정정|철회|수정했던/i,
  ]);
  const toolBoundaryHits = hitCount(text, [
    /\b(web|browse|api|file|workspace|shell|database|db|rdb|vector|embedding)\b/i,
    /웹|브라우즈|api|파일|워크스페이스|셸|데이터베이스|벡터|임베딩/i,
  ]);
  const skillMemoryIndexHits = hitCount(text, [
    /\b(skill|role|memory).{0,40}\b(vector|embedding|index|search)\b/i,
    /\b(vector|embedding|index).{0,40}\b(skill|role|memory)\b/i,
    /스킬|skill|메모리|memory|role|역할|벡터|vector|임베딩|indexing|인덱싱/i,
  ]);

  const feedback = asObject(executionFeedback);
  const feedbackQualityGap = Number(feedback.quality_gap || feedback.qualityGap || feedback.summary?.quality_gap || feedback.summary?.qualityGap || 0) || 0;
  const feedbackFailure = hit(cleanText(JSON.stringify(feedback).slice(0, 4000), { lower: true }), [/failed|error|missing|quality_gap|contract/i, /실패|누락|품질|계약|미충족/i]);
  const unhealthyModels = asArray(modelNodes).filter((node) => /down|error|capacity|timeout|unavailable|disabled/i.test(cleanText(node?.health?.status || node?.status || '', { lower: true }))).length;

  const workflowIntent = {
    continuous_loop: loopHits > 0,
    review_each_iteration: reviewHits > 0 && (loopHits > 0 || hit(text, [/매\s*개선|each\s+(change|iteration|improvement)/i])),
    review_required: reviewHits > 0 || cleanText(interpreted.review_policy || interpreted.reviewPolicy, { lower: true }) === 'required',
    approval_boundary: approvalHits > 0,
    stop_condition_present: stopHits > 0,
    compare_or_explore: compareHits > 0,
    implementation_allowed: implementHits > 0,
  };
  const sourceSignals = {
    indirect_user_request: workflowIntent.continuous_loop || workflowIntent.review_required || workflowIntent.approval_boundary || workflowIntent.stop_condition_present || workflowIntent.compare_or_explore,
    explicit_team_config: explicitConfig.configured || explicitTeamHits > 0,
    automatic_task_need: implementHits > 0 || evidenceHits > 0 || riskHits > 0 || toolBoundaryHits > 0 || memoryContextHits > 0,
    execution_feedback: feedbackQualityGap > 0 || feedbackFailure,
    runtime_health: unhealthyModels > 0,
    learned_or_project_policy: false,
  };
  const pressure = {
    workflow: clamp01(confidenceFromHits(loopHits + reviewHits + approvalHits + stopHits + compareHits, 7)),
    task: clamp01(confidenceFromHits(implementHits + compareHits + toolBoundaryHits, 5)),
    evidence: clamp01(confidenceFromHits(evidenceHits, 3)),
    risk: clamp01(confidenceFromHits(riskHits + approvalHits, 4)),
    memory_context: clamp01(confidenceFromHits(memoryContextHits, 3)),
    tool_boundary: clamp01(confidenceFromHits(toolBoundaryHits, 3)),
    runtime_health: clamp01(unhealthyModels / Math.max(1, asArray(modelNodes).length || 1)),
    feedback: clamp01((feedbackQualityGap / 4) + (feedbackFailure ? 0.35 : 0)),
    semantic_indexing: clamp01(confidenceFromHits(skillMemoryIndexHits, 4)),
  };
  const recommendedRoles = [];
  if (workflowIntent.continuous_loop || workflowIntent.review_required || workflowIntent.approval_boundary) recommendedRoles.push('operator');
  if (workflowIntent.continuous_loop || evidenceHits > 0 || riskHits > 0 || workflowIntent.compare_or_explore) recommendedRoles.push('researcher');
  if (implementHits > 0) recommendedRoles.push('builder');
  if (workflowIntent.review_required || workflowIntent.approval_boundary || riskHits > 0 || evidenceHits > 0) recommendedRoles.push('reviewer');
  if (workflowIntent.continuous_loop || workflowIntent.compare_or_explore || reviewHits > 0) recommendedRoles.push('synthesizer');
  if (recommendedRoles.length === 0 && explicitConfig.roles.length > 0) recommendedRoles.push(...explicitConfig.roles);
  const reasons = [];
  if (workflowIntent.continuous_loop) reasons.push('workflow_intent:continuous_loop');
  if (workflowIntent.review_required) reasons.push('workflow_intent:review_required');
  if (workflowIntent.approval_boundary) reasons.push('workflow_intent:approval_boundary');
  if (workflowIntent.stop_condition_present) reasons.push('workflow_intent:stop_condition');
  if (evidenceHits > 0) reasons.push('evidence_or_freshness_pressure');
  if (riskHits > 0) reasons.push('risk_pressure');
  if (toolBoundaryHits > 0) reasons.push('tool_boundary_pressure');
  if (skillMemoryIndexHits > 0) reasons.push('semantic_indexing_signal');
  if (explicitConfig.configured || explicitTeamHits > 0) reasons.push('explicit_team_configuration');
  if (feedbackQualityGap > 0 || feedbackFailure) reasons.push('execution_feedback_pressure');
  return {
    kind: 'team_creation_signals_v1',
    source_signals: sourceSignals,
    workflow_intent: workflowIntent,
    pressure,
    recommended_roles: uniq(recommendedRoles, { max: 8 }),
    explicit_config: explicitConfig,
    semantic_indexing: {
      requested: skillMemoryIndexHits > 0,
      targets: uniq([
        hit(text, [/memory|메모리/i]) ? 'memory' : '',
        hit(text, [/skill|스킬/i]) ? 'skill' : '',
        hit(text, [/role|역할/i]) ? 'role' : '',
      ].filter(Boolean), { max: 4 }),
      recommended_backend: 'structured_registry_plus_vector_index',
    },
    confidence: clamp01((Object.values(sourceSignals).filter(Boolean).length / 5) * 0.4 + Math.max(...Object.values(pressure), 0) * 0.6),
    reasons: uniq(reasons, { max: 16 }),
  };
}

export function summarizeTeamCreationSignals(signals = null) {
  const row = asObject(signals);
  const src = asObject(row.source_signals || row.sourceSignals);
  const workflow = asObject(row.workflow_intent || row.workflowIntent);
  const parts = [];
  if (src.explicit_team_config) parts.push('explicit-config');
  if (src.indirect_user_request) parts.push('workflow-intent');
  if (src.automatic_task_need) parts.push('task-pressure');
  if (src.execution_feedback) parts.push('feedback');
  if (src.runtime_health) parts.push('runtime-health');
  if (workflow.continuous_loop) parts.push('loop');
  if (workflow.review_required) parts.push('review');
  if (workflow.approval_boundary) parts.push('approval');
  if (parts.length === 0) parts.push('single-fast-path-ok');
  return parts;
}
