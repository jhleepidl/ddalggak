function clean(value = '') {
  return String(value ?? '').trim();
}

function lower(value = '') {
  return clean(value).toLowerCase();
}

function first(...values) {
  for (const value of values) {
    const normalized = clean(value);
    if (normalized) return normalized;
  }
  return '';
}

function positiveInt(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function normalizeProvider(value = '') {
  const provider = lower(value);
  if (['', 'auto'].includes(provider)) return provider;
  if (['anti_gravity', 'anti-gravity', 'google_ai', 'google-ai', 'antigravity_cli'].includes(provider)) return 'antigravity';
  if (['openai-compatible', 'openai_compatible', 'local', 'ollama', 'local_model', 'openai-compatible-local'].includes(provider)) return 'openai_compatible';
  if (['codex', 'openai', 'antigravity', 'none', 'disabled', 'workbench'].includes(provider)) return provider;
  return provider;
}

function normalizePreset(value = '') {
  const preset = lower(value || 'balanced');
  if (['fast', 'free_fast', 'local-fast', 'local_fast'].includes(preset)) return 'local_fast';
  if (['codex', 'codex-only', 'codex_only', 'workbench'].includes(preset)) return 'codex_workbench';
  if (['local', 'local_model', 'local-model'].includes(preset)) return 'local_model';
  if (['minimal', 'safe', 'balanced', 'auto', ''].includes(preset)) return 'balanced';
  return preset;
}

function normalizeBudget(value = '') {
  const budget = lower(value || 'medium');
  if (['s', 'small', 'tight', 'fast'].includes(budget)) return 'small';
  if (['l', 'large', 'rich', 'full'].includes(budget)) return 'large';
  return 'medium';
}

const PRESETS = {
  balanced: {
    description: 'auto route selection; fast path uses configured lightweight provider when available; workbench keeps legacy provider policy',
    fastProvider: 'auto',
    searchProvider: 'auto',
    workbenchProvider: '',
    directTimeoutMs: 25000,
    searchTimeoutMs: 20000,
    searchMaxSeconds: 20,
    searchFallbackToWorkbench: true,
    allowCodexFallback: false,
  },
  local_fast: {
    description: 'prefer Antigravity or local lightweight model for /c and search; keep heavy work in workbench',
    fastProvider: 'antigravity',
    searchProvider: 'antigravity',
    workbenchProvider: '',
    directTimeoutMs: 25000,
    searchTimeoutMs: 20000,
    searchMaxSeconds: 20,
    searchFallbackToWorkbench: true,
    allowCodexFallback: false,
  },
  local_model: {
    description: 'prefer an OpenAI-compatible local model for fast conversational turns',
    fastProvider: 'openai_compatible',
    searchProvider: 'openai_compatible',
    workbenchProvider: '',
    directTimeoutMs: 25000,
    searchTimeoutMs: 20000,
    searchMaxSeconds: 20,
    searchFallbackToWorkbench: true,
    allowCodexFallback: false,
  },
  codex_workbench: {
    description: 'use Codex for explicit heavy workbench paths; direct casual Codex remains opt-in unless set by provider',
    fastProvider: 'auto',
    searchProvider: 'auto',
    workbenchProvider: 'codex',
    directTimeoutMs: 45000,
    searchTimeoutMs: 30000,
    searchMaxSeconds: 30,
    searchFallbackToWorkbench: true,
    allowCodexFallback: false,
  },
};

function budgetDefaults(budget = 'medium') {
  if (budget === 'small') {
    return {
      directContextMaxChars: 800,
      directContextTurns: 3,
      searchContextMaxChars: 1200,
      searchContextTurns: 4,
      directMaxChars: 360,
      directMaxTokenishUnits: 45,
    };
  }
  if (budget === 'large') {
    return {
      directContextMaxChars: 1800,
      directContextTurns: 6,
      searchContextMaxChars: 3000,
      searchContextTurns: 10,
      directMaxChars: 640,
      directMaxTokenishUnits: 85,
    };
  }
  return {
    directContextMaxChars: 1200,
    directContextTurns: 4,
    searchContextMaxChars: 1800,
    searchContextTurns: 6,
    directMaxChars: 420,
    directMaxTokenishUnits: 55,
  };
}

function resolveOpenAICompatibleBaseUrl(env = process.env, route = 'direct') {
  const prefix = route === 'search' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK';
  return first(
    env[`${prefix}_BASE_URL`],
    route === 'search' ? env.DDALGGAK_DIRECT_ASK_BASE_URL : '',
    env.DDALGGAK_LOCAL_BASE_URL,
    env.OPENAI_COMPATIBLE_BASE_URL,
    env.LOCAL_MODEL_BASE_URL,
    env.OLLAMA_BASE_URL,
  );
}

function resolveOpenAICompatibleApiKey(env = process.env, route = 'direct') {
  const prefix = route === 'search' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK';
  return first(
    env[`${prefix}_API_KEY`],
    route === 'search' ? env.DDALGGAK_DIRECT_ASK_API_KEY : '',
    env.DDALGGAK_LOCAL_API_KEY,
    env.OPENAI_COMPATIBLE_API_KEY,
    env.LOCAL_MODEL_API_KEY,
    env.OLLAMA_API_KEY,
  );
}

function resolveOpenAICompatibleRuntime(env = process.env, route = 'direct') {
  const prefix = route === 'search' ? 'DDALGGAK_SEARCH_ASK' : 'DDALGGAK_DIRECT_ASK';
  return first(env[`${prefix}_RUNTIME`], route === 'search' ? env.DDALGGAK_DIRECT_ASK_RUNTIME : '', env.DDALGGAK_LOCAL_RUNTIME);
}

function resolveRouteModel({ env = process.env, route = 'direct', provider = '', preset = {} } = {}) {
  const normalized = normalizeProvider(provider);
  if (route === 'search') {
    return first(
      env.DDALGGAK_SEARCH_MODEL,
      env.DDALGGAK_SEARCH_ASK_MODEL,
      env.DDALGGAK_FAST_MODEL,
      env.DDALGGAK_CHAT_MODEL,
      normalized === 'codex' ? env.DDALGGAK_SEARCH_ASK_CODEX_MODEL : '',
      normalized === 'codex' ? env.DDALGGAK_DIRECT_ASK_CODEX_MODEL : '',
      normalized === 'codex' ? env.CODEX_MODEL : '',
      normalized === 'codex' ? env.CODEX_ASSIST_MODEL : '',
      normalized === 'antigravity' ? env.ANTIGRAVITY_MODEL : '',
      normalized === 'antigravity' ? env.GOOGLE_AI_MODEL : '',
      normalized === 'openai_compatible' || normalized === 'openai' ? env.DDALGGAK_LOCAL_MODEL : '',
      normalized === 'openai_compatible' || normalized === 'openai' ? env.OPENAI_COMPATIBLE_MODEL : '',
      normalized === 'openai_compatible' || normalized === 'openai' ? env.LOCAL_MODEL : '',
      normalized === 'openai_compatible' || normalized === 'openai' ? env.OLLAMA_MODEL : '',
      preset.searchModel,
    );
  }
  if (route === 'workbench') {
    return first(
      env.DDALGGAK_WORK_MODEL,
      env.DDALGGAK_WORKBENCH_MODEL,
      normalized === 'codex' ? env.CODEX_MODEL : '',
      normalized === 'codex' ? env.CODEX_ASSIST_MODEL : '',
      normalized === 'antigravity' ? env.ANTIGRAVITY_MODEL : '',
      normalized === 'antigravity' ? env.GOOGLE_AI_MODEL : '',
      preset.workbenchModel,
    );
  }
  return first(
    env.DDALGGAK_FAST_MODEL,
    env.DDALGGAK_CHAT_MODEL,
    env.DDALGGAK_DIRECT_ASK_MODEL,
    normalized === 'codex' ? env.DDALGGAK_DIRECT_ASK_CODEX_MODEL : '',
    normalized === 'codex' ? env.CODEX_MODEL : '',
    normalized === 'codex' ? env.CODEX_ASSIST_MODEL : '',
    normalized === 'antigravity' ? env.DDALGGAK_ASK_ANTIGRAVITY_MODEL : '',
    normalized === 'antigravity' ? env.ANTIGRAVITY_MODEL : '',
    normalized === 'antigravity' ? env.GOOGLE_AI_MODEL : '',
    normalized === 'openai_compatible' || normalized === 'openai' ? env.DDALGGAK_LOCAL_MODEL : '',
    normalized === 'openai_compatible' || normalized === 'openai' ? env.OPENAI_COMPATIBLE_MODEL : '',
    normalized === 'openai_compatible' || normalized === 'openai' ? env.LOCAL_MODEL : '',
    normalized === 'openai_compatible' || normalized === 'openai' ? env.OLLAMA_MODEL : '',
    preset.fastModel,
  );
}

function resolveRouteProvider({ env = process.env, route = 'direct', preset = {} } = {}) {
  if (route === 'search') {
    return normalizeProvider(first(
      env.DDALGGAK_SEARCH_PROVIDER,
      env.DDALGGAK_SEARCH_MODEL_PROVIDER,
      env.DDALGGAK_SEARCH_ASK_PROVIDER,
      env.ROOM_CONCIERGE_SEARCH_ASK_PROVIDER,
      env.DDALGGAK_FAST_PROVIDER,
      env.DDALGGAK_FAST_MODEL_PROVIDER,
      env.DDALGGAK_CHAT_PROVIDER,
      env.DDALGGAK_DIRECT_ASK_PROVIDER,
      env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER,
      preset.searchProvider,
    ));
  }
  if (route === 'workbench') {
    return normalizeProvider(first(
      env.DDALGGAK_WORK_PROVIDER,
      env.DDALGGAK_WORKBENCH_PROVIDER,
      env.DDALGGAK_AGENT_PROVIDER,
      env.DDALGGAK_GEMINI_REPLACEMENT_PROVIDER,
      env.GEMINI_REPLACEMENT_PROVIDER,
      preset.workbenchProvider,
    ));
  }
  return normalizeProvider(first(
    env.DDALGGAK_FAST_PROVIDER,
    env.DDALGGAK_FAST_MODEL_PROVIDER,
    env.DDALGGAK_CHAT_PROVIDER,
    env.DDALGGAK_DIRECT_ASK_PROVIDER,
    env.ROOM_CONCIERGE_DIRECT_ASK_PROVIDER,
    preset.fastProvider,
  ));
}

export function resolveDdalggakRuntimeConfig({ env = process.env } = {}) {
  const presetName = normalizePreset(first(env.DDALGGAK_RUNTIME_PRESET, env.DDALGGAK_PROFILE, env.AI_ROOMS_RUNTIME_PRESET, 'balanced'));
  const preset = PRESETS[presetName] || PRESETS.balanced;
  const budget = normalizeBudget(first(env.DDALGGAK_CONTEXT_BUDGET, env.ROOM_CONTEXT_BUDGET, 'medium'));
  const budgets = budgetDefaults(budget);
  const fastProvider = resolveRouteProvider({ env, route: 'direct', preset });
  const searchProvider = resolveRouteProvider({ env, route: 'search', preset: { ...preset, searchProvider: preset.searchProvider || fastProvider } });
  const workbenchProvider = resolveRouteProvider({ env, route: 'workbench', preset });
  const directTimeoutMs = positiveInt(first(env.DDALGGAK_FAST_TIMEOUT_MS, env.DDALGGAK_DIRECT_ASK_TIMEOUT_MS, env.ANTIGRAVITY_TIMEOUT_MS), preset.directTimeoutMs, { min: 3000, max: 180000 });
  const searchMaxSeconds = positiveInt(first(env.DDALGGAK_SEARCH_MAX_SECONDS, env.DDALGGAK_SEARCH_ASK_MAX_SECONDS), preset.searchMaxSeconds, { min: 3, max: 180 });
  const searchTimeoutMs = positiveInt(first(env.DDALGGAK_SEARCH_TIMEOUT_MS, env.DDALGGAK_SEARCH_ASK_TIMEOUT_MS, env.ANTIGRAVITY_TIMEOUT_MS), preset.searchTimeoutMs || Math.max(8000, searchMaxSeconds * 1000), { min: 3000, max: 240000 });
  const allowCodexFallback = ['1', 'true', 'yes', 'on'].includes(lower(first(env.DDALGGAK_ALLOW_CODEX_FOR_FAST_PATH, env.DDALGGAK_ASK_ALLOW_CODEX_FALLBACK, preset.allowCodexFallback ? 'true' : 'false')));
  const searchFallbackToWorkbench = !['0', 'false', 'no', 'off'].includes(lower(first(env.DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH, env.DDALGGAK_SEARCH_ASK_FALLBACK_TO_WORKBENCH, preset.searchFallbackToWorkbench === false ? 'false' : 'true')));
  const fallbackNotice = !['0', 'false', 'no', 'off'].includes(lower(first(env.DDALGGAK_SEARCH_FALLBACK_NOTICE, env.DDALGGAK_SEARCH_ASK_FALLBACK_NOTICE, 'true')));

  const directModel = resolveRouteModel({ env, route: 'direct', provider: fastProvider, preset });
  const searchModel = resolveRouteModel({ env, route: 'search', provider: searchProvider, preset: { ...preset, fastModel: directModel } });
  const workbenchModel = resolveRouteModel({ env, route: 'workbench', provider: workbenchProvider, preset });

  return {
    schema_version: 'ddalggak.runtime_config/v1',
    preset: presetName,
    preset_description: preset.description,
    context_budget: budget,
    fast: {
      provider: fastProvider,
      model: directModel,
      timeout_ms: directTimeoutMs,
      context_max_chars: positiveInt(first(env.DDALGGAK_DIRECT_CONTEXT_MAX_CHARS, env.DDALGGAK_FAST_CONTEXT_MAX_CHARS), budgets.directContextMaxChars, { min: 200, max: 12000 }),
      context_turns: positiveInt(first(env.DDALGGAK_DIRECT_CONTEXT_TURNS, env.DDALGGAK_FAST_CONTEXT_TURNS), budgets.directContextTurns, { min: 1, max: 30 }),
      max_chars: positiveInt(first(env.DDALGGAK_DIRECT_ASK_MAX_CHARS, env.DDALGGAK_FAST_MAX_CHARS), budgets.directMaxChars, { min: 80, max: 4000 }),
      max_tokenish_units: positiveInt(first(env.DDALGGAK_DIRECT_ASK_MAX_TOKENISH_UNITS, env.DDALGGAK_FAST_MAX_TOKENISH_UNITS), budgets.directMaxTokenishUnits, { min: 10, max: 1000 }),
      openai_compatible: {
        base_url: resolveOpenAICompatibleBaseUrl(env, 'direct'),
        api_key_configured: !!resolveOpenAICompatibleApiKey(env, 'direct'),
        runtime: resolveOpenAICompatibleRuntime(env, 'direct'),
      },
    },
    search: {
      provider: searchProvider,
      model: searchModel,
      timeout_ms: searchTimeoutMs,
      max_seconds: searchMaxSeconds,
      context_max_chars: positiveInt(first(env.DDALGGAK_SEARCH_CONTEXT_MAX_CHARS, env.DDALGGAK_SEARCH_ASK_CONTEXT_MAX_CHARS), budgets.searchContextMaxChars, { min: 200, max: 20000 }),
      context_turns: positiveInt(first(env.DDALGGAK_SEARCH_CONTEXT_TURNS, env.DDALGGAK_SEARCH_ASK_CONTEXT_TURNS), budgets.searchContextTurns, { min: 1, max: 50 }),
      fallback_to_workbench: searchFallbackToWorkbench,
      fallback_notice: fallbackNotice,
      openai_compatible: {
        base_url: resolveOpenAICompatibleBaseUrl(env, 'search'),
        api_key_configured: !!resolveOpenAICompatibleApiKey(env, 'search'),
        runtime: resolveOpenAICompatibleRuntime(env, 'search'),
      },
    },
    workbench: {
      provider: workbenchProvider,
      model: workbenchModel,
    },
    flags: {
      allow_codex_fast_path_fallback: allowCodexFallback,
    },
  };
}

export function resolveDdalggakRouteRuntimeConfig(route = 'direct', { env = process.env } = {}) {
  const config = resolveDdalggakRuntimeConfig({ env });
  if (route === 'search' || route === 'concierge_search_answer') return config.search;
  if (route === 'workbench' || route === 'agent' || route === 'team') return config.workbench;
  return config.fast;
}


const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off', 'n']);

const SIMPLIFIED_ENV_KEYS = [
  'DDALGGAK_RUNTIME_PRESET',
  'DDALGGAK_PROFILE',
  'AI_ROOMS_RUNTIME_PRESET',
  'DDALGGAK_FAST_PROVIDER',
  'DDALGGAK_SEARCH_PROVIDER',
  'DDALGGAK_WORK_PROVIDER',
  'DDALGGAK_FAST_MODEL',
  'DDALGGAK_SEARCH_MODEL',
  'DDALGGAK_WORK_MODEL',
  'DDALGGAK_LOCAL_BASE_URL',
  'DDALGGAK_LOCAL_API_KEY',
  'DDALGGAK_LOCAL_RUNTIME',
  'DDALGGAK_LOCAL_MODEL',
  'DDALGGAK_CONTEXT_BUDGET',
  'ROOM_CONTEXT_BUDGET',
  'DDALGGAK_FAST_TIMEOUT_MS',
  'DDALGGAK_SEARCH_TIMEOUT_MS',
  'DDALGGAK_SEARCH_MAX_SECONDS',
  'DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH',
  'DDALGGAK_SEARCH_FALLBACK_NOTICE',
  'DDALGGAK_ALLOW_CODEX_FOR_FAST_PATH',
  'TEAM_ROLE_PROVIDER_POLICY_MODE',
  'TEAM_PLANNER_MODE',
  'TEAM_PLANNER_PROVIDER',
  'TEAM_CREATE_PLANNER_PROVIDER',
  'TEAM_REFINE_PLANNER_PROVIDER',
];

const LEGACY_ENV_KEYS = [
  'DDALGGAK_FAST_MODEL_PROVIDER',
  'DDALGGAK_CHAT_PROVIDER',
  'DDALGGAK_CHAT_MODEL',
  'DDALGGAK_DIRECT_ASK_PROVIDER',
  'DDALGGAK_DIRECT_ASK_MODEL',
  'DDALGGAK_DIRECT_ASK_CODEX_MODEL',
  'DDALGGAK_DIRECT_ASK_BASE_URL',
  'DDALGGAK_DIRECT_ASK_API_KEY',
  'DDALGGAK_DIRECT_ASK_RUNTIME',
  'DDALGGAK_DIRECT_ASK_TIMEOUT_MS',
  'DDALGGAK_DIRECT_ASK_MAX_CHARS',
  'DDALGGAK_DIRECT_ASK_MAX_TOKENISH_UNITS',
  'DDALGGAK_DIRECT_CONTEXT_MAX_CHARS',
  'DDALGGAK_DIRECT_CONTEXT_TURNS',
  'DDALGGAK_FAST_CONTEXT_MAX_CHARS',
  'DDALGGAK_FAST_CONTEXT_TURNS',
  'DDALGGAK_FAST_MAX_CHARS',
  'DDALGGAK_FAST_MAX_TOKENISH_UNITS',
  'DDALGGAK_SEARCH_MODEL_PROVIDER',
  'DDALGGAK_SEARCH_ASK_PROVIDER',
  'DDALGGAK_SEARCH_ASK_MODEL',
  'DDALGGAK_SEARCH_ASK_CODEX_MODEL',
  'DDALGGAK_SEARCH_ASK_BASE_URL',
  'DDALGGAK_SEARCH_ASK_API_KEY',
  'DDALGGAK_SEARCH_ASK_RUNTIME',
  'DDALGGAK_SEARCH_ASK_TIMEOUT_MS',
  'DDALGGAK_SEARCH_ASK_MAX_SECONDS',
  'DDALGGAK_SEARCH_ASK_CONTEXT_MAX_CHARS',
  'DDALGGAK_SEARCH_ASK_CONTEXT_TURNS',
  'DDALGGAK_SEARCH_ASK_FALLBACK_TO_WORKBENCH',
  'DDALGGAK_SEARCH_ASK_FALLBACK_NOTICE',
  'DDALGGAK_SEARCH_CONTEXT_MAX_CHARS',
  'DDALGGAK_SEARCH_CONTEXT_TURNS',
  'DDALGGAK_WORKBENCH_PROVIDER',
  'DDALGGAK_WORKBENCH_MODEL',
  'DDALGGAK_AGENT_PROVIDER',
  'DDALGGAK_GEMINI_REPLACEMENT_PROVIDER',
  'GEMINI_REPLACEMENT_PROVIDER',
  'DDALGGAK_ASK_ALLOW_CODEX_FALLBACK',
  'DDALGGAK_ASK_ANTIGRAVITY_MODEL',
  'ROOM_CONCIERGE_DIRECT_ASK_PROVIDER',
  'ROOM_CONCIERGE_SEARCH_ASK_PROVIDER',
  'ROOM_ASK_PROVIDER',
  'ROOM_AGENT_PROVIDER',
  'DDALGGAK_DEFAULT_PROVIDER',
];

const PROVIDER_ENV_KEYS = [
  'ANTIGRAVITY_CLI_COMMAND',
  'ANTIGRAVITY_MODEL',
  'ANTIGRAVITY_MODEL_ARG',
  'ANTIGRAVITY_MODEL_CANDIDATES',
  'ANTIGRAVITY_MODEL_DISCOVERY_ARGS',
  'ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED',
  'ANTIGRAVITY_TIMEOUT_MS',
  'GOOGLE_AI_MODEL',
  'CLAUDE_CLI_COMMAND',
  'CLAUDE_CLI_ARGS',
  'CLAUDE_CLI_MODEL',
  'CLAUDE_MODEL_CANDIDATES',
  'CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES',
  'CLAUDE_CLI_MODEL_DISCOVERY_ENABLED',
  'CLAUDE_CLI_TIMEOUT_MS',
  'CODEX_CLI_COMMAND',
  'CODEX_MODEL',
  'CODEX_MODEL_CANDIDATES',
  'CODEX_CLI_MODEL_DISCOVERY_ENABLED',
  'CODEX_ASSIST_MODEL',
  'CODEX_PROFILE',
  'CODEX_SANDBOX_MODE',
  'CODEX_APPROVAL_POLICY',
  'CODEX_ASSIST_SANDBOX_MODE',
  'CODEX_ASSIST_APPROVAL_POLICY',
  'MODEL_CATALOG_REFRESH_ENABLED',
  'MODEL_CATALOG_REFRESH_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS',
  'MODEL_CATALOG_REFRESH_IDLE_MIN_MS',
  'MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE',
  'MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT',
  'CLI_MODEL_DISCOVERY_TIMEOUT_MS',
  'MODEL_BENCHMARK_MIN_RUNS',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_MODEL',
  'LOCAL_MODEL_BASE_URL',
  'LOCAL_MODEL_API_KEY',
  'LOCAL_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'OLLAMA_MODEL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTIGRAVITY_CLI_ARGS',
  'CHAT_SUPERVISOR_PROVIDER',
  'CHAT_SUPERVISOR_ANTIGRAVITY_TIMEOUT_MS',
  'TEAM_ANTIGRAVITY_PLANNER_MODEL',
  'TEAM_CREATE_ANTIGRAVITY_PLANNER_MODEL',
  'TEAM_REFINE_ANTIGRAVITY_PLANNER_MODEL',
  'TEAM_CREATE_PLANNER_TIMEOUT_MS',
  'TEAM_REFINE_PLANNER_TIMEOUT_MS',
];

const TELEGRAM_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_ALLOWED_USER_IDS',
  'TELEGRAM_REQUIRE_MENTION_IN_GROUP',
  'TELEGRAM_POLLING',
  'TELEGRAM_WEBHOOK_URL',
  'TELEGRAM_WEBHOOK_PORT',
  'TZ',
  'DEFAULT_USER_LOCALE',
  'RUNS_DIR',
];

const GOC_ENV_KEYS = [
  'GOC_API_BASE',
  'GOC_SERVICE_KEY',
  'GOC_UI_BASE',
  'GOC_RUNTIME_COMMAND_POLL_ENABLED',
  'GOC_RUNTIME_COMMAND_POLL_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_MAX_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_ERROR_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_LIMIT',
  'GOC_RUN_EVENT_OUTBOX_ENABLED',
  'GOC_RUN_EVENT_BATCH_SIZE',
  'GOC_SYNC_BOOTSTRAP_MEMORY',
  'GOC_UI_LINK_MODE',
  'GOC_SYNC_MODE',
  'GOC_LATE_SYNC_ENABLED',
  'GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD',
  'GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS',
  'GOC_RUNTIME_COMMAND_POLL_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_MAX_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_ERROR_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_LIMIT',
  'GOC_RUN_EVENT_BATCH_SIZE',
  'MAX_CONCURRENCY',
  'MAX_PARALLEL_PER_RUN',
  'CHAT_MODEL_BADGE_MAX_PARTS',
  'GOC_ROUTE_CIRCUIT_BREAKER_DISABLED',
];

const TRACE_ENV_KEYS = [
  'LLM_TRACE_ENABLED',
  'LLM_TRACE_SAVE_PROMPTS',
  'LLM_TRACE_SAVE_OUTPUTS',
  'LLM_TRACE_REDACT_SECRETS',
  'LLM_TRACE_UNSCOPED',
  'CHAT_SHOW_MODEL_BADGE',
  'CHAT_MODEL_BADGE_MAX_PARTS',
  'CHAT_VERBOSE',
  'DDALGGAK_LOOP_DEFAULT_VISIBILITY',
  'IDLE_MEMORY_MAINTENANCE_ENABLED',
  'IDLE_LOOP_MEMORY_MAINTENANCE_LIMIT',
  'IDLE_MEMORY_MAINTENANCE_MIN_INTERVAL_MS',
  'IDLE_MEMORY_COMPACTION_STRESS_THRESHOLD',
];

const AUXILIARY_ENV_KEYS = [
  'DDALGGAK_ENV_FILE',
  'MEMORY_MODE',
  'MEMORY_SEED_MODE',
  'MAX_CONCURRENCY',
  'MAX_PARALLEL_PER_RUN',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_ENABLED',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_COMMAND',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_ARGS',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_TIMEOUT_MS',
  'DDALGGAK_ROOM_CONCIERGE_MODEL_ENABLED',
  'DDALGGAK_ROOM_CONCIERGE_MODEL_PATH',
  'DDALGGAK_ROOM_CONCIERGE_MODEL_MIN_CONFIDENCE',
  'ALLOW_GEMINI_CLI',
  'DDALGGAK_ALLOW_GEMINI_CLI',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  'GEMINI_CLI_COMMAND',
  'ROOM_MEMORY_TRIALS_OPENAI_MODEL',
  'ROOM_MEMORY_TRIALS_MAX_OUTPUT_TOKENS',
  'ROOM_MEMORY_TRIALS_TEMPERATURE',
  'ROOM_MEMORY_TRIALS_OPENAI_TIMEOUT_S',
  'NODE_ENV',
  'PORT',
  'HOST',
  'LOG_LEVEL',
  'DEBUG',
];

const RUNTIME_ENV_GROUPS = [
  { name: 'recommended', keys: SIMPLIFIED_ENV_KEYS },
  { name: 'legacy_overrides', keys: LEGACY_ENV_KEYS },
  { name: 'providers', keys: PROVIDER_ENV_KEYS },
  { name: 'telegram', keys: TELEGRAM_ENV_KEYS },
  { name: 'goc', keys: GOC_ENV_KEYS },
  { name: 'tracing', keys: TRACE_ENV_KEYS },
  { name: 'auxiliary', keys: AUXILIARY_ENV_KEYS },
];

const KNOWN_RUNTIME_ENV_KEYS = new Set(RUNTIME_ENV_GROUPS.flatMap((group) => group.keys));
const PROJECT_ENV_PREFIXES = [
  'DDALGGAK_', 'ROOM_CONCIERGE_', 'ROOM_', 'AI_ROOMS_', 'GOC_', 'TELEGRAM_', 'CODEX_', 'ANTIGRAVITY_',
  'GOOGLE_AI_', 'GEMINI_', 'CLAUDE_', 'MODEL_', 'CLI_MODEL_', 'OPENAI_COMPATIBLE_', 'LOCAL_MODEL_', 'OLLAMA_', 'LLM_TRACE_', 'CHAT_', 'ROOM_MEMORY_TRIALS_',
  'TEAM_', 'IDLE_', 'MEMORY_', 'MAX_',
];

const BOOLEAN_ENV_KEYS = new Set([
  'TELEGRAM_REQUIRE_MENTION_IN_GROUP',
  'DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH',
  'DDALGGAK_SEARCH_ASK_FALLBACK_TO_WORKBENCH',
  'DDALGGAK_SEARCH_FALLBACK_NOTICE',
  'DDALGGAK_SEARCH_ASK_FALLBACK_NOTICE',
  'DDALGGAK_ALLOW_CODEX_FOR_FAST_PATH',
  'DDALGGAK_ASK_ALLOW_CODEX_FALLBACK',
  'MODEL_CATALOG_REFRESH_ENABLED',
  'MODEL_CATALOG_REFRESH_ON_CLI_VERSION_CHANGE',
  'MODEL_DISCOVERY_INCLUDE_PROVIDER_DEFAULT',
  'CODEX_CLI_MODEL_DISCOVERY_ENABLED',
  'CLAUDE_CLI_MODEL_DISCOVERY_ENABLED',
  'CLAUDE_MODEL_DISCOVERY_INCLUDE_ALIASES',
  'ANTIGRAVITY_CLI_MODEL_DISCOVERY_ENABLED',
  'GOC_LATE_SYNC_ENABLED',
  'GOC_ROUTE_CIRCUIT_BREAKER_DISABLED',
  'LLM_TRACE_ENABLED',
  'LLM_TRACE_SAVE_PROMPTS',
  'LLM_TRACE_SAVE_OUTPUTS',
  'LLM_TRACE_REDACT_SECRETS',
  'LLM_TRACE_UNSCOPED',
  'CHAT_SHOW_MODEL_BADGE',
  'CHAT_VERBOSE',
  'IDLE_MEMORY_MAINTENANCE_ENABLED',
  'GOC_RUNTIME_COMMAND_POLL_ENABLED',
  'GOC_RUN_EVENT_OUTBOX_ENABLED',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_ENABLED',
  'DDALGGAK_ROOM_CONCIERGE_MODEL_ENABLED',
  'ALLOW_GEMINI_CLI',
  'DDALGGAK_ALLOW_GEMINI_CLI',
]);

const INTEGER_ENV_KEYS = new Set([
  'DDALGGAK_FAST_TIMEOUT_MS',
  'DDALGGAK_DIRECT_ASK_TIMEOUT_MS',
  'DDALGGAK_SEARCH_TIMEOUT_MS',
  'DDALGGAK_SEARCH_ASK_TIMEOUT_MS',
  'DDALGGAK_SEARCH_MAX_SECONDS',
  'DDALGGAK_SEARCH_ASK_MAX_SECONDS',
  'DDALGGAK_DIRECT_ASK_MAX_CHARS',
  'DDALGGAK_FAST_MAX_CHARS',
  'DDALGGAK_DIRECT_ASK_MAX_TOKENISH_UNITS',
  'DDALGGAK_FAST_MAX_TOKENISH_UNITS',
  'DDALGGAK_DIRECT_CONTEXT_MAX_CHARS',
  'DDALGGAK_FAST_CONTEXT_MAX_CHARS',
  'DDALGGAK_DIRECT_CONTEXT_TURNS',
  'DDALGGAK_FAST_CONTEXT_TURNS',
  'DDALGGAK_SEARCH_CONTEXT_MAX_CHARS',
  'DDALGGAK_SEARCH_ASK_CONTEXT_MAX_CHARS',
  'DDALGGAK_SEARCH_CONTEXT_TURNS',
  'DDALGGAK_SEARCH_ASK_CONTEXT_TURNS',
  'ANTIGRAVITY_TIMEOUT_MS',
  'CLAUDE_CLI_TIMEOUT_MS',
  'MODEL_CATALOG_REFRESH_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_CHECK_INTERVAL_MS',
  'MODEL_CATALOG_REFRESH_STARTUP_DELAY_MS',
  'MODEL_CATALOG_REFRESH_IDLE_MIN_MS',
  'MODEL_CATALOG_REFRESH_CLI_VERSION_CHECK_INTERVAL_MS',
  'CLI_MODEL_DISCOVERY_TIMEOUT_MS',
  'MODEL_BENCHMARK_MIN_RUNS',
  'GOC_ROUTE_CIRCUIT_BREAKER_THRESHOLD',
  'GOC_ROUTE_CIRCUIT_BREAKER_COOLDOWN_MS',
  'GOC_RUNTIME_COMMAND_POLL_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_MAX_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_ERROR_INTERVAL_MS',
  'GOC_RUNTIME_COMMAND_POLL_LIMIT',
  'GOC_RUN_EVENT_BATCH_SIZE',
  'MAX_CONCURRENCY',
  'MAX_PARALLEL_PER_RUN',
  'CHAT_MODEL_BADGE_MAX_PARTS',
  'TELEGRAM_WEBHOOK_PORT',
  'DDALGGAK_VISUAL_ARTIFACT_EXTRACTION_TIMEOUT_MS',
  'ROOM_MEMORY_TRIALS_MAX_OUTPUT_TOKENS',
  'ROOM_MEMORY_TRIALS_OPENAI_TIMEOUT_S',
  'CHAT_SUPERVISOR_ANTIGRAVITY_TIMEOUT_MS',
  'TEAM_CREATE_PLANNER_TIMEOUT_MS',
  'TEAM_REFINE_PLANNER_TIMEOUT_MS',
  'IDLE_LOOP_MEMORY_MAINTENANCE_LIMIT',
  'IDLE_MEMORY_MAINTENANCE_MIN_INTERVAL_MS',
]);

const ENUM_ENV_KEYS = {
  DDALGGAK_RUNTIME_PRESET: ['balanced', 'local_fast', 'local_model', 'codex_workbench', 'auto'],
  AI_ROOMS_RUNTIME_PRESET: ['balanced', 'local_fast', 'local_model', 'codex_workbench', 'auto'],
  DDALGGAK_CONTEXT_BUDGET: ['s', 'small', 'tight', 'fast', 'medium', 'l', 'large', 'rich', 'full'],
  ROOM_CONTEXT_BUDGET: ['s', 'small', 'tight', 'fast', 'medium', 'l', 'large', 'rich', 'full'],
  DDALGGAK_FAST_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  DDALGGAK_SEARCH_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  DDALGGAK_WORK_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled', 'workbench'],
  DDALGGAK_DIRECT_ASK_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  ROOM_CONCIERGE_DIRECT_ASK_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  DDALGGAK_SEARCH_ASK_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  ROOM_CONCIERGE_SEARCH_ASK_PROVIDER: ['auto', 'antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  DDALGGAK_GEMINI_REPLACEMENT_PROVIDER: ['antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  GEMINI_REPLACEMENT_PROVIDER: ['antigravity', 'claude', 'openai_compatible', 'codex', 'none', 'disabled'],
  GOC_SYNC_MODE: ['late', 'immediate', 'off', 'disabled'],
  CODEX_SANDBOX_MODE: ['workspace-write', 'read-only', 'danger-full-access'],
  CODEX_APPROVAL_POLICY: ['never', 'on-request', 'on-failure', 'untrusted'],
  TEAM_ROLE_PROVIDER_POLICY_MODE: ['off', 'prefer', 'enforce_generated', 'enforce', 'strict'],
  TEAM_PLANNER_MODE: ['off', 'auto', 'codex', 'antigravity'],
  TEAM_PLANNER_PROVIDER: ['auto', 'antigravity', 'codex', 'none', 'disabled'],
  TEAM_CREATE_PLANNER_PROVIDER: ['auto', 'antigravity', 'codex', 'none', 'disabled'],
  TEAM_REFINE_PLANNER_PROVIDER: ['auto', 'antigravity', 'codex', 'none', 'disabled'],
  CHAT_SUPERVISOR_PROVIDER: ['auto', 'antigravity', 'codex', 'none', 'disabled'],
  DDALGGAK_LOOP_DEFAULT_VISIBILITY: ['quiet', 'standard', 'debug'],
};

const CANONICAL_LEGACY_CONFLICTS = [
  { canonical: 'DDALGGAK_FAST_PROVIDER', legacy: ['DDALGGAK_DIRECT_ASK_PROVIDER', 'ROOM_CONCIERGE_DIRECT_ASK_PROVIDER', 'DDALGGAK_FAST_MODEL_PROVIDER', 'DDALGGAK_CHAT_PROVIDER'] },
  { canonical: 'DDALGGAK_SEARCH_PROVIDER', legacy: ['DDALGGAK_SEARCH_ASK_PROVIDER', 'ROOM_CONCIERGE_SEARCH_ASK_PROVIDER', 'DDALGGAK_SEARCH_MODEL_PROVIDER'] },
  { canonical: 'DDALGGAK_WORK_PROVIDER', legacy: ['DDALGGAK_WORKBENCH_PROVIDER', 'DDALGGAK_AGENT_PROVIDER', 'DDALGGAK_GEMINI_REPLACEMENT_PROVIDER', 'GEMINI_REPLACEMENT_PROVIDER'] },
  { canonical: 'DDALGGAK_FAST_MODEL', legacy: ['DDALGGAK_DIRECT_ASK_MODEL', 'DDALGGAK_DIRECT_ASK_CODEX_MODEL', 'DDALGGAK_CHAT_MODEL'] },
  { canonical: 'DDALGGAK_SEARCH_MODEL', legacy: ['DDALGGAK_SEARCH_ASK_MODEL', 'DDALGGAK_SEARCH_ASK_CODEX_MODEL'] },
  { canonical: 'DDALGGAK_FAST_TIMEOUT_MS', legacy: ['DDALGGAK_DIRECT_ASK_TIMEOUT_MS'] },
  { canonical: 'DDALGGAK_SEARCH_TIMEOUT_MS', legacy: ['DDALGGAK_SEARCH_ASK_TIMEOUT_MS'] },
  { canonical: 'DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH', legacy: ['DDALGGAK_SEARCH_ASK_FALLBACK_TO_WORKBENCH'] },
];

function hasEnv(env = {}, key = '') {
  return Object.prototype.hasOwnProperty.call(env, key) && clean(env[key]) !== '';
}

function isKnownProjectEnvKey(key = '') {
  const normalized = String(key || '').trim();
  return KNOWN_RUNTIME_ENV_KEYS.has(normalized) || PROJECT_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isValidBoolean(value = '') {
  const normalized = lower(value);
  return TRUE_VALUES.has(normalized) || FALSE_VALUES.has(normalized);
}

function isValidPositiveInt(value = '') {
  const normalized = clean(value);
  if (!normalized) return true;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed > 0 && Math.floor(parsed) === parsed;
}

function addFinding(list, code, message, keys = []) {
  list.push({ code, message, keys });
}

export function getRuntimeEnvCatalog() {
  return RUNTIME_ENV_GROUPS.map((group) => ({ name: group.name, keys: [...group.keys] }));
}

export function auditDdalggakRuntimeEnv({ env = process.env, configuredKeys = null, sourceLabel = 'process.env' } = {}) {
  const keys = [...new Set(configuredKeys || Object.keys(env || {}))].filter((key) => clean(key));
  const configuredProjectKeys = keys.filter((key) => isKnownProjectEnvKey(key));
  const errors = [];
  const warnings = [];
  const info = [];
  const unknown = configuredProjectKeys.filter((key) => !KNOWN_RUNTIME_ENV_KEYS.has(key) && !key.startsWith('DDALGGAK_MODEL_ROLE_'));

  for (const key of unknown) {
    addFinding(warnings, 'unknown_project_env', `${key} is not in the runtime env catalog. It may be a typo or an unsupported legacy setting.`, [key]);
  }

  for (const key of keys) {
    if (!hasEnv(env, key)) continue;
    if (BOOLEAN_ENV_KEYS.has(key) && !isValidBoolean(env[key])) {
      addFinding(errors, 'invalid_boolean', `${key} should be a boolean-like value: true/false, yes/no, on/off, or 1/0.`, [key]);
    }
    if (INTEGER_ENV_KEYS.has(key) && !isValidPositiveInt(env[key])) {
      addFinding(errors, 'invalid_integer', `${key} should be a positive integer.`, [key]);
    }
    const enumValues = ENUM_ENV_KEYS[key];
    if (enumValues) {
      let normalized = lower(env[key]);
      if (key.includes('PROVIDER')) normalized = normalizeProvider(env[key]);
      if (key.includes('PRESET') || key === 'DDALGGAK_RUNTIME_PRESET') normalized = normalizePreset(env[key]);
      if (key.includes('BUDGET')) normalized = lower(env[key]);
      if (!enumValues.includes(normalized)) {
        addFinding(errors, 'invalid_enum', `${key}=${clean(env[key])} is not one of: ${enumValues.join(', ')}.`, [key]);
      }
    }
  }

  for (const { canonical, legacy } of CANONICAL_LEGACY_CONFLICTS) {
    const legacySet = legacy.filter((key) => hasEnv(env, key));
    if (hasEnv(env, canonical) && legacySet.length) {
      addFinding(warnings, 'legacy_override_conflict', `${canonical} is set, but legacy override(s) ${legacySet.join(', ')} are also set. Remove the legacy value(s) unless you intentionally want an expert override.`, [canonical, ...legacySet]);
    } else if (!hasEnv(env, canonical) && legacySet.length) {
      addFinding(info, 'legacy_override_active', `${legacySet.join(', ')} is active as a legacy override. Prefer ${canonical} for normal operation.`, legacySet);
    }
  }

  const config = resolveDdalggakRuntimeConfig({ env });

  if ((config.fast.provider === 'openai_compatible' || config.search.provider === 'openai_compatible')
    && !config.fast.openai_compatible.base_url && !config.search.openai_compatible.base_url) {
    addFinding(errors, 'missing_local_base_url', 'openai_compatible is selected for fast/search, but no DDALGGAK_LOCAL_BASE_URL or compatible base URL is configured.', ['DDALGGAK_LOCAL_BASE_URL']);
  }

  if (config.search.fallback_to_workbench) {
    addFinding(warnings, 'search_fallback_latency', 'Search fast-path fallback to full workbench is enabled. This can make simple verification/search turns feel slow after a timeout.', ['DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH']);
  }

  if (config.fast.provider === 'codex' && !config.flags.allow_codex_fast_path_fallback) {
    addFinding(info, 'codex_fast_path_explicit', 'Fast provider is explicitly Codex. This is valid, but keep Codex for workbench paths unless you really want casual /c turns to use it.', ['DDALGGAK_FAST_PROVIDER']);
  }

  const recommendedMinimalKeys = [
    'DDALGGAK_RUNTIME_PRESET',
    'DDALGGAK_FAST_PROVIDER',
    'DDALGGAK_SEARCH_PROVIDER',
    'DDALGGAK_WORK_PROVIDER',
    'DDALGGAK_CONTEXT_BUDGET',
    'DDALGGAK_FAST_TIMEOUT_MS',
    'DDALGGAK_SEARCH_TIMEOUT_MS',
    'DDALGGAK_SEARCH_FALLBACK_TO_WORKBENCH',
  ];

  return {
    schema_version: 'ddalggak.runtime_config_doctor/v1',
    source_label: sourceLabel,
    configured_key_count: keys.length,
    configured_project_keys: configuredProjectKeys.sort(),
    unknown_project_keys: unknown.sort(),
    errors,
    warnings,
    info,
    effective_config: config,
    recommended_minimal_keys: recommendedMinimalKeys,
  };
}

function formatFindingList(title, items, maxItems = 8) {
  if (!items?.length) return [`${title}: none`];
  const lines = [`${title}:`];
  for (const item of items.slice(0, maxItems)) {
    lines.push(`- ${item.message}`);
  }
  if (items.length > maxItems) lines.push(`- ...and ${items.length - maxItems} more`);
  return lines;
}

export function formatRuntimeConfigDoctorForTelegram(report = auditDdalggakRuntimeEnv()) {
  const config = report.effective_config || resolveDdalggakRuntimeConfig();
  const lines = [
    '🩺 DdalGgak config doctor',
    `- source: ${report.source_label || 'process.env'}`,
    `- inspected keys: ${report.configured_key_count ?? 0} (${report.configured_project_keys?.length || 0} project/runtime keys)`,
    `- result: ${report.errors?.length || 0} error(s), ${report.warnings?.length || 0} warning(s), ${report.info?.length || 0} note(s)`,
    '',
    'Effective runtime:',
    `- preset: ${config.preset}`,
    `- context budget: ${config.context_budget}`,
    `- fast: ${config.fast?.provider || 'auto/unconfigured'}${config.fast?.model ? ` · ${config.fast.model}` : ''}`,
    `- search: ${config.search?.provider || 'auto/unconfigured'}${config.search?.model ? ` · ${config.search.model}` : ''} · fallback ${config.search?.fallback_to_workbench ? 'workbench' : 'off'}`,
    `- workbench: ${config.workbench?.provider || 'legacy/team-config'}${config.workbench?.model ? ` · ${config.workbench.model}` : ''}`,
    '',
    ...formatFindingList('Errors', report.errors || []),
    '',
    ...formatFindingList('Warnings', report.warnings || []),
    '',
    ...formatFindingList('Notes', report.info || [], 5),
    '',
    'Recommended normal-operation knobs:',
    ...((report.recommended_minimal_keys || []).map((key) => `- ${key}`)),
    '',
    'Tip: keep route-specific legacy envs unset unless debugging a specific override.',
  ];
  return lines.join('\n');
}

export function formatRuntimeConfigForTelegram(config = resolveDdalggakRuntimeConfig()) {
  const lines = [
    '⚙️ DdalGgak runtime config',
    `- preset: ${config.preset}`,
    `- context budget: ${config.context_budget}`,
    `- fast /c provider: ${config.fast.provider || 'auto/unconfigured'}${config.fast.model ? ` · model ${config.fast.model}` : ''}`,
    `- search provider: ${config.search.provider || 'auto/unconfigured'}${config.search.model ? ` · model ${config.search.model}` : ''}`,
    `- workbench provider: ${config.workbench.provider || 'legacy/team-config'}${config.workbench.model ? ` · model ${config.workbench.model}` : ''}`,
    `- fast timeout: ${config.fast.timeout_ms}ms · context ${config.fast.context_turns} turns/${config.fast.context_max_chars} chars`,
    `- search timeout: ${config.search.timeout_ms}ms · max ${config.search.max_seconds}s · fallback ${config.search.fallback_to_workbench ? 'workbench' : 'off'}`,
  ];
  if (config.fast.provider === 'openai_compatible' || config.search.provider === 'openai_compatible') {
    lines.push(`- local/OpenAI-compatible base URL: ${config.fast.openai_compatible.base_url || config.search.openai_compatible.base_url || '(not set)'}`);
  }
  lines.push('', 'Minimal env examples:', 'DDALGGAK_RUNTIME_PRESET=local_fast', 'DDALGGAK_FAST_PROVIDER=antigravity', 'DDALGGAK_WORK_PROVIDER=codex');
  return lines.join('\n');
}

export const __runtimeConfigInternals = {
  normalizeProvider,
  normalizePreset,
  normalizeBudget,
  budgetDefaults,
  PRESETS,
  KNOWN_RUNTIME_ENV_KEYS,
  RUNTIME_ENV_GROUPS,
  isKnownProjectEnvKey,
};
