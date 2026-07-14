import { buildRoomModelPolicy } from './default_room_library.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 500, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  return lower ? text.toLowerCase() : text;
}
function envKey(role = '', suffix = '') {
  return `DDALGGAK_MODEL_ROLE_${String(role || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_${suffix}`;
}

export const MODEL_ROLE_PHASE_MAP = Object.freeze({
  concierge: 'concierge_router',
  routing: 'concierge_router',
  source: 'source_grounder',
  grounding: 'source_grounder',
  browse: 'source_grounder',
  code: 'code_executor',
  build: 'code_executor',
  patch: 'code_executor',
  verifier: 'verifier_critic',
  review: 'verifier_critic',
  safety: 'verifier_critic',
  idle: 'idle_structurer',
  memory: 'idle_structurer',
  synthesis: 'delivery_synthesizer',
  delivery: 'delivery_synthesizer',
  answer: 'delivery_synthesizer',
});

export const DEFAULT_MODEL_ROLE_FALLBACKS = Object.freeze({
  concierge_router: { preferred_tier: 'fast_low_latency', fallback_tier: 'general_reasoning' },
  source_grounder: { preferred_tier: 'source_grounded_reasoning', fallback_tier: 'general_reasoning' },
  code_executor: { preferred_tier: 'tool_code_capable', fallback_tier: 'general_reasoning' },
  verifier_critic: { preferred_tier: 'high_precision_critic', fallback_tier: 'general_reasoning' },
  idle_structurer: { preferred_tier: 'cheap_structuring', fallback_tier: 'fast_low_latency' },
  delivery_synthesizer: { preferred_tier: 'user_surface_synthesis', fallback_tier: 'general_reasoning' },
});

export function modelRoleForPhase(phase = '') {
  const key = cleanText(phase, { lower: true, maxLen: 120 }).replace(/[\s-]+/g, '_');
  return MODEL_ROLE_PHASE_MAP[key] || (key && DEFAULT_MODEL_ROLE_FALLBACKS[key] ? key : 'delivery_synthesizer');
}

export function modelRoleForAgentRole(agentRole = '') {
  const key = cleanText(agentRole, { lower: true, maxLen: 160 }).replace(/[\s-]+/g, '_');
  if (!key) return 'delivery_synthesizer';
  if (/verifier|review|critic|checker|adjudicat|safety|quality/.test(key)) return 'verifier_critic';
  if (/builder|implementation|executor|code|patch|test|developer|engineer/.test(key)) return 'code_executor';
  if (/research|source|ground|evidence|scout|browse|retriev/.test(key)) return 'source_grounder';
  if (/operator|planner|router|coordinator|concierge|orchestrat/.test(key)) return 'concierge_router';
  if (/idle|memory|structur|curator/.test(key)) return 'idle_structurer';
  if (/synth|delivery|writer|draft|answer|revision|editor/.test(key)) return 'delivery_synthesizer';
  return modelRoleForPhase(key);
}

export function normalizeRoomModelRolePolicy({ roomPackage = null, profile = null } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const packagePolicy = asObject(pkg.model_policy || pkg.modelPolicy);
  const profilePolicy = asObject(prof.model_policy || prof.modelPolicy);
  const generatedPolicy = buildRoomModelPolicy(pkg, { intent: prof.room_package_composition?.intent_card || null });
  const normalizeAssignments = (policy = {}) => asArray(asObject(policy).default_assignment).map((row) => {
    const item = asObject(row);
    const role = cleanText(item.role || item.model_role || '', { lower: true, maxLen: 120 });
    if (!role) return null;
    const fallback = asObject(DEFAULT_MODEL_ROLE_FALLBACKS[role]);
    return {
      role,
      purpose: cleanText(item.purpose || 'Room model role', { maxLen: 300 }),
      preferred_tier: cleanText(item.preferred_tier || fallback.preferred_tier || 'general_reasoning', { lower: true, maxLen: 120 }),
      fallback_tier: cleanText(item.fallback_tier || fallback.fallback_tier || 'general_reasoning', { lower: true, maxLen: 120 }),
      provider: cleanText(item.provider || '', { lower: true, maxLen: 80 }),
      model: cleanText(item.model || '', { maxLen: 160 }),
      node_id: cleanText(item.node_id || item.nodeId || '', { maxLen: 160 }),
      selection: cleanText(item.selection || '', { lower: true, maxLen: 120 }),
    };
  }).filter(Boolean);

  const basePolicy = asArray(packagePolicy.default_assignment).length ? packagePolicy : generatedPolicy;
  const byRole = new Map(normalizeAssignments(basePolicy).map((row) => [row.role, row]));
  for (const row of normalizeAssignments(profilePolicy)) {
    byRole.set(row.role, { ...(byRole.get(row.role) || {}), ...row });
  }
  for (const [role, fallback] of Object.entries(DEFAULT_MODEL_ROLE_FALLBACKS)) {
    if (!byRole.has(role)) byRole.set(role, { role, purpose: 'Default fallback model role', provider: '', model: '', node_id: '', ...fallback });
  }
  return {
    schema_version: 'ddalggak.room_model_role_policy/v1',
    policy_id: cleanText(profilePolicy.policy_id || profilePolicy.policyId || basePolicy.policy_id || basePolicy.policyId || 'effective_room_model_policy', { maxLen: 160 }),
    policy_scope: cleanText(profilePolicy.policy_scope || profilePolicy.policyScope || basePolicy.policy_scope || basePolicy.policyScope || 'room', { lower: true, maxLen: 120 }),
    policy_revision: Math.max(1, Number(profilePolicy.policy_revision || profilePolicy.policyRevision || basePolicy.policy_revision || basePolicy.policyRevision || 1) || 1),
    parent_policy_id: cleanText(profilePolicy.parent_policy_id || profilePolicy.parentPolicyId || basePolicy.parent_policy_id || basePolicy.parentPolicyId || '', { maxLen: 160 }) || null,
    inherited_policy_id: cleanText(profilePolicy.inherited_policy_id || profilePolicy.inheritedPolicyId || '', { maxLen: 160 }) || null,
    inherited_policy_revision: Number(profilePolicy.inherited_policy_revision || profilePolicy.inheritedPolicyRevision || 0) || null,
    strategy: cleanText(profilePolicy.strategy || basePolicy.strategy || 'room_scoped_model_portfolio', { lower: true, maxLen: 120 }),
    default_assignment: [...byRole.values()],
    routing_signals: asArray(profilePolicy.routing_signals).length
      ? profilePolicy.routing_signals
      : (asArray(basePolicy.routing_signals).length ? basePolicy.routing_signals : ['room_intent_card', 'active_loop_phase', 'artifact_type', 'risk_profile', 'latency_budget', 'cost_budget']),
    governance: {
      footer_required: true,
      log_provider_and_model_per_response: true,
      single_model_fallback_allowed: true,
      provider_secret_export: 'never',
      room_override_mode: 'role_by_role_merge',
      room_policy_learning: 'proposal_then_trial_then_approval',
      durable_model_policy_change: 'trial_then_user_or_goc_approval',
      ...asObject(basePolicy.governance),
      ...asObject(profilePolicy.governance),
    },
  };
}

function envAssignmentForRole(role = '', env = process.env) {
  const provider = cleanText(env[envKey(role, 'PROVIDER')] || env[envKey(role, 'NODE_PROVIDER')] || '', { lower: true, maxLen: 80 });
  const model = cleanText(env[envKey(role, 'MODEL')] || env[envKey(role, 'NODE_MODEL')] || '', { maxLen: 160 });
  const nodeId = cleanText(env[envKey(role, 'NODE_ID')] || '', { maxLen: 160 });
  if (!provider && !model && !nodeId) return null;
  return { provider, model, node_id: nodeId, source: 'env_model_role_override' };
}

export function resolveRoomModelRole({ phase = '', modelRole = '', roomPackage = null, profile = null, env = process.env, preferredProvider = '', preferredModel = '' } = {}) {
  const role = cleanText(modelRole || modelRoleForPhase(phase), { lower: true, maxLen: 120 });
  const policy = normalizeRoomModelRolePolicy({ roomPackage, profile });
  const assignment = policy.default_assignment.find((row) => row.role === role) || { role, ...asObject(DEFAULT_MODEL_ROLE_FALLBACKS[role]) };
  const envAssignment = envAssignmentForRole(role, env);
  const provider = cleanText(preferredProvider || envAssignment?.provider || assignment.provider || '', { lower: true, maxLen: 80 });
  const model = cleanText(preferredModel || envAssignment?.model || assignment.model || '', { maxLen: 160 });
  return {
    schema_version: 'ddalggak.room_model_role_resolution/v1',
    phase: cleanText(phase || role, { lower: true, maxLen: 120 }),
    role,
    provider,
    model,
    node_id: envAssignment?.node_id || assignment.node_id || '',
    preferred_tier: assignment.preferred_tier || DEFAULT_MODEL_ROLE_FALLBACKS[role]?.preferred_tier || 'general_reasoning',
    fallback_tier: assignment.fallback_tier || DEFAULT_MODEL_ROLE_FALLBACKS[role]?.fallback_tier || 'general_reasoning',
    purpose: assignment.purpose || 'Room model role',
    source: envAssignment?.source || (assignment.provider || assignment.model ? 'room_package_model_policy' : 'tier_policy_fallback'),
    route_footer: `${role}${provider || model ? `:${[provider, model].filter(Boolean).join('/')}` : `:${assignment.preferred_tier || 'tier'}`}`,
    governance: policy.governance,
  };
}

export function resolveRoomModelRolePlan({ phases = ['concierge', 'source', 'code', 'verifier', 'idle', 'synthesis'], roomPackage = null, profile = null, env = process.env } = {}) {
  const rows = asArray(phases).map((phase) => resolveRoomModelRole({ phase, roomPackage, profile, env }));
  return {
    schema_version: 'ddalggak.room_model_role_plan/v1',
    generated_at: new Date().toISOString(),
    rows,
    role_count: rows.length,
    guardrail: {
      credentials_exported: false,
      provider_secret_export: 'never',
      durable_model_policy_change: 'trial_then_user_or_goc_approval',
      trace_provider_and_model_per_call: true,
    },
  };
}

export function formatRoomModelRolePlanForTelegram(plan = {}) {
  const rows = asArray(plan.rows);
  const lines = ['🧩 Room model-role router', '', `roles: ${Number(plan.role_count || rows.length)}`];
  for (const row of rows) {
    lines.push(`- ${row.phase} → ${row.role}: ${row.provider || '(provider by tier)'}/${row.model || row.preferred_tier || '(model by tier)'}`);
    lines.push(`  fallback=${row.fallback_tier || '-'} · source=${row.source || '-'}`);
  }
  lines.push('', 'Guardrails:', '- provider credentials/secrets are not exported in room packages', '- route footer/trace should include role + provider/model when known', '- durable model-policy edits require trial + user/GoC approval');
  return lines.join('\n');
}
