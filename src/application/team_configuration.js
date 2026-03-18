import { loadAgents } from '../agents.js';
import { recommendTeamForTask } from './telegram_route_planning.js';
import { inferProviderForModel, listSupportedModels, resolveSupportedModel } from '../catalog/model_catalog.js';
import {
  buildDefaultInteractionSpec,
  buildAgentLocalInteractionContract,
  buildInteractionSummaryLines,
  normalizeInteractionSpec,
  parseNaturalLanguageInteractionPatch,
  validateInteractionSpec,
} from '../domain/interaction_spec.js';

function asArray(v){return Array.isArray(v)?v:[]}
function asObject(v){return v&&typeof v==='object'?v:{}}
function clean(v=''){return String(v||'').trim()}
function cleanId(v=''){return clean(v).toLowerCase()}
function nowIso(){return new Date().toISOString();}

function normalizeStoredTeamEnvelope(raw = {}) {
  const row = asObject(raw);
  const active = row.active_team && typeof row.active_team === 'object' && Object.keys(row.active_team).length > 0 ? row.active_team : null;
  const pending = row.pending_team && typeof row.pending_team === 'object' && Object.keys(row.pending_team).length > 0 ? row.pending_team : null;
  return {
    status: cleanId(row.status || (active ? 'active' : (pending ? 'suggested' : 'none'))) || 'none',
    active_team: active,
    pending_team: pending,
    updated_at: clean(row.updated_at || nowIso()),
  };
}

function buildFallbackRuntime() {
  const registry = loadAgents();
  const catalog = asArray(registry?.agents).map((row) => ({
    id: cleanId(row?.id || row?.agent_id || row?.agentId),
    name: clean(row?.name),
    provider: cleanId(row?.provider || inferProviderForModel(row?.model || '') || 'gemini'),
    model: clean(row?.model || ''),
    role: cleanId(row?.role || row?.system_key || row?.id),
    tools: asArray(row?.tools),
    skills: asArray(row?.skills).map((entry) => cleanId(entry?.id || entry)),
  })).filter((row) => row.id);
  return { agentsCatalog: catalog, agents: catalog, enabledAgentIds: catalog.map((row) => row.id) };
}

function teamStoreTarget(runtime = null) {
  if (!runtime || typeof runtime !== 'object') return {};
  const threadId = clean(runtime?.map?.threadId || runtime?.threadId || '');
  const jobId = clean(runtime?.jobId || runtime?.currentJobId || '');
  return threadId ? { threadId } : (jobId ? { jobId } : {});
}

function runtimeCatalog(runtime = null) {
  const base = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  return [...asArray(base?.agentsCatalog), ...asArray(base?.agents), ...asArray(buildFallbackRuntime().agentsCatalog)]
    .map((row) => ({
      ...row,
      id: cleanId(row?.id || row?.agent_id || row?.agentId),
      name: clean(row?.name),
      provider: cleanId(row?.provider || inferProviderForModel(row?.model || '') || ''),
      model: clean(row?.model || ''),
      role: cleanId(row?.role || row?.system_key || row?.role_id || row?.id),
      skills: asArray(row?.skills).map((entry) => cleanId(entry?.id || entry)).filter(Boolean),
    }))
    .filter((row) => row.id);
}

function findCatalogAgent(runtime = {}, agentId = '') {
  const key = cleanId(agentId);
  const rows = runtimeCatalog(runtime);
  return rows.find((row) => row.id === key) || null;
}

export function getSessionTeamState(sessionStore, chatId) {
  const session = sessionStore?.get ? sessionStore.get(chatId) : {};
  return normalizeStoredTeamEnvelope(asObject(session?.team_config));
}

function saveSessionTeamState(sessionStore, chatId, state = {}) {
  if (!sessionStore?.upsert) return;
  const normalized = normalizeStoredTeamEnvelope(state);
  sessionStore.upsert(chatId, (session) => ({
    ...session,
    team_config: {
      status: normalized.status,
      active_team: normalized.active_team,
      pending_team: normalized.pending_team,
      updated_at: nowIso(),
    },
  }));
}

export async function hydrateSessionTeamStateFromConversationStore({ sessionStore = null, chatId = '', runtime = null } = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  if (current.active_team || current.pending_team) return current;
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore.getTeamConfig !== 'function') return current;
  const target = teamStoreTarget(runtime);
  if (!target.threadId && !target.jobId) return current;
  try {
    const persisted = normalizeStoredTeamEnvelope(await teamStore.getTeamConfig(target));
    if (!persisted.active_team && !persisted.pending_team) return current;
    saveSessionTeamState(sessionStore, chatId, persisted);
    return getSessionTeamState(sessionStore, chatId);
  } catch {
    return current;
  }
}

async function clearConversationStoreTeamConfiguration(runtime = null) {
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore.setTeamConfig !== 'function') return { ok: false, reason: 'team_store_unavailable' };
  const target = teamStoreTarget(runtime);
  if (!target.threadId && !target.jobId) return { ok: false, reason: 'missing_target' };
  await teamStore.setTeamConfig({ ...target, teamConfig: { status: 'none', active_team: null, pending_team: null, updated_at: nowIso() } });
  return { ok: true };
}

export function buildTeamConfigurationTemplate(team = {}) {
  const row = team && typeof team === 'object' ? team : {};
  return JSON.stringify({
    team_name: clean(row.team_name || row.teamName || 'team_config'),
    mode: cleanId(row.mode || 'scoped_context') || 'scoped_context',
    lock_after_apply: row.lock_after_apply !== false,
    agents: asArray(row.agents).map((agent) => ({
      agent_id: cleanId(agent.agent_id || agent.agentId || agent.id),
      name: clean(agent.name || agent.display_name),
      role: cleanId(agent.role || agent.role_id || agent.roleId),
      model: clean(agent.model),
      purpose: clean(agent.purpose),
      skills: asArray(agent.skills).map((entry) => cleanId(entry)),
    })),
    interaction_spec: normalizeInteractionSpec(row.interaction_spec || row.interactions || {}),
  }, null, 2);
}

function normalizeTeamConfig(raw = {}, { runtime = null } = {}) {
  const row = asObject(raw);
  const agents = asArray(row.agents).map((entry) => {
    const agentId = cleanId(entry.agent_id || entry.agentId || entry.id);
    if (!agentId) return null;
    const runtimeAgent = findCatalogAgent(runtime || {}, agentId) || {};
    const model = resolveSupportedModel(entry.model || runtimeAgent.model || '');
    return {
      agent_id: agentId,
      name: clean(entry.name || runtimeAgent.name || agentId),
      role: cleanId(entry.role || entry.role_id || runtimeAgent.role || runtimeAgent.system_key || agentId),
      model: model || '',
      purpose: clean(entry.purpose || runtimeAgent.description || ''),
      skills: asArray(entry.skills).map((skill) => cleanId(skill)).filter(Boolean),
      provider: cleanId(entry.provider || runtimeAgent.provider || inferProviderForModel(model) || ''),
      source_agent: runtimeAgent,
    };
  }).filter(Boolean);
  const interactionSpec = validateInteractionSpec(
    row.interaction_spec || row.interactions || buildDefaultInteractionSpec(agents, { task: clean(row.task || '') }),
    { agentRoster: agents.map((agent) => ({ name: agent.name })) }
  );
  return {
    team_name: clean(row.team_name || row.teamName || 'configured_team'),
    mode: cleanId(row.mode || 'scoped_context') || 'scoped_context',
    lock_after_apply: row.lock_after_apply !== false,
    agents,
    interaction_spec: interactionSpec,
    interaction_notes: buildInteractionSummaryLines(interactionSpec),
    status: cleanId(row.status || 'draft') || 'draft',
    created_at: clean(row.created_at || nowIso()),
    updated_at: nowIso(),
  };
}

function defaultModelForRole(role = '', provider = '') {
  const roleId = cleanId(role);
  const providerId = cleanId(provider);
  if ((providerId === 'openai' || providerId === 'codex') && roleId === 'builder') return 'gpt-5-codex';
  if (roleId === 'builder') return 'gpt-5-codex';
  if (roleId === 'reviewer' || roleId === 'synthesizer') return 'gpt-5.4';
  return 'gemini-2.5-pro';
}

function defaultAgentsFromCatalog(runtime = {}, taskText = '') {
  const rows = runtimeCatalog(runtime).slice(0, 4);
  const picked = rows.map((row) => ({
    agent_id: cleanId(row.id || row.agent_id),
    name: clean(row.name || row.id),
    role: cleanId(row.role || row.system_key || row.id),
    model: resolveSupportedModel(row.model || '') || defaultModelForRole(row.role, row.provider),
    purpose: clean(taskText),
    skills: asArray(row.skills).map((skill) => cleanId(skill?.id || skill)),
    provider: cleanId(row.provider || inferProviderForModel(row.model || '') || ''),
  })).filter((row) => row.agent_id);
  if (picked.length > 0) return picked;
  return [{ agent_id: 'researcher', name: 'Researcher', role: 'researcher', model: 'gemini-2.5-pro', purpose: clean(taskText), skills: [], provider: 'gemini' }];
}

export function suggestTeamConfiguration({ taskText = '', runtime = null } = {}) {
  const effectiveRuntime = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  const recommendation = recommendTeamForTask(taskText, effectiveRuntime);
  const selected = asArray(recommendation?.selected_existing_agents).map((entry) => {
    const runtimeAgent = findCatalogAgent(effectiveRuntime, entry.agent_id) || {};
    return {
      agent_id: cleanId(entry.agent_id),
      name: clean(entry.name || runtimeAgent.name || entry.role || entry.agent_id),
      role: cleanId(entry.role || runtimeAgent.role || runtimeAgent.system_key || 'researcher'),
      model: resolveSupportedModel(runtimeAgent.model || '') || defaultModelForRole(entry.role, runtimeAgent.provider),
      purpose: clean(entry.why || ''),
      skills: asArray(runtimeAgent.skills).map((skill) => cleanId(skill?.id || skill)),
      provider: cleanId(runtimeAgent.provider || inferProviderForModel(runtimeAgent.model || '') || ''),
    };
  });
  const agents = selected.length > 0 ? selected : defaultAgentsFromCatalog(effectiveRuntime, taskText);
  const interactionSpec = buildDefaultInteractionSpec(agents, { task: taskText });
  return normalizeTeamConfig({
    team_name: clean(taskText).slice(0, 36).replace(/\s+/g, '_') || 'team_config',
    mode: 'scoped_context',
    lock_after_apply: true,
    agents,
    interaction_spec: interactionSpec,
    status: 'suggested',
    task: taskText,
  }, { runtime: effectiveRuntime });
}

export function refineTeamConfiguration(team = {}, instruction = '', { runtime = null } = {}) {
  const current = normalizeTeamConfig(team, { runtime: runtime || { agentsCatalog: asArray(team?.agents).map((agent) => ({ id: agent.agent_id, name: agent.name, role: agent.role, model: agent.model, provider: agent.provider, skills: agent.skills })) } });
  const next = { ...current, agents: [...current.agents] };
  const text = clean(instruction);
  if (/builder\s+추가|builder\s+add/i.test(text)) {
    const existingIds = new Set(next.agents.map((agent) => cleanId(agent.agent_id)));
    const builderCandidate = runtimeCatalog(runtime).find((agent) => agent.role === 'builder' && !existingIds.has(agent.id));
    if (builderCandidate) {
      next.agents.push({
        agent_id: builderCandidate.id,
        name: builderCandidate.name || 'Builder',
        role: builderCandidate.role || 'builder',
        model: resolveSupportedModel(builderCandidate.model || '') || defaultModelForRole('builder', builderCandidate.provider),
        purpose: 'Implement changes',
        skills: builderCandidate.skills || [],
        provider: cleanId(builderCandidate.provider || inferProviderForModel(builderCandidate.model || '') || 'codex'),
      });
    } else {
      next.agents.push({
        agent_id: `builder_custom_${next.agents.filter((agent) => cleanId(agent.role) === 'builder').length + 1}`,
        name: 'Builder',
        role: 'builder',
        model: 'gpt-5-codex',
        purpose: 'Implement changes',
        skills: [],
        provider: 'codex',
      });
    }
  }
  next.interaction_spec = parseNaturalLanguageInteractionPatch(text, { current: current.interaction_spec, agentRoster: current.agents.map((agent) => ({ name: agent.name })) });
  next.interaction_notes = buildInteractionSummaryLines(next.interaction_spec);
  next.status = 'suggested';
  next.updated_at = nowIso();
  return next;
}

export function parseTeamTemplate(raw = '') {
  const text = clean(raw);
  if (!text) throw new Error('template is empty');
  try { return JSON.parse(text); } catch (error) { throw new Error(`template parse failed: ${String(error?.message || error)}`); }
}

export function validateTeamConfiguration(raw = {}, { runtime = null } = {}) {
  const team = normalizeTeamConfig(raw, { runtime });
  if (team.agents.length === 0) throw new Error('team must include at least one agent');
  const seenIds = new Set();
  const seenNames = new Set();
  for (const agent of team.agents) {
    if (!agent.model) throw new Error(`unsupported or missing model for ${agent.name}`);
    agent.provider = cleanId(agent.provider || inferProviderForModel(agent.model) || '');
    if (!agent.provider) throw new Error(`unsupported provider for ${agent.name}`);
    const agentId = cleanId(agent.agent_id);
    if (!agentId) throw new Error('agent_id is required');
    if (seenIds.has(agentId)) throw new Error(`duplicate agent_id: ${agent.agent_id}`);
    seenIds.add(agentId);
    const agentName = clean(agent.name);
    if (!agentName) throw new Error(`agent name is required for ${agent.agent_id}`);
    const agentNameKey = agentName.toLowerCase();
    if (seenNames.has(agentNameKey)) throw new Error(`duplicate agent name: ${agent.name}`);
    seenNames.add(agentNameKey);
  }
  validateInteractionSpec(team.interaction_spec, { agentRoster: team.agents.map((agent) => ({ name: agent.name })) });
  return team;
}

export async function syncTeamConfigurationToConversationStore({ runtime = null, teamConfig = null, source = 'team_apply' } = {}) {
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore !== 'object' || !teamConfig) return { ok: false, reason: 'team_store_unavailable' };
  const normalizedTeam = validateTeamConfiguration(teamConfig, { runtime });
  const target = runtime?.map?.threadId ? { threadId: runtime.map.threadId, source } : { jobId: runtime?.jobId, source };
  const desiredRows = asArray(normalizedTeam.agents).map((agent, index) => ({
    agent_id: agent.agent_id,
    enabled: true,
    order_index: index,
    overrides_json: {
      configured_model: agent.model,
      configured_role: agent.role,
      configured_provider: cleanId(agent.provider || inferProviderForModel(agent.model) || ''),
      local_interaction_contract: buildAgentLocalInteractionContract(normalizedTeam.interaction_spec, agent.name),
    },
  }));
  const desiredIds = new Set(desiredRows.map((row) => cleanId(row.agent_id)));
  let existingRows = [];
  if (typeof teamStore.listAgents === 'function') {
    try {
      const listed = await teamStore.listAgents(target);
      existingRows = asArray(listed?.rows || listed || []).map((row) => ({
        agent_id: cleanId(row?.agent_id || row?.agentId || row?.id),
        enabled: row?.enabled !== false,
        order_index: Number.isFinite(Number(row?.order_index ?? row?.orderIndex ?? row?.order))
          ? Math.max(0, Math.floor(Number(row?.order_index ?? row?.orderIndex ?? row?.order)))
          : null,
        overrides_json: asObject(row?.overrides_json ?? row?.overridesJson ?? row?.overrides),
      })).filter((row) => row.agent_id);
    } catch {}
  }
  for (const existing of existingRows) {
    if (!desiredIds.has(existing.agent_id) && typeof teamStore.removeAgent === 'function') {
      await teamStore.removeAgent({ ...target, agentId: existing.agent_id }).catch(() => null);
    }
  }
  const existingMap = new Map(existingRows.map((row) => [row.agent_id, row]));
  const rows = [];
  for (const desired of desiredRows) {
    const existing = existingMap.get(cleanId(desired.agent_id));
    if (!existing && typeof teamStore.addAgent === 'function') {
      await teamStore.addAgent({
        ...target,
        agentId: desired.agent_id,
        enabled: true,
        orderIndex: desired.order_index,
        overridesJson: desired.overrides_json,
      });
    } else if (existing) {
      const needsPatch = existing.enabled !== true
        || Number(existing.order_index ?? -1) !== desired.order_index
        || JSON.stringify(asObject(existing.overrides_json)) !== JSON.stringify(asObject(desired.overrides_json));
      if (needsPatch) {
        if (typeof teamStore.patchAgent === 'function') {
          await teamStore.patchAgent({ ...target, agentId: desired.agent_id, patch: desired }).catch(() => null);
        } else if (typeof teamStore.setAgentEnabled === 'function') {
          await teamStore.setAgentEnabled({
            ...target,
            agentId: desired.agent_id,
            enabled: true,
            orderIndex: desired.order_index,
            overridesJson: desired.overrides_json,
          }).catch(() => null);
        }
      }
    }
    rows.push(desired);
  }
  if (typeof teamStore.setTeamConfig === 'function') {
    await teamStore.setTeamConfig({ ...target, teamConfig: { status: 'active', active_team: normalizedTeam, pending_team: null, updated_at: nowIso() } });
  }
  return { ok: true, rows };
}

export function applyTeamConfigurationToRuntime(runtime = {}, teamConfig = null) {
  const team = teamConfig && typeof teamConfig === 'object' ? teamConfig : null;
  if (!team) return runtime;
  const catalog = new Map(runtimeCatalog(runtime).map((row) => [cleanId(row.id), row]));
  const configuredAgents = [];
  const runtimeAgents = [];
  const enabledAgentIds = [];
  for (const [index, configAgent] of asArray(team.agents).entries()) {
    const base = asObject(catalog.get(cleanId(configAgent.agent_id)) || {});
    const merged = {
      ...base,
      id: cleanId(configAgent.agent_id),
      name: clean(configAgent.name || base.name || configAgent.agent_id),
      role: cleanId(configAgent.role || base.role || base.system_key || configAgent.agent_id),
      model: clean(configAgent.model || base.model),
      provider: cleanId(configAgent.provider || base.provider || inferProviderForModel(configAgent.model || base.model || '') || ''),
      configured_model: clean(configAgent.model || base.model),
      skills: asArray(configAgent.skills).length > 0 ? asArray(configAgent.skills) : asArray(base.skills),
      interaction_contract: buildAgentLocalInteractionContract(team.interaction_spec, clean(configAgent.name || base.name || configAgent.agent_id)),
      prompt: clean(base.prompt || configAgent.prompt || ''),
      enabled: true,
      order_index: index,
    };
    configuredAgents.push(merged);
    enabledAgentIds.push(merged.id);
    runtimeAgents.push({
      instance_id: `team_${merged.role}_${index + 1}`,
      template_id: merged.id,
      display_label: merged.name,
      role_id: merged.role,
      provider: cleanId(merged.provider || inferProviderForModel(merged.model) || ''),
      model: merged.model,
      attached_skill_ids: asArray(merged.skills),
      assigned_goal: clean(configAgent.purpose),
      interaction_contract: merged.interaction_contract,
      status: 'ready',
    });
  }
  runtime.activeTeamConfig = team;
  runtime.teamLocked = true;
  runtime.teamInteractionSpec = normalizeInteractionSpec(team.interaction_spec);
  runtime.agents = configuredAgents;
  runtime.enabledAgentIds = enabledAgentIds;
  runtime.runtimeTeamSnapshot = {
    ...(asObject(runtime.runtimeTeamSnapshot)),
    runtime_agents: runtimeAgents,
    interaction_spec: runtime.teamInteractionSpec,
    team_locked: true,
  };
  return runtime;
}

export function buildTeamListMessage(teamState = {}) {
  const active = teamState?.active_team;
  if (!active) return '현재 활성 팀이 없습니다.\n/team suggest <목적> 으로 팀을 먼저 구성해 주세요.';
  const lines = [
    `Team: ${clean(active.team_name || 'active_team')}`,
    `Mode: ${cleanId(active.mode || 'scoped_context')}`,
    `Agents: ${asArray(active.agents).length}`,
    ...asArray(active.agents).map((agent) => `- ${agent.name} [${agent.role}] · model=${agent.model} · provider=${cleanId(agent.provider || inferProviderForModel(agent.model) || '(unknown)')} · skills=${asArray(agent.skills).slice(0,4).join(', ') || '(none)'}`),
    '',
    ...buildInteractionSummaryLines(active.interaction_spec || {}),
  ];
  return lines.join('\n');
}

export function formatTeamProposalMessage(team = {}) {
  const row = team && typeof team === 'object' ? team : {};
  const lines = [
    `Team proposal: ${clean(row.team_name || 'team_config')}`,
    `mode=${cleanId(row.mode || 'scoped_context')}`,
    '',
    'Agents:',
    ...asArray(row.agents).map((agent) => `- ${agent.name} [${agent.role}] · model=${agent.model} · provider=${cleanId(agent.provider || inferProviderForModel(agent.model) || '(unknown)')} · skills=${asArray(agent.skills).slice(0,4).join(', ') || '(none)'}${agent.purpose ? ` · why=${agent.purpose}` : ''}`),
    '',
    'Interaction:',
    ...buildInteractionSummaryLines(row.interaction_spec || {}),
    '',
    '다음 단계:',
    '/team apply',
    '/team refine <자연어 수정>',
    '/team template',
  ];
  return lines.join('\n');
}

export function storePendingTeam(sessionStore, chatId, team = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  saveSessionTeamState(sessionStore, chatId, { ...current, status: 'suggested', pending_team: team });
  return getSessionTeamState(sessionStore, chatId);
}

export async function applyPendingTeam({ sessionStore, chatId, runtime = null } = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  const team = current.pending_team || current.active_team;
  if (!team) throw new Error('no pending team to apply');
  const normalized = validateTeamConfiguration(team, { runtime });
  saveSessionTeamState(sessionStore, chatId, { status: 'active', active_team: normalized, pending_team: null });
  if (runtime) {
    applyTeamConfigurationToRuntime(runtime, normalized);
    await syncTeamConfigurationToConversationStore({ runtime, teamConfig: normalized, source: 'team_apply' }).catch(() => null);
  }
  return normalized;
}

export async function resetTeamConfiguration(sessionStore, chatId, { runtime = null } = {}) {
  saveSessionTeamState(sessionStore, chatId, { status: 'none', active_team: null, pending_team: null });
  await clearConversationStoreTeamConfiguration(runtime).catch(() => null);
}

export function formatSupportedModelLines() {
  return listSupportedModels().map((row) => `- ${row.label} (${row.id})`).join('\n');
}
