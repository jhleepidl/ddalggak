function clean(value = '', { lower = true } = {}) {
  const text = String(value || '').trim();
  return lower ? text.toLowerCase() : text;
}

const GEMINI_KEYS = new Set([
  'gemini',
  'gemini_cli',
  'gemini-cli',
  'google_gemini',
  'google-gemini',
]);

const ANTIGRAVITY_KEYS = new Set([
  'antigravity',
  'anti_gravity',
  'anti-gravity',
  'google_ai',
  'google-ai',
  'antigravity_cli',
  'antigravity-cli',
  'google_ai_antigravity',
]);

const CLAUDE_KEYS = new Set([
  'claude',
  'claude_cli',
  'claude-cli',
  'claude_code',
  'claude-code',
  'anthropic',
]);

const DISABLED_KEYS = new Set(['off', 'false', '0', 'disabled', 'none', 'no']);

export function geminiCliDisabledByDefault() {
  const raw = clean(process.env.DDALGGAK_ALLOW_GEMINI_CLI || process.env.ALLOW_GEMINI_CLI || '');
  if (['1', 'true', 'yes', 'on'].includes(raw)) return false;
  return true;
}

export function isGeminiProvider(value = '') {
  return GEMINI_KEYS.has(clean(value));
}

export function isAntigravityProvider(value = '') {
  return ANTIGRAVITY_KEYS.has(clean(value));
}

export function isClaudeProvider(value = '') {
  return CLAUDE_KEYS.has(clean(value));
}

export function normalizeRuntimeProvider(raw = '', fallback = 'codex') {
  const key = clean(raw || fallback || 'codex');
  if (!key) return clean(fallback || 'codex');
  if (['chatgpt', 'gpt', 'openai'].includes(key)) return 'chatgpt';
  if (['codex', 'codex_cli', 'codex-cli'].includes(key)) return 'codex';
  if (['openai_compatible', 'openai-compatible', 'ollama', 'local', 'local_model', 'llamacpp', 'llama.cpp'].includes(key)) return 'openai_compatible';
  if (isClaudeProvider(key)) return 'claude';
  if (isAntigravityProvider(key)) return 'antigravity';
  if (isGeminiProvider(key)) {
    if (!geminiCliDisabledByDefault()) return 'gemini';
    return normalizeGeminiReplacementProvider();
  }
  if (DISABLED_KEYS.has(key)) return 'disabled';
  return key;
}

export function normalizeGeminiReplacementProvider() {
  const raw = clean(
    process.env.DDALGGAK_GEMINI_REPLACEMENT_PROVIDER
    || process.env.GEMINI_REPLACEMENT_PROVIDER
    || process.env.DDALGGAK_DEFAULT_PROVIDER
    || process.env.ROOM_AGENT_PROVIDER
    || process.env.ROOM_ASK_PROVIDER
    || 'codex'
  );
  if (!raw || isGeminiProvider(raw)) return 'codex';
  if (DISABLED_KEYS.has(raw)) return 'disabled';
  return normalizeRuntimeProvider(raw, 'codex');
}

export function migrateProviderAwayFromGemini(provider = '', { fallback = 'codex' } = {}) {
  const raw = clean(provider || fallback || 'codex');
  const normalized = normalizeRuntimeProvider(raw, fallback);
  const migrated = isGeminiProvider(raw) && geminiCliDisabledByDefault();
  return {
    provider: migrated ? normalizeGeminiReplacementProvider() : normalized,
    original_provider: raw,
    migrated_from_gemini: migrated,
    gemini_cli_disabled: geminiCliDisabledByDefault(),
  };
}

export function sanitizeGeminiModelForProvider(model = '', provider = '') {
  const cleanModel = String(model || '').trim();
  const target = normalizeRuntimeProvider(provider || 'codex', 'codex');
  if (!cleanModel) return '';
  if (target === 'gemini') return cleanModel;
  if (/^gemini[-_:]/i.test(cleanModel) || /^gemini$/i.test(cleanModel)) return '';
  return cleanModel;
}


export function sanitizeProviderModelForExecution(model = '', provider = '') {
  const cleanModel = String(model || '').trim();
  const target = normalizeRuntimeProvider(provider || 'codex', 'codex');
  if (!cleanModel) return '';
  const key = cleanModel.toLowerCase().replace(/[\s_-]+/g, '-');
  const genericAliases = new Set(['default', 'provider-default', 'provider-default-model', 'auto']);
  if (genericAliases.has(key)) return '';
  if (target === 'claude' && ['claude', 'claude-code', 'anthropic'].includes(key)) return '';
  if (target === 'codex' && ['codex', 'codex-cli'].includes(key)) return '';
  if (target === 'chatgpt' && ['chatgpt', 'openai', 'gpt'].includes(key)) return '';
  return sanitizeGeminiModelForProvider(cleanModel, target);
}

export function geminiCliDisabledMessage() {
  return 'Gemini CLI is disabled in ddalggak. Use Antigravity/Codex/OpenAI-compatible providers instead. Set DDALGGAK_ALLOW_GEMINI_CLI=1 only for explicit legacy testing.';
}
