import { resolveDdalggakRuntimeConfig } from './runtime_config.js';

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
  const runtime = resolveDdalggakRuntimeConfig({ env });
  return configured(env.DDALGGAK_ASK_ANTIGRAVITY_ENABLED)
    ? truthyEnv(env.DDALGGAK_ASK_ANTIGRAVITY_ENABLED)
    : runtime.fast.provider === 'antigravity'
      || runtime.search.provider === 'antigravity'
      || configured(env.ANTIGRAVITY_CLI_COMMAND)
      || configured(env.GOOGLE_AI_CLI_COMMAND)
      || configured(env.ANTIGRAVITY_MODEL)
      || configured(env.GOOGLE_AI_MODEL)
      || lower(env.DDALGGAK_DIRECT_ASK_PROVIDER) === 'antigravity'
      || lower(env.DDALGGAK_SEARCH_ASK_PROVIDER) === 'antigravity';
}

export function openAICompatibleConfigured(env = process.env, { prefix = 'DDALGGAK_DIRECT_ASK' } = {}) {
  const runtime = resolveDdalggakRuntimeConfig({ env });
  const route = prefix === 'DDALGGAK_SEARCH_ASK' ? 'search' : 'fast';
  const routeConfig = route === 'search' ? runtime.search : runtime.fast;
  const baseUrl = env[`${prefix}_BASE_URL`] || env.DDALGGAK_LOCAL_BASE_URL || env.OPENAI_COMPATIBLE_BASE_URL || env.LOCAL_MODEL_BASE_URL || env.OLLAMA_BASE_URL || routeConfig?.openai_compatible?.base_url || '';
  const model = env[`${prefix}_MODEL`] || env.DDALGGAK_FAST_MODEL || env.DDALGGAK_CHAT_MODEL || env.DDALGGAK_LOCAL_MODEL || env.OPENAI_COMPATIBLE_MODEL || env.LOCAL_MODEL || env.OLLAMA_MODEL || routeConfig?.model || '';
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
  const runtime = resolveDdalggakRuntimeConfig({ env });
  if (cleanRoute === 'concierge_search_answer') {
    return env.DDALGGAK_SEARCH_ASK_PROVIDER || env.ROOM_CONCIERGE_SEARCH_ASK_PROVIDER || env.DDALGGAK_SEARCH_PROVIDER || env.DDALGGAK_SEARCH_MODEL_PROVIDER || env.DDALGGAK_DIRECT_ASK_PROVIDER || env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER || runtime.search.provider || '';
  }
  return env.DDALGGAK_DIRECT_ASK_PROVIDER || env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER || env.DDALGGAK_FAST_PROVIDER || env.DDALGGAK_FAST_MODEL_PROVIDER || env.DDALGGAK_CHAT_PROVIDER || runtime.fast.provider || '';
}

function envModelForProvider(provider = '', route = '', env = process.env) {
  const cleanProvider = normalizeConciergeProvider(provider);
  const cleanRoute = lower(route);
  const runtime = resolveDdalggakRuntimeConfig({ env });
  const routeConfig = cleanRoute === 'concierge_search_answer' ? runtime.search : runtime.fast;
  if (cleanProvider === 'antigravity') return routeConfig.model || env.DDALGGAK_FAST_MODEL || env.DDALGGAK_CHAT_MODEL || env.DDALGGAK_ASK_ANTIGRAVITY_MODEL || env.ANTIGRAVITY_MODEL || env.GOOGLE_AI_MODEL || '';
  if (cleanProvider === 'openai_compatible' || cleanProvider === 'openai') {
    const prefix = cleanRoute === 'concierge_search_answer' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK';
    return routeConfig.model || env[`${prefix}_MODEL`] || env.DDALGGAK_FAST_MODEL || env.DDALGGAK_CHAT_MODEL || env.DDALGGAK_LOCAL_MODEL || env.DDALGGAK_DIRECT_ASK_MODEL || env.OPENAI_COMPATIBLE_MODEL || env.LOCAL_MODEL || env.OLLAMA_MODEL || '';
  }
  if (cleanProvider === 'codex') return routeConfig.model || env.DDALGGAK_SEARCH_ASK_CODEX_MODEL || env.DDALGGAK_DIRECT_ASK_CODEX_MODEL || env.DDALGGAK_WORK_MODEL || env.CODEX_MODEL || env.CODEX_ASSIST_MODEL || '';
  return routeConfig.model || '';
}

export function resolveRoomConciergeModelPolicy({ decision = {}, env = process.env, allowCodexFallback = false } = {}) {
  const route = lower(decision?.route || 'standard_workbench');
  const runtime = resolveDdalggakRuntimeConfig({ env });
  const explicit = normalizeConciergeProvider(envProviderForRoute(route, env));
  const reasons = [`runtime_preset:${runtime.preset}`, `context_budget:${runtime.context_budget}`];
  let provider = explicit;

  if (!provider || provider === 'auto') {
    if (antigravityConfigured(env)) {
      provider = 'antigravity';
      reasons.push('auto_prefers_configured_antigravity_for_non_coding_ask');
    } else if (openAICompatibleConfigured(env, { prefix: route === 'concierge_search_answer' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK' })) {
      provider = 'openai_compatible';
      reasons.push('auto_uses_configured_openai_compatible_model');
    } else if (allowCodexFallback || (truthyEnv(env.DDALGGAK_ASK_ALLOW_CODEX_FALLBACK) || runtime.flags.allow_codex_fast_path_fallback)) {
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
    allow_codex_fallback: !!(allowCodexFallback || (truthyEnv(env.DDALGGAK_ASK_ALLOW_CODEX_FALLBACK) || runtime.flags.allow_codex_fast_path_fallback)),
    reasons,
  };
}

export function shouldEnableConciergeFastPathForPolicy(policy = {}) {
  const provider = normalizeConciergeProvider(policy?.provider || '');
  return ['antigravity', 'openai', 'openai_compatible', 'codex'].includes(provider);
}
