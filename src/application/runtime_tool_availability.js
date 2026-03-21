import { normalizeRuntimeExecutionPolicy } from './runtime_execution_policy.js';
import { resolveProviderRuntimeOptions } from './provider_runtime_policy.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanId(value = '') {
  return String(value || '').trim().toLowerCase();
}

function uniqueIds(values = [], { max = 128 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function hasRuntimeToolSignal(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return false;
  return [
    runtime.availableToolIds, runtime.available_tool_ids, runtime.enabledToolIds, runtime.enabled_tool_ids,
    runtime.toolsCatalog, runtime.tools_catalog, runtime.tools, runtime.toolIds, runtime.tool_ids,
    runtime.agents, runtime.runtime_agents,
  ].some((value) => Array.isArray(value) && value.length > 0);
}

export function collectRuntimeAvailableToolIds(runtime = null) {
  const out = [];
  out.push(...asArray(runtime?.availableToolIds || runtime?.available_tool_ids));
  out.push(...asArray(runtime?.enabledToolIds || runtime?.enabled_tool_ids));
  out.push(...asArray(runtime?.toolIds || runtime?.tool_ids));
  out.push(...asArray(runtime?.tools).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name));
  out.push(...asArray(runtime?.toolsCatalog || runtime?.tools_catalog).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name));
  for (const row of asArray(runtime?.agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(runtime?.runtime_agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  return new Set(uniqueIds(out));
}

function collectImpliedRuntimeToolIds(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return [];
  const agents = [
    ...asArray(runtime?.agents),
    ...asArray(runtime?.runtime_agents),
    ...asArray(runtime?.activeTeamConfig?.agents),
    ...asArray(runtime?.runtimeTeamSnapshot?.agents),
    ...asArray(runtime?.runtime_team_snapshot?.agents),
  ];
  const hasCodexAgent = agents.some((row) => cleanId(row?.provider) === 'codex');
  if (!hasCodexAgent) return [];
  const rawPolicy = runtime?.activeTeamConfig?.structure_v2?.control_policy?.runtime_execution
    || runtime?.activeTeamConfig?.runtime_execution
    || runtime?.runtimeTeamSnapshot?.structure_v2?.control_policy?.runtime_execution
    || runtime?.runtimeTeamSnapshot?.runtime_execution
    || runtime?.runtime_team_snapshot?.structure_v2?.control_policy?.runtime_execution
    || runtime?.runtime_team_snapshot?.runtime_execution
    || runtime?.runtime_execution
    || runtime?.runtimeExecution
    || {};
  const runtimeExecutionPolicy = normalizeRuntimeExecutionPolicy(rawPolicy);
  const codexOptions = resolveProviderRuntimeOptions({ runtimeExecutionPolicy, provider: 'codex' });
  const sandboxMode = cleanId(codexOptions?.sandboxMode || '');
  if (!['workspace-write', 'danger-full-access'].includes(sandboxMode)) return [];
  return ['workspace_fs', 'write_file', 'create_file', 'save_file'];
}

export function collectFallbackKnownToolIds(registry = null) {
  const out = [];
  for (const row of asArray(registry?.agentsCatalog)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(registry?.agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(registry?.toolCatalog || registry?.toolsCatalog || registry?.tools || [])) out.push(row?.id || row?.tool_id || row?.toolId || row?.name);
  return new Set(uniqueIds(out));
}

export function collectEffectiveAvailableToolIds(runtime = null, registry = null) {
  const base = hasRuntimeToolSignal(runtime)
    ? collectRuntimeAvailableToolIds(runtime)
    : collectFallbackKnownToolIds(registry || runtime);
  for (const toolId of collectImpliedRuntimeToolIds(runtime)) base.add(toolId);
  return base;
}
