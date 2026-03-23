import { normalizeRuntimeCapabilityId, toLegacyRuntimeCapabilityId } from './participant_schema.js';

const joinKey = (...parts) => parts.join('');
const joinSnake = (...parts) => parts.join('_');
const LEGACY_TOOL_INSTALL_FIELD = joinSnake('tool', 'install', 'proposals');
const LEGACY_TOOL_INSTALL_FIELD_CAMEL = joinKey('tool', 'Install', 'Proposals');

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}


export function readLegacyToolInstallProposals(raw = {}) {
  const row = asObject(raw);
  return asArray(row[LEGACY_TOOL_INSTALL_FIELD] || row[LEGACY_TOOL_INSTALL_FIELD_CAMEL]);
}

export function applyLegacyToolInstallProposals(target = {}, rows = []) {
  const out = target && typeof target === 'object' ? target : {};
  out[LEGACY_TOOL_INSTALL_FIELD] = rows;
  return out;
}

function uniqueRows(rows = [], keyFn = (row) => JSON.stringify(row), { max = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const key = clean(keyFn(row)).toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function inferCapabilityEnableStrategy(capabilityId = '') {
  const id = cleanId(capabilityId || normalizeRuntimeCapabilityId(capabilityId));
  if (id === 'filesystem_write') return { install_target: 'runtime', strategy: 'enable_workspace_fs', auto_installable: true };
  if (id === 'filesystem_read') return { install_target: 'runtime', strategy: 'enable_read_only_fs', auto_installable: true };
  if (id === 'shell_exec') return { install_target: 'runtime', strategy: 'enable_shell_access', auto_installable: false };
  if (id === 'web_browse') return { install_target: 'runtime', strategy: 'enable_web_browse', auto_installable: false };
  return { install_target: 'runtime', strategy: 'enable_runtime_capability', auto_installable: false };
}

function inferExternalToolInstallStrategy(toolId = '') {
  const id = cleanId(toolId);
  if (/browser|search|retrieval/.test(id)) return { install_target: 'team', strategy: 'connect_search_or_retrieval_tool', auto_installable: false };
  if (/github|gitlab|jira|slack|notion|mcp/.test(id)) return { install_target: 'team', strategy: 'connect_external_tool_binding', auto_installable: false };
  return { install_target: 'runtime', strategy: 'connect_runtime_tool', auto_installable: false };
}

function normalizeCapabilityEnableProposal(raw = {}) {
  const row = asObject(raw);
  const capabilityId = cleanId(row.capability_id || row.capabilityId || normalizeRuntimeCapabilityId(row.tool_id || row.toolId || row.id || row.tool));
  if (!capabilityId) return null;
  const strategyMeta = inferCapabilityEnableStrategy(capabilityId);
  return {
    kind: 'capability_enable_proposal',
    capability_id: capabilityId,
    tool_id: cleanId(row.tool_id || row.toolId || toLegacyRuntimeCapabilityId(capabilityId)),
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    install_target: cleanId(row.install_target || row.installTarget || strategyMeta.install_target) || strategyMeta.install_target,
    strategy: cleanId(row.strategy || strategyMeta.strategy) || strategyMeta.strategy,
    auto_installable: row.auto_installable === true || row.autoInstallable === true || strategyMeta.auto_installable === true,
    approval_required: row.approval_required !== false && row.approvalRequired !== false,
    reason: clean(row.reason || row.detail || row.note || ''),
  };
}

function normalizeExternalToolInstallProposal(raw = {}) {
  const row = asObject(raw);
  const toolId = cleanId(row.external_tool_id || row.externalToolId || row.tool_id || row.toolId || row.id || row.tool);
  if (!toolId) return null;
  const strategyMeta = inferExternalToolInstallStrategy(toolId);
  return {
    kind: 'external_tool_install_proposal',
    external_tool_id: toolId,
    tool_id: toolId,
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    install_target: cleanId(row.install_target || row.installTarget || strategyMeta.install_target) || strategyMeta.install_target,
    strategy: cleanId(row.strategy || strategyMeta.strategy) || strategyMeta.strategy,
    auto_installable: row.auto_installable === true || row.autoInstallable === true || strategyMeta.auto_installable === true,
    approval_required: row.approval_required !== false && row.approvalRequired !== false,
    reason: clean(row.reason || row.detail || row.note || ''),
  };
}

function normalizeCredentialRequest(raw = {}) {
  const row = asObject(raw);
  const key = clean(row.credential_key || row.credentialKey || row.key || 'API_KEY') || 'API_KEY';
  return {
    kind: 'credential_request',
    credential_key: key,
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    delivery_method: cleanId(row.delivery_method || row.deliveryMethod || 'env_var') || 'env_var',
    prompt: clean(row.prompt || `Provide ${key} through env var or secret store.`) || `Provide ${key} through env var or secret store.`,
    approval_required: row.approval_required !== false && row.approvalRequired !== false,
    reason: clean(row.reason || row.detail || row.note || ''),
  };
}

function normalizeGeneratedSkillProposal(raw = {}) {
  const row = asObject(raw);
  const skillId = cleanId(row.skill_id || row.skillId || row.id || row.skill);
  if (!skillId) return null;
  return {
    kind: 'generated_skill_proposal',
    skill_id: skillId,
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    strategy: cleanId(row.strategy || 'generate_inline_brief') || 'generate_inline_brief',
    approval_required: row.approval_required !== false && row.approvalRequired !== false,
    prompt_brief: clean(row.prompt_brief || row.promptBrief || ''),
    reason: clean(row.reason || row.detail || row.note || ''),
  };
}

export function normalizeInstallRequirementActions(raw = {}) {
  const row = asObject(raw);
  const capability_enable_proposals = uniqueRows(
    asArray(row.capability_enable_proposals || row.capabilityEnableProposals)
      .map(normalizeCapabilityEnableProposal)
      .filter(Boolean),
    (entry) => [entry.capability_id, entry.required_by, entry.strategy].join('|'),
  );
  const external_install_proposals = uniqueRows(
    asArray(row.external_install_proposals || row.externalToolInstallProposals)
      .map(normalizeExternalToolInstallProposal)
      .filter(Boolean),
    (entry) => [entry.external_tool_id, entry.required_by, entry.strategy].join('|'),
  );
  const legacyToolInstallProposals = uniqueRows(
    readLegacyToolInstallProposals(row)
      .map((entry) => {
        const capabilityId = normalizeRuntimeCapabilityId(entry?.tool_id || entry?.toolId || entry?.id || entry?.tool);
        return capabilityId ? normalizeCapabilityEnableProposal(entry) : normalizeExternalToolInstallProposal(entry);
      })
      .filter(Boolean),
    (entry) => [entry.capability_id || entry.external_tool_id, entry.required_by, entry.strategy].join('|'),
  );
  const mergedCapabilityEnableProposals = uniqueRows([...capability_enable_proposals, ...legacyToolInstallProposals.filter((entry) => entry.capability_id)], (entry) => [entry.capability_id, entry.required_by, entry.strategy].join('|'));
  const mergedExternalToolInstallProposals = uniqueRows([...external_install_proposals, ...legacyToolInstallProposals.filter((entry) => entry.external_tool_id)], (entry) => [entry.external_tool_id, entry.required_by, entry.strategy].join('|'));
  const legacyInstallRows = uniqueRows([
    ...mergedCapabilityEnableProposals.map((entry) => ({ ...entry, kind: 'tool_install_proposal', tool_id: entry.tool_id || toLegacyRuntimeCapabilityId(entry.capability_id) })),
    ...mergedExternalToolInstallProposals.map((entry) => ({ ...entry, kind: 'tool_install_proposal', tool_id: entry.external_tool_id })),
  ], (entry) => [entry.tool_id, entry.required_by, entry.strategy].join('|'));
  const credential_requests = uniqueRows(
    asArray(row.credential_requests || row.credentialRequests).map(normalizeCredentialRequest).filter(Boolean),
    (entry) => [entry.credential_key, entry.required_by, entry.delivery_method].join('|'),
  );
  const generated_skill_proposals = uniqueRows(
    asArray(row.generated_skill_proposals || row.generatedSkillProposals).map(normalizeGeneratedSkillProposal).filter(Boolean),
    (entry) => [entry.skill_id, entry.required_by, entry.strategy].join('|'),
  );
  return applyLegacyToolInstallProposals({
    capability_enable_proposals: mergedCapabilityEnableProposals,
    external_install_proposals: mergedExternalToolInstallProposals,
    legacy_install_rows: legacyInstallRows,
    credential_requests,
    generated_skill_proposals,
    summary: {
      capability_enable_count: mergedCapabilityEnableProposals.length,
      external_tool_install_count: mergedExternalToolInstallProposals.length,
      tool_install_count: legacyInstallRows.length,
      credential_request_count: credential_requests.length,
      generated_skill_count: generated_skill_proposals.length,
    },
  }, legacyInstallRows);
}

export function buildInstallRequirementActions(requirements = {}) {
  const row = asObject(requirements);
  const capability_enable_proposals = asArray(row.capabilities).map((entry) => normalizeCapabilityEnableProposal(entry)).filter(Boolean);
  const external_install_proposals = asArray(row.external_tools).map((entry) => normalizeExternalToolInstallProposal(entry)).filter(Boolean);
  const legacyToolProposals = asArray(row.tools)
    .map((entry) => {
      const capabilityId = normalizeRuntimeCapabilityId(entry?.tool_id || entry?.toolId || entry?.id || entry?.tool);
      return capabilityId ? normalizeCapabilityEnableProposal(entry) : normalizeExternalToolInstallProposal(entry);
    })
    .filter(Boolean);
  const credential_requests = asArray(row.credentials).map((entry) => normalizeCredentialRequest(entry)).filter(Boolean);
  const generated_skill_proposals = asArray(row.skills)
    .map((entry) => normalizeGeneratedSkillProposal({
      ...entry,
      prompt_brief: clean(entry?.reason || `${clean(entry?.required_by || 'agent')} needs ${clean(entry?.skill_id || 'skill')} capability.`),
    }))
    .filter(Boolean);
  return normalizeInstallRequirementActions({
    capability_enable_proposals: [...capability_enable_proposals, ...legacyToolProposals.filter((entry) => entry.capability_id)],
    external_install_proposals: [...external_install_proposals, ...legacyToolProposals.filter((entry) => entry.external_tool_id)],
    credential_requests,
    generated_skill_proposals,
  });
}

export function formatInstallRequirementActionLines(actions = {}, { maxLines = 8 } = {}) {
  const row = normalizeInstallRequirementActions(actions);
  const lines = [
    ...row.capability_enable_proposals.map((entry) => `- capability requirement: ${entry.capability_id} · by ${entry.required_by} · ${entry.strategy}`),
    ...row.external_install_proposals.map((entry) => `- external tool requirement: ${entry.external_tool_id} · by ${entry.required_by} · ${entry.strategy}`),
    ...row.credential_requests.map((entry) => `- credential request: ${entry.credential_key} · by ${entry.required_by}`),
    ...row.generated_skill_proposals.map((entry) => `- generated skill: ${entry.skill_id} · by ${entry.required_by}`),
  ].filter(Boolean);
  return lines.slice(0, Math.max(1, Number(maxLines) || 8));
}
