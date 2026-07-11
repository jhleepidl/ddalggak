function clean(value = '') { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function normalizeNativeDelegationPolicy(raw = {}) {
  const row = asObject(raw);
  const mode = ['disabled', 'allowed', 'preferred'].includes(clean(row.mode).toLowerCase())
    ? clean(row.mode).toLowerCase()
    : 'allowed';
  return {
    schema_version: 'ddalggak.native_delegation_policy/v1',
    mode,
    max_depth: Math.max(0, Math.min(Number(row.max_depth ?? 2) || 0, 8)),
    max_parallel_agents: Math.max(1, Math.min(Number(row.max_parallel_agents ?? 4) || 1, 32)),
    max_cost_usd: Math.max(0, Number(row.max_cost_usd ?? 0) || 0),
    prefer_native_for: asArray(row.prefer_native_for).map((x) => clean(x)).filter(Boolean).slice(0, 24),
    prefer_room_external_for: asArray(row.prefer_room_external_for).map((x) => clean(x)).filter(Boolean).slice(0, 24),
  };
}

export function renderNativeDelegationPolicy(policy = {}, capabilities = {}) {
  const normalized = normalizeNativeDelegationPolicy(policy);
  const nativeAvailable = capabilities?.native_subagents === true;
  if (normalized.mode === 'disabled' || !nativeAvailable) {
    return [
      'Native delegation policy:',
      '- Do not create or delegate to provider-native subagents for this run.',
      '- Complete the bounded task in the current agent context.',
    ].join('\n');
  }
  const lines = [
    'Native delegation policy:',
    `- Provider-native subagents are ${normalized.mode === 'preferred' ? 'preferred when useful' : 'allowed when useful'}, but are not required.`,
    `- Keep delegation shallow (target max depth ${normalized.max_depth}) and bounded (target max parallel agents ${normalized.max_parallel_agents}).`,
    '- Use native delegation for local exploration or independent analysis; AI Rooms remains responsible for durable state, approval, and cross-provider review.',
  ];
  if (normalized.prefer_native_for.length) lines.push(`- Prefer native delegation for: ${normalized.prefer_native_for.join(', ')}.`);
  if (normalized.prefer_room_external_for.length) lines.push(`- Do not substitute native delegation for external independent roles such as: ${normalized.prefer_room_external_for.join(', ')}.`);
  if (normalized.max_cost_usd > 0) lines.push(`- Treat ${normalized.max_cost_usd.toFixed(2)} USD as the requested delegation budget ceiling when the provider exposes cost controls.`);
  return lines.join('\n');
}
