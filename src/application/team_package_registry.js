import fs from 'node:fs';
import path from 'node:path';
import { installTeamBlueprintToSession } from './team_blueprint_runtime.js';
import { buildTeamPublishCandidate } from './team_publish_candidate.js';

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '', { maxLen = 2000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function cleanId(value = '', fallback = '') {
  const raw = clean(value || fallback, { maxLen: 180 }).toLowerCase();
  return raw.replace(/[^a-z0-9가-힣._:-]+/g, '_').replace(/^_+|_+$/g, '') || clean(fallback, { maxLen: 80 }) || 'team_package';
}
function unique(values = [], { max = 64 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw, { maxLen: 180 });
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}
function nowIso() { return new Date().toISOString(); }
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
function getTeamPackageRegistryPath(registryPath = '') {
  const explicit = clean(registryPath || process.env.TEAM_PACKAGE_REGISTRY_PATH || '', { maxLen: 1000 });
  if (explicit) return explicit;
  return path.resolve(process.cwd(), 'config', 'shared_team_packages.json');
}
function pick(...values) {
  for (const value of values) {
    const text = clean(value, { maxLen: 1000 });
    if (text) return text;
  }
  return '';
}
function getManifestBlueprint(manifest = {}) {
  const row = asObject(manifest);
  return asObject(row.blueprint || row.team_blueprint || row.teamBlueprint);
}
function getManifestTeam(manifest = {}) {
  const row = asObject(manifest);
  return asObject(row.team || row.team_seed || row.teamSeed || row.active_team || row.pending_team || asObject(row.blueprint).team_seed || asObject(row.blueprint).teamSeed);
}
function deepClone(value) { return JSON.parse(JSON.stringify(value ?? {})); }

const PRIVATE_KEY_RE = /(credential|secret|token|password|api[_-]?key|provider[_-]?state|runtime[_-]?log|chat[_-]?history|transcript|raw[_-]?message|conversation[_-]?turn|private[_-]?memory|memory[_-]?node|memory[_-]?content|artifact[_-]?content|upload[_-]?content)/i;
const PRIVATE_VALUE_RE = /(credential|secret|token|password|api[_-]?key|passport|billing|invoice|hotel|flight|itinerary|private|personal)/i;

function stripUnsafeKeys(value, { depth = 0 } = {}) {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.map((item) => stripUnsafeKeys(item, { depth: depth + 1 })).filter((item) => typeof item !== 'undefined');
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (PRIVATE_KEY_RE.test(key)) continue;
    if (key === 'content' && typeof raw === 'string' && PRIVATE_VALUE_RE.test(raw)) continue;
    const next = stripUnsafeKeys(raw, { depth: depth + 1 });
    if (typeof next !== 'undefined') out[key] = next;
  }
  return out;
}

function sanitizeMemoryPlan(memoryPlan = {}, publishCandidate = {}) {
  const candidateSurfaces = asArray(asObject(publishCandidate.memory_contract).surfaces);
  const byId = new Map(candidateSurfaces.map((surface) => [cleanId(surface.surface_id || surface.id), asObject(surface)]));
  const plan = stripUnsafeKeys(asObject(memoryPlan)) || {};
  const surfaces = asArray(plan.surfaces).map((raw, index) => {
    const surface = asObject(raw);
    const surfaceId = cleanId(surface.surface_id || surface.surfaceId || surface.id || `surface_${index + 1}`);
    const candidate = byId.get(surfaceId) || {};
    const policy = cleanId(candidate.content_policy || surface.content_policy || surface.contentPolicy || 'schema_only');
    return {
      surface_id: surfaceId,
      label: pick(surface.label, surface.title, surface.file_name, surface.fileName, surfaceId),
      semantic_slots: unique(surface.semantic_slots || surface.semanticSlots || [], { max: 12 }),
      target_roles: unique(surface.target_roles || surface.targetRoles || [], { max: 12 }),
      load_policy: cleanId(surface.load_policy || surface.loadPolicy || 'on_demand') || 'on_demand',
      write_policy: policy === 'exclude' ? 'none' : cleanId(surface.write_policy || surface.writePolicy || 'shared') || 'shared',
      content_policy: policy === 'optional_knowledge_pack' ? 'optional_knowledge_pack' : (policy === 'exclude' ? 'exclude_private_memory' : 'schema_only'),
    };
  }).filter((surface) => surface.content_policy !== 'exclude_private_memory').slice(0, 32);
  return { ...plan, surfaces };
}

function sanitizeTeamSeed(team = {}, publishCandidate = {}) {
  const cloned = stripUnsafeKeys(deepClone(team)) || {};
  const structure = asObject(cloned.structure_v2 || cloned.structureV2 || cloned.structure);
  const memoryPlan = sanitizeMemoryPlan(cloned.memory_plan || cloned.memoryPlan || structure.memory_plan || structure.memoryPlan || {}, publishCandidate);
  if (Object.keys(memoryPlan).length > 0) {
    cloned.memory_plan = memoryPlan;
    if (Object.keys(structure).length > 0) {
      structure.memory_plan = memoryPlan;
      cloned.structure_v2 = structure;
      cloned.structure = structure;
    }
  }
  cloned.source = 'shared_team_package';
  cloned.package_clone_policy = {
    private_memory: 'fresh_on_clone',
    credential_binding: 'never_copy',
    provider_state: 'never_copy',
  };
  return cloned;
}

function buildPackageId({ packageId = '', title = '', version = '0.1.0' } = {}) {
  if (packageId) return cleanId(packageId);
  return `${cleanId(title || 'shared_team')}_${cleanId(version || '0_1_0')}_${Date.now().toString(36)}`;
}

function inferWorkModeDefaults(manifest = {}) {
  const team = getManifestTeam(manifest);
  const blueprint = getManifestBlueprint(manifest);
  const structure = asObject(team.structure_v2 || team.structureV2 || team.structure || blueprint.structure);
  const workMode = asObject(team.work_mode || team.workMode || blueprint.work_mode || blueprint.workMode || structure.work_mode || structure.workMode);
  const runtime = asObject(blueprint.runtime_policy || team.runtime_policy || team.runtimePolicy || structure.control_policy);
  const control = asObject(structure.control_policy);
  return {
    work_mode: cleanId(workMode.work_mode || workMode.mode || team.work_mode_id || team.workModeId || 'team_task') || 'team_task',
    loop_budget: clean(workMode.loop_budget || workMode.loopBudget || runtime.loop_budget || control.loop_budget || '1', { maxLen: 40 }) || '1',
    review_policy: cleanId(workMode.review_policy || workMode.reviewPolicy || runtime.review_policy || control.review_policy || 'optional') || 'optional',
    stop_condition: cleanId(workMode.stop_condition || workMode.stopCondition || runtime.stop_condition || control.stop_condition || 'answer_ready') || 'answer_ready',
    goc_mode: cleanId(workMode.goc_mode || workMode.gocMode || runtime.goc_mode || 'optional') || 'optional',
  };
}

function collectCapabilityRequirements(manifest = {}, teamSeed = {}) {
  const blueprint = getManifestBlueprint(manifest);
  const req = asObject(teamSeed.requirements || blueprint.requirements || manifest.requirements);
  const tools = [];
  const capabilities = [];
  for (const source of [req.required_tools, req.tools, req.external_tools]) {
    for (const raw of asArray(source)) {
      const row = asObject(raw);
      tools.push(cleanId(row.tool_id || row.toolId || row.id || raw));
    }
  }
  for (const source of [req.required_capabilities, req.capabilities]) {
    for (const raw of asArray(source)) {
      const row = asObject(raw);
      capabilities.push(cleanId(row.capability_id || row.capabilityId || row.id || raw));
    }
  }
  for (const agent of asArray(teamSeed.agents)) {
    for (const raw of asArray(agent.required_tool_ids || agent.requiredToolIds)) tools.push(cleanId(raw));
    for (const raw of asArray(agent.optional_tool_ids || agent.optionalToolIds || agent.recommended_tool_ids || agent.recommendedToolIds)) tools.push(cleanId(raw));
  }
  return {
    required_tools: unique(tools.filter(Boolean), { max: 48 }),
    required_capabilities: unique(capabilities.filter(Boolean), { max: 48 }),
  };
}

export function buildSharedTeamPackageFromManifest(manifest = {}, options = {}) {
  const visibility = cleanId(options.visibility || 'private_review') || 'private_review';
  const status = cleanId(options.status || (visibility === 'public' ? 'published' : 'candidate')) || 'candidate';
  const version = clean(options.version || '0.1.0', { maxLen: 40 }) || '0.1.0';
  const publishBundle = buildTeamPublishCandidate(manifest, { visibility });
  const candidate = asObject(publishBundle.candidate);
  const teamSeed = sanitizeTeamSeed(getManifestTeam(manifest), candidate);
  const blueprint = getManifestBlueprint(manifest);
  const title = pick(options.title, candidate.title, blueprint.title, teamSeed.team_name, 'Shared Team');
  const packageId = buildPackageId({ packageId: options.packageId || options.package_id, title, version });
  const created = nowIso();
  const privateExclusions = asArray(asObject(publishBundle.review).keep_private).map((surface) => ({
    surface_id: cleanId(surface.surface_id || surface.id),
    label: clean(surface.label || surface.title || surface.surface_id, { maxLen: 160 }),
    reason: clean(surface.reason || 'private memory excluded', { maxLen: 300 }),
  })).filter((row) => row.surface_id);
  const packageDoc = {
    kind: 'shared_team_package_v1',
    schema_version: 1,
    package_id: packageId,
    title,
    description: pick(options.description, candidate.description, blueprint.description, teamSeed.task_brief),
    visibility,
    status,
    version,
    license: clean(options.license || 'unlicensed', { maxLen: 80 }) || 'unlicensed',
    tags: unique([...(asArray(asObject(blueprint.catalog).tags)), ...(asArray(teamSeed.catalog_tags)), ...(asArray(options.tags))], { max: 16 }),
    source: {
      exported_at: created,
      exported_from: clean(options.source || 'team_package_registry', { maxLen: 120 }) || 'team_package_registry',
      source_thread_id: clean(options.threadId || options.thread_id || '', { maxLen: 160 }) || undefined,
      source_chat_id: clean(options.chatId || options.chat_id || '', { maxLen: 160 }) || undefined,
    },
    lineage: {
      parent_package_id: cleanId(options.parentPackageId || options.parent_package_id || ''),
      forked_from: cleanId(options.forkedFrom || options.forked_from || ''),
    },
    agents: asArray(candidate.agents).map((agent) => ({
      agent_id: cleanId(agent.agent_id || agent.id || agent.name),
      name: clean(agent.name || agent.agent_id || 'Agent', { maxLen: 120 }),
      role: cleanId(agent.role || 'agent'),
      purpose: clean(agent.purpose || '', { maxLen: 500 }),
    })).filter((agent) => agent.agent_id).slice(0, 24),
    runtime_rules: asArray(asObject(candidate.behavior_spec).runtime_rules).map((text) => clean(text, { maxLen: 800 })).filter(Boolean).slice(0, 32),
    team_motif: asObject(candidate.team_motif),
    work_mode_defaults: inferWorkModeDefaults(manifest),
    capability_requirements: collectCapabilityRequirements(manifest, teamSeed),
    memory_contract: {
      copies_private_memory: false,
      initial_mode: 'fresh_private_on_clone',
      publish_memory_content_by_default: false,
      required_surfaces: asArray(asObject(candidate.memory_contract).surfaces).filter((surface) => cleanId(surface.content_policy) !== 'exclude').map((surface) => ({
        surface_id: cleanId(surface.surface_id || surface.id),
        label: clean(surface.label || surface.title || surface.surface_id, { maxLen: 160 }),
        content_policy: cleanId(surface.content_policy || 'schema_only') || 'schema_only',
      })).filter((surface) => surface.surface_id),
      optional_knowledge_packs: asArray(candidate.knowledge_dependencies).map((row) => ({
        surface_id: cleanId(row.surface_id || row.id),
        title: clean(row.title || row.label || row.surface_id, { maxLen: 180 }),
        install_default: 'ask',
        refresh_on_clone: true,
      })).filter((row) => row.surface_id),
      private_exclusions: privateExclusions,
    },
    clone_policy: {
      private_memory: 'fresh_on_clone',
      credential_binding: 'never_copy',
      provider_state: 'never_copy',
      runtime_logs: 'never_copy',
      knowledge_packs: asArray(candidate.knowledge_dependencies).length ? 'ask' : 'none',
    },
    install_policy: {
      install_as: 'pending_by_default',
      credential_preview_required: true,
      capability_preview_required: true,
      fresh_private_memory_required: true,
    },
    quality_signals: {
      installs: 0,
      successful_promotions: 0,
      known_failures: [],
      user_notes: [],
    },
    safety_report: {
      clone_safe: true,
      copies_private_memory: false,
      credentials_copied: false,
      provider_state_copied: false,
      private_exclusion_count: privateExclusions.length,
      warnings: asArray(asObject(publishBundle.review).warnings).map((x) => clean(x, { maxLen: 300 })).filter(Boolean),
    },
    team_seed: teamSeed,
    publish_review: publishBundle.review,
    created_at: created,
    updated_at: created,
  };
  return sanitizeSharedTeamPackage(packageDoc);
}

export function sanitizeSharedTeamPackage(raw = {}) {
  const pkg = asObject(raw.package || raw.team_package || raw.teamPackage || raw);
  const packageId = cleanId(pkg.package_id || pkg.packageId || pkg.id || pkg.title || 'shared_team_package');
  const memoryContract = asObject(pkg.memory_contract || pkg.memoryContract);
  const clonePolicy = asObject(pkg.clone_policy || pkg.clonePolicy);
  const teamSeed = sanitizeTeamSeed(asObject(pkg.team_seed || pkg.teamSeed || asObject(pkg.team_contract).team_config), { memory_contract: memoryContract });
  const now = nowIso();
  return {
    kind: 'shared_team_package_v1',
    schema_version: 1,
    ...pkg,
    package_id: packageId,
    title: clean(pkg.title || packageId, { maxLen: 160 }) || packageId,
    description: clean(pkg.description || '', { maxLen: 2000 }),
    visibility: cleanId(pkg.visibility || 'private_review') || 'private_review',
    status: cleanId(pkg.status || pkg.publish_state || 'candidate') || 'candidate',
    version: clean(pkg.version || '0.1.0', { maxLen: 40 }) || '0.1.0',
    license: clean(pkg.license || 'unlicensed', { maxLen: 80 }) || 'unlicensed',
    tags: unique(pkg.tags || [], { max: 16 }),
    agents: asArray(pkg.agents).map((agent, index) => ({
      agent_id: cleanId(agent?.agent_id || agent?.id || agent?.name || `agent_${index + 1}`),
      name: clean(agent?.name || agent?.display_name || agent?.displayName || agent?.agent_id || `Agent ${index + 1}`, { maxLen: 120 }),
      role: cleanId(agent?.role || 'agent') || 'agent',
      purpose: clean(agent?.purpose || agent?.description || '', { maxLen: 500 }),
    })).filter((agent) => agent.agent_id).slice(0, 24),
    runtime_rules: asArray(pkg.runtime_rules || pkg.runtimeRules || asObject(pkg.behavior_spec).runtime_rules).map((text) => clean(text, { maxLen: 800 })).filter(Boolean).slice(0, 32),
    memory_contract: {
      ...memoryContract,
      copies_private_memory: false,
      initial_mode: 'fresh_private_on_clone',
      publish_memory_content_by_default: false,
      required_surfaces: asArray(memoryContract.required_surfaces || memoryContract.surfaces).map((surface) => ({
        surface_id: cleanId(surface?.surface_id || surface?.surfaceId || surface?.id || surface?.label),
        label: clean(surface?.label || surface?.title || surface?.surface_id || '', { maxLen: 160 }),
        content_policy: cleanId(surface?.content_policy || surface?.contentPolicy || 'schema_only') || 'schema_only',
      })).filter((surface) => surface.surface_id && surface.content_policy !== 'exclude').slice(0, 32),
      optional_knowledge_packs: asArray(memoryContract.optional_knowledge_packs || memoryContract.optionalKnowledgePacks || []).map((row) => ({
        surface_id: cleanId(row?.surface_id || row?.id || row?.title),
        title: clean(row?.title || row?.label || row?.surface_id || '', { maxLen: 180 }),
        install_default: 'ask',
        refresh_on_clone: true,
      })).filter((row) => row.surface_id).slice(0, 32),
      private_exclusions: asArray(memoryContract.private_exclusions || memoryContract.privateExclusions || []).map((row) => ({
        surface_id: cleanId(row?.surface_id || row?.id || row?.label),
        label: clean(row?.label || row?.title || row?.surface_id || '', { maxLen: 160 }),
        reason: clean(row?.reason || 'private memory excluded', { maxLen: 300 }),
      })).filter((row) => row.surface_id).slice(0, 32),
    },
    clone_policy: {
      ...clonePolicy,
      private_memory: 'fresh_on_clone',
      credential_binding: 'never_copy',
      provider_state: 'never_copy',
      runtime_logs: 'never_copy',
    },
    team_seed: teamSeed,
    safety_report: {
      ...asObject(pkg.safety_report || pkg.safetyReport),
      clone_safe: true,
      copies_private_memory: false,
      credentials_copied: false,
      provider_state_copied: false,
    },
    updated_at: now,
  };
}

export function readSharedTeamPackageRegistry({ registryPath = '' } = {}) {
  const filePath = getTeamPackageRegistryPath(registryPath);
  const payload = readJsonFile(filePath, { kind: 'shared_team_package_registry_v1', schema_version: 1, packages: [] });
  return {
    kind: 'shared_team_package_registry_v1',
    schema_version: 1,
    packages: asArray(payload.packages).map(sanitizeSharedTeamPackage),
    path: filePath,
    updated_at: payload.updated_at || null,
  };
}

export function saveSharedTeamPackageToRegistry(teamPackage = {}, { registryPath = '' } = {}) {
  const filePath = getTeamPackageRegistryPath(registryPath);
  const registry = readSharedTeamPackageRegistry({ registryPath: filePath });
  const pkg = sanitizeSharedTeamPackage(teamPackage);
  const packages = [pkg, ...registry.packages.filter((row) => row.package_id !== pkg.package_id)].slice(0, 500);
  const payload = { kind: 'shared_team_package_registry_v1', schema_version: 1, updated_at: nowIso(), packages };
  writeJsonFile(filePath, payload);
  return { package: pkg, registry: { ...payload, path: filePath }, path: filePath };
}

export function findSharedTeamPackage(packageId = '', { registryPath = '' } = {}) {
  const id = cleanId(packageId);
  if (!id) return null;
  const registry = readSharedTeamPackageRegistry({ registryPath });
  return registry.packages.find((pkg) => pkg.package_id === id || cleanId(pkg.title) === id) || null;
}

export function searchSharedTeamPackages({ query = '', visibility = '', includeCandidates = true, registryPath = '', limit = 50 } = {}) {
  const registry = readSharedTeamPackageRegistry({ registryPath });
  const q = clean(query, { maxLen: 200 }).toLowerCase();
  const vis = cleanId(visibility);
  const rows = registry.packages.filter((pkg) => {
    if (vis && cleanId(pkg.visibility) !== vis) return false;
    if (!includeCandidates && cleanId(pkg.status) !== 'published') return false;
    if (!q) return true;
    const haystack = [pkg.package_id, pkg.title, pkg.description, pkg.version, ...(asArray(pkg.tags)), ...(asArray(pkg.agents).map((a) => `${a.role} ${a.name} ${a.purpose}`))].join(' ').toLowerCase();
    return haystack.includes(q);
  }).slice(0, Math.max(1, Math.min(Number(limit) || 50, 200)));
  return { ...registry, packages: rows, query: q };
}

export function forkSharedTeamPackage(packageId = '', options = {}) {
  const source = typeof packageId === 'object' ? sanitizeSharedTeamPackage(packageId) : findSharedTeamPackage(packageId, options);
  if (!source) return null;
  const title = clean(options.title || `${source.title} Fork`, { maxLen: 160 });
  const forked = sanitizeSharedTeamPackage({
    ...source,
    package_id: buildPackageId({ packageId: options.packageId || options.package_id, title, version: source.version || '0.1.0' }),
    title,
    visibility: cleanId(options.visibility || 'private_review') || 'private_review',
    status: cleanId(options.status || 'candidate') || 'candidate',
    lineage: {
      ...asObject(source.lineage),
      parent_package_id: source.package_id,
      forked_from: source.package_id,
    },
    source: {
      ...asObject(source.source),
      forked_at: nowIso(),
      forked_from: source.package_id,
    },
    created_at: nowIso(),
  });
  return forked;
}

export function buildInstallManifestFromSharedTeamPackage(teamPackage = {}) {
  const pkg = sanitizeSharedTeamPackage(teamPackage);
  return {
    kind: 'team_blueprint_install_from_shared_package_v1',
    source: 'shared_team_package',
    package_id: pkg.package_id,
    blueprint: {
      title: pkg.title,
      description: pkg.description,
      topology: pkg.team_motif,
      memory_contract: pkg.memory_contract,
      clone_policy: pkg.clone_policy,
      runtime_rules: pkg.runtime_rules,
      work_mode_defaults: pkg.work_mode_defaults,
    },
    team: {
      ...pkg.team_seed,
      team_name: pkg.team_seed.team_name || pkg.title,
      task_brief: pkg.team_seed.task_brief || pkg.description,
      source: 'shared_team_package_clone',
      package_id: pkg.package_id,
      clone_policy: pkg.clone_policy,
    },
  };
}

export async function installSharedTeamPackageToSession({ sessionStore = null, chatId = '', teamPackage = {}, runtime = null, applyState = 'pending' } = {}) {
  const pkg = sanitizeSharedTeamPackage(teamPackage);
  const manifest = buildInstallManifestFromSharedTeamPackage(pkg);
  const installed = await installTeamBlueprintToSession({ sessionStore, chatId, manifest, runtime, applyState });
  return { ...installed, package: pkg, manifest };
}

export function formatSharedTeamPackage(teamPackage = {}, { detail = false } = {}) {
  const pkg = sanitizeSharedTeamPackage(teamPackage);
  const lines = [
    `Shared Team Package · ${pkg.title}`,
    `- package_id: ${pkg.package_id}`,
    `- version: ${pkg.version}`,
    `- visibility/status: ${pkg.visibility}/${pkg.status}`,
    `- agents: ${pkg.agents.map((agent) => `${agent.name}(${agent.role})`).join(', ') || '-'}`,
    `- rules: ${pkg.runtime_rules.length}`,
    `- memory: fresh_private_on_clone · copies_private_memory=false`,
    `- clone: credentials never copied · provider state never copied`,
  ];
  if (pkg.description) lines.push(`- description: ${pkg.description}`);
  const requirements = asObject(pkg.capability_requirements);
  if (asArray(requirements.required_tools).length || asArray(requirements.required_capabilities).length) {
    lines.push(`- requirements: tools=${asArray(requirements.required_tools).length} capabilities=${asArray(requirements.required_capabilities).length}`);
  }
  if (detail) {
    const surfaces = asArray(pkg.memory_contract.required_surfaces);
    if (surfaces.length) lines.push('', 'Memory contract:', ...surfaces.slice(0, 16).map((surface) => `- ${surface.surface_id}: ${surface.content_policy || 'schema_only'}`));
    const exclusions = asArray(pkg.memory_contract.private_exclusions);
    if (exclusions.length) lines.push('', 'Private exclusions:', ...exclusions.slice(0, 12).map((surface) => `- ${surface.label || surface.surface_id}`));
    if (pkg.runtime_rules.length) lines.push('', 'Runtime rules:', ...pkg.runtime_rules.slice(0, 12).map((rule) => `- ${rule}`));
    if (pkg.lineage?.parent_package_id) lines.push('', `Lineage: forked_from=${pkg.lineage.parent_package_id}`);
  }
  return lines.join('\n');
}

export function formatSharedTeamPackageRegistry(registry = {}) {
  const packages = asArray(registry.packages);
  if (!packages.length) {
    return ['Shared team package registry is empty.', '', 'Create one with:', '- /team publish', '- /team publish --public'].join('\n');
  }
  const lines = [`Shared team packages · ${packages.length}`, `registry=${registry.path || '-'}`];
  packages.slice(0, 30).forEach((pkg, index) => {
    lines.push(`${index + 1}. ${pkg.title} · ${pkg.package_id}`);
    lines.push(`   - v${pkg.version} agents=${pkg.agents.length} visibility=${pkg.visibility} status=${pkg.status}`);
  });
  lines.push('', 'Use: /team package <package_id> · /team clone <package_id> · /team fork <package_id>');
  return lines.join('\n');
}
