function cleanText(value = '') {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function boolNumber(value) {
  return value ? 1 : 0;
}

function countFrom(value, fallback = 0) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pushReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

export function inferProjectionSignals({
  userText = '',
  artifactContextText = '',
  traceStats = {},
  memoryStats = {},
  skillNeeds = [],
  sideEffectRisk = false,
} = {}) {
  const text = cleanText(userText);
  const artifactContext = cleanText(artifactContextText);
  const combined = `${text}\n${artifactContext}`;
  const correctionMatches = combined.match(/아니라|잘못|정정|틀렸|혼동|retract|correction|not\s+that|wrong/gi) || [];
  const negativeMatches = combined.match(/rejected_previous_labels|negative_labels|retracted_claim|철회|아니라/gi) || [];
  const artifactMatches = combined.match(/\bartifact:|uploads\/|workspace_path|첨부|업로드|이미지|사진|photo|image/gi) || [];
  const external = /검색|찾아|주변|최신|가격|일정|예약|주문|배달|api|웹|근처|nearby|latest|search|order|delivery/i.test(text);
  const promptChars = asNumber(traceStats.prompt_chars || traceStats.promptChars, 0);
  const memoryBytes = asNumber(memoryStats.bytes || memoryStats.total_bytes || memoryStats.memory_bytes, 0);
  return {
    activeArtifacts: artifactMatches.length > 0 ? 1 : 0,
    activeRetractions: correctionMatches.length,
    negativeLabels: negativeMatches.length,
    recentUserCorrection: correctionMatches.length > 0,
    artifactAmbiguity: artifactMatches.length > 0 && correctionMatches.length > 0,
    promptChars,
    memoryConflicts: correctionMatches.length > 1 ? 1 : 0,
    missingSkillPressure: asArray(skillNeeds).length > 0 || external,
    sideEffectRisk: Boolean(sideEffectRisk || /예약|구매|주문|전송|삭제|수정|배포|commit|promote|install|delete|send|book|buy|order/i.test(text)),
    memoryPressure: memoryBytes > 250000,
  };
}

export function computeProjectionStress({
  activeArtifacts = 0,
  observations = [],
  negativeLabels = [],
  activeRetractions = 0,
  retractions = [],
  promptChars = 0,
  skillNeeds = [],
  sideEffectRisk = false,
  recentUserCorrection = false,
  artifactAmbiguity = false,
  missingSkillPressure = false,
  staleMemoryConflicts = 0,
  memoryConflicts = 0,
  memoryPressure = false,
} = {}) {
  const reasons = [];
  const activeArtifactCount = countFrom(activeArtifacts, 0);
  const observationCount = countFrom(observations, 0);
  const negativeLabelCount = countFrom(negativeLabels, 0);
  const retractionCount = Math.max(countFrom(activeRetractions, 0), countFrom(retractions, 0));
  const skillNeedCount = countFrom(skillNeeds, 0);
  const prompt = asNumber(promptChars, 0);
  const conflictCount = Math.max(countFrom(staleMemoryConflicts, 0), countFrom(memoryConflicts, 0));

  const components = {
    active_artifacts: Math.min(1.0, activeArtifactCount * 0.4),
    observations: Math.min(0.8, observationCount * 0.2),
    retractions: Math.min(3.0, retractionCount * 1.5),
    negative_labels: Math.min(2.4, negativeLabelCount * 1.2),
    recent_user_correction: boolNumber(recentUserCorrection) * 1.5,
    artifact_ambiguity: boolNumber(artifactAmbiguity) * 1.0,
    prompt_pressure: prompt > 80000 ? 2.0 : (prompt > 30000 ? 1.0 : 0),
    missing_skill_pressure: (missingSkillPressure || skillNeedCount > 0) ? 1.2 : 0,
    side_effect_risk: boolNumber(sideEffectRisk) * 1.5,
    stale_memory_conflict: Math.min(2.0, conflictCount * 1.0),
    memory_pressure: boolNumber(memoryPressure) * 0.7,
  };

  pushReason(reasons, activeArtifactCount > 0, 'active_artifact_context');
  pushReason(reasons, retractionCount > 0, 'active_retraction');
  pushReason(reasons, negativeLabelCount > 0, 'negative_label_pressure');
  pushReason(reasons, recentUserCorrection, 'recent_user_correction');
  pushReason(reasons, artifactAmbiguity, 'artifact_ambiguity');
  pushReason(reasons, prompt > 30000, 'prompt_pressure');
  pushReason(reasons, missingSkillPressure || skillNeedCount > 0, 'missing_skill_pressure');
  pushReason(reasons, sideEffectRisk, 'side_effect_risk');
  pushReason(reasons, conflictCount > 0, 'memory_conflict');
  pushReason(reasons, memoryPressure, 'memory_pressure');

  const rawScore = Object.values(components).reduce((sum, value) => sum + value, 0);
  const score = Number(clamp(rawScore, 0, 12).toFixed(2));
  const modePressure = score >= 8.5 ? 3 : score >= 5 ? 2 : score >= 3 ? 1 : 0;
  const recommendedModeHint = score >= 8.5
    ? 'multi_motif'
    : score >= 5
      ? 'hybrid_sidecar'
      : score >= 3
        ? 'single_with_skill_or_verifier'
        : 'single';

  return {
    score,
    mode_pressure: modePressure,
    recommended_mode_hint: recommendedModeHint,
    reasons: [...new Set(reasons)],
    components,
  };
}

export function summarizeProjectionStress(stress = {}) {
  const score = asNumber(stress.score, 0).toFixed(1);
  const hint = cleanText(stress.recommended_mode_hint || 'single');
  const reasons = asArray(stress.reasons).slice(0, 5).join(', ') || 'none';
  return `PSI=${score}; hint=${hint}; reasons=${reasons}`;
}
