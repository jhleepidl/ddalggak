import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeProviderName } from './provider_capability_registry.js';
import { normalizeNativeDelegationPolicy, renderNativeDelegationPolicy } from './native_delegation_policy.js';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function hashJson(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

const BUILTIN_VARIANTS = [
  {
    id: 'code_executor.codex.default.high.v1', role: 'code_executor', provider: 'codex', model: '', reasoning_effort: 'high', status: 'champion',
    provider_runtime: { config_overrides: { model_reasoning_effort: 'high' } },
    native_delegation: { mode: 'allowed', max_depth: 2, max_parallel_agents: 4, prefer_native_for: ['repository exploration', 'independent file analysis'], prefer_room_external_for: ['cross-provider review', 'durable state changes'] },
  },
  {
    id: 'code_executor.claude.default.high.v1', role: 'code_executor', provider: 'claude', model: '', reasoning_effort: 'high', status: 'champion',
    provider_runtime: { effort: 'high' },
    native_delegation: { mode: 'allowed', max_depth: 2, max_parallel_agents: 4, prefer_native_for: ['repository exploration', 'independent analysis'], prefer_room_external_for: ['cross-provider review', 'durable state changes'] },
  },
  {
    id: 'code_executor.antigravity.default.v1', role: 'code_executor', provider: 'antigravity', model: '', reasoning_effort: 'provider_default', status: 'champion',
    provider_runtime: {},
    native_delegation: { mode: 'allowed', max_depth: 2, max_parallel_agents: 4, prefer_native_for: ['repository exploration', 'background tasks'], prefer_room_external_for: ['cross-provider review', 'durable state changes'] },
  },
  {
    id: 'reviewer.claude.default.high.v1', role: 'reviewer', provider: 'claude', model: '', reasoning_effort: 'high', status: 'champion',
    provider_runtime: { effort: 'high' },
    native_delegation: { mode: 'disabled' },
  },
  {
    id: 'reviewer.codex.default.high.v1', role: 'reviewer', provider: 'codex', model: '', reasoning_effort: 'high', status: 'challenger',
    provider_runtime: { config_overrides: { model_reasoning_effort: 'high' } },
    native_delegation: { mode: 'disabled' },
  },
];

function normalizeVariant(raw = {}) {
  const row = asObject(raw);
  const provider = normalizeProviderName(row.provider);
  const role = clean(row.role || 'code_executor').toLowerCase();
  const reasoning = clean(row.reasoning_effort || row.reasoning || 'provider_default').toLowerCase();
  const variant = {
    schema_version: 'ddalggak.harness_variant/v1',
    id: clean(row.id) || `${role}.${provider || 'unknown'}.${reasoning}.custom`,
    role,
    provider,
    model: clean(row.model),
    reasoning_effort: reasoning,
    status: ['champion', 'challenger', 'archived', 'trial'].includes(clean(row.status).toLowerCase()) ? clean(row.status).toLowerCase() : 'trial',
    provider_runtime: asObject(row.provider_runtime),
    prompt_layers: asObject(row.prompt_layers),
    native_delegation: normalizeNativeDelegationPolicy(row.native_delegation),
    metadata: asObject(row.metadata),
  };
  return { ...variant, variant_hash: hashJson(variant) };
}

export function loadHarnessVariantRegistry({ registryPath = '', cwd = process.cwd() } = {}) {
  const explicit = clean(registryPath || process.env.HARNESS_VARIANT_REGISTRY_PATH);
  const defaultPath = path.resolve(cwd, 'config', 'harness_variants.json');
  const candidate = explicit ? path.resolve(explicit) : defaultPath;
  let configured = [];
  if (fs.existsSync(candidate)) {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    configured = asArray(parsed?.variants || parsed);
  }
  const byId = new Map();
  for (const item of [...BUILTIN_VARIANTS, ...configured]) {
    const variant = normalizeVariant(item);
    byId.set(variant.id, variant);
  }
  return {
    schema_version: 'ddalggak.harness_variant_registry/v1',
    registry_path: fs.existsSync(candidate) ? candidate : null,
    variants: [...byId.values()],
  };
}

export function resolveHarnessVariant({ registry, variantId = '', provider = '', role = 'code_executor', model = '', reasoningEffort = '' } = {}) {
  const source = registry?.variants ? registry : loadHarnessVariantRegistry();
  const variants = asArray(source.variants);
  const direct = clean(variantId) ? variants.find((row) => row.id === clean(variantId)) : null;
  if (direct) return { ...direct, model: clean(model) || direct.model, reasoning_effort: clean(reasoningEffort) || direct.reasoning_effort };
  const providerKey = normalizeProviderName(provider);
  const roleKey = clean(role || 'code_executor').toLowerCase();
  const candidates = variants.filter((row) => row.provider === providerKey && row.role === roleKey && row.status !== 'archived');
  const chosen = candidates.find((row) => row.status === 'champion') || candidates[0];
  if (!chosen) throw new Error(`No harness variant for provider=${providerKey} role=${roleKey}`);
  return { ...chosen, model: clean(model) || chosen.model, reasoning_effort: clean(reasoningEffort) || chosen.reasoning_effort };
}

function scenarioContract(scenario = {}) {
  const expectations = asObject(scenario.expectations);
  const lines = [
    'Canonical task contract:',
    `- Goal: ${clean(scenario.goal || scenario.title || scenario.id)}`,
  ];
  const acceptance = asArray(scenario.acceptance_criteria || expectations.acceptance_criteria).map(clean).filter(Boolean);
  if (acceptance.length) {
    lines.push('- Acceptance criteria:');
    for (const item of acceptance) lines.push(`  - ${item}`);
  }
  const forbidden = asArray(expectations?.files?.forbidden_changed).map(clean).filter(Boolean);
  if (forbidden.length) lines.push(`- Forbidden changed paths: ${forbidden.join(', ')}`);
  const allowed = asArray(expectations?.files?.allowed_changed).map(clean).filter(Boolean);
  if (allowed.length) lines.push(`- Allowed changed paths: ${allowed.join(', ')}`);
  lines.push('- Work only inside the provided workspace. Do not modify external durable state.');
  return lines.join('\n');
}

function rolePolicy(role = '') {
  const key = clean(role).toLowerCase();
  if (key === 'reviewer') return [
    'Role policy: reviewer',
    '- Inspect the supplied work independently.',
    '- Do not modify files unless the task contract explicitly asks for a review fix.',
    '- Report concrete findings with evidence and severity; avoid inventing issues.',
  ].join('\n');
  if (['task_worker', 'researcher', 'analyst'].includes(key)) return [
    'Role policy: bounded task worker',
    '- Inspect the supplied workspace, files, and declared sources before answering.',
    '- Treat the task contract as authoritative and create only the requested reviewable artifacts.',
    '- Separate evidence from assumptions and preserve explicit constraints.',
    '- Run provided deterministic checks before claiming completion.',
  ].join('\n');
  return [
    'Role policy: code executor',
    '- Inspect the repository before editing.',
    '- Make the smallest coherent change that satisfies the contract.',
    '- Run relevant deterministic checks before claiming completion.',
    '- Do not claim success when required checks fail.',
  ].join('\n');
}

function providerDialect(variant = {}) {
  if (variant.provider === 'codex') return [
    'Provider guidance: Codex',
    '- Use the native coding workflow and tools available in this workspace.',
    '- Prefer direct repository evidence over speculative plans.',
    '- Return a concise completion summary after edits and checks.',
  ].join('\n');
  if (variant.provider === 'claude') return [
    'Provider guidance: Claude Code',
    '- Use repository tools and native delegation only when it improves bounded execution.',
    '- Keep durable decisions outside provider-private memory; the final result must stand on repository evidence.',
    '- Return a concise completion summary after edits and checks.',
  ].join('\n');
  if (variant.provider === 'antigravity') return [
    'Provider guidance: Antigravity',
    '- Use the shared agent harness, skills, and background work only within the bounded workspace.',
    '- Keep external durable state changes outside this execution capsule.',
    '- Return a concise completion summary after edits and checks.',
  ].join('\n');
  return 'Provider guidance: follow the bounded task contract and available workspace tools.';
}

function reasoningGuidance(variant = {}) {
  const effort = clean(variant.reasoning_effort).toLowerCase();
  if (['low', 'minimal'].includes(effort)) return [
    `Reasoning profile: ${effort}`,
    '- Keep the task narrow and verify each concrete change with deterministic checks.',
    '- Avoid unnecessary architecture changes.',
  ].join('\n');
  if (['high', 'max', 'xhigh'].includes(effort)) return [
    `Reasoning profile: ${effort}`,
    '- You may investigate alternatives internally, but optimize for the task goal and constraints rather than producing a long plan.',
    '- Check assumptions and edge cases before completion.',
  ].join('\n');
  return `Reasoning profile: ${effort || 'provider_default'}; use the provider's default reasoning behavior while honoring the contract.`;
}

export function buildHarnessPrompt({ scenario = {}, variant = {}, capabilityProfile = {}, workspaceRoot = '' } = {}) {
  const normalized = normalizeVariant(variant);
  const custom = asObject(normalized.prompt_layers);
  const sections = [
    scenarioContract(scenario),
    clean(custom.role_policy) || rolePolicy(normalized.role),
    clean(custom.provider_adapter) || providerDialect(normalized),
    clean(custom.reasoning_adapter) || reasoningGuidance(normalized),
    renderNativeDelegationPolicy(normalized.native_delegation, capabilityProfile.capabilities || {}),
    [
      'Runtime context:',
      `- Scenario ID: ${clean(scenario.id)}`,
      `- Harness variant: ${normalized.id}`,
      `- Provider: ${normalized.provider}`,
      `- Model: ${normalized.model || 'provider default'}`,
      `- Reasoning effort: ${normalized.reasoning_effort || 'provider default'}`,
      `- Workspace: ${clean(workspaceRoot) || '(provided working directory)'}`,
    ].join('\n'),
    clean(scenario.user_prompt || scenario.prompt || scenario.goal),
  ].filter(Boolean);
  const prompt = sections.join('\n\n---\n\n');
  return {
    prompt,
    prompt_hash: hashJson({ prompt }),
    variant: normalized,
  };
}

export function summarizeHarnessVariants(registry = {}) {
  return asArray(registry.variants).map((row) => ({
    id: row.id,
    provider: row.provider,
    role: row.role,
    model: row.model || null,
    reasoning_effort: row.reasoning_effort,
    status: row.status,
    variant_hash: row.variant_hash,
  }));
}


function envBool(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

export function applyHarnessVariantToPrompt({ basePrompt = '', provider = '', role = 'code_executor', model = '', reasoningEffort = '', variantId = '', capabilityProfile = {}, registry = null } = {}) {
  const explicitVariantId = clean(variantId);
  if (!explicitVariantId && !envBool('HARNESS_RUNTIME_VARIANT_ENABLED', false)) {
    return { prompt: String(basePrompt || ''), applied: false, variant: null };
  }
  const source = registry || loadHarnessVariantRegistry({ cwd: process.cwd() });
  const variant = resolveHarnessVariant({ registry: source, variantId: explicitVariantId, provider, role, model, reasoningEffort });
  const envelope = [
    `AI Rooms runtime harness variant: ${variant.id}`,
    providerDialect(variant),
    reasoningGuidance(variant),
    renderNativeDelegationPolicy(variant.native_delegation, capabilityProfile.capabilities || { native_subagents: true }),
    'The existing runtime task prompt follows. Preserve its task-specific constraints and context:',
    String(basePrompt || ''),
  ].join('\n\n---\n\n');
  return { prompt: envelope, applied: true, variant };
}
