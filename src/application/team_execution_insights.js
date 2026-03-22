import { roleLabel, resolveAgencyOverlayMeta } from './team_presentation.js';
import { resolveActionAgentNameHint } from '../shared/agent_labels.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function clip(value = '', max = 160) {
  const text = clean(value).replace(/\s+/g, ' ');
  if (!text) return '';
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

export function flattenExecutableAgentActions(actions = [], out = []) {
  for (const raw of asArray(actions)) {
    const action = asObject(raw);
    const type = cleanLower(action.type);
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      flattenExecutableAgentActions(action.agents, out);
      continue;
    }
    if (!['run_agent', 'agent_run', 'synthesize_final'].includes(type)) continue;
    out.push(action);
  }
  return out;
}

function resolveActionAgentId(action = {}) {
  return cleanLower(action.agent_id || action.agentId || action.agent || action.id);
}

function resolveActionRoleId(action = {}) {
  const inputs = asObject(action.inputs);
  const explicit = cleanLower(inputs.role_id || inputs.roleId || inputs.role_label || inputs.roleLabel || action.role_id || action.roleId || action.role || '');
  if (explicit) return explicit;
  if (cleanLower(action.type) === 'synthesize_final') return 'synthesizer';
  return '';
}

function resolveActionLabel(action = {}) {
  const inputs = asObject(action.inputs);
  return clean(inputs.display_label || inputs.displayLabel || inputs.agent_name || inputs.agentName || action.display_label || action.displayLabel || resolveActionAgentNameHint(action) || action.agent_name || action.agentName || action.agent_id || action.agent || action.id || 'Agent') || 'Agent';
}

function findReasonSummary(summary = {}, keys = []) {
  const row = summary && typeof summary === 'object' ? summary : {};
  for (const key of keys) {
    const value = clean(row[key]);
    if (value) return value;
  }
  return '';
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const next = clean(value);
    if (!next || seen.has(next)) continue;
    seen.add(next);
    out.push(next);
  }
  return out;
}

export function summarizeSelectionInsights({ runtimeTeamSnapshot = null, actions = [] } = {}) {
  const snapshot = runtimeTeamSnapshot && typeof runtimeTeamSnapshot === 'object' ? runtimeTeamSnapshot : {};
  const task = snapshot.task_interpretation && typeof snapshot.task_interpretation === 'object'
    ? snapshot.task_interpretation
    : {};
  const runtimeAgents = asArray(snapshot.runtime_agents);
  const selectionExplanations = asArray(snapshot.selection_explanations);
  const selectionReasonSummary = snapshot.selection_reason_summary && typeof snapshot.selection_reason_summary === 'object'
    ? snapshot.selection_reason_summary
    : {};
  const actionRows = flattenExecutableAgentActions(actions);
  const actionAgentIds = new Set(actionRows.map((row) => resolveActionAgentId(row)).filter(Boolean));

  const selected = [];
  const selectedSeen = new Set();
  for (const agent of runtimeAgents) {
    const roleId = cleanLower(agent.role_id || agent.role || agent.role_label);
    const label = clean(agent.display_label || agent.name || agent.agent_name || agent.agent_id || agent.template_id || roleId || 'Agent');
    const reason = clean(agent.selection_reason)
      || findReasonSummary(selectionReasonSummary, [clean(agent.template_id), clean(agent.slot_id), clean(agent.instance_id), roleId, clean(agent.role_label)]);
    const activeMarker = actionAgentIds.has(cleanLower(agent.template_id || agent.agent_id || roleId)) || actionAgentIds.has(cleanLower(agent.instance_id || '')) ? ' · active' : '';
    const line = `${label}${roleId ? `(${roleLabel(roleId)})` : ''}${reason ? ` · ${clip(reason, 140)}` : ''}${activeMarker}`;
    const key = `${label}|${roleId}|${reason}`;
    if (!selectedSeen.has(key)) {
      selectedSeen.add(key);
      selected.push(line);
    }
  }
  for (const row of selectionExplanations) {
    const subject = clean(row.subject_id || row.subjectId || 'team_plan');
    const reason = clip(row.reason || row.selection_reason || row.selectionReason, 160);
    if (!reason) continue;
    if (subject === 'team_plan' || subject === 'interaction_spec' || subject === 'supervisor_runtime') {
      const line = `${subject}: ${reason}`;
      if (!selectedSeen.has(line)) {
        selectedSeen.add(line);
        selected.push(line);
      }
    }
  }

  const suppressed = [];
  const suppressedRoles = uniqueStrings(task.suppressed_role_ids || task.suppressedRoleIds || []);
  for (const roleId of suppressedRoles) {
    suppressed.push(`${roleLabel(roleId)} · task_interpretation suppressed_role_ids`);
  }
  const preferredRoles = uniqueStrings(task.preferred_role_ids || task.preferredRoleIds || []);
  const selectedRoles = new Set(runtimeAgents.map((row) => cleanLower(row.role_id || row.role || row.role_label)).filter(Boolean));
  for (const roleId of preferredRoles) {
    if (!selectedRoles.has(cleanLower(roleId))) {
      suppressed.push(`${roleLabel(roleId)} · preferred_role requested but not present in runtime team`);
    }
  }

  const plannerFacts = [];
  if (clean(task.task_type)) plannerFacts.push(`task_type=${clean(task.task_type)}`);
  if (clean(task.deliverable_type)) plannerFacts.push(`deliverable=${clean(task.deliverable_type)}`);
  if (clean(task.parallelism_preference)) plannerFacts.push(`parallelism=${clean(task.parallelism_preference)}`);
  if (clean(task.review_policy)) plannerFacts.push(`review_policy=${clean(task.review_policy)}`);
  const pattern = clean(snapshot.blueprint_summary?.execution_pattern || snapshot.execution_graph?.pattern || snapshot.team_plan?.interaction_spec?.execution_pattern || '');
  if (pattern) plannerFacts.push(`pattern=${pattern}`);

  return {
    selected: selected.slice(0, 8),
    suppressed: suppressed.slice(0, 6),
    planner_facts: plannerFacts,
  };
}

export function summarizeExecutionParticipation({ actions = [], outputs = [], recentTurns = [], currentJobId = '' } = {}) {
  const plannedRows = flattenExecutableAgentActions(actions).map((action) => ({
    agent_id: resolveActionAgentId(action),
    role_id: resolveActionRoleId(action),
    label: resolveActionLabel(action),
    type: cleanLower(action.type),
  })).filter((row) => row.agent_id || row.role_id || row.label);

  const plannedByAgent = new Map();
  for (const row of plannedRows) {
    const key = row.agent_id || `${row.role_id}:${row.label}`;
    const current = plannedByAgent.get(key) || { ...row, action_count: 0 };
    current.action_count += 1;
    plannedByAgent.set(key, current);
  }

  const observedByAgent = new Map();
  for (const raw of asArray(outputs)) {
    const row = asObject(raw);
    if (currentJobId && clean(row.jobId) && clean(row.jobId) !== clean(currentJobId)) continue;
    const key = cleanLower(row.agentId || row.agent_id || row.agent);
    if (!key) continue;
    const planned = plannedByAgent.get(key);
    observedByAgent.set(key, {
      agent_id: key,
      role_id: planned?.role_id || '',
      label: planned?.label || clean(row.agentName || row.agent_name || key) || key,
    });
  }
  for (const raw of asArray(recentTurns)) {
    const row = asObject(raw);
    if (currentJobId && clean(row.job_id) && clean(row.job_id) !== clean(currentJobId)) continue;
    const key = cleanLower(row.agent_id || row.agentId);
    if (!key || observedByAgent.has(key)) continue;
    const planned = plannedByAgent.get(key);
    observedByAgent.set(key, {
      agent_id: key,
      role_id: cleanLower(row.role) || planned?.role_id || '',
      label: clean(row.agent_name || row.agentName || planned?.label || key) || key,
    });
  }

  const plannedRoleCounts = {};
  for (const row of plannedByAgent.values()) {
    const key = row.role_id || row.agent_id || 'agent';
    plannedRoleCounts[key] = Number(plannedRoleCounts[key] || 0) + 1;
  }
  const observedRoleCounts = {};
  for (const row of observedByAgent.values()) {
    const key = row.role_id || plannedByAgent.get(row.agent_id)?.role_id || row.agent_id || 'agent';
    observedRoleCounts[key] = Number(observedRoleCounts[key] || 0) + 1;
  }

  const missing = [];
  for (const [key, row] of plannedByAgent.entries()) {
    if (!observedByAgent.has(key)) missing.push(row.label || row.agent_id || key);
  }
  const extra = [];
  for (const [key, row] of observedByAgent.entries()) {
    if (!plannedByAgent.has(key)) extra.push(row.label || row.agent_id || key);
  }

  const participationByRole = [];
  const allRoles = uniqueStrings([...Object.keys(plannedRoleCounts), ...Object.keys(observedRoleCounts)]);
  for (const roleId of allRoles) {
    const plannedCount = Number(plannedRoleCounts[roleId] || 0);
    const observedCount = Number(observedRoleCounts[roleId] || 0);
    participationByRole.push(`${roleLabel(roleId)} ${observedCount}/${plannedCount || observedCount || 0}`);
  }

  const participationPct = plannedByAgent.size > 0
    ? Math.round((observedByAgent.size / plannedByAgent.size) * 1000) / 10
    : (observedByAgent.size > 0 ? 100 : 0);

  return {
    planned_agent_count: plannedByAgent.size,
    observed_agent_count: observedByAgent.size,
    participation_pct: participationPct,
    planned_agents: Array.from(plannedByAgent.values()).map((row) => row.label || row.agent_id).slice(0, 12),
    observed_agents: Array.from(observedByAgent.values()).map((row) => row.label || row.agent_id).slice(0, 12),
    missing_agents: missing.slice(0, 12),
    extra_agents: extra.slice(0, 12),
    participation_by_role: participationByRole.slice(0, 8),
  };
}


function summarizeRuntimeOverlays(runtimeTeamSnapshot = null) {
  const rows = asArray(runtimeTeamSnapshot?.runtime_agents || runtimeTeamSnapshot?.runtimeAgents);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const meta = resolveAgencyOverlayMeta(row);
    const overlayId = cleanLower(meta.overlay_id);
    const title = clean(meta.title);
    const key = `${overlayId}|${title}`;
    if ((!overlayId && !title) || seen.has(key)) continue;
    seen.add(key);
    out.push(title || overlayId);
  }
  return out.slice(0, 8);
}

export function buildExecutionInsightSnapshot({ runtimeTeamSnapshot = null, actions = [], outputs = [], recentTurns = [], currentJobId = '' } = {}) {
  return {
    execution_pattern: clean(runtimeTeamSnapshot?.blueprint_summary?.execution_pattern || runtimeTeamSnapshot?.execution_graph?.pattern || runtimeTeamSnapshot?.team_plan?.interaction_spec?.execution_pattern || ''),
    selection: summarizeSelectionInsights({ runtimeTeamSnapshot, actions }),
    execution: summarizeExecutionParticipation({ actions, outputs, recentTurns, currentJobId }),
    overlays: summarizeRuntimeOverlays(runtimeTeamSnapshot),
  };
}
