function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function clamp01(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(1, num));
}

function keywordScore(text = '', patterns = []) {
  const source = clean(text).toLowerCase();
  if (!source) return 0;
  let hits = 0;
  for (const pattern of asArray(patterns)) {
    if (pattern instanceof RegExp) {
      if (pattern.test(source)) hits += 1;
    } else if (source.includes(String(pattern || '').toLowerCase())) {
      hits += 1;
    }
  }
  return Math.min(1, hits / Math.max(1, Math.min(4, asArray(patterns).length)));
}

function runtimeHas(runtime = null, capability = '') {
  const target = clean(capability).toLowerCase();
  if (!target) return false;
  const caps = asObject(runtime?.capabilities);
  if (caps[target] === true) return true;
  const toolIds = new Set([
    ...asArray(runtime?.availableToolIds),
    ...asArray(runtime?.tools),
    ...asArray(runtime?.enabledToolIds),
    ...asArray(caps.availableToolIds),
    ...asArray(caps.enabledToolIds),
  ].map((v) => clean(v).toLowerCase()).filter(Boolean));
  if (toolIds.has(target)) return true;
  if (target === 'workspace_write') return caps.filesystem_write === true || caps.workspace_write === true || toolIds.has('filesystem_write');
  if (target === 'workspace_read') return caps.filesystem_read === true || caps.workspace_read === true || toolIds.has('filesystem_read');
  if (target === 'web_browse') return caps.web_browse === true || caps.web === true || toolIds.has('web') || toolIds.has('web_browse');
  if (target === 'shell_exec') return caps.shell_exec === true || caps.shell === true || toolIds.has('shell') || toolIds.has('shell_exec');
  return false;
}

export function estimateTeamStressVector({ request = '', runtime = null, contextProjection = null, modelNodes = [] } = {}) {
  const text = clean(request);
  const words = text.split(/\s+/).filter(Boolean).length;
  const chars = text.length;
  const artifactPressure = Math.max(
    keywordScore(text, [/\b(file|artifact|deliverable|report|dashboard|website|app|code|patch|repo|notebook|csv|json|html|markdown)\b/i, /파일|산출물|결과물|웹사이트|앱|코드|구현|패치|레포|노트북|대시보드/i]),
    /\.[a-z0-9]{1,8}\b/i.test(text) ? 0.8 : 0,
  );
  const workspaceMutation = Math.max(
    keywordScore(text, [/\b(implement|build|create|write|modify|fix|patch|refactor|generate)\b/i, /구현|만들|작성|수정|고쳐|패치|리팩터|생성/i]),
    artifactPressure > 0.6 ? 0.7 : 0,
  );
  const currentInfoNeed = Math.max(
    keywordScore(text, [/\b(latest|current|today|news|stock|price|market|filing|earnings)\b/i, /최신|오늘|뉴스|주식|가격|시장|공시|실적/i]),
    /\b(latest|current|today|news)\b|최신|오늘|뉴스/i.test(text) ? 0.7 : 0,
  );
  const verificationNeed = Math.max(
    keywordScore(text, [/\b(review|verify|test|audit|security|quality|regression|risk)\b/i, /검토|검증|테스트|감사|보안|품질|회귀|리스크/i]),
    workspaceMutation > 0.65 ? 0.75 : 0,
    currentInfoNeed > 0.6 ? 0.55 : 0,
  );
  const sideEffectRisk = Math.max(
    keywordScore(text, [/\b(delete|deploy|commit|push|prod|production|credential|payment|trade|order)\b/i, /삭제|배포|커밋|푸시|운영|프로덕션|credential|결제|매수|매도|주문/i]),
    runtimeHas(runtime, 'workspace_write') && workspaceMutation > 0.7 ? 0.45 : 0,
  );
  const contextConflict = Math.max(
    Number(asObject(contextProjection).conflict_score || contextProjection?.conflictScore || 0),
    keywordScore(text, [/\b(conflict|contradict|retract|correction|stale)\b/i, /충돌|모순|정정|철회|오래된|틀린/i]),
  );
  const taskComplexity = clamp01((Math.min(1, words / 80) * 0.35) + (Math.min(1, chars / 800) * 0.2) + (artifactPressure * 0.2) + (verificationNeed * 0.15) + (currentInfoNeed * 0.1));
  const capabilityGap = Math.max(
    workspaceMutation > 0.5 && !runtimeHas(runtime, 'workspace_write') ? 0.65 : 0,
    currentInfoNeed > 0.55 && !runtimeHas(runtime, 'web_browse') ? 0.55 : 0,
  );
  const unhealthy = asArray(modelNodes).filter((node) => /down|error|capacity|timeout|unavailable|disabled/i.test(clean(node?.health?.status || node?.status || ''))).length;
  const modelHealthRisk = clamp01(unhealthy / Math.max(1, asArray(modelNodes).length));
  const operatorUncertainty = keywordScore(text, [/\b(maybe|unsure|figure out|decide|choose|recommend)\b/i, /모르겠|아마|판단|정해|추천|골라/i]);
  const overall = clamp01((taskComplexity * 0.2) + (artifactPressure * 0.18) + (workspaceMutation * 0.15) + (currentInfoNeed * 0.1) + (verificationNeed * 0.14) + (sideEffectRisk * 0.1) + (contextConflict * 0.08) + (capabilityGap * 0.05));
  return {
    task_complexity: clamp01(taskComplexity),
    artifact_pressure: clamp01(artifactPressure),
    workspace_mutation: clamp01(workspaceMutation),
    current_info_need: clamp01(currentInfoNeed),
    side_effect_risk: clamp01(sideEffectRisk),
    verification_need: clamp01(verificationNeed),
    context_conflict: clamp01(contextConflict),
    capability_gap: clamp01(capabilityGap),
    model_health_risk: clamp01(modelHealthRisk),
    operator_uncertainty: clamp01(operatorUncertainty),
    overall,
  };
}

export function summarizeStressVector(stress = {}) {
  const row = asObject(stress);
  const labels = [];
  for (const [key, label] of [
    ['artifact_pressure', 'artifact'],
    ['workspace_mutation', 'workspace'],
    ['current_info_need', 'current-info'],
    ['verification_need', 'verification'],
    ['side_effect_risk', 'side-effect'],
    ['capability_gap', 'capability-gap'],
    ['model_health_risk', 'model-health'],
  ]) {
    const value = Number(row[key] || 0);
    if (value >= 0.7) labels.push(`${label}=high`);
    else if (value >= 0.4) labels.push(`${label}=medium`);
  }
  if (labels.length === 0) labels.push('low-stress');
  return labels;
}
