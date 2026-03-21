import { collectRuntimeAvailableToolIds, hasRuntimeToolSignal } from './runtime_tool_availability.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase(); }
function uniqueIds(values = [], { max = 64 } = {}) { const out = []; const seen = new Set(); for (const raw of asArray(values)) { const value = cleanId(raw); if (!value || seen.has(value)) continue; seen.add(value); out.push(value); if (out.length >= max) break; } return out; }

function buildAgentContract(agent = {}) {
  const role = cleanId(agent?.role);
  const purposeText = `${clean(agent?.purpose)} ${clean(agent?.name)}`.toLowerCase();
  const explicitRequired = uniqueIds(agent?.required_tool_ids || agent?.requiredToolIds || []);
  const explicitOptional = uniqueIds(agent?.optional_tool_ids || agent?.optionalToolIds || agent?.recommended_tool_ids || agent?.recommendedToolIds || []);
  const required = new Set(explicitRequired);
  const optional = new Set(explicitOptional);
  const codeLike = /ipynb|notebook|jupyter|file|json|python|script|workspace|code|코드|노트북|파일/.test(purposeText);
  if (role === 'builder' && codeLike) required.add('workspace_fs');
  if (role === 'builder') optional.add('shell');
  if ((role === 'researcher' || role === 'reviewer') && /research|review|evidence|fact|검토|조사/.test(purposeText)) optional.add('web');
  return { agent_id: clean(agent?.agent_id || agent?.id || agent?.name || role || 'agent'), agent_name: clean(agent?.name || agent?.agent_id || role || 'agent') || 'agent', role: role || 'agent', required_tools: uniqueIds([...required]), optional_tools: uniqueIds([...optional].filter((toolId) => !required.has(toolId))) };
}

export function buildTeamCapabilityContract({ team = {}, runtime = null } = {}) {
  const row = team && typeof team === 'object' ? team : {};
  const availableTools = hasRuntimeToolSignal(runtime) ? [...collectRuntimeAvailableToolIds(runtime)] : [];
  const availableSet = new Set(availableTools);
  const requirements = asArray(row?.requirements);
  const agentContracts = asArray(row?.agents).map((agent) => buildAgentContract(agent));
  const requiredTools = new Set(uniqueIds(row?.required_tool_ids || row?.requiredToolIds || []));
  const optionalTools = new Set(uniqueIds(row?.optional_tool_ids || row?.optionalToolIds || row?.recommended_tool_ids || row?.recommendedToolIds || []));
  for (const requirement of requirements) { const toolId = cleanId(requirement?.tool_id || requirement?.toolId); if (!toolId) continue; if (cleanId(requirement?.severity || 'blocking') === 'blocking') requiredTools.add(toolId); else optionalTools.add(toolId); }
  for (const contract of agentContracts) { for (const toolId of contract.required_tools) requiredTools.add(toolId); for (const toolId of contract.optional_tools) optionalTools.add(toolId); }
  for (const toolId of [...requiredTools]) optionalTools.delete(toolId);
  const missingRequired = [...requiredTools].filter((toolId) => !availableSet.has(toolId));
  const missingOptional = [...optionalTools].filter((toolId) => !availableSet.has(toolId));
  const runtimeBound = hasRuntimeToolSignal(runtime);
  return { version: 'capability_contract_v1', runtime_bound: runtimeBound, runtime_source: runtimeBound ? 'runtime' : 'template', status: !runtimeBound ? 'unbound' : missingRequired.length > 0 ? 'degraded' : missingOptional.length > 0 ? 'advisory_gap' : 'ready', required_tools: uniqueIds([...requiredTools]), optional_tools: uniqueIds([...optionalTools]), available_tools: uniqueIds(availableTools), missing_required_tools: uniqueIds(missingRequired), missing_optional_tools: uniqueIds(missingOptional), auto_installable_missing_tools: [], mismatch_count: missingRequired.length + missingOptional.length, agent_contracts: agentContracts };
}

export function summarizeCapabilityContract(contract = {}) { const row = contract && typeof contract === 'object' ? contract : {}; return { capability_status: cleanId(row.status || 'unbound') || 'unbound', required_tool_count: asArray(row.required_tools).length, optional_tool_count: asArray(row.optional_tools).length, missing_required_tool_count: asArray(row.missing_required_tools).length, missing_optional_tool_count: asArray(row.missing_optional_tools).length, missing_required_tools: uniqueIds(row.missing_required_tools || []), missing_optional_tools: uniqueIds(row.missing_optional_tools || []) }; }

export function formatTeamCapabilityContractLines(contract = {}, { maxMissing = 4 } = {}) { const row = contract && typeof contract === 'object' ? contract : {}; const lines = [`- status: ${cleanId(row.status || 'unbound') || 'unbound'}${row.runtime_bound ? '' : ' (runtime unbound)'}`, `- required tools: ${asArray(row.required_tools).join(', ') || '(none)'}`, `- optional tools: ${asArray(row.optional_tools).join(', ') || '(none)'}`]; const missingRequired = asArray(row.missing_required_tools).slice(0, Math.max(1, Number(maxMissing) || 4)); const missingOptional = asArray(row.missing_optional_tools).slice(0, Math.max(1, Number(maxMissing) || 4)); if (missingRequired.length > 0) lines.push(`- missing required: ${missingRequired.join(', ')}`); if (missingOptional.length > 0) lines.push(`- missing optional: ${missingOptional.join(', ')}`); return lines; }
