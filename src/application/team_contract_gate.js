function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }

function runtimeHas(runtime = null, capability = '') {
  const target = cleanId(capability);
  const caps = asObject(runtime?.capabilities);
  if (!target) return false;
  if (caps[target] === true) return true;
  const toolIds = new Set([
    ...asArray(runtime?.availableToolIds), ...asArray(runtime?.tools), ...asArray(runtime?.enabledToolIds),
    ...asArray(caps.availableToolIds), ...asArray(caps.enabledToolIds),
  ].map(cleanId).filter(Boolean));
  if (toolIds.has(target)) return true;
  if (target === 'workspace_write') return caps.workspace_write === true || caps.filesystem_write === true || toolIds.has('filesystem_write');
  if (target === 'workspace_read') return caps.workspace_read === true || caps.filesystem_read === true || toolIds.has('filesystem_read');
  if (target === 'web_browse') return caps.web_browse === true || caps.web === true || toolIds.has('web') || toolIds.has('web_browse');
  if (target === 'shell_exec') return caps.shell_exec === true || caps.shell === true || toolIds.has('shell') || toolIds.has('shell_exec');
  return false;
}

function candidateRoles(candidate = {}) {
  return asArray(candidate.roles || candidate.role_ids || candidate.team?.agents?.map((a) => a.role)).map(cleanId).filter(Boolean);
}

function candidateAgents(candidate = {}) {
  return asArray(candidate.team?.agents || candidate.agents);
}

function hasRole(candidate = {}, role = '') {
  return candidateRoles(candidate).includes(cleanId(role));
}

function modelIsUnhealthy(agent = {}, modelNodes = []) {
  const provider = cleanId(agent.provider || '');
  const model = clean(agent.model || '');
  const id = cleanId(agent.model_node_id || agent.modelNodeId || agent.model_node || '');
  for (const node of asArray(modelNodes)) {
    const nodeId = cleanId(node?.id || node?.node_id || '');
    const nodeModel = clean(node?.model || '');
    const nodeProvider = cleanId(node?.provider || '');
    const status = clean(node?.health?.status || node?.status || (node?.enabled === false ? 'disabled' : 'ok')).toLowerCase();
    const matches = (id && nodeId === id) || (model && nodeModel === model && (!provider || !nodeProvider || nodeProvider === provider));
    if (matches && /disabled|down|error|capacity|timeout|unavailable/.test(status)) return true;
  }
  return false;
}

export function checkTeamCandidateContracts(candidate = {}, { runtime = null, stress = {}, modelNodes = [] } = {}) {
  const violations = [];
  const warnings = [];
  const repairs = [];
  const roles = candidateRoles(candidate);
  const agents = candidateAgents(candidate);
  const requires = asObject(candidate.requires);
  const artifactPressure = Number(stress.artifact_pressure || 0);
  const workspaceMutation = Number(stress.workspace_mutation || 0);
  const verificationNeed = Number(stress.verification_need || 0);
  const sideEffectRisk = Number(stress.side_effect_risk || 0);
  const currentInfoNeed = Number(stress.current_info_need || 0);

  if ((requires.workspace_write || workspaceMutation >= 0.45) && !hasRole(candidate, 'builder')) {
    violations.push('missing_builder_for_workspace_mutation');
    repairs.push('add_builder');
  }
  if ((requires.workspace_write || workspaceMutation >= 0.45) && !runtimeHas(runtime, 'workspace_write')) {
    warnings.push('runtime_workspace_write_not_advertised');
    repairs.push('use_artifact_contract_or_workspace_builder');
  }
  if ((artifactPressure >= 0.45 || requires.artifact_delivery) && !hasRole(candidate, 'builder') && !hasRole(candidate, 'synthesizer')) {
    violations.push('missing_artifact_delivery_role');
    repairs.push('add_builder_or_synthesizer');
  }
  if ((verificationNeed >= 0.55 || sideEffectRisk >= 0.45 || requires.verifier) && !hasRole(candidate, 'reviewer')) {
    violations.push('missing_reviewer_for_risky_or_artifact_task');
    repairs.push('add_reviewer');
  }
  if ((artifactPressure >= 0.45 || workspaceMutation >= 0.45) && roles.length >= 2 && !hasRole(candidate, 'synthesizer')) {
    violations.push('missing_synthesizer_for_multi_agent_delivery');
    repairs.push('add_synthesizer');
  }
  if (currentInfoNeed >= 0.65 && !hasRole(candidate, 'synthesizer')) {
    violations.push('missing_synthesizer_for_current_info_briefing');
    repairs.push('add_synthesizer');
  }
  if (currentInfoNeed >= 0.65 && !hasRole(candidate, 'researcher')) {
    warnings.push('missing_researcher_for_current_info_need');
    repairs.push('add_researcher_or_mark_current_info_out_of_scope');
  }
  if (requires.web_browse && !runtimeHas(runtime, 'web_browse')) {
    warnings.push('web_browse_not_available');
    repairs.push('downgrade_web_browse_to_optional_or_request_context');
  }
  if (requires.shell_exec && !runtimeHas(runtime, 'shell_exec')) {
    warnings.push('shell_exec_not_available');
    repairs.push('use_workspace_patch_without_shell_or_request_permission');
  }
  if (agents.some((agent) => modelIsUnhealthy(agent, modelNodes))) {
    violations.push('unhealthy_model_node_selected');
    repairs.push('choose_healthy_model_node');
  }
  const executable = violations.length === 0;
  return {
    executable,
    ready: executable,
    violations,
    warnings: [...new Set(warnings)],
    repair_hints: [...new Set(repairs)],
    blocking_reason_codes: violations,
    degrade_reason_codes: [...new Set(warnings)],
  };
}

export function summarizeCandidateGate(gate = {}) {
  const row = asObject(gate);
  if (row.executable === true) {
    const warnings = asArray(row.warnings || row.degrade_reason_codes).slice(0, 2);
    return warnings.length ? `executable · warnings: ${warnings.join(', ')}` : 'executable';
  }
  const violations = asArray(row.violations || row.blocking_reason_codes).slice(0, 3);
  return `blocked: ${violations.join(', ') || 'contract violation'}`;
}
