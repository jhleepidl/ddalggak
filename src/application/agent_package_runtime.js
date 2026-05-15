import fs from 'node:fs';
import path from 'node:path';
import { applyPendingTeam, getSessionTeamState, storePendingTeam } from './team_configuration.js';
import { buildAgentRoomProfile, getAgentRoomProfile, normalizeRoomAgentRoles, upsertAgentRoomProfile } from './agent_room_profile.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', { maxLen = 1000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function cleanId(value = '', fallback = '') {
  const raw = clean(value || fallback, { maxLen: 160 }).toLowerCase();
  return raw.replace(/[^a-z0-9가-힣._:-]+/g, '_').replace(/^_+|_+$/g, '') || clean(fallback, { maxLen: 80 }) || 'agent_package';
}

function unique(values = [], { max = 64 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw, { maxLen: 160 });
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function getSession(sessionStore, chatId) {
  if (!sessionStore || typeof sessionStore.get !== 'function') return {};
  return asObject(sessionStore.get(chatId));
}

function upsertSession(sessionStore, chatId, patcher) {
  if (!sessionStore) return null;
  const current = getSession(sessionStore, chatId);
  const next = typeof patcher === 'function' ? patcher(current) : { ...current, ...asObject(patcher) };
  if (typeof sessionStore.upsert === 'function') {
    sessionStore.upsert(chatId, () => next);
    return next;
  }
  if (typeof sessionStore.set === 'function') {
    sessionStore.set(chatId, next);
    return next;
  }
  return null;
}

function getPackageRegistryPath(registryPath = '') {
  const explicit = clean(registryPath || process.env.AGENT_PACKAGE_REGISTRY_PATH || '', { maxLen: 1000 });
  if (explicit) return explicit;
  return path.resolve(process.cwd(), 'config', 'agent_packages.json');
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function agentFromTeamRow(row = {}, index = 0) {
  const source = asObject(row);
  const roleProfile = asObject(source.role_profile || source.roleProfile);
  const id = cleanId(source.agent_id || source.id || source.participant_id || source.name || `agent_${index + 1}`);
  const role = cleanId(roleProfile.role || source.role || source.role_id || source.roleId || id, 'agent');
  return {
    agent_id: id,
    display_name: clean(source.name || source.display_name || source.displayName || source.label || id, { maxLen: 120 }),
    role,
    purpose: clean(roleProfile.purpose || source.purpose || source.description || '', { maxLen: 400 }),
    skills: unique([...(asArray(source.skills).map((skill) => typeof skill === 'string' ? skill : skill?.id || skill?.name)), ...(asArray(roleProfile.skills).map((skill) => typeof skill === 'string' ? skill : skill?.id || skill?.name))], { max: 12 }),
    provider: clean(source.provider || source.model_node?.provider || '', { maxLen: 80 }) || undefined,
    model: clean(source.model || source.model_id || source.modelId || source.model_node?.model || '', { maxLen: 120 }) || undefined,
  };
}

function extractAgents({ roomProfile = {}, teamState = {} } = {}) {
  const team = asObject(teamState.active_team || teamState.pending_team);
  const teamAgents = asArray(team.agents || asObject(team.structure_v2 || team.structureV2 || team.structure).participants)
    .map(agentFromTeamRow)
    .filter((agent) => agent.agent_id);
  if (teamAgents.length) return teamAgents;
  return normalizeRoomAgentRoles(asArray(roomProfile.default_agents)).map((role, index) => ({
    agent_id: cleanId(role || `agent_${index + 1}`),
    display_name: clean(role || `Agent ${index + 1}`, { maxLen: 120 }),
    role: cleanId(role || 'agent'),
    purpose: '',
    skills: [],
  }));
}

function collectRuntimeRules(session = {}) {
  return asArray(session.runtime_rules)
    .filter((row) => row?.enabled !== false)
    .map((row) => ({
      id: cleanId(row?.id || row?.topic || row?.text || 'rule'),
      text: clean(row?.text || row?.display_text || '', { maxLen: 800 }),
      topic: clean(row?.topic || 'general', { maxLen: 80 }),
      source: clean(row?.source || 'chat', { maxLen: 80 }),
    }))
    .filter((row) => row.text)
    .slice(0, 32);
}

function inferMemorySurfaces(roomProfile = {}, teamState = {}) {
  const team = asObject(teamState.active_team || teamState.pending_team);
  const structure = asObject(team.structure_v2 || team.structureV2 || team.structure);
  const memoryPlan = asObject(team.memory_plan || team.memoryPlan || structure.memory_plan || structure.memoryPlan);
  const surfaces = asArray(memoryPlan.surfaces).map((surface) => asObject(surface)).filter(Boolean);
  if (surfaces.length) {
    return surfaces.slice(0, 32).map((surface, index) => ({
      surface_id: cleanId(surface.surface_id || surface.surfaceId || surface.file_name || surface.fileName || `surface_${index + 1}`),
      label: clean(surface.label || surface.title || surface.file_name || surface.fileName || `surface_${index + 1}`, { maxLen: 160 }),
      content_policy: /public|knowledge|source|docs|reference/i.test(JSON.stringify(surface)) ? 'optional_knowledge_pack' : 'schema_only',
    }));
  }
  return [{
    surface_id: 'room_memory',
    label: clean(roomProfile.memory_scope || 'room memory', { maxLen: 120 }),
    content_policy: 'fresh_private_on_clone',
  }];
}

function buildPackageId({ packageId = '', title = '', chatId = '', agentCount = 0 } = {}) {
  if (packageId) return cleanId(packageId);
  const base = cleanId(title || `chat_${chatId || 'room'}_${agentCount || 1}_agents`);
  return `${base}_${Date.now().toString(36)}`;
}

export function buildAgentPackageFromSession({ sessionStore = null, chatId = '', packageId = '', title = '', description = '', visibility = 'private_review' } = {}) {
  const session = getSession(sessionStore, chatId);
  const roomProfile = getAgentRoomProfile(sessionStore, chatId) || asObject(session.agent_room_profile);
  const teamState = getSessionTeamState(sessionStore, chatId);
  const agents = extractAgents({ roomProfile, teamState });
  const effectiveTitle = clean(title || roomProfile.name || asObject(teamState.active_team || teamState.pending_team).team_name || 'Agent Room Package', { maxLen: 140 });
  const now = nowIso();
  return {
    kind: 'agent_package_v1',
    schema_version: 1,
    package_id: buildPackageId({ packageId, title: effectiveTitle, chatId, agentCount: agents.length }),
    title: effectiveTitle,
    description: clean(description || roomProfile.current_goal || asObject(teamState.active_team || teamState.pending_team).task_brief || '', { maxLen: 1200 }),
    visibility: clean(visibility || 'private_review', { maxLen: 80 }),
    source: {
      chat_id: String(chatId || ''),
      exported_at: now,
      exported_from: 'telegram_agents_export',
    },
    agents,
    rule_refs: collectRuntimeRules(session),
    skill_refs: unique(agents.flatMap((agent) => asArray(agent.skills)), { max: 32 }).map((skill_id) => ({ skill_id })),
    team_contract: {
      default_workflow: clean(roomProfile.default_workflow || asObject(teamState.active_team || teamState.pending_team).default_workflow || 'task_adaptive', { maxLen: 120 }),
      interaction_contract: asObject(asObject(teamState.active_team || teamState.pending_team).interaction_spec || asObject(teamState.active_team || teamState.pending_team).interactionSpec),
      team_config: asObject(teamState.active_team || teamState.pending_team),
    },
    memory_contract: {
      copies_private_memory: false,
      initial_mode: 'fresh_private_on_clone',
      required_surfaces: inferMemorySurfaces(roomProfile, teamState),
    },
    model_policy: {
      preferred_quality: 'good',
      allowed_privacy: ['local_private', 'trusted_private', 'user_controlled_remote', 'external_api'],
      avoid_cost_tier_above: 'premium',
      per_agent: agents.map((agent) => ({ agent_id: agent.agent_id, provider: agent.provider || null, model: agent.model || null })).filter((row) => row.provider || row.model),
    },
    clone_policy: {
      private_memory: 'fresh_on_clone',
      credential_binding: 'never_copy',
      provider_state: 'never_copy',
      runtime_logs: 'never_copy',
    },
    eval_summary: {
      runs: 0,
      known_failures: [],
      notes: [],
    },
    created_at: now,
    updated_at: now,
  };
}

export function sanitizeAgentPackage(raw = {}) {
  const pkg = asObject(raw);
  const packageId = cleanId(pkg.package_id || pkg.id || pkg.title || 'agent_package');
  const agents = asArray(pkg.agents).map((agent, index) => agentFromTeamRow({ ...asObject(agent), name: agent?.display_name || agent?.name }, index)).filter((agent) => agent.agent_id).slice(0, 24);
  return {
    kind: 'agent_package_v1',
    schema_version: 1,
    ...pkg,
    package_id: packageId,
    title: clean(pkg.title || packageId, { maxLen: 160 }),
    description: clean(pkg.description || '', { maxLen: 2000 }),
    visibility: clean(pkg.visibility || 'private_review', { maxLen: 80 }),
    agents,
    rule_refs: asArray(pkg.rule_refs || pkg.rules).map((rule) => ({
      id: cleanId(rule?.id || rule?.topic || rule?.text || 'rule'),
      text: clean(rule?.text || rule?.display_text || '', { maxLen: 800 }),
      topic: clean(rule?.topic || 'general', { maxLen: 80 }),
      source: clean(rule?.source || 'package', { maxLen: 80 }),
    })).filter((rule) => rule.text).slice(0, 32),
    skill_refs: asArray(pkg.skill_refs || pkg.skills).map((skill) => ({ skill_id: cleanId(skill?.skill_id || skill?.id || skill) })).filter((skill) => skill.skill_id).slice(0, 64),
    memory_contract: {
      copies_private_memory: false,
      initial_mode: 'fresh_private_on_clone',
      ...asObject(pkg.memory_contract || pkg.memoryContract),
      copies_private_memory: false,
    },
    clone_policy: {
      private_memory: 'fresh_on_clone',
      credential_binding: 'never_copy',
      provider_state: 'never_copy',
      runtime_logs: 'never_copy',
      ...asObject(pkg.clone_policy || pkg.clonePolicy),
      private_memory: 'fresh_on_clone',
      credential_binding: 'never_copy',
      provider_state: 'never_copy',
    },
    updated_at: nowIso(),
  };
}

export function readAgentPackageRegistry({ registryPath = '' } = {}) {
  const filePath = getPackageRegistryPath(registryPath);
  const payload = readJsonFile(filePath, { kind: 'agent_package_registry_v1', packages: [] });
  const packages = asArray(payload.packages).map(sanitizeAgentPackage);
  return {
    kind: 'agent_package_registry_v1',
    schema_version: 1,
    packages,
    path: filePath,
    updated_at: payload.updated_at || null,
  };
}

export function saveAgentPackageToRegistry(agentPackage = {}, { registryPath = '' } = {}) {
  const filePath = getPackageRegistryPath(registryPath);
  const registry = readAgentPackageRegistry({ registryPath: filePath });
  const pkg = sanitizeAgentPackage(agentPackage);
  const packages = [pkg, ...registry.packages.filter((row) => row.package_id !== pkg.package_id)].slice(0, 200);
  const payload = { kind: 'agent_package_registry_v1', schema_version: 1, updated_at: nowIso(), packages };
  writeJsonFile(filePath, payload);
  return { package: pkg, registry: { ...payload, path: filePath }, path: filePath };
}

export function findAgentPackage(packageId = '', { registryPath = '' } = {}) {
  const id = cleanId(packageId);
  if (!id) return null;
  const registry = readAgentPackageRegistry({ registryPath });
  return registry.packages.find((pkg) => pkg.package_id === id || cleanId(pkg.title) === id) || null;
}

export async function installAgentPackageToSession({ sessionStore = null, chatId = '', agentPackage = {}, runtime = null, applyState = 'pending', source = 'agent_package_clone' } = {}) {
  const pkg = sanitizeAgentPackage(agentPackage);
  const roles = normalizeRoomAgentRoles(pkg.agents.map((agent) => agent.role || agent.agent_id));
  const profile = buildAgentRoomProfile({
    chatId,
    roomName: pkg.title || 'Agent Package',
    goal: pkg.description || `Clone package ${pkg.package_id}`,
    roles,
    team: asObject(pkg.team_contract).team_config,
    source,
  });
  profile.package_id = pkg.package_id;
  profile.clone_policy = pkg.clone_policy;
  upsertAgentRoomProfile(sessionStore, chatId, profile);

  const teamConfig = asObject(asObject(pkg.team_contract).team_config);
  if (Object.keys(teamConfig).length) {
    storePendingTeam(sessionStore, chatId, { ...teamConfig, proposal_mode: 'apply', source });
    if (String(applyState || '').toLowerCase() === 'active') {
      await applyPendingTeam({ sessionStore, chatId, runtime }).catch(() => null);
    }
  }

  if (pkg.rule_refs.length) {
    upsertSession(sessionStore, chatId, (session) => {
      const existing = asArray(session.runtime_rules);
      const now = nowIso();
      const nextRules = pkg.rule_refs.map((rule) => ({
        id: `pkg_${pkg.package_id}_${rule.id}`.slice(0, 160),
        text: rule.text,
        topic: rule.topic || 'general',
        source: 'agent_package',
        package_id: pkg.package_id,
        enabled: true,
        created_at: now,
      }));
      const seen = new Set();
      const merged = [...existing, ...nextRules].filter((rule) => {
        const key = clean(rule.text || '').toLowerCase();
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(-64);
      return { ...session, runtime_rules: merged };
    });
  }

  upsertSession(sessionStore, chatId, (session) => ({
    ...session,
    installed_agent_packages: [
      { package_id: pkg.package_id, title: pkg.title, installed_at: nowIso(), source, apply_state: applyState },
      ...asArray(session.installed_agent_packages).filter((row) => row?.package_id !== pkg.package_id),
    ].slice(0, 32),
  }));

  return { package: pkg, profile: getAgentRoomProfile(sessionStore, chatId), team_state: getSessionTeamState(sessionStore, chatId) };
}

export function formatAgentPackage(agentPackage = {}, { detail = false } = {}) {
  const pkg = sanitizeAgentPackage(agentPackage);
  const lines = [
    `Agent Package · ${pkg.title}`,
    `- package_id: ${pkg.package_id}`,
    `- visibility: ${pkg.visibility}`,
    `- agents: ${pkg.agents.map((agent) => `${agent.display_name || agent.agent_id}(${agent.role})`).join(', ') || '-'}`,
    `- rules: ${pkg.rule_refs.length}`,
    `- skills: ${pkg.skill_refs.length}`,
    `- memory: ${pkg.memory_contract.initial_mode || 'fresh_private_on_clone'} · copies_private_memory=false`,
    `- clone: private memory fresh · credentials never copied · provider state never copied`,
  ];
  if (pkg.description) lines.push(`- description: ${pkg.description}`);
  if (detail) {
    const surfaces = asArray(pkg.memory_contract.required_surfaces);
    if (surfaces.length) lines.push('', 'Memory surfaces:', ...surfaces.slice(0, 12).map((surface) => `- ${surface.surface_id || surface.label}: ${surface.content_policy || 'schema_only'}`));
    if (pkg.rule_refs.length) lines.push('', 'Rules:', ...pkg.rule_refs.slice(0, 12).map((rule) => `- ${rule.text}`));
  }
  return lines.join('\n');
}

export function formatAgentPackageRegistry(registry = {}) {
  const packages = asArray(registry.packages);
  if (!packages.length) {
    return [
      'Agent package registry is empty.',
      '',
      'Create one with:',
      '- /agents export',
      '- /agents publish-candidate',
    ].join('\n');
  }
  const lines = [`Agent packages · ${packages.length}`, `registry=${registry.path || '-'}`];
  packages.slice(0, 20).forEach((pkg, index) => {
    lines.push(`${index + 1}. ${pkg.title} · ${pkg.package_id}`);
    lines.push(`   - agents=${pkg.agents.length} rules=${pkg.rule_refs.length} visibility=${pkg.visibility}`);
  });
  lines.push('', 'Use: /agents clone <package_id> · /agents package <package_id>');
  return lines.join('\n');
}
