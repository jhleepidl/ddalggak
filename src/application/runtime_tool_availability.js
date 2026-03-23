import { normalizeRuntimeExecutionPolicy } from './runtime_execution_policy.js';
import { resolveProviderRuntimeOptions } from './provider_runtime_policy.js';
import {
  collectRuntimeCapabilityIds,
  normalizeRuntimeCapabilityId,
  toLegacyRuntimeCapabilityId,
} from '../shared/participant_schema.js';

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
    runtime.availableCapabilityIds, runtime.available_capability_ids, runtime.enabledCapabilityIds, runtime.enabled_capability_ids,
    runtime.runtime_capabilities, runtime.runtimeCapabilities,
    runtime.agents, runtime.runtime_agents,
  ].some((value) => (Array.isArray(value) && value.length > 0) || (value && typeof value === 'object' && Object.keys(value).length > 0));
}

export function collectRuntimeAvailableCapabilityIds(runtime = null) {
  const out = [];
  out.push(...collectRuntimeCapabilityIds(runtime?.availableCapabilityIds || runtime?.available_capability_ids));
  out.push(...collectRuntimeCapabilityIds(runtime?.enabledCapabilityIds || runtime?.enabled_capability_ids));
  out.push(...collectRuntimeCapabilityIds(runtime?.runtime_capabilities || runtime?.runtimeCapabilities));
  out.push(...collectRuntimeCapabilityIds(runtime?.availableToolIds || runtime?.available_tool_ids));
  out.push(...collectRuntimeCapabilityIds(runtime?.enabledToolIds || runtime?.enabled_tool_ids));
  out.push(...collectRuntimeCapabilityIds(runtime?.toolIds || runtime?.tool_ids));
  out.push(...collectRuntimeCapabilityIds(asArray(runtime?.tools).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name)));
  out.push(...collectRuntimeCapabilityIds(asArray(runtime?.toolsCatalog || runtime?.tools_catalog).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name)));
  for (const row of asArray(runtime?.agents)) out.push(...collectRuntimeCapabilityIds(row?.tools || row?.tool_ids || row?.toolIds || row?.runtime_capabilities || row?.runtimeCapabilities));
  for (const row of asArray(runtime?.runtime_agents)) out.push(...collectRuntimeCapabilityIds(row?.tools || row?.tool_ids || row?.toolIds || row?.runtime_capabilities || row?.runtimeCapabilities));
  return new Set(uniqueIds(out));
}

export function collectRuntimeAvailableExternalToolIds(runtime = null) {
  const out = [];
  out.push(...asArray(runtime?.availableToolIds || runtime?.available_tool_ids));
  out.push(...asArray(runtime?.enabledToolIds || runtime?.enabled_tool_ids));
  out.push(...asArray(runtime?.toolIds || runtime?.tool_ids));
  out.push(...asArray(runtime?.tools).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name));
  out.push(...asArray(runtime?.toolsCatalog || runtime?.tools_catalog).map((row) => row?.id || row?.tool_id || row?.toolId || row?.name));
  for (const row of asArray(runtime?.agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(runtime?.runtime_agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  return new Set(uniqueIds(out.filter((entry) => !normalizeRuntimeCapabilityId(entry))));
}

function collectImpliedRuntimeCapabilityIds(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return [];
  const implied = new Set();
  const mode = cleanId(runtime?.mode || runtime?.runtime_mode || runtime?.runtimeAuthority?.mode || runtime?.runtime_authority?.mode || '');
  const hasJobBinding = Boolean(cleanId(runtime?.jobId || runtime?.currentJobId || runtime?.job_id));
  const hasWorkspaceCatalog = [...asArray(runtime?.tools), ...asArray(runtime?.toolsCatalog), ...asArray(runtime?.tools_catalog)]
    .some((row) => cleanId(row?.id || row?.tool_id || row?.toolId || row?.name) === 'workspace_fs');
  if (hasWorkspaceCatalog || hasJobBinding || ['local', 'standalone'].includes(mode)) {
    implied.add('filesystem_read');
    implied.add('filesystem_write');
  }
  const agents = [
    ...asArray(runtime?.agents),
    ...asArray(runtime?.runtime_agents),
    ...asArray(runtime?.activeTeamConfig?.agents),
    ...asArray(runtime?.runtimeTeamSnapshot?.agents),
    ...asArray(runtime?.runtime_team_snapshot?.agents),
  ];
  const hasCodexAgent = agents.some((row) => cleanId(row?.provider) === 'codex');
  if (!hasCodexAgent) return [...implied];
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
  if (['workspace-write', 'danger-full-access'].includes(sandboxMode)) {
    implied.add('filesystem_read');
    implied.add('filesystem_write');
  }
  return [...implied];
}

export function collectFallbackKnownToolIds(registry = null) {
  const out = [];
  for (const row of asArray(registry?.agentsCatalog)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(registry?.agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(registry?.toolCatalog || registry?.toolsCatalog || registry?.tools || [])) out.push(row?.id || row?.tool_id || row?.toolId || row?.name);
  return new Set(uniqueIds(out.filter((entry) => !normalizeRuntimeCapabilityId(entry))));
}

export function collectEffectiveAvailableCapabilityIds(runtime = null) {
  const base = collectRuntimeAvailableCapabilityIds(runtime);
  for (const capabilityId of collectImpliedRuntimeCapabilityIds(runtime)) base.add(capabilityId);
  return base;
}

export function collectEffectiveAvailableExternalToolIds(runtime = null, registry = null) {
  return hasRuntimeToolSignal(runtime)
    ? collectRuntimeAvailableExternalToolIds(runtime)
    : collectFallbackKnownToolIds(registry || runtime);
}

export function collectEffectiveAvailableToolIds(runtime = null, registry = null) {
  const base = collectEffectiveAvailableExternalToolIds(runtime, registry);
  for (const capabilityId of collectEffectiveAvailableCapabilityIds(runtime)) {
    const legacyId = toLegacyRuntimeCapabilityId(capabilityId);
    if (legacyId) base.add(legacyId);
  }
  return base;
}
