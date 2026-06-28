function clean(value = '') {
  return String(value || '').trim();
}

function lower(value = '') {
  return clean(value).toLowerCase();
}

function truthyEnv(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(lower(value));
}

function configured(value = '') {
  return clean(value).length > 0;
}

export function antigravityConfigured(env = process.env) {
  return configured(env.DDALGGAK_ASK_ANTIGRAVITY_ENABLED)
    ? truthyEnv(env.DDALGGAK_ASK_ANTIGRAVITY_ENABLED)
    : configured(env.ANTIGRAVITY_CLI_COMMAND)
      || configured(env.GOOGLE_AI_CLI_COMMAND)
      || configured(env.ANTIGRAVITY_MODEL)
      || configured(env.GOOGLE_AI_MODEL)
      || lower(env.DDALGGAK_DIRECT_ASK_PROVIDER) === 'antigravity'
      || lower(env.DDALGGAK_SEARCH_ASK_PROVIDER) === 'antigravity';
}

export function openAICompatibleConfigured(env = process.env, { prefix = 'DDALGGAK_DIRECT_ASK' } = {}) {
  const baseUrl = env[`${prefix}_BASE_URL`] || env.OPENAI_COMPATIBLE_BASE_URL || env.LOCAL_MODEL_BASE_URL || env.OLLAMA_BASE_URL || '';
  const model = env[`${prefix}_MODEL`] || env.OPENAI_COMPATIBLE_MODEL || env.LOCAL_MODEL || env.OLLAMA_MODEL || '';
  return configured(baseUrl) && configured(model);
}

export function normalizeConciergeProvider(value = '') {
  const provider = lower(value);
  if (['anti_gravity', 'anti-gravity', 'google_ai', 'google-ai', 'antigravity_cli'].includes(provider)) return 'antigravity';
  if (['openai-compatible', 'openai_compatible', 'local', 'ollama'].includes(provider)) return 'openai_compatible';
  if (['codex', 'openai', 'antigravity', 'auto', ''].includes(provider)) return provider;
  return provider;
}

function envProviderForRoute(route = '', env = process.env) {
  const cleanRoute = lower(route);
  if (cleanRoute === 'concierge_search_answer') {
    return env.DDALGGAK_SEARCH_ASK_PROVIDER || env.ROOM_CONCIERGE_SEARCH_ASK_PROVIDER || env.DDALGGAK_DIRECT_ASK_PROVIDER || env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER || '';
  }
  return env.DDALGGAK_DIRECT_ASK_PROVIDER || env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER || '';
}

function envModelForProvider(provider = '', route = '', env = process.env) {
  const cleanProvider = normalizeConciergeProvider(provider);
  const cleanRoute = lower(route);
  if (cleanProvider === 'antigravity') return env.DDALGGAK_ASK_ANTIGRAVITY_MODEL || env.ANTIGRAVITY_MODEL || env.GOOGLE_AI_MODEL || '';
  if (cleanProvider === 'openai_compatible' || cleanProvider === 'openai') {
    const prefix = cleanRoute === 'concierge_search_answer' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK';
    return env[`${prefix}_MODEL`] || env.DDALGGAK_DIRECT_ASK_MODEL || env.OPENAI_COMPATIBLE_MODEL || env.LOCAL_MODEL || env.OLLAMA_MODEL || '';
  }
  if (cleanProvider === 'codex') return env.DDALGGAK_DIRECT_ASK_CODEX_MODEL || env.CODEX_MODEL || env.CODEX_ASSIST_MODEL || '';
  return '';
}

export function resolveRoomConciergeModelPolicy({ decision = {}, env = process.env, allowCodexFallback = false } = {}) {
  const route = lower(decision?.route || 'standard_workbench');
  const explicit = normalizeConciergeProvider(envProviderForRoute(route, env));
  const reasons = [];
  let provider = explicit;

  if (!provider || provider === 'auto') {
    if (antigravityConfigured(env)) {
      provider = 'antigravity';
      reasons.push('auto_prefers_configured_antigravity_for_non_coding_ask');
    } else if (openAICompatibleConfigured(env, { prefix: route === 'concierge_search_answer' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK' })) {
      provider = 'openai_compatible';
      reasons.push('auto_uses_configured_openai_compatible_model');
    } else if (allowCodexFallback || truthyEnv(env.DDALGGAK_ASK_ALLOW_CODEX_FALLBACK)) {
      provider = 'codex';
      reasons.push('codex_fallback_explicitly_allowed');
    } else {
      provider = '';
      reasons.push('no_fast_path_provider_configured');
    }
  } else {
    reasons.push(`explicit_provider:${provider}`);
  }

  const model = envModelForProvider(provider, route, env);
  return {
    kind: 'room_concierge_model_policy_v1',
    route,
    provider,
    model: clean(model),
    allow_codex_fallback: !!(allowCodexFallback || truthyEnv(env.DDALGGAK_ASK_ALLOW_CODEX_FALLBACK)),
    reasons,
  };
}

export function shouldEnableConciergeFastPathForPolicy(policy = {}) {
  const provider = normalizeConciergeProvider(policy?.provider || '');
  return ['antigravity', 'openai', 'openai_compatible', 'codex'].includes(provider);
}
