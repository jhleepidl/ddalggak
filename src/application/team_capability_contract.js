import {
  collectEffectiveAvailableCapabilityIds,
  collectEffectiveAvailableExternalToolIds,
  collectEffectiveAvailableToolIds,
  hasRuntimeToolSignal,
} from './runtime_tool_availability.js';
import { normalizeManifestRequirements } from '../shared/manifest_requirements.js';
import { normalizeParticipantExecutionSchema, toLegacyRuntimeCapabilityId, uniqueIds } from '../shared/participant_schema.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase(); }

function buildAgentContract(agent = {}) {
  const role = cleanId(agent?.role);
  const purposeText = `${clean(agent?.purpose)} ${clean(agent?.name)}`.toLowerCase();
  const participant = normalizeParticipantExecutionSchema(agent);
  const requiredCapabilities = new Set(participant.runtime_capabilities_required);
  const optionalCapabilities = new Set(participant.runtime_capabilities_optional);
  const requiredExternalTools = new Set(participant.external_tool_requirements);
  const optionalExternalTools = new Set(participant.external_tool_preferences);
  const codeLike = /ipynb|notebook|jupyter|file|json|python|script|workspace|code|코드|노트북|파일/.test(purposeText);
  if (role === 'builder' && codeLike) requiredCapabilities.add('filesystem_write');
  if (role === 'builder') optionalCapabilities.add('shell_exec');
  if ((role === 'researcher' || role === 'reviewer') && /research|review|evidence|fact|검토|조사/.test(purposeText)) optionalCapabilities.add('web_browse');
  for (const capabilityId of [...requiredCapabilities]) optionalCapabilities.delete(capabilityId);
  for (const toolId of [...requiredExternalTools]) optionalExternalTools.delete(toolId);
  return {
    agent_id: clean(agent?.agent_id || agent?.id || agent?.name || role || 'agent'),
    agent_name: clean(agent?.name || agent?.agent_id || role || 'agent') || 'agent',
    role: role || 'agent',
    required_capabilities: uniqueIds([...requiredCapabilities]),
    optional_capabilities: uniqueIds([...optionalCapabilities]),
    required_external_tools: uniqueIds([...requiredExternalTools]),
    optional_external_tools: uniqueIds([...optionalExternalTools]),
    required_tools: uniqueIds([
      ...[...requiredCapabilities].map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
      ...requiredExternalTools,
    ]),
    optional_tools: uniqueIds([
      ...[...optionalCapabilities].map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
      ...optionalExternalTools,
    ]),
  };
}

export function buildTeamCapabilityContract({ team = {}, runtime = null } = {}) {
  const row = team && typeof team === 'object' ? team : {};
  const availableCapabilities = hasRuntimeToolSignal(runtime) ? [...collectEffectiveAvailableCapabilityIds(runtime)] : [];
  const availableExternalTools = hasRuntimeToolSignal(runtime) ? [...collectEffectiveAvailableExternalToolIds(runtime, runtime)] : [];
  const availableLegacyTools = [...collectEffectiveAvailableToolIds(runtime)];
  const availableCapabilitySet = new Set(availableCapabilities);
  const availableExternalToolSet = new Set(availableExternalTools);
  const requirements = normalizeManifestRequirements(row?.requirements || {});
  const agentContracts = asArray(row?.agents).map((agent) => buildAgentContract(agent));
  const requiredCapabilities = new Set();
  const optionalCapabilities = new Set();
  const requiredExternalTools = new Set();
  const optionalExternalTools = new Set();
  for (const requirement of asArray(requirements.capabilities)) {
    const capabilityId = cleanId(requirement?.capability_id || requirement?.capabilityId);
    if (!capabilityId) continue;
    if (cleanId(requirement?.severity || 'blocking') === 'blocking') requiredCapabilities.add(capabilityId); else optionalCapabilities.add(capabilityId);
  }
  for (const requirement of asArray(requirements.external_tools)) {
    const toolId = cleanId(requirement?.external_tool_id || requirement?.externalToolId || requirement?.tool_id || requirement?.toolId);
    if (!toolId) continue;
    if (cleanId(requirement?.severity || 'blocking') === 'blocking') requiredExternalTools.add(toolId); else optionalExternalTools.add(toolId);
  }
  for (const contract of agentContracts) {
    for (const id of contract.required_capabilities) requiredCapabilities.add(id);
    for (const id of contract.optional_capabilities) optionalCapabilities.add(id);
    for (const id of contract.required_external_tools) requiredExternalTools.add(id);
    for (const id of contract.optional_external_tools) optionalExternalTools.add(id);
  }
  for (const id of [...requiredCapabilities]) optionalCapabilities.delete(id);
  for (const id of [...requiredExternalTools]) optionalExternalTools.delete(id);
  const missingRequiredCapabilities = [...requiredCapabilities].filter((id) => !availableCapabilitySet.has(id));
  const missingOptionalCapabilities = [...optionalCapabilities].filter((id) => !availableCapabilitySet.has(id));
  const missingRequiredExternalTools = [...requiredExternalTools].filter((id) => !availableExternalToolSet.has(id));
  const missingOptionalExternalTools = [...optionalExternalTools].filter((id) => !availableExternalToolSet.has(id));
  const runtimeBound = hasRuntimeToolSignal(runtime);
  const requiredTools = uniqueIds([
    ...[...requiredCapabilities].map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
    ...requiredExternalTools,
  ]);
  const optionalTools = uniqueIds([
    ...[...optionalCapabilities].map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
    ...optionalExternalTools,
  ]);
  return {
    version: 'capability_contract_v2',
    runtime_bound: runtimeBound,
    runtime_source: runtimeBound ? 'runtime' : 'template',
    status: !runtimeBound
      ? 'unbound'
      : (missingRequiredCapabilities.length + missingRequiredExternalTools.length) > 0
        ? 'degraded'
        : (missingOptionalCapabilities.length + missingOptionalExternalTools.length) > 0
          ? 'advisory_gap'
          : 'ready',
    required_capabilities: uniqueIds([...requiredCapabilities]),
    optional_capabilities: uniqueIds([...optionalCapabilities]),
    available_capabilities: uniqueIds(availableCapabilities),
    missing_required_capabilities: uniqueIds(missingRequiredCapabilities),
    missing_optional_capabilities: uniqueIds(missingOptionalCapabilities),
    required_external_tools: uniqueIds([...requiredExternalTools]),
    optional_external_tools: uniqueIds([...optionalExternalTools]),
    available_external_tools: uniqueIds(availableExternalTools),
    missing_required_external_tools: uniqueIds(missingRequiredExternalTools),
    missing_optional_external_tools: uniqueIds(missingOptionalExternalTools),
    required_tools: requiredTools,
    optional_tools: optionalTools,
    available_tools: uniqueIds(availableLegacyTools),
    missing_required_tools: uniqueIds([
      ...missingRequiredCapabilities.map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
      ...missingRequiredExternalTools,
    ]),
    missing_optional_tools: uniqueIds([
      ...missingOptionalCapabilities.map((id) => toLegacyRuntimeCapabilityId(id)).filter(Boolean),
      ...missingOptionalExternalTools,
    ]),
    auto_installable_missing_tools: [],
    mismatch_count: missingRequiredCapabilities.length + missingOptionalCapabilities.length + missingRequiredExternalTools.length + missingOptionalExternalTools.length,
    agent_contracts: agentContracts,
  };
}

export function summarizeCapabilityContract(contract = {}) {
  const row = contract && typeof contract === 'object' ? contract : {};
  return {
    capability_status: cleanId(row.status || 'unbound') || 'unbound',
    required_capability_count: asArray(row.required_capabilities).length,
    optional_capability_count: asArray(row.optional_capabilities).length,
    required_external_tool_count: asArray(row.required_external_tools).length,
    optional_external_tool_count: asArray(row.optional_external_tools).length,
    missing_required_capability_count: asArray(row.missing_required_capabilities).length,
    missing_optional_capability_count: asArray(row.missing_optional_capabilities).length,
    missing_required_external_tool_count: asArray(row.missing_required_external_tools).length,
    missing_optional_external_tool_count: asArray(row.missing_optional_external_tools).length,
    required_tool_count: asArray(row.required_tools).length,
    optional_tool_count: asArray(row.optional_tools).length,
    missing_required_tool_count: asArray(row.missing_required_tools).length,
    missing_optional_tool_count: asArray(row.missing_optional_tools).length,
    missing_required_tools: uniqueIds(row.missing_required_tools || []),
    missing_optional_tools: uniqueIds(row.missing_optional_tools || []),
  };
}

export function formatTeamCapabilityContractLines(contract = {}, { maxMissing = 4 } = {}) {
  const row = contract && typeof contract === 'object' ? contract : {};
  const lines = [
    `- status: ${cleanId(row.status || 'unbound') || 'unbound'}${row.runtime_bound ? '' : ' (runtime unbound)'}`,
    `- required capabilities: ${asArray(row.required_capabilities).join(', ') || '(none)'}`,
    `- optional capabilities: ${asArray(row.optional_capabilities).join(', ') || '(none)'}`,
    `- required external tools: ${asArray(row.required_external_tools).join(', ') || '(none)'}`,
    `- optional external tools: ${asArray(row.optional_external_tools).join(', ') || '(none)'}`,
  ];
  const missingRequired = [
    ...asArray(row.missing_required_capabilities).slice(0, Math.max(1, Number(maxMissing) || 4)),
    ...asArray(row.missing_required_external_tools).slice(0, Math.max(1, Number(maxMissing) || 4)),
  ];
  const missingOptional = [
    ...asArray(row.missing_optional_capabilities).slice(0, Math.max(1, Number(maxMissing) || 4)),
    ...asArray(row.missing_optional_external_tools).slice(0, Math.max(1, Number(maxMissing) || 4)),
  ];
  if (missingRequired.length > 0) lines.push(`- missing required: ${missingRequired.join(', ')}`);
  if (missingOptional.length > 0) lines.push(`- missing optional: ${missingOptional.join(', ')}`);
  return lines;
}
