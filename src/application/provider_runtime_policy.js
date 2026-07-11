import path from 'node:path';

import { normalizeRuntimeExecutionPolicy, resolveProviderRuntimePolicy } from './runtime_execution_policy.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function uniqStrings(values = [], { limit = 12 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const cleanValue = clean(value);
    if (!cleanValue) continue;
    const key = cleanValue.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleanValue);
    if (out.length >= limit) break;
  }
  return out;
}

function mergeConfigObjects(base = {}, extra = {}) {
  const left = asObject(base);
  const right = asObject(extra);
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeConfigObjects(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function resolveOptionalProviderPolicy(raw = {}, provider = '') {
  const row = asObject(raw);
  if (Object.keys(row).length === 0) return {};
  return resolveProviderRuntimePolicy(row, provider);
}

function normalizeOverrideAddDirs(raw = []) {
  return uniqStrings(Array.isArray(raw) ? raw : [raw], { limit: 16 }).map((entry) => path.resolve(entry));
}

export function resolveProviderRuntimeOptions({
  runtimeExecutionPolicy = {},
  provider = '',
  workspaceRoot = process.cwd(),
  action = null,
  agent = null,
} = {}) {
  const runtimePolicy = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy);
  const providerPolicy = resolveProviderRuntimePolicy(runtimePolicy, provider);
  const actionInputs = asObject(action?.inputs);
  const agentPolicy = asObject(agent?.runtime_execution || agent?.runtimeExecution);
  const providerAgentPolicy = resolveOptionalProviderPolicy(agentPolicy, provider);
  const actionProviderPolicy = resolveOptionalProviderPolicy(
    actionInputs.runtime_execution || actionInputs.runtimeExecution || actionInputs.provider_policy || actionInputs.providerPolicy || {},
    provider,
  );
  const approvalMatrix = runtimePolicy.approval_matrix || {};
  const root = path.resolve(String(workspaceRoot || process.cwd()).trim() || process.cwd());

  if (String(provider || '').trim().toLowerCase() === 'codex') {
    const merged = {
      ...providerPolicy,
      ...providerAgentPolicy,
      ...actionProviderPolicy,
      config_overrides: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.config_overrides, providerAgentPolicy.config_overrides),
        actionProviderPolicy.config_overrides,
      ),
      mcp_servers: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.mcp_servers, providerAgentPolicy.mcp_servers),
        actionProviderPolicy.mcp_servers,
      ),
    };
    const addDirs = uniqStrings([
      ...(Array.isArray(providerPolicy.add_dirs) ? providerPolicy.add_dirs : []),
      ...(Array.isArray(providerAgentPolicy.add_dirs) ? providerAgentPolicy.add_dirs : []),
      ...(Array.isArray(actionProviderPolicy.add_dirs) ? actionProviderPolicy.add_dirs : []),
    ], { limit: 16 }).map((entry) => path.resolve(root, entry));
    const configOverrides = mergeConfigObjects(merged.config_overrides, {});
    if (Object.keys(asObject(merged.mcp_servers)).length > 0 && !configOverrides.mcp_servers) configOverrides.mcp_servers = merged.mcp_servers;
    return {
      sandboxMode: clean(actionInputs.codex_sandbox_mode || actionInputs.codexSandboxMode || merged.sandbox_mode) || 'workspace-write',
      approvalPolicy: clean(actionInputs.codex_approval_policy || actionInputs.codexApprovalPolicy || merged.approval_policy) || (approvalMatrix.codex_exec === 'ask' ? 'untrusted' : 'never'),
      profile: clean(actionInputs.codex_profile || actionInputs.codexProfile || merged.profile),
      reasoningEffort: clean(actionInputs.codex_reasoning_effort || actionInputs.codexReasoningEffort || merged.reasoning_effort || merged.config_overrides?.model_reasoning_effort),
      harnessVariantId: clean(actionInputs.harness_variant_id || actionInputs.harnessVariantId || actionInputs.codex_harness_variant_id || actionInputs.codexHarnessVariantId || merged.harness_variant_id),
      addDirs,
      configOverrides,
      providerPolicy: merged,
      approvalMatrix,
    };
  }

  if (String(provider || '').trim().toLowerCase() === 'claude') {
    const merged = {
      ...providerPolicy,
      ...providerAgentPolicy,
      ...actionProviderPolicy,
      extra_env: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.extra_env, providerAgentPolicy.extra_env),
        actionProviderPolicy.extra_env,
      ),
    };
    return {
      effort: clean(actionInputs.claude_effort || actionInputs.claudeEffort || actionInputs.reasoning_effort || actionInputs.reasoningEffort || merged.effort),
      reasoningEffort: clean(actionInputs.claude_effort || actionInputs.claudeEffort || actionInputs.reasoning_effort || actionInputs.reasoningEffort || merged.effort),
      harnessVariantId: clean(actionInputs.harness_variant_id || actionInputs.harnessVariantId || actionInputs.claude_harness_variant_id || actionInputs.claudeHarnessVariantId || merged.harness_variant_id),
      extraEnv: merged.extra_env,
      providerPolicy: merged,
      approvalMatrix,
    };
  }

  if (String(provider || '').trim().toLowerCase() === 'antigravity') {
    const merged = {
      ...providerPolicy,
      ...providerAgentPolicy,
      ...actionProviderPolicy,
      workspace_settings: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.workspace_settings, providerAgentPolicy.workspace_settings),
        actionProviderPolicy.workspace_settings,
      ),
      extra_env: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.extra_env, providerAgentPolicy.extra_env),
        actionProviderPolicy.extra_env,
      ),
    };
    return {
      reasoningEffort: clean(actionInputs.antigravity_reasoning_effort || actionInputs.antigravityReasoningEffort || actionInputs.reasoning_effort || actionInputs.reasoningEffort || merged.reasoning_effort),
      harnessVariantId: clean(actionInputs.harness_variant_id || actionInputs.harnessVariantId || actionInputs.antigravity_harness_variant_id || actionInputs.antigravityHarnessVariantId || merged.harness_variant_id),
      workspaceSettings: merged.workspace_settings,
      extraEnv: merged.extra_env,
      providerPolicy: merged,
      approvalMatrix,
    };
  }

  if (String(provider || '').trim().toLowerCase() === 'gemini') {
    const merged = {
      ...providerPolicy,
      ...providerAgentPolicy,
      ...actionProviderPolicy,
      workspace_settings: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.workspace_settings, providerAgentPolicy.workspace_settings),
        actionProviderPolicy.workspace_settings,
      ),
      extra_env: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.extra_env, providerAgentPolicy.extra_env),
        actionProviderPolicy.extra_env,
      ),
      mcp_servers: mergeConfigObjects(
        mergeConfigObjects(providerPolicy.mcp_servers, providerAgentPolicy.mcp_servers),
        actionProviderPolicy.mcp_servers,
      ),
    };
    if (Object.keys(asObject(merged.mcp_servers)).length > 0 && !merged.workspace_settings.mcpServers && !merged.workspace_settings.mcp_servers) {
      merged.workspace_settings = {
        ...merged.workspace_settings,
        mcpServers: merged.mcp_servers,
      };
    }
    return {
      approvalMode: clean(actionInputs.gemini_approval_mode || actionInputs.geminiApprovalMode || merged.approval_mode) || (approvalMatrix.gemini_exec === 'ask' ? 'default' : 'yolo'),
      settingsOverwrite: clean(actionInputs.gemini_settings_overwrite || actionInputs.geminiSettingsOverwrite || merged.settings_overwrite) || 'merge',
      workspaceSettings: merged.workspace_settings,
      extraEnv: merged.extra_env,
      providerPolicy: merged,
      approvalMatrix,
    };
  }

  return {
    providerPolicy: providerPolicy || {},
    approvalMatrix,
  };
}

export function buildProviderRuntimePolicySummary({ runtimeExecutionPolicy = {}, provider = '', options = {} } = {}) {
  const providerKey = String(provider || '').trim().toLowerCase();
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy);
  const lines = [
    `provider=${providerKey || 'unknown'}`,
    `approval_matrix=${JSON.stringify(policy.approval_matrix || {})}`,
  ];
  if (providerKey === 'codex') {
    lines.push(`sandbox_mode=${clean(options.sandboxMode || policy.providers?.codex?.sandbox_mode || '') || 'workspace-write'}`);
    lines.push(`approval_policy=${clean(options.approvalPolicy || policy.providers?.codex?.approval_policy || '') || 'never'}`);
    if (clean(options.profile || policy.providers?.codex?.profile || '')) lines.push(`profile=${clean(options.profile || policy.providers?.codex?.profile || '')}`);
    if (clean(options.reasoningEffort || policy.providers?.codex?.reasoning_effort || '')) lines.push(`reasoning_effort=${clean(options.reasoningEffort || policy.providers?.codex?.reasoning_effort || '')}`);
    if (clean(options.harnessVariantId || policy.providers?.codex?.harness_variant_id || '')) lines.push(`harness_variant_id=${clean(options.harnessVariantId || policy.providers?.codex?.harness_variant_id || '')}`);
    const addDirs = uniqStrings(options.addDirs || policy.providers?.codex?.add_dirs || [], { limit: 16 });
    if (addDirs.length > 0) lines.push(`add_dirs=${addDirs.join(', ')}`);
    const mcpNames = Object.keys(asObject(options.providerPolicy?.mcp_servers || policy.providers?.codex?.mcp_servers));
    if (mcpNames.length > 0) lines.push(`mcp_servers=${mcpNames.join(', ')}`);
  } else if (providerKey === 'claude') {
    lines.push(`reasoning_effort=${clean(options.reasoningEffort || options.effort || policy.providers?.claude?.effort || '') || 'provider_default'}`);
    if (clean(options.harnessVariantId || policy.providers?.claude?.harness_variant_id || '')) lines.push(`harness_variant_id=${clean(options.harnessVariantId || policy.providers?.claude?.harness_variant_id || '')}`);
  } else if (providerKey === 'antigravity') {
    lines.push(`reasoning_effort=${clean(options.reasoningEffort || policy.providers?.antigravity?.reasoning_effort || '') || 'provider_default'}`);
    if (clean(options.harnessVariantId || policy.providers?.antigravity?.harness_variant_id || '')) lines.push(`harness_variant_id=${clean(options.harnessVariantId || policy.providers?.antigravity?.harness_variant_id || '')}`);
  } else if (providerKey === 'gemini') {
    lines.push(`approval_mode=${clean(options.approvalMode || policy.providers?.gemini?.approval_mode || '') || 'default'}`);
    lines.push(`settings_overwrite=${clean(options.settingsOverwrite || policy.providers?.gemini?.settings_overwrite || '') || 'merge'}`);
    const envKeys = Object.keys(asObject(options.extraEnv || policy.providers?.gemini?.extra_env));
    if (envKeys.length > 0) lines.push(`env_keys=${envKeys.join(', ')}`);
    const mcpNames = Object.keys(asObject(options.providerPolicy?.mcp_servers || policy.providers?.gemini?.mcp_servers));
    if (mcpNames.length > 0) lines.push(`mcp_servers=${mcpNames.join(', ')}`);
  }
  return lines.join('\n');
}
