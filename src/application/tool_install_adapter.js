import { normalizeInstallRequirementActions } from '../shared/install_requirement_actions.js';
import { normalizeParticipantExecutionSchema, normalizeRuntimeCapabilityId } from '../shared/participant_schema.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

function cloneJson(value = null) {
  return JSON.parse(JSON.stringify(value && typeof value === 'object' ? value : {}));
}

function normalizeChecklist(promptBrief = '', reason = '') {
  const seed = [clean(promptBrief), clean(reason)].filter(Boolean).join(' ');
  if (!seed) return ['Deliver the missing capability safely.', 'Record assumptions and limits.'];
  return [seed.slice(0, 140), 'Record assumptions and execution limits.'];
}

function targetAgentIndexes(team = {}, requiredBy = '') {
  const name = cleanId(requiredBy);
  const indexes = [];
  for (const [idx, agent] of asArray(team?.agents).entries()) {
    const matches = [agent?.agent_id, agent?.name, agent?.id].some((value) => cleanId(value) === name);
    if (name && matches) indexes.push(idx);
  }
  if (indexes.length > 0) return indexes;
  for (const [idx, agent] of asArray(team?.agents).entries()) {
    if (cleanId(agent?.role) === 'builder') indexes.push(idx);
  }
  return indexes.length > 0 ? indexes : (asArray(team?.agents).length > 0 ? [0] : []);
}

function addUnique(list = [], value = '') {
  const out = [];
  const seen = new Set();
  for (const item of [...asArray(list), value]) {
    const key = cleanId(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function applyToolExpectation(agent = {}, toolId = '', severity = 'blocking') {
  const cleanToolId = cleanId(toolId);
  const execution = normalizeParticipantExecutionSchema(agent);
  const capabilityId = normalizeRuntimeCapabilityId(cleanToolId);
  if (cleanId(severity || 'blocking') === 'blocking') {
    if (capabilityId) {
      execution.runtime_capabilities_required = addUnique(execution.runtime_capabilities_required || [], capabilityId);
      execution.runtime_capabilities_optional = asArray(execution.runtime_capabilities_optional || []).filter((entry) => cleanId(entry) !== capabilityId);
    } else {
      execution.external_tool_requirements = addUnique(execution.external_tool_requirements || [], cleanToolId);
      execution.external_tool_preferences = asArray(execution.external_tool_preferences || []).filter((entry) => cleanId(entry) !== cleanToolId);
    }
  } else if (capabilityId) {
    execution.runtime_capabilities_optional = addUnique(execution.runtime_capabilities_optional || [], capabilityId).filter((entry) => cleanId(entry));
  } else {
    execution.external_tool_preferences = addUnique(execution.external_tool_preferences || [], cleanToolId).filter((entry) => cleanId(entry));
  }
  Object.assign(agent, normalizeParticipantExecutionSchema(execution));
  return agent;
}

export function applyInstallProposalActionsToTeam(team = {}, proposal = {}) {
  const nextTeam = cloneJson(team);
  nextTeam.agents = asArray(nextTeam.agents);
  const actions = normalizeInstallRequirementActions(proposal?.actions || {});
  const appliedActions = [];

  for (const entry of actions.tool_install_proposals) {
    for (const index of targetAgentIndexes(nextTeam, entry.required_by)) {
      const agent = nextTeam.agents[index] || {};
      nextTeam.agents[index] = applyToolExpectation(agent, entry.tool_id, entry.severity);
    }
    appliedActions.push({ kind: 'tool_requirement', tool_id: entry.tool_id, required_by: entry.required_by, severity: entry.severity, strategy: entry.strategy });
  }

  for (const entry of actions.generated_skill_proposals) {
    for (const index of targetAgentIndexes(nextTeam, entry.required_by)) {
      const agent = nextTeam.agents[index] || {};
      const briefs = asArray(agent.generated_skill_briefs || agent.generatedSkillBriefs);
      const exists = briefs.some((row) => cleanId(row?.label) === cleanId(entry.skill_id) || cleanId(row?.goal).includes(cleanId(entry.skill_id)));
      if (!exists) {
        briefs.push({
          label: clean(entry.skill_id) || 'generated_skill',
          goal: clean(entry.prompt_brief || entry.reason || `${entry.required_by} needs ${entry.skill_id}`) || `${entry.required_by} needs ${entry.skill_id}`,
          checklist: normalizeChecklist(entry.prompt_brief, entry.reason),
        });
      }
      agent.generated_skill_briefs = briefs;
      nextTeam.agents[index] = agent;
    }
    appliedActions.push({ kind: 'generated_skill', skill_id: entry.skill_id, required_by: entry.required_by, strategy: entry.strategy });
  }

  if (appliedActions.length > 0) {
    nextTeam.install_resolution = {
      applied_actions: appliedActions,
      updated_at: new Date().toISOString(),
    };
  }

  return {
    team: nextTeam,
    applied_actions: appliedActions,
  };
}

export function autoInstallRuntimeSupport({ proposal = {}, jobs = null, jobId = '' } = {}) {
  const actions = normalizeInstallRequirementActions(proposal?.actions || {});
  const applied = [];
  for (const entry of actions.tool_install_proposals) {
    if (entry.strategy === 'enable_workspace_fs' && entry.auto_installable === true && jobs && typeof jobs.ensureWorkspacePath === 'function' && clean(jobId)) {
      jobs.ensureWorkspacePath(jobId, '.', { asDirectory: true });
      applied.push({ kind: 'runtime_tool', tool_id: entry.tool_id, strategy: entry.strategy });
    }
  }
  return applied;
}
