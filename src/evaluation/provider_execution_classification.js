function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }


function matchedMessage(text = '', rule = {}) {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const matched = lines.find((line) => asObject(rule).patterns?.some((pattern) => pattern.test(line)));
  return clean(matched).slice(0, 1200) || clean(asObject(rule).category);
}

function genericFailureMessage(text = '') {
  const lines = String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  const matched = lines.findLast((line) => /\b(?:error|failed|failure|exception|fatal|denied|unavailable|timeout|timed out|refused|reset)\b/i.test(line));
  return clean(matched).slice(0, 1200) || 'provider execution failed before a quality-eligible result was produced';
}

const RULES = Object.freeze([
  {
    category: 'model_access_denied',
    retryable: false,
    scope: 'model',
    lifecycle_action: 'mark_model_ineligible',
    patterns: [
      /model is not supported when using .* account/i,
      /model .* is not supported when using .* account/i,
      /(?:do not|don't) have access to (?:the )?model/i,
      /model .* (?:is not available|is unavailable) (?:for|to) (?:this|your|the current) account/i,
      /model .* (?:not found|does not exist).*(?:access|permission)/i,
    ],
  },
  {
    category: 'authentication_required',
    retryable: true,
    scope: 'provider',
    lifecycle_action: 'retry_after_credentials_change',
    patterns: [
      /not logged in/i,
      /authentication (?:is )?required/i,
      /please (?:log|sign) in/i,
      /invalid (?:api )?key/i,
      /unauthorized/i,
      /status["']?\s*:\s*401/i,
    ],
  },
  {
    category: 'rate_limited',
    retryable: true,
    scope: 'provider',
    lifecycle_action: 'retry',
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /quota (?:exceeded|exhausted)/i,
      /status["']?\s*:\s*429/i,
    ],
  },
  {
    category: 'provider_timeout',
    retryable: true,
    scope: 'provider',
    lifecycle_action: 'retry',
    patterns: [
      /timed? out/i,
      /deadline exceeded/i,
      /request timeout/i,
    ],
  },
  {
    category: 'provider_unavailable',
    retryable: true,
    scope: 'provider',
    lifecycle_action: 'retry',
    patterns: [
      /provider cli unavailable/i,
      /service unavailable/i,
      /temporarily unavailable/i,
      /connection (?:refused|reset)/i,
      /network (?:error|unreachable)/i,
      /status["']?\s*:\s*5\d\d/i,
    ],
  },
]);

export function classifyProviderExecutionResult(result = {}) {
  const row = asObject(result);
  if (row.ok === true) return null;
  const text = [row.stderr, row.stdout, row.error, row.message].map(clean).filter(Boolean).join('\n');
  const exitCode = Number.isInteger(row.exitCode) ? row.exitCode : (Number.isInteger(row.exit_code) ? row.exit_code : null);
  for (const rule of RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(text))) continue;
    return {
      schema_version: 'ddalggak.provider_execution_error/v1',
      kind: 'execution_error',
      category: rule.category,
      retryable: rule.retryable,
      scope: rule.scope,
      lifecycle_action: rule.lifecycle_action || 'none',
      quality_eligible: false,
      exit_code: exitCode,
      message: matchedMessage(text, rule),
    };
  }
  if (row.ok === false || (exitCode !== null && exitCode !== 0)) {
    return {
      schema_version: 'ddalggak.provider_execution_error/v1',
      kind: 'execution_error',
      category: 'provider_execution_failed',
      retryable: true,
      scope: 'provider',
      lifecycle_action: 'retry',
      quality_eligible: false,
      exit_code: exitCode,
      message: genericFailureMessage(text),
    };
  }
  return null;
}

export function isExecutionIneligible(classification = null) {
  return asObject(classification).quality_eligible === false;
}

export function shouldMarkModelExecutionIneligible(classification = null) {
  const row = asObject(classification);
  return row.lifecycle_action === 'mark_model_ineligible' || clean(row.category) === 'model_access_denied';
}
