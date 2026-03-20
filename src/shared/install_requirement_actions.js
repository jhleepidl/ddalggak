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

function inferToolInstallStrategy(toolId = '') {
  const id = cleanId(toolId);
  if (!id) return { install_target: 'runtime', strategy: 'connect_runtime_tool', auto_installable: false };
  if (/workspace_fs|write_file|create_file|save_file|ipynb/.test(id)) {
    return { install_target: 'runtime', strategy: 'enable_workspace_fs', auto_installable: true };
  }
  if (/web|browser|search/.test(id)) {
    return { install_target: 'team', strategy: 'add_search_capable_agent', auto_installable: false };
  }
  if (/shell|bash|terminal/.test(id)) {
    return { install_target: 'runtime', strategy: 'enable_shell_access', auto_installable: false };
  }
  return { install_target: 'runtime', strategy: 'connect_runtime_tool', auto_installable: false };
}

function normalizeToolInstallProposal(raw = {}) {
  const row = asObject(raw);
  const toolId = cleanId(row.tool_id || row.toolId || row.id || row.tool);
  if (!toolId) return null;
  const strategyMeta = inferToolInstallStrategy(toolId);
  return {
    kind: 'tool_install_proposal',
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
  const tool_install_proposals = uniqueRows(
    asArray(row.tool_install_proposals || row.toolInstallProposals)
      .map(normalizeToolInstallProposal)
      .filter(Boolean),
    (entry) => [entry.tool_id, entry.required_by, entry.strategy].join('|'),
  );
  const credential_requests = uniqueRows(
    asArray(row.credential_requests || row.credentialRequests)
      .map(normalizeCredentialRequest)
      .filter(Boolean),
    (entry) => [entry.credential_key, entry.required_by, entry.delivery_method].join('|'),
  );
  const generated_skill_proposals = uniqueRows(
    asArray(row.generated_skill_proposals || row.generatedSkillProposals)
      .map(normalizeGeneratedSkillProposal)
      .filter(Boolean),
    (entry) => [entry.skill_id, entry.required_by, entry.strategy].join('|'),
  );
  return {
    tool_install_proposals,
    credential_requests,
    generated_skill_proposals,
    summary: {
      tool_install_count: tool_install_proposals.length,
      credential_request_count: credential_requests.length,
      generated_skill_count: generated_skill_proposals.length,
    },
  };
}

export function buildInstallRequirementActions(requirements = {}) {
  const row = asObject(requirements);
  const tool_install_proposals = asArray(row.tools)
    .map((entry) => normalizeToolInstallProposal(entry))
    .filter(Boolean);
  const credential_requests = asArray(row.credentials)
    .map((entry) => normalizeCredentialRequest(entry))
    .filter(Boolean);
  const generated_skill_proposals = asArray(row.skills)
    .map((entry) => normalizeGeneratedSkillProposal({
      ...entry,
      prompt_brief: clean(entry?.reason || `${clean(entry?.required_by || 'agent')} needs ${clean(entry?.skill_id || 'skill')} capability.`),
    }))
    .filter(Boolean);
  return normalizeInstallRequirementActions({
    tool_install_proposals,
    credential_requests,
    generated_skill_proposals,
  });
}

export function formatInstallRequirementActionLines(actions = {}, { maxLines = 8 } = {}) {
  const row = normalizeInstallRequirementActions(actions);
  const lines = [
    ...row.tool_install_proposals.map((entry) => `- tool install: ${entry.tool_id} · by ${entry.required_by} · ${entry.strategy}`),
    ...row.credential_requests.map((entry) => `- credential request: ${entry.credential_key} · by ${entry.required_by}`),
    ...row.generated_skill_proposals.map((entry) => `- generated skill: ${entry.skill_id} · by ${entry.required_by}`),
  ].filter(Boolean);
  return lines.slice(0, Math.max(1, Number(maxLines) || 8));
}
