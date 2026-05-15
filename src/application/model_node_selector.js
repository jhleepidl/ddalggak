function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function includesAny(values = [], needles = []) {
  const set = new Set(asArray(values).map(cleanId).filter(Boolean));
  return asArray(needles).map(cleanId).filter(Boolean).some((needle) => set.has(needle));
}

function tierScore(value = '', order = []) {
  const key = cleanId(value || 'unknown');
  const index = order.map(cleanId).indexOf(key);
  if (index < 0) return 0.5;
  if (order.length <= 1) return 1;
  return 1 - (index / (order.length - 1));
}

function costCheapness(tier = '') {
  return tierScore(tier, ['free', 'very_cheap', 'cheap', 'medium', 'expensive', 'premium', 'unknown']);
}

function latencyFitness(tier = '') {
  return tierScore(tier, ['instant', 'fast', 'medium', 'slow', 'very_slow', 'unknown']);
}

function qualityFitness(tier = '') {
  const key = cleanId(tier || 'standard');
  const order = ['experimental', 'draft', 'standard', 'good', 'strong', 'frontier'];
  const index = order.indexOf(key);
  if (index < 0) return 0.55;
  return index / (order.length - 1);
}

function privacyFitness(profile = {}, { privacyRequired = false } = {}) {
  const p = asObject(profile);
  const tier = cleanId(p.tier || 'standard');
  const boundary = cleanId(p.data_boundary || p.dataBoundary || '');
  const offDevice = p.sends_context_off_device === true || p.sendsContextOffDevice === true;
  const trusted = p.trusted_context === true || p.trustedContext === true || p.allow_private_context === true || p.allowPrivateContext === true;
  if (privacyRequired) {
    if (tier.includes('local') || boundary === 'local_device' || offDevice === false) return 1;
    if (trusted || tier.includes('trusted') || tier.includes('private') || boundary === 'user_controlled_remote' || boundary.includes('dedicated')) return 0.95;
    return 0.15;
  }
  if (offDevice === false || tier.includes('local')) return 0.8;
  if (trusted || tier.includes('trusted') || boundary === 'user_controlled_remote') return 0.72;
  return 0.55;
}

function capabilitySatisfied(node = {}, hints = {}) {
  const caps = asObject(node.capabilities);
  const perms = asObject(node.permissions);
  const missing = [];
  if (caps.chat === false) missing.push('chat');
  if (hints.needsCode && caps.code !== true) missing.push('code');
  if (hints.needsStructuredJson && caps.structured_json !== true && caps.structuredJson !== true) missing.push('structured_json');
  if (hints.needsVision && caps.vision !== true) missing.push('vision');
  if (hints.needsEmbedding && caps.embedding !== true) missing.push('embedding');
  if (hints.workspaceWriteRequired && perms.workspace_write !== true && perms.workspaceWrite !== true) missing.push('workspace_write');
  return { ok: missing.length === 0, missing };
}

export function normalizeModelNodeTaskHints(input = {}) {
  const roleId = cleanId(input.roleId || input.role_id || input.role || '');
  const text = clean(input.taskText || input.task_text || input.request || '');
  const lowered = text.toLowerCase();
  const privateSignals = /private|privacy|local|sensitive|credential|secret|내부|비공개|민감|로컬|개인정보/i.test(text);
  const codeSignals = /\b(code|patch|implement|build|refactor|test)\b|코드|구현|패치|리팩터|테스트/i.test(text);
  const fastSignals = /urgent|quick|fast|지금|빨리|긴급/i.test(text);
  const cheapSignals = /cheap|budget|cost|무료|저렴|비용/i.test(text);
  const qualitySignals = /hard|complex|architecture|design|correctness|어려|복잡|아키텍처|설계|정확/i.test(text);
  return {
    roleId,
    taskText: text,
    taskTags: asArray(input.taskTags || input.task_tags || []).map(cleanId).filter(Boolean),
    privacyRequired: input.privacyRequired === true || input.privacy_required === true || privateSignals,
    latencySensitive: input.latencySensitive === true || input.latency_sensitive === true || fastSignals,
    costSensitive: input.costSensitive !== false && input.cost_sensitive !== false && (cheapSignals || input.policy === 'cheapest_sufficient'),
    qualitySensitive: input.qualitySensitive === true || input.quality_sensitive === true || qualitySignals,
    needsCode: input.needsCode === true || input.needs_code === true || ['builder', 'reviewer', 'verifier'].includes(roleId) || codeSignals,
    needsStructuredJson: input.needsStructuredJson === true || input.needs_structured_json === true || false,
    needsVision: input.needsVision === true || input.needs_vision === true || false,
    needsEmbedding: input.needsEmbedding === true || input.needs_embedding === true || false,
    workspaceWriteRequired: input.workspaceWriteRequired === true || input.workspace_write_required === true || roleId === 'builder',
    policy: cleanId(input.policy || 'balanced'),
  };
}

export function scoreModelNodeForTask(node = {}, rawHints = {}) {
  const hints = normalizeModelNodeTaskHints(rawHints);
  const capability = capabilitySatisfied(node, hints);
  const disabled = node.enabled === false;
  const roleBias = asArray(node.role_bias || node.roleBias).map(cleanId).filter(Boolean);
  const preferFor = asArray(node.routing?.prefer_for || node.routing?.preferFor).map(cleanId).filter(Boolean);
  const avoidFor = asArray(node.routing?.avoid_for || node.routing?.avoidFor).map(cleanId).filter(Boolean);
  const hintTags = [hints.roleId, ...hints.taskTags].filter(Boolean);
  const matchesRole = includesAny(roleBias, hintTags) || includesAny(preferFor, hintTags);
  const avoided = includesAny(avoidFor, hintTags);

  const cheap = costCheapness(node.cost_profile?.tier || node.costProfile?.tier || node.cost || 'unknown');
  const latency = latencyFitness(node.latency_profile?.tier || node.latencyProfile?.tier || node.latency || 'unknown');
  const quality = qualityFitness(node.quality_profile?.tier || node.qualityProfile?.tier || node.quality || 'standard');
  const privacy = privacyFitness(node.privacy_profile || node.privacyProfile || node.privacy || {}, hints);
  const priority = clamp((Number(node.routing?.priority ?? node.priority ?? 50) || 50) / 100, 0, 1);
  const healthStatus = cleanId(node.health?.status || node.status || 'ok');
  const healthPenalty = /disabled|down|error|timeout|capacity|unreachable|unhealthy/.test(healthStatus) ? 0.35 : 0;
  const missingPenalty = capability.missing.length * 0.22;
  const disabledPenalty = disabled ? 0.8 : 0;
  const avoidPenalty = avoided ? 0.35 : 0;

  const weights = {
    cheap: hints.costSensitive ? 0.22 : 0.1,
    latency: hints.latencySensitive ? 0.22 : 0.1,
    quality: hints.qualitySensitive ? 0.24 : 0.14,
    privacy: hints.privacyRequired ? 0.28 : 0.12,
    role: 0.16,
    priority: 0.08,
  };
  const score = clamp(
    (cheap * weights.cheap)
      + (latency * weights.latency)
      + (quality * weights.quality)
      + (privacy * weights.privacy)
      + (matchesRole ? weights.role : 0)
      + (priority * weights.priority)
      - healthPenalty
      - missingPenalty
      - disabledPenalty
      - avoidPenalty,
    -1,
    1,
  );
  const reasons = [];
  if (matchesRole) reasons.push('role_affinity');
  if (hints.privacyRequired && privacy >= 0.9) reasons.push('privacy_fit');
  if (hints.costSensitive && cheap >= 0.8) reasons.push('cheap_or_free');
  if (hints.latencySensitive && latency >= 0.75) reasons.push('latency_fit');
  if (hints.qualitySensitive && quality >= 0.7) reasons.push('quality_fit');
  if (capability.missing.length) reasons.push(`missing:${capability.missing.join(',')}`);
  if (disabled) reasons.push('disabled');
  if (avoided) reasons.push('avoid_for_task');
  return {
    node_id: clean(node.id || ''),
    model: clean(node.model || ''),
    provider: clean(node.provider || ''),
    score: Number(score.toFixed(3)),
    executable: !disabled && capability.ok && score > 0,
    reasons,
    components: {
      cheapness: Number(cheap.toFixed(3)),
      latency: Number(latency.toFixed(3)),
      quality: Number(quality.toFixed(3)),
      privacy: Number(privacy.toFixed(3)),
      priority: Number(priority.toFixed(3)),
    },
    missing_capabilities: capability.missing,
  };
}

export function selectModelNodeForTask({ nodes = [], roleId = '', taskText = '', policy = 'balanced', taskTags = [], ...hints } = {}) {
  const scored = asArray(nodes)
    .map((node) => ({ node, fit: scoreModelNodeForTask(node, { roleId, taskText, policy, taskTags, ...hints }) }))
    .sort((a, b) => {
      if (a.fit.executable && !b.fit.executable) return -1;
      if (!a.fit.executable && b.fit.executable) return 1;
      return Number(b.fit.score || 0) - Number(a.fit.score || 0);
    });
  const selected = scored.find((row) => row.fit.executable) || scored[0] || null;
  return {
    selected: selected?.node || null,
    fit: selected?.fit || null,
    ranked: scored.map((row) => row.fit),
  };
}
