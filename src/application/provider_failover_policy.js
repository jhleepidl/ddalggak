const GEMINI_PROVIDER_KEYS = new Set(['gemini', 'gemini_cli']);
const CODEX_PROVIDER_KEYS = new Set(['codex', 'codex_cli']);

const CAPACITY_PATTERNS = [
  /MODEL_CAPACITY_EXHAUSTED/i,
  /No capacity available for model/i,
  /RESOURCE_EXHAUSTED/i,
  /capacity circuit open/i,
  /capacity circuit opened/i,
  /capacity_exhausted/i,
];
const RATE_LIMIT_429_RE = /\b429\b|Too Many Requests|rateLimitExceeded/i;
const TIMEOUT_RE = /\btimeout\b|timed?\s*out|ETIMEDOUT|killed after/i;
const CREDENTIAL_RE = /credential|login|auth|unauthori[sz]ed|permission denied|api[_\s-]*key/i;

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeProvider(raw = '') {
  const key = clean(raw).toLowerCase();
  if (CODEX_PROVIDER_KEYS.has(key)) return 'codex';
  if (GEMINI_PROVIDER_KEYS.has(key)) return 'gemini';
  return key;
}

export function providerErrorText(error = null) {
  if (!error) return '';
  const parts = [];
  if (typeof error === 'string') parts.push(error);
  if (error instanceof Error) {
    parts.push(error.message || '');
    parts.push(error.stack || '');
  }
  if (error && typeof error === 'object') {
    parts.push(error.message || '');
    parts.push(error.stderr || '');
    parts.push(error.stdout || '');
    parts.push(error.error_type || error.errorType || '');
    if (error.cause) parts.push(providerErrorText(error.cause));
  }
  return parts.map((part) => clean(part)).filter(Boolean).join('\n');
}

export function classifyProviderFailure({ provider = '', error = null, result = null } = {}) {
  const providerKey = normalizeProvider(provider);
  const text = providerErrorText(error || result);
  const hasCapacity = CAPACITY_PATTERNS.some((re) => re.test(text));
  const has429 = RATE_LIMIT_429_RE.test(text);
  if (providerKey === 'gemini' && (hasCapacity || (has429 && /capacity|RESOURCE_EXHAUSTED|rateLimitExceeded/i.test(text)))) {
    return {
      category: 'provider_capacity',
      provider: providerKey,
      transient: true,
      safe_to_failover: true,
      summary: 'Gemini capacity/429 transient failure',
    };
  }
  if (has429) {
    return {
      category: 'provider_rate_limit',
      provider: providerKey,
      transient: true,
      safe_to_failover: true,
      summary: 'Provider rate limit transient failure',
    };
  }
  if (TIMEOUT_RE.test(text)) {
    return {
      category: 'provider_timeout',
      provider: providerKey,
      transient: true,
      safe_to_failover: true,
      summary: 'Provider timeout',
    };
  }
  if (CREDENTIAL_RE.test(text)) {
    return {
      category: 'credential_gap',
      provider: providerKey,
      transient: false,
      safe_to_failover: false,
      summary: 'Provider credential/authentication failure',
    };
  }
  return {
    category: 'unknown',
    provider: providerKey,
    transient: false,
    safe_to_failover: false,
    summary: text ? 'Provider failure' : 'Unknown provider failure',
  };
}

export function envFlagEnabled(name, fallback = false) {
  const raw = process.env[name];
  if (typeof raw === 'undefined') return fallback;
  const key = clean(raw).toLowerCase();
  if (!key) return fallback;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(key)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(key)) return false;
  return fallback;
}

export function resolveProviderFailoverDecision({ provider = '', error = null, result = null, roleId = '', agentId = '', requestedProvider = '' } = {}) {
  const fromProvider = normalizeProvider(provider || requestedProvider);
  const failure = classifyProviderFailure({ provider: fromProvider, error, result });
  const enabled = envFlagEnabled('PROVIDER_FAILOVER_ENABLED', true)
    && envFlagEnabled('GEMINI_CAPACITY_FAILOVER_ENABLED', true);
  const configuredRaw = clean(process.env.GEMINI_CAPACITY_FAILOVER_PROVIDER || process.env.PROVIDER_FAILOVER_PROVIDER || 'codex').toLowerCase();
  const toProvider = normalizeProvider(configuredRaw || 'codex');
  if (!enabled || fromProvider !== 'gemini' || !failure.safe_to_failover || failure.category === 'credential_gap') {
    return {
      should_failover: false,
      from_provider: fromProvider,
      to_provider: '',
      failure,
      reason: enabled ? `no failover rule for ${fromProvider}/${failure.category}` : 'provider failover disabled',
    };
  }
  if (toProvider !== 'codex') {
    return {
      should_failover: false,
      from_provider: fromProvider,
      to_provider: toProvider,
      failure,
      reason: `unsupported failover provider: ${toProvider || configuredRaw}`,
    };
  }
  return {
    should_failover: true,
    from_provider: fromProvider,
    to_provider: 'codex',
    failure,
    role_id: clean(roleId).toLowerCase(),
    agent_id: clean(agentId).toLowerCase(),
    reason: `${failure.category}: ${failure.summary}`,
  };
}

export function formatProviderFailoverNote(decision = {}) {
  if (!decision?.should_failover) return '';
  const from = clean(decision.from_provider) || 'provider';
  const to = clean(decision.to_provider) || 'fallback provider';
  const category = clean(decision.failure?.category || decision.reason || 'transient failure');
  return `[provider_failover] ${from} -> ${to} after ${category}`;
}
