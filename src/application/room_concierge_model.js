import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function norm(value, scale = 1) {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isFinite(scale) || scale <= 0) return 0;
  return Math.max(0, Math.min(1, n / scale));
}

function sigmoid(x) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0.5;
  if (n >= 30) return 1;
  if (n <= -30) return 0;
  return 1 / (1 + Math.exp(-n));
}

function unique(values = []) {
  return [...new Set(asArray(values).map((v) => String(v || '').trim()).filter(Boolean))];
}

function dot(weights = {}, features = {}) {
  let out = Number(weights.bias || 0);
  for (const [key, weight] of Object.entries(weights || {})) {
    if (key === 'bias') continue;
    out += Number(weight || 0) * Number(features[key] || 0);
  }
  return out;
}

function euclideanDistance(a = {}, b = {}, featureNames = []) {
  let total = 0;
  for (const key of featureNames) {
    const diff = Number(a[key] || 0) - Number(b[key] || 0);
    total += diff * diff;
  }
  return Math.sqrt(total);
}

const MODEL_ROUTES = [
  'concierge_direct_answer',
  'concierge_search_answer',
  'standard_workbench',
  'team_orchestration',
];

export const DEFAULT_CONCIERGE_MODEL_POLICY = Object.freeze({
  enabled: false,
  min_confidence: 0.72,
  allow_safe_escalation: true,
  allow_direct_override: false,
  hard_blockers_prevent_direct: true,
});

export function extractRoomConciergeFeatureVector({
  text = '',
  baseDecision = {},
  hasAttachment = false,
  pendingApproval = false,
  busy = false,
  roomFootprint = {},
  recentRouteStats = {},
} = {}) {
  const decision = asObject(baseDecision);
  const metrics = asObject(decision.metrics);
  const signals = new Set(asArray(decision.signals));
  const blockers = new Set(asArray(decision.blockers));
  const footprint = asObject(roomFootprint);
  const taskDistribution = asObject(footprint.task_distribution || footprint.taskDistribution);
  const explicitRouteStats = asObject(recentRouteStats);
  const routeStats = Object.keys(explicitRouteStats).length
    ? explicitRouteStats
    : asObject(footprint.recent_route_stats || footprint.recentRouteStats);
  const textValue = String(text || '');
  const charCount = Number(metrics.char_count ?? Array.from(textValue).length);
  const tokenish = Number(metrics.tokenish_units ?? Math.max(textValue.split(/\s+/g).filter(Boolean).length, Math.ceil(charCount / 12)));
  const totalRecent = Math.max(1, Number(routeStats.total || routeStats.total_count || 0));

  return {
    bias: 1,
    char_norm: norm(charCount, 600),
    tokenish_norm: norm(tokenish, 80),
    has_attachment: hasAttachment || blockers.has('has_attachment') ? 1 : 0,
    pending_approval: pendingApproval || blockers.has('pending_approval') ? 1 : 0,
    busy_chat: busy || blockers.has('busy_chat') ? 1 : 0,
    signal_simple_qa: signals.has('simple_qa_intent') ? 1 : 0,
    signal_search: signals.has('search_or_freshness_intent') ? 1 : 0,
    signal_workbench: signals.has('workbench_intent') ? 1 : 0,
    signal_team: signals.has('team_or_review_intent') ? 1 : 0,
    signal_high_risk: signals.has('high_risk_domain') ? 1 : 0,
    blocker_count_norm: norm(blockers.size, 8),
    room_memory_pressure: clamp01(footprint.memory_pressure ?? footprint.memoryPressure),
    room_governance_pressure: clamp01(footprint.governance_pressure ?? footprint.governancePressure),
    room_export_boundary_risk: clamp01(footprint.export_boundary_risk ?? footprint.exportBoundaryRisk),
    room_handoff_need: clamp01(footprint.handoff_need ?? footprint.handoffNeed),
    room_search_need: clamp01(footprint.external_search_need ?? footprint.externalSearchNeed),
    room_team_need: clamp01(footprint.team_need ?? footprint.teamNeed),
    task_coding: clamp01(taskDistribution.coding || taskDistribution.code || 0),
    task_research: clamp01(taskDistribution.research || 0),
    task_strategy: clamp01(taskDistribution.strategy || taskDistribution.product || 0),
    task_casual: clamp01(taskDistribution.casual || taskDistribution.qa || 0),
    recent_direct_rate: clamp01(Number(routeStats.concierge_direct_answer || routeStats.direct || 0) / totalRecent),
    recent_search_rate: clamp01(Number(routeStats.concierge_search_answer || routeStats.search || 0) / totalRecent),
    recent_workbench_rate: clamp01(Number(routeStats.standard_workbench || routeStats.workbench || 0) / totalRecent),
    recent_team_rate: clamp01(Number(routeStats.team_orchestration || routeStats.team || 0) / totalRecent),
  };
}

export function normalizeRoomConciergeModel(raw = {}) {
  const model = asObject(raw);
  const policy = { ...DEFAULT_CONCIERGE_MODEL_POLICY, ...asObject(model.policy) };
  const routes = unique(model.routes).length ? unique(model.routes) : MODEL_ROUTES;
  const featureNames = unique(model.feature_names || model.featureNames);
  return {
    kind: model.kind || 'room_concierge_model_v1',
    model_type: model.model_type || model.modelType || (model.route_centroids ? 'route_centroid' : 'linear_route_scorer'),
    version: model.version || 'local_unversioned',
    routes,
    feature_names: featureNames,
    route_weights: asObject(model.route_weights || model.routeWeights),
    route_centroids: asObject(model.route_centroids || model.routeCentroids),
    policy,
    metadata: asObject(model.metadata),
  };
}

export function loadRoomConciergeModelFromFile(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  const parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  return normalizeRoomConciergeModel({ ...parsed, metadata: { ...asObject(parsed.metadata), source_file: resolved } });
}

export function loadRoomConciergeModelFromEnv(env = process.env) {
  const enabledRaw = String(env.DDALGGAK_ROOM_CONCIERGE_MODEL_ENABLED || env.ROOM_CONCIERGE_MODEL_ENABLED || '').trim().toLowerCase();
  const explicitEnabled = ['1', 'true', 'yes', 'on'].includes(enabledRaw);
  const filePath = String(env.DDALGGAK_ROOM_CONCIERGE_MODEL_PATH || env.ROOM_CONCIERGE_MODEL_PATH || '').trim();
  if (!explicitEnabled && !filePath) return null;
  if (!filePath) return normalizeRoomConciergeModel({ policy: { enabled: explicitEnabled } });
  try {
    return normalizeRoomConciergeModel({
      ...loadRoomConciergeModelFromFile(filePath),
      policy: { ...DEFAULT_CONCIERGE_MODEL_POLICY, enabled: explicitEnabled || true },
    });
  } catch (error) {
    return {
      kind: 'room_concierge_model_error_v1',
      ok: false,
      error: String(error?.message || error || 'failed_to_load_model'),
      path: filePath,
      policy: { ...DEFAULT_CONCIERGE_MODEL_POLICY, enabled: false },
    };
  }
}

function softmax(scores = {}) {
  const entries = Object.entries(scores).filter(([, value]) => Number.isFinite(Number(value)));
  if (!entries.length) return {};
  const maxScore = Math.max(...entries.map(([, value]) => Number(value)));
  const expEntries = entries.map(([key, value]) => [key, Math.exp(Number(value) - maxScore)]);
  const denom = expEntries.reduce((sum, [, value]) => sum + value, 0) || 1;
  return Object.fromEntries(expEntries.map(([key, value]) => [key, value / denom]));
}

export function scoreRoomConciergeRoutes({ model = null, features = {}, baseDecision = {} } = {}) {
  const normalized = normalizeRoomConciergeModel(model || {});
  if (asObject(normalized.policy).enabled === false) {
    return { ok: false, reason: 'model_disabled', model: { version: normalized.version, model_type: normalized.model_type } };
  }
  const routes = normalized.routes.length ? normalized.routes : MODEL_ROUTES;
  let probabilities = {};
  let rawScores = {};

  if (normalized.model_type === 'route_centroid') {
    const featureNames = normalized.feature_names.length
      ? normalized.feature_names
      : unique(Object.keys(features).filter((k) => k !== 'bias'));
    for (const route of routes) {
      const centroid = asObject(normalized.route_centroids[route]);
      if (!Object.keys(centroid).length) continue;
      rawScores[route] = -euclideanDistance(features, centroid, featureNames);
    }
    probabilities = softmax(rawScores);
  } else {
    for (const route of routes) {
      const weights = asObject(normalized.route_weights[route]);
      if (!Object.keys(weights).length) continue;
      rawScores[route] = dot(weights, features);
    }
    probabilities = softmax(rawScores);
  }

  if (!Object.keys(probabilities).length) return { ok: false, reason: 'no_route_scores', model: { version: normalized.version, model_type: normalized.model_type } };
  const ranked = Object.entries(probabilities)
    .map(([route, probability]) => ({ route, probability }))
    .sort((a, b) => b.probability - a.probability);
  const top = ranked[0] || { route: baseDecision.route || 'standard_workbench', probability: 0 };
  return {
    ok: true,
    kind: 'room_concierge_model_score_v1',
    route: top.route,
    confidence: Number(top.probability || 0),
    ranked,
    raw_scores: rawScores,
    model: {
      version: normalized.version,
      model_type: normalized.model_type,
    },
  };
}

const HARD_DIRECT_BLOCKERS = new Set([
  'empty_message',
  'not_ask_command',
  'has_attachment',
  'pending_approval',
  'busy_chat',
  'needs_workspace_or_artifact',
  'needs_team_or_review',
  'needs_standard_safety_context',
]);

export function isModelRouteAllowed({ route = '', baseDecision = {}, policy = {} } = {}) {
  const d = asObject(baseDecision);
  const p = { ...DEFAULT_CONCIERGE_MODEL_POLICY, ...asObject(policy) };
  const blockers = new Set(asArray(d.blockers));
  const baseRoute = String(d.route || 'standard_workbench');
  const requested = String(route || 'standard_workbench');

  if (requested === baseRoute) return { ok: true, reason: 'same_as_base' };
  if (requested === 'concierge_direct_answer') {
    if (!p.allow_direct_override) return { ok: false, reason: 'direct_override_disabled' };
    if (p.hard_blockers_prevent_direct && [...blockers].some((b) => HARD_DIRECT_BLOCKERS.has(b))) {
      return { ok: false, reason: 'hard_blocker_prevents_direct' };
    }
    return { ok: true, reason: 'direct_override_allowed' };
  }
  if (p.allow_safe_escalation && ['concierge_search_answer', 'standard_workbench', 'team_orchestration'].includes(requested)) {
    return { ok: true, reason: 'safe_escalation_allowed' };
  }
  return { ok: false, reason: 'route_not_allowed' };
}

export function applyLearnedRoomConciergeModel({ baseDecision = {}, modelScore = {}, model = null } = {}) {
  const d = { ...asObject(baseDecision) };
  const normalized = normalizeRoomConciergeModel(model || {});
  const policy = { ...DEFAULT_CONCIERGE_MODEL_POLICY, ...asObject(normalized.policy) };
  const score = asObject(modelScore);
  if (!score.ok) {
    return {
      ...d,
      learned_model: { applied: false, reason: score.reason || 'model_not_scored', score },
    };
  }
  const confidence = Number(score.confidence || 0);
  if (confidence < Number(policy.min_confidence || DEFAULT_CONCIERGE_MODEL_POLICY.min_confidence)) {
    return {
      ...d,
      learned_model: { applied: false, reason: 'below_min_confidence', score },
    };
  }
  const allowed = isModelRouteAllowed({ route: score.route, baseDecision: d, policy });
  if (!allowed.ok) {
    return {
      ...d,
      learned_model: { applied: false, reason: allowed.reason, score },
    };
  }
  if (score.route === d.route) {
    return {
      ...d,
      learned_model: { applied: false, reason: 'same_as_base', score },
    };
  }

  const next = {
    ...d,
    route: score.route,
    learned_model: { applied: true, reason: allowed.reason, score, base_route: d.route },
  };
  if (score.route === 'concierge_direct_answer') {
    next.depth = 'direct_answer';
    next.should_bypass_workbench = true;
    next.should_show_plan_preview = false;
    next.answer_mode = 'single_model_minimal_prompt';
  } else if (score.route === 'concierge_search_answer') {
    next.depth = 'single_agent_search';
    next.should_bypass_workbench = false;
    next.should_show_plan_preview = false;
    next.answer_mode = 'bounded_search_or_standard_fallback';
  } else if (score.route === 'team_orchestration') {
    next.depth = 'team';
    next.should_bypass_workbench = false;
    next.should_show_plan_preview = true;
    next.answer_mode = 'team_orchestration';
  } else {
    next.depth = 'workbench';
    next.should_bypass_workbench = false;
    next.should_show_plan_preview = true;
    next.answer_mode = 'standard_ai_room_pipeline';
  }
  next.reasons = unique([...(asArray(d.reasons)), `learned_model_${score.route}`]);
  return next;
}
