function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
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

function normalizeStringMap(raw = {}, { limit = 32 } = {}) {
  const row = asObject(raw);
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = clean(key);
    if (!cleanKey) continue;
    if (Object.keys(out).length >= limit) break;
    if (value && typeof value === 'object') out[cleanKey] = value;
    else if (typeof value !== 'undefined' && value !== null) out[cleanKey] = clean(value);
  }
  return out;
}

function normalizeApprovalDecision(raw = '', fallback = 'allow') {
  const key = cleanId(raw);
  if (['allow', 'ask', 'deny'].includes(key)) return key;
  return fallback;
}

function normalizeApprovalMatrix(raw = {}) {
  const row = asObject(raw);
  return {
    codex_exec: normalizeApprovalDecision(row.codex_exec || row.codexExec || row.provider_exec || row.providerExec, 'allow'),
    gemini_exec: normalizeApprovalDecision(row.gemini_exec || row.geminiExec || row.provider_exec || row.providerExec, 'allow'),
    workspace_write: normalizeApprovalDecision(row.workspace_write || row.workspaceWrite || row.file_write || row.fileWrite, 'allow'),
    shell_exec: normalizeApprovalDecision(row.shell_exec || row.shellExec || row.command_exec || row.commandExec, 'ask'),
    network: normalizeApprovalDecision(row.network, 'deny'),
    mcp: normalizeApprovalDecision(row.mcp, 'ask'),
    verification: normalizeApprovalDecision(row.verification || row.tool_proxy || row.toolProxy, 'allow'),
  };
}

export function normalizeCheckpointingPolicy(raw = {}) {
  const row = asObject(raw);
  return {
    enabled: row.enabled !== false,
    write_on_turn_end: row.write_on_turn_end === true || row.writeOnTurnEnd === true,
    write_on_approval_pause: row.write_on_approval_pause !== false && row.writeOnApprovalPause !== false,
    write_on_resume: row.write_on_resume !== false && row.writeOnResume !== false,
    expose_restore_context_to_agents: row.expose_restore_context_to_agents !== false && row.exposeRestoreContextToAgents !== false,
  };
}

export function normalizeContinuousImprovementPolicy(raw = {}) {
  const row = asObject(raw);
  const mode = cleanId(row.mode || row.strategy || 'until_quality_threshold') || 'until_quality_threshold';
  return {
    enabled: row.enabled === true,
    mode,
    max_turns: Number.isFinite(Number(row.max_turns ?? row.maxTurns))
      ? Math.max(1, Math.min(24, Math.floor(Number(row.max_turns ?? row.maxTurns))))
      : 8,
    max_total_actions: Number.isFinite(Number(row.max_total_actions ?? row.maxTotalActions))
      ? Math.max(1, Math.min(200, Math.floor(Number(row.max_total_actions ?? row.maxTotalActions))))
      : 48,
    min_turns: Number.isFinite(Number(row.min_turns ?? row.minTurns))
      ? Math.max(1, Math.min(12, Math.floor(Number(row.min_turns ?? row.minTurns))))
      : 1,
    progress_report_each_turn: row.progress_report_each_turn !== false && row.progressReportEachTurn !== false,
    stop_signals: uniqStrings(
      row.stop_signals || row.stopSignals || ['quality_threshold_met', 'ready_for_user', 'final_answer_ready', 'done_enough'],
      { limit: 12 }
    ),
    self_refine_prompt: clean(row.self_refine_prompt || row.selfRefinePrompt || ''),
  };
}

function normalizeCodexProviderPolicy(raw = {}) {
  const row = asObject(raw);
  const configOverrides = asObject(row.config_overrides || row.configOverrides);
  const mcpServers = asObject(row.mcp_servers || row.mcpServers);
  if (Object.keys(mcpServers).length > 0 && !configOverrides.mcp_servers) configOverrides.mcp_servers = mcpServers;
  return {
    sandbox_mode: cleanId(row.sandbox_mode || row.sandboxMode || 'workspace-write') || 'workspace-write',
    approval_policy: cleanId(row.approval_policy || row.approvalPolicy || 'never') || 'never',
    profile: clean(row.profile || ''),
    add_dirs: uniqStrings(row.add_dirs || row.addDirs || [], { limit: 16 }),
    config_overrides: configOverrides,
    mcp_servers: mcpServers,
  };
}

function normalizeGeminiProviderPolicy(raw = {}) {
  const row = asObject(raw);
  const workspaceSettings = asObject(row.workspace_settings || row.workspaceSettings);
  const mcpServers = asObject(row.mcp_servers || row.mcpServers);
  if (Object.keys(mcpServers).length > 0 && !workspaceSettings.mcpServers && !workspaceSettings.mcp_servers) {
    workspaceSettings.mcpServers = mcpServers;
  }
  return {
    approval_mode: cleanId(row.approval_mode || row.approvalMode || 'default') || 'default',
    settings_overwrite: cleanId(row.settings_overwrite || row.settingsOverwrite || 'merge') || 'merge',
    workspace_settings: workspaceSettings,
    extra_env: normalizeStringMap(row.extra_env || row.extraEnv || {}, { limit: 24 }),
    mcp_servers: mcpServers,
  };
}

export function normalizeProviderRuntimePolicies(raw = {}) {
  const row = asObject(raw);
  return {
    codex: normalizeCodexProviderPolicy(row.codex || row.codex_cli || row.codexCli || {}),
    gemini: normalizeGeminiProviderPolicy(row.gemini || row.gemini_cli || row.geminiCli || {}),
  };
}

export function normalizeRuntimeExecutionPolicy(raw = {}) {
  const row = asObject(raw);
  const providerPolicies = normalizeProviderRuntimePolicies(row.providers || row.provider_policies || row.providerPolicies || row);
  return {
    checkpointing: normalizeCheckpointingPolicy(row.checkpointing || row.checkpoints || {}),
    continuous_improvement: normalizeContinuousImprovementPolicy(row.continuous_improvement || row.continuousImprovement || {}),
    approval_matrix: normalizeApprovalMatrix(row.approval_matrix || row.approvalMatrix || {}),
    providers: providerPolicies,
    codex: providerPolicies.codex,
    gemini: providerPolicies.gemini,
    workflow_contract: row.workflow_contract && typeof row.workflow_contract === 'object'
      ? row.workflow_contract
      : (row.workflowContract && typeof row.workflowContract === 'object' ? row.workflowContract : undefined),
  };
}

export function resolveRuntimeExecutionPolicy(source = null) {
  const row = asObject(source);
  const runtimeExecution = row.runtime_execution || row.runtimeExecution || row;
  return normalizeRuntimeExecutionPolicy(runtimeExecution);
}

export function resolveProviderRuntimePolicy(runtimeExecution = {}, provider = '') {
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecution);
  const key = cleanId(provider);
  if (key === 'codex') return policy.providers.codex;
  if (key === 'gemini') return policy.providers.gemini;
  return {};
}

export function summarizeProviderRuntimePolicy(runtimeExecution = {}) {
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecution);
  return {
    checkpointing: policy.checkpointing,
    continuous_improvement: policy.continuous_improvement,
    approval_matrix: policy.approval_matrix,
    providers: {
      codex: {
        sandbox_mode: policy.providers.codex.sandbox_mode,
        approval_policy: policy.providers.codex.approval_policy,
        profile: policy.providers.codex.profile,
        add_dirs: policy.providers.codex.add_dirs,
        mcp_server_names: Object.keys(asObject(policy.providers.codex.mcp_servers)),
      },
      gemini: {
        approval_mode: policy.providers.gemini.approval_mode,
        settings_overwrite: policy.providers.gemini.settings_overwrite,
        env_keys: Object.keys(asObject(policy.providers.gemini.extra_env)),
        mcp_server_names: Object.keys(asObject(policy.providers.gemini.mcp_servers)),
      },
    },
  };
}
