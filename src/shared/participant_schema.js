import { asObject, normalizeProviderName, normalizeStringList } from './normalize.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

export const CAPABILITY_ALIAS_MAP = Object.freeze({
  workspace_fs: 'filesystem_write',
  read_only_fs: 'filesystem_read',
  shell: 'shell_exec',
  web: 'web_browse',
  write_file: 'filesystem_write',
  create_file: 'filesystem_write',
  save_file: 'filesystem_write',
  read_file: 'filesystem_read',
});

export const LEGACY_CAPABILITY_ALIAS_MAP = Object.freeze({
  filesystem_write: 'workspace_fs',
  filesystem_read: 'read_only_fs',
  shell_exec: 'shell',
  web_browse: 'web',
  long_running_process: 'long_running_process',
  network_access: 'network_access',
});

const PROVIDER_RUNTIME_KEYS = new Set([
  'sandbox_mode', 'sandboxMode', 'approval_policy', 'approvalPolicy', 'workspace_settings', 'workspaceSettings',
  'mcp_servers', 'mcpServers', 'network_policy', 'networkPolicy', 'profile', 'add_dirs', 'addDirs',
  'config_overrides', 'configOverrides', 'extra_env', 'extraEnv', 'approval_mode', 'approvalMode',
  'settings_overwrite', 'settingsOverwrite',
]);

export function uniqueIds(values = [], { max = 24 } = {}) {
  const list = Array.isArray(values)
    ? values
    : (typeof values === 'string' ? values.split(/[\n,]/) : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export function mergeUniqueIds(...groups) {
  return uniqueIds(groups.flatMap((group) => uniqueIds(group, { max: 64 })), { max: 64 });
}

export function normalizeRuntimeCapabilityId(value = '') {
  const key = cleanId(value);
  if (!key) return '';
  return CAPABILITY_ALIAS_MAP[key] || (LEGACY_CAPABILITY_ALIAS_MAP[key] ? key : '');
}

export function isRuntimeCapabilityId(value = '') {
  return Boolean(normalizeRuntimeCapabilityId(value));
}

export function toLegacyRuntimeCapabilityId(value = '') {
  const key = normalizeRuntimeCapabilityId(value);
  return key ? (LEGACY_CAPABILITY_ALIAS_MAP[key] || key) : '';
}

export function classifyToolishId(value = '') {
  const raw = cleanId(value);
  if (!raw) return { raw: '', kind: 'unknown', canonical_id: '', legacy_id: '' };
  const capabilityId = normalizeRuntimeCapabilityId(raw);
  if (capabilityId) {
    return { raw, kind: 'capability', canonical_id: capabilityId, legacy_id: toLegacyRuntimeCapabilityId(capabilityId) };
  }
  return { raw, kind: 'external_tool', canonical_id: raw, legacy_id: raw };
}

export function splitToolishIds(values = []) {
  const runtimeCapabilities = [];
  const externalTools = [];
  const seenCaps = new Set();
  const seenTools = new Set();
  for (const raw of uniqueIds(values, { max: 64 })) {
    const classified = classifyToolishId(raw);
    if (classified.kind === 'capability') {
      if (!seenCaps.has(classified.canonical_id)) {
        seenCaps.add(classified.canonical_id);
        runtimeCapabilities.push(classified.canonical_id);
      }
      continue;
    }
    if (!seenTools.has(classified.canonical_id)) {
      seenTools.add(classified.canonical_id);
      externalTools.push(classified.canonical_id);
    }
  }
  return { runtimeCapabilities, externalTools };
}

export function collectRuntimeCapabilityIds(...groups) {
  const out = [];
  const seen = new Set();
  for (const group of groups) {
    let items = [];
    if (Array.isArray(group)) items = group;
    else if (typeof group === 'string') items = [group];
    else if (group && typeof group === 'object') items = Object.entries(group).filter(([, enabled]) => enabled !== false).map(([key]) => key);
    for (const item of items) {
      const id = normalizeRuntimeCapabilityId(item);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export function normalizeProviderSpec(raw = {}) {
  const row = asObject(raw);
  const providerRow = asObject(row.provider_spec || row.providerSpec);
  const provider = normalizeProviderName(providerRow.provider || row.provider || row.transport || '', '');
  const executionChannel = cleanId(providerRow.execution_channel || providerRow.executionChannel || row.execution_channel || row.executionChannel || row.channel || '');
  const interactionMode = cleanId(providerRow.interaction_mode || providerRow.interactionMode || row.interaction_mode || row.interactionMode || '');
  return {
    provider: provider || '',
    model: clean(providerRow.model || row.model || ''),
    execution_channel: executionChannel || undefined,
    interaction_mode: interactionMode || undefined,
  };
}

export function normalizeProviderRuntimeConfig(raw = {}) {
  const row = asObject(raw);
  const nested = asObject(row.provider_runtime_config || row.providerRuntimeConfig);
  const candidate = Object.keys(nested).length > 0
    ? nested
    : Object.fromEntries(Object.entries(row).filter(([key]) => PROVIDER_RUNTIME_KEYS.has(key)));
  return {
    sandbox_mode: cleanId(candidate.sandbox_mode || candidate.sandboxMode || '') || undefined,
    approval_policy: cleanId(candidate.approval_policy || candidate.approvalPolicy || candidate.approval_mode || candidate.approvalMode || '') || undefined,
    workspace_settings: asObject(candidate.workspace_settings || candidate.workspaceSettings),
    mcp_servers: asObject(candidate.mcp_servers || candidate.mcpServers),
    network_policy: cleanId(candidate.network_policy || candidate.networkPolicy || '') || undefined,
    profile: clean(candidate.profile || '') || undefined,
    add_dirs: normalizeStringList(candidate.add_dirs || candidate.addDirs || [], { max: 16, lower: false }),
    config_overrides: asObject(candidate.config_overrides || candidate.configOverrides),
    extra_env: asObject(candidate.extra_env || candidate.extraEnv),
  };
}

export function normalizeRoleProfile(raw = {}) {
  const row = asObject(raw);
  const nested = asObject(row.role_profile || row.roleProfile);
  return {
    role: cleanId(nested.role || row.role || row.role_id || row.roleId || 'specialist') || 'specialist',
    purpose: clean(nested.purpose || row.purpose || row.description || ''),
    specialty: cleanId(nested.specialty || row.specialty || '') || undefined,
    final_owner: nested.final_owner === true || row.final_owner === true || row.finalOwner === true,
  };
}

export function normalizeSkillPackage(raw = {}) {
  const row = asObject(raw);
  const nested = asObject(row.skill_package || row.skillPackage);
  return {
    skill_ids: uniqueIds(nested.skill_ids || nested.skillIds || row.attached_skill_ids || row.attachedSkillIds || [], { max: 12 }),
    generated_skill_briefs: asArray(nested.generated_skill_briefs || nested.generatedSkillBriefs || row.generated_skill_briefs || row.generatedSkillBriefs || []).slice(0, 8),
  };
}

export function normalizeMemoryContract(raw = {}) {
  const row = asObject(raw);
  const nested = asObject(row.memory_contract || row.memoryContract);
  return {
    read_surface_ids: uniqueIds(nested.read_surface_ids || nested.readSurfaceIds || row.read_surface_ids || row.readSurfaceIds || row.context_policy?.reads?.surface_ids || row.contextPolicy?.reads?.surface_ids || [], { max: 12 }),
    write_surface_ids: uniqueIds(nested.write_surface_ids || nested.writeSurfaceIds || row.write_surface_ids || row.writeSurfaceIds || row.context_policy?.writes?.surface_ids || row.contextPolicy?.writes?.surface_ids || [], { max: 12 }),
    publish_surface_ids: uniqueIds(nested.publish_surface_ids || nested.publishSurfaceIds || row.publish_surface_ids || row.publishSurfaceIds || row.context_policy?.writes?.publish_targets || row.contextPolicy?.writes?.publish_targets || [], { max: 12 }),
    enforcement_mode: cleanId(nested.enforcement_mode || nested.enforcementMode || row.enforcement_mode || row.enforcementMode || '') || undefined,
  };
}

export function normalizeParticipantExecutionSchema(raw = {}) {
  const row = asObject(raw);
  const roleProfile = normalizeRoleProfile(row);
  const providerSpec = normalizeProviderSpec(row);
  const providerRuntimeConfig = normalizeProviderRuntimeConfig(row);
  const skillPackage = normalizeSkillPackage(row);
  const memoryContract = normalizeMemoryContract(row);

  const requiredLegacy = splitToolishIds(row.required_tool_ids || row.requiredToolIds || []);
  const optionalLegacy = splitToolishIds(row.optional_tool_ids || row.optionalToolIds || []);
  const recommendedLegacy = splitToolishIds(row.recommended_tool_ids || row.recommendedToolIds || []);

  const runtimeCapabilitiesRequired = collectRuntimeCapabilityIds(
    row.runtime_capabilities_required || row.runtimeCapabilitiesRequired || row.required_runtime_capabilities || row.requiredRuntimeCapabilities,
    requiredLegacy.runtimeCapabilities,
  );
  const runtimeCapabilitiesOptional = collectRuntimeCapabilityIds(
    row.runtime_capabilities_optional || row.runtimeCapabilitiesOptional || row.optional_runtime_capabilities || row.optionalRuntimeCapabilities,
    optionalLegacy.runtimeCapabilities,
    recommendedLegacy.runtimeCapabilities,
  ).filter((id) => !runtimeCapabilitiesRequired.includes(id));

  const externalToolRequirements = uniqueIds([
    ...uniqueIds(row.external_tool_requirements || row.externalToolRequirements || []),
    ...requiredLegacy.externalTools,
  ], { max: 16 });
  const externalToolPreferences = uniqueIds([
    ...uniqueIds(row.external_tool_preferences || row.externalToolPreferences || []),
    ...optionalLegacy.externalTools,
    ...recommendedLegacy.externalTools,
  ], { max: 16 }).filter((id) => !externalToolRequirements.includes(id));

  const requiredToolIds = uniqueIds([
    ...runtimeCapabilitiesRequired.map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
    ...externalToolRequirements,
  ], { max: 16 });
  const optionalToolIds = uniqueIds([
    ...runtimeCapabilitiesOptional.map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
    ...externalToolPreferences,
  ], { max: 16 }).filter((id) => !requiredToolIds.includes(id));
  const recommendedToolIds = uniqueIds([...requiredToolIds, ...optionalToolIds], { max: 16 });

  return {
    role_profile: roleProfile,
    provider_spec: providerSpec,
    provider_runtime_config: providerRuntimeConfig,
    skill_package: skillPackage,
    runtime_capabilities_required: runtimeCapabilitiesRequired,
    runtime_capabilities_optional: runtimeCapabilitiesOptional,
    external_tool_requirements: externalToolRequirements,
    external_tool_preferences: externalToolPreferences,
    memory_contract: memoryContract,
    required_tool_ids: requiredToolIds,
    optional_tool_ids: optionalToolIds,
    recommended_tool_ids: recommendedToolIds,
  };
}


export function getParticipantRuntimeCapabilitiesRequired(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).runtime_capabilities_required;
}

export function getParticipantRuntimeCapabilitiesOptional(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).runtime_capabilities_optional;
}

export function getParticipantExternalToolRequirements(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).external_tool_requirements;
}

export function getParticipantExternalToolPreferences(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).external_tool_preferences;
}

export function getParticipantLegacyRequiredToolIds(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).required_tool_ids;
}

export function getParticipantLegacyOptionalToolIds(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).optional_tool_ids;
}

export function getParticipantLegacyRecommendedToolIds(raw = {}) {
  return normalizeParticipantExecutionSchema(raw).recommended_tool_ids;
}

export function applyParticipantExecutionSchema(raw = {}) {
  const row = asObject(raw);
  return {
    ...row,
    ...normalizeParticipantExecutionSchema(row),
  };
}
