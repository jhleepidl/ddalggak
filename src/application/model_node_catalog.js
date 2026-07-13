function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:\-\.]+/g, '_').replace(/^_+|_+$/g, '');
}

function numberOrUndefined(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function parseParameterSizeToBillion(value = '') {
  const text = clean(value).toLowerCase();
  const matches = [...text.matchAll(/([0-9]+(?:\.[0-9]+)?)\s*([btm])?\b/gi)];
  if (!matches.length) return undefined;
  const values = matches.map((match) => {
    const n = Number(match[1]);
    if (!Number.isFinite(n)) return undefined;
    const unit = (match[2] || 'b').toLowerCase();
    if (unit === 't') return n * 1000;
    if (unit === 'm') return n / 1000;
    return n;
  }).filter((n) => Number.isFinite(n));
  if (!values.length) return undefined;
  return Math.max(...values);
}

function estimateLocalQualityFromParams(parameterB = 0, modelId = '') {
  const id = cleanId(modelId);
  if (/coder|codestral|deepseek|qwen.*code/.test(id)) return { tier: parameterB >= 30 ? 'strong' : parameterB >= 7 ? 'good' : 'standard', coding: 'strong', reasoning: parameterB >= 30 ? 'strong' : 'standard', factuality: 'standard', context: 'unknown' };
  if (/70b|72b|90b|120b|405b/.test(id) || parameterB >= 60) return { tier: 'strong', reasoning: 'strong', coding: 'good', factuality: 'good', context: 'unknown' };
  if (/32b|34b|30b/.test(id) || parameterB >= 30) return { tier: 'good', reasoning: 'good', coding: 'good', factuality: 'standard', context: 'unknown' };
  if (/14b|12b|13b/.test(id) || parameterB >= 12) return { tier: 'good', reasoning: 'standard', coding: 'standard', factuality: 'standard', context: 'unknown' };
  if (/7b|8b|9b/.test(id) || parameterB >= 7) return { tier: 'standard', reasoning: 'standard', coding: 'standard', factuality: 'draft', context: 'unknown' };
  return { tier: 'draft', reasoning: 'draft', coding: 'draft', factuality: 'draft', context: 'unknown' };
}

function estimateLocalLatencyFromParams(parameterB = 0) {
  if (!parameterB) return { tier: 'medium', expected: 'medium' };
  if (parameterB <= 4) return { tier: 'fast', expected: 'fast' };
  if (parameterB <= 14) return { tier: 'medium', expected: 'medium' };
  if (parameterB <= 34) return { tier: 'slow', expected: 'slow' };
  return { tier: 'very_slow', expected: 'very_slow' };
}

function inferCapabilities(modelId = '', runtime = '', explicit = {}) {
  const id = cleanId(modelId);
  const caps = {
    chat: true,
    structured_json: /gpt|gemini|qwen|llama|mistral|deepseek|gemma|phi|codex|coder/i.test(id),
    tool_calling: /gpt|gemini|claude/i.test(id),
    code: /code|coder|codex|deepseek|qwen|gpt|gemini|llama|mistral/i.test(id),
    vision: /vision|llava|bakllava|moondream|gpt-4o|gemini/i.test(id),
    embedding: /embed|embedding|nomic|bge|e5/i.test(id),
  };
  if (cleanId(runtime) === 'ollama') caps.tool_calling = false;
  return { ...caps, ...asObject(explicit) };
}

const KNOWN_MODEL_PATTERNS = [
  {
    // Future GPT-5.x Codex models should remain usable before a code release adds a named entry.
    // Exact routing promotion still depends on live evaluation evidence.
    test: /^gpt-5\.(?:[6-9]|[1-9][0-9])(?:[-_.]|$)/,
    spec: { cost_profile: { tier: 'premium', billing: 'subscription_or_metered' }, latency_profile: { tier: 'medium', expected: 'medium' }, quality_profile: { tier: 'frontier_candidate', reasoning: 'unknown_until_evaluated', coding: 'unknown_until_evaluated', factuality: 'unknown_until_evaluated', context: 'unknown' }, capabilities: { chat: true, structured_json: true, tool_calling: true, code: true }, routing: { prefer_for: ['benchmark_candidate'] } },
  },
  {
    test: /^gpt-5\.5|^gpt-5_5|^gpt-5$/,
    spec: { cost_profile: { tier: 'premium', billing: 'subscription_or_metered' }, latency_profile: { tier: 'medium', expected: 'medium' }, quality_profile: { tier: 'frontier', reasoning: 'frontier', coding: 'frontier', factuality: 'strong', context: 'very_large' }, capabilities: { chat: true, structured_json: true, tool_calling: true, code: true }, routing: { prefer_for: ['hard_reasoning', 'architecture', 'synthesis', 'reviewer', 'verifier'] } },
  },
  {
    test: /^gpt-5\.4|^gpt-5_4|^gpt-5-codex|^gpt-5_codex/,
    spec: { cost_profile: { tier: 'premium', billing: 'subscription_or_metered' }, latency_profile: { tier: 'medium', expected: 'medium' }, quality_profile: { tier: 'frontier', reasoning: 'strong', coding: 'frontier', factuality: 'strong', context: 'large' }, capabilities: { chat: true, structured_json: true, tool_calling: true, code: true }, routing: { prefer_for: ['builder', 'reviewer', 'verifier', 'code'] } },
  },
  {
    test: /^gemini-3.*pro|^gemini-2\.5.*pro/,
    spec: { cost_profile: { tier: 'premium', billing: 'metered_or_quota' }, latency_profile: { tier: 'medium', expected: 'medium' }, quality_profile: { tier: 'frontier', reasoning: 'frontier', coding: 'strong', factuality: 'strong', context: 'large' }, capabilities: { chat: true, structured_json: true, tool_calling: true, code: true, vision: true }, routing: { prefer_for: ['planner', 'researcher', 'hard_reasoning'] } },
  },
  {
    test: /^gemini-3.*flash|^gemini-2\.5.*flash/,
    spec: { cost_profile: { tier: 'cheap', billing: 'metered_or_quota' }, latency_profile: { tier: 'fast', expected: 'fast' }, quality_profile: { tier: 'good', reasoning: 'good', coding: 'good', factuality: 'good', context: 'large' }, capabilities: { chat: true, structured_json: true, tool_calling: true, code: true, vision: true }, routing: { prefer_for: ['researcher', 'draft', 'fast_summary'] } },
  },
  {
    test: /embed|embedding|nomic|bge|e5/,
    spec: { cost_profile: { tier: 'free', billing: 'local_or_metered' }, latency_profile: { tier: 'fast', expected: 'fast' }, quality_profile: { tier: 'standard', reasoning: 'draft', coding: 'draft', factuality: 'standard', context: 'small' }, capabilities: { chat: false, embedding: true }, routing: { prefer_for: ['embedding', 'semantic_index'] } },
  },
];

function mergeProfile(primary = {}, fallback = {}) {
  return { ...asObject(fallback), ...asObject(primary) };
}

function mergeQualityProfile(catalogProfile = {}, explicitProfile = {}) {
  const catalog = asObject(catalogProfile);
  const explicit = asObject(explicitProfile);
  const merged = { ...catalog, ...explicit };
  const explicitTier = cleanId(explicit.tier || '');
  const catalogTier = cleanId(catalog.tier || '');
  if ((!explicitTier || explicitTier === 'standard') && catalogTier && catalogTier !== 'standard') merged.tier = catalog.tier;
  if ((!explicit.reasoning || cleanId(explicit.reasoning) === 'standard') && catalog.reasoning) merged.reasoning = catalog.reasoning;
  if ((!explicit.coding || cleanId(explicit.coding) === 'standard') && catalog.coding) merged.coding = catalog.coding;
  if ((!explicit.factuality || cleanId(explicit.factuality) === 'standard') && catalog.factuality) merged.factuality = catalog.factuality;
  if ((!explicit.context || cleanId(explicit.context) === 'standard') && catalog.context) merged.context = catalog.context;
  return merged;
}

function pickKnownSpec(modelId = '') {
  const id = cleanId(modelId);
  for (const row of KNOWN_MODEL_PATTERNS) {
    if (row.test.test(id)) return row.spec;
  }
  return {};
}

export function inferModelCatalogEntry(input = {}) {
  const row = asObject(input);
  const modelId = clean(row.model || row.model_id || row.id || row.name || '');
  const runtime = cleanId(row.runtime || row.provider || '');
  const details = asObject(row.details || row.model_details || row.modelDetails);
  const parameterB = parseParameterSizeToBillion(row.parameter_size || row.parameterSize || details.parameter_size || details.parameterSize || modelId);
  const known = pickKnownSpec(modelId);
  const localLike = runtime === 'ollama' || runtime === 'llama_cpp' || row.provider === 'openai_compatible' && /localhost|127\.0\.0\.1|11434/i.test(clean(row.base_url || row.baseUrl || ''));
  const estimatedQuality = localLike ? estimateLocalQualityFromParams(parameterB, modelId) : { tier: 'standard', reasoning: 'standard', coding: 'standard', factuality: 'standard', context: 'unknown' };
  const estimatedLatency = localLike ? estimateLocalLatencyFromParams(parameterB) : { tier: 'medium', expected: 'medium' };
  const contextTokens = numberOrUndefined(row.context_tokens || row.contextTokens || details.context_length || details.contextLength || row.num_ctx || row.numCtx);
  const cost = localLike ? { tier: 'free', billing: 'local_compute' } : { tier: 'unknown', billing: 'unknown' };
  const quality = mergeProfile(known.quality_profile, estimatedQuality);
  const latency = mergeProfile(known.latency_profile, estimatedLatency);
  const caps = inferCapabilities(modelId, runtime, known.capabilities);
  const routing = mergeProfile(known.routing, {});
  return {
    model: modelId,
    family: clean(details.family || row.family || ''),
    parameter_size: clean(details.parameter_size || row.parameter_size || ''),
    parameter_size_b: parameterB,
    quantization_level: clean(details.quantization_level || row.quantization_level || ''),
    cost_profile: mergeProfile(known.cost_profile, cost),
    latency_profile: latency,
    quality_profile: quality,
    capabilities: caps,
    limits: { context_tokens: contextTokens },
    routing,
    catalog_confidence: Object.keys(known).length ? 'known_pattern' : (parameterB ? 'estimated_from_size' : 'default_estimate'),
  };
}

export function applyModelCatalogToNode(node = {}) {
  const catalog = inferModelCatalogEntry(node);
  return {
    ...asObject(node),
    capabilities: { ...asObject(catalog.capabilities), ...asObject(node.capabilities) },
    limits: { ...asObject(catalog.limits), ...asObject(node.limits) },
    cost_profile: { ...asObject(catalog.cost_profile), ...asObject(node.cost_profile) },
    latency_profile: { ...asObject(catalog.latency_profile), ...asObject(node.latency_profile) },
    quality_profile: mergeQualityProfile(catalog.quality_profile, node.quality_profile),
    routing: {
      ...asObject(catalog.routing),
      ...asObject(node.routing),
      prefer_for: [...new Set([...(catalog.routing?.prefer_for || []), ...(node.routing?.prefer_for || [])])],
      avoid_for: [...new Set([...(catalog.routing?.avoid_for || []), ...(node.routing?.avoid_for || [])])],
    },
    model_catalog: {
      ...asObject(node.model_catalog || node.modelCatalog),
      family: clean(node.model_catalog?.family || node.modelCatalog?.family || catalog.family || ''),
      parameter_size: clean(node.model_catalog?.parameter_size || node.modelCatalog?.parameterSize || catalog.parameter_size || ''),
      parameter_size_b: node.model_catalog?.parameter_size_b ?? node.modelCatalog?.parameterSizeB ?? catalog.parameter_size_b,
      quantization_level: clean(node.model_catalog?.quantization_level || node.modelCatalog?.quantizationLevel || catalog.quantization_level || ''),
      confidence: clean(node.model_catalog?.confidence || node.modelCatalog?.confidence || catalog.catalog_confidence || ''),
    },
  };
}

export function summarizeModelCatalogEntry(node = {}) {
  const merged = applyModelCatalogToNode(node);
  const bits = [
    `cost=${merged.cost_profile?.tier || 'unknown'}`,
    `latency=${merged.latency_profile?.tier || 'unknown'}`,
    `quality=${merged.quality_profile?.tier || 'standard'}`,
    `context=${merged.limits?.context_tokens || 'unknown'}`,
  ];
  if (merged.model_catalog?.parameter_size) bits.push(`size=${merged.model_catalog.parameter_size}`);
  if (merged.model_catalog?.quantization_level) bits.push(`quant=${merged.model_catalog.quantization_level}`);
  return bits.join(', ');
}
