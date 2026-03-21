import { buildManifestRequirements, buildManifestInstallHints, normalizeManifestRequirements } from '../shared/manifest_requirements.js';
import { buildTeamInstallProposal } from './install_proposal.js';
import { normalizeInstallProposalState } from './install_proposal_state.js';
import { normalizeCredentialBindingState } from './credential_binding.js';
import { buildTeamStructureV2, normalizeTeamStructureV2, deriveTeamConfigFromStructureV2 } from '../shared/team_structure_v2.js';
import { deriveKnowledgeBaseDesign, normalizeMemoryPlan } from '../knowledge_base/profile.js';
import { buildTeamSeedFromTaskArchetype, listTeamBlueprintTemplateSeeds } from './team_blueprint_templates.js';
import { buildTeamCapabilityContract, summarizeCapabilityContract } from './team_capability_contract.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9._:-]+/g, '_');
}

function cleanState(value = 'pending') {
  return cleanId(value) === 'active' ? 'active' : 'pending';
}

function uniqStrings(values = [], { limit = 16 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

export function inferTaskArchetype({ team = {}, structure = {}, memoryPlan = {} } = {}) {
  const profileId = cleanId(memoryPlan?.plan_id || team?.knowledge_base_profile?.profile_id || '');
  const pattern = cleanId(structure?.topology?.pattern || team?.structure_v2?.topology?.pattern || team?.structure?.topology?.pattern || '');
  const goal = clean(`${team?.task_brief || structure?.intent?.task_brief || ''}`).toLowerCase();
  if (profileId.includes('review_repair') || /review|audit|repair|regression|fixup|회귀|감사|수습|수정/.test(goal)) return 'review_repair';
  if (profileId.includes('iterative_improvement') || /iterate|iterative|iteration|improve|improvement|optimi[sz]e|계속 개선|반복 개선|지속 개선|계속 발전|여러 모델|multi-model|자동 개선/.test(goal)) return 'iterative_improvement';
  if (profileId.includes('implementation') || /implement|fix|patch|code|repo|구현|수정|패치/.test(goal)) return 'implementation';
  if (profileId.includes('analysis') || profileId.includes('research') || /analysis|research|brief|memo|조사|분석|브리프/.test(goal)) return 'research';
  if (profileId.includes('deliberation') || pattern === 'debate' || pattern === 'committee') return 'deliberation';
  if (profileId.includes('experiment') || pattern === 'workflow') return 'experiment';
  return 'general';
}

function buildRoleContracts(team = {}, structure = {}, memoryPlan = {}) {
  const agentsById = new Map(asArray(team.agents).map((agent) => [cleanId(agent.agent_id || agent.name || agent.role), agent]));
  const surfaces = asArray(memoryPlan.surfaces);
  const defaultLoads = new Set(asArray(memoryPlan.default_load_surface_ids).map((entry) => cleanId(entry)));
  const writable = new Set(asArray(memoryPlan.writable_surface_ids).map((entry) => cleanId(entry)));
  return asArray(structure.participants).map((participant) => {
    const role = cleanId(participant?.role || 'agent') || 'agent';
    const agent = agentsById.get(cleanId(participant?.participant_id)) || agentsById.get(cleanId(participant?.name)) || {};
    const reads = surfaces
      .filter((surface) => defaultLoads.has(cleanId(surface.surface_id)) || asArray(surface.target_roles).map((entry) => cleanId(entry)).includes(role))
      .map((surface) => cleanId(surface.surface_id))
      .filter(Boolean);
    const writes = surfaces
      .filter((surface) => writable.has(cleanId(surface.surface_id)) && (asArray(surface.target_roles).length === 0 || asArray(surface.target_roles).map((entry) => cleanId(entry)).includes(role)))
      .map((surface) => cleanId(surface.surface_id))
      .filter(Boolean);
    return {
      participant_id: participant.participant_id,
      role,
      assigned_goal: clean(agent.purpose || participant?.purpose || ''),
      reads: uniqStrings(reads),
      writes: uniqStrings(writes),
      context_types: uniqStrings(asArray(agent?.context_policy?.reads?.context_types || agent?.contextPolicy?.reads?.context_types)),
      publish_targets: uniqStrings(asArray(agent?.context_policy?.writes?.publish_targets || agent?.contextPolicy?.writes?.publish_targets)),
    };
  });
}

function buildArtifactContract(team = {}, structure = {}) {
  const artifacts = asObject(structure.artifacts);
  return {
    expected_outputs: uniqStrings(artifacts.expected_outputs || team.expected_outputs || [], { limit: 12 }),
    artifact_contracts: asArray(artifacts.artifact_contracts || team.artifact_contracts || []).slice(0, 12),
    telegram_report_policy: {
      final_owner: clean(structure?.control_policy?.final_answer_owner_participant_id || structure?.topology?.final_participant_id || ''),
      direct_response_enabled: structure?.interaction_policy?.handoff_policy?.direct_response_enabled === true,
      followup_shortcuts_enabled: structure?.interaction_policy?.handoff_policy?.followup_shortcuts_enabled !== false,
    },
  };
}

function summarizeMemoryMap(memoryPlan = {}) {
  return asArray(memoryPlan.surfaces).map((surface) => ({
    surface_id: clean(surface.surface_id),
    file_name: clean(surface.file_name),
    load_policy: cleanId(surface.load_policy || 'on_demand') || 'on_demand',
    write_policy: cleanId(surface.write_policy || 'shared') || 'shared',
    target_roles: uniqStrings(surface.target_roles || [], { limit: 8 }),
    semantic_slots: uniqStrings(surface.semantic_slots || [], { limit: 8 }),
  }));
}

function buildCatalogMetadata(team = {}, structure = {}, memoryPlan = {}) {
  const pattern = clean(structure?.topology?.pattern || 'hybrid') || 'hybrid';
  const archetype = inferTaskArchetype({ team, structure, memoryPlan });
  const roleTags = asArray(team.agents).map((agent) => cleanId(agent.role)).filter(Boolean);
  return {
    tags: uniqStrings([archetype, pattern, ...roleTags, ...(team.catalog_tags || [])], { limit: 10 }),
    good_for: uniqStrings(asArray(team.good_for || team.recommended_for || team.use_cases || [team.task_brief]).filter(Boolean), { limit: 6 }),
    bad_for: uniqStrings(asArray(team.bad_for || team.anti_patterns || []), { limit: 6 }),
  };
}

function deriveTeamSeed(payload = {}, applyState = 'pending') {
  const raw = asObject(payload);
  const blueprint = asObject(raw.blueprint || raw.team_blueprint || raw.teamBlueprint);
  const explicitStructure = asObject(
    raw.structure
    || raw.structure_v2
    || raw.structureV2
    || blueprint.structure
    || blueprint.structure_v2
    || blueprint.structureV2
  );
  if (Object.keys(explicitStructure).length > 0) {
    return {
      ...asObject(raw.team || blueprint.team_seed || blueprint.teamSeed || raw.active_team || raw.pending_team),
      ...deriveTeamConfigFromStructureV2(explicitStructure),
      requirements: asObject(raw.requirements || blueprint.requirements),
      structure_v2: normalizeTeamStructureV2(explicitStructure),
    };
  }
  if (Object.keys(asObject(raw.team)).length > 0) return { ...asObject(raw.team), requirements: asObject(raw.requirements || blueprint.requirements || asObject(raw.team).requirements) };
  if (Object.keys(asObject(blueprint.team_seed || blueprint.teamSeed)).length > 0) return asObject(blueprint.team_seed || blueprint.teamSeed);
  const teamConfig = asObject(raw.team_config);
  if (applyState === 'active' && Object.keys(asObject(teamConfig.active_team)).length > 0) return { ...asObject(teamConfig.active_team), requirements: asObject(raw.requirements || asObject(teamConfig.active_team).requirements) };
  if (Object.keys(asObject(teamConfig.pending_team)).length > 0) return { ...asObject(teamConfig.pending_team), requirements: asObject(raw.requirements || asObject(teamConfig.pending_team).requirements) };
  if (Object.keys(asObject(teamConfig.active_team)).length > 0) return { ...asObject(teamConfig.active_team), requirements: asObject(raw.requirements || asObject(teamConfig.active_team).requirements) };
  if (Object.keys(asObject(raw.active_team)).length > 0) return { ...asObject(raw.active_team), requirements: asObject(raw.requirements || asObject(raw.active_team).requirements) };
  if (Object.keys(asObject(raw.pending_team)).length > 0) return { ...asObject(raw.pending_team), requirements: asObject(raw.requirements || asObject(raw.pending_team).requirements) };
  return raw;
}

export function attachTeamBlueprint(team = {}, { runtime = null, applyState = 'pending', source = 'team_configuration', installProposalState = null, credentialBindingState = null } = {}) {
  const cleanApplyState = cleanState(applyState);
  const structure = normalizeTeamStructureV2(
    team.structure || team.structure_v2 || team.structureV2 || buildTeamStructureV2(team, {
      applyState: cleanApplyState,
      installProposalState: normalizeInstallProposalState(installProposalState),
      credentialBindingState: normalizeCredentialBindingState(credentialBindingState || {}),
    })
  );
  const explicitMemoryPlan = normalizeMemoryPlan(team.memory_plan || team.memoryPlan || structure.memory_plan || structure.memoryPlan || {});
  const hasExplicitMemoryPlan = asArray(explicitMemoryPlan.surfaces).length > 0;
  const knowledgeDesign = deriveKnowledgeBaseDesign({
    goal: clean(team.task_brief || structure?.intent?.task_brief || ''),
    teamConfig: { ...team, structure_v2: structure, structure, memory_plan: hasExplicitMemoryPlan ? explicitMemoryPlan : (team.memory_plan || team.memoryPlan || structure.memory_plan) },
  });
  const requirements = normalizeManifestRequirements(team.requirements || buildManifestRequirements({ team, capabilityGaps: team.capability_gaps || team.capabilityGaps || [] }));
  const normalizedInstallProposalState = normalizeInstallProposalState(installProposalState);
  const normalizedCredentialBindingState = normalizeCredentialBindingState(credentialBindingState || {});
  const installProposal = buildTeamInstallProposal({ team: { ...team, structure_v2: structure, requirements }, runtime, applyState: cleanApplyState });
  const topology = asObject(structure.topology);
  const memoryPlan = hasExplicitMemoryPlan ? explicitMemoryPlan : normalizeMemoryPlan(knowledgeDesign.memory_plan);
  const archetype = inferTaskArchetype({ team, structure, memoryPlan });
  const catalog = buildCatalogMetadata(team, structure, memoryPlan);
  const blueprintId = cleanId(team.blueprint_id || team.team_blueprint?.blueprint_id || `${team.team_name || structure?.metadata?.team_name || 'team'}:${archetype}`) || 'team_blueprint';
  const roleContracts = buildRoleContracts(team, structure, memoryPlan);
  const artifactContract = buildArtifactContract(team, structure);
  const capabilityContract = buildTeamCapabilityContract({ team: { ...team, requirements }, runtime });
  const teamSeed = {
    ...deriveTeamConfigFromStructureV2(structure),
    ...team,
    requirements,
    structure_v2: structure,
    structure,
    memory_plan: memoryPlan,
    runtime_execution: asObject(structure.control_policy?.runtime_execution),
    primary_schema: 'team_blueprint_v1',
  };
  const blueprint = {
    blueprint_id: blueprintId,
    title: clean(team.team_name || structure?.metadata?.team_name || 'Configured Team') || 'Configured Team',
    description: clean(team.task_brief || structure?.intent?.task_brief || ''),
    task_archetype: archetype,
    topology: {
      pattern: clean(topology.pattern || 'hybrid') || 'hybrid',
      execution_pattern: clean(topology.execution_pattern || topology.executionPattern || ''),
      final_participant_id: clean(topology.final_participant_id || topology.finalParticipantId || structure?.control_policy?.final_answer_owner_participant_id || ''),
      participants: asArray(structure.participants),
      nodes: asArray(topology.nodes),
      edges: asArray(topology.edges),
    },
    structure,
    memory_plan: memoryPlan,
    memory_map: summarizeMemoryMap(memoryPlan),
    role_contracts: roleContracts,
    artifact_contract: artifactContract,
    capability_contract: capabilityContract,
    runtime_policy: { runtime_execution: asObject(structure.control_policy?.runtime_execution) },
    team_seed: teamSeed,
    catalog,
  };
  return {
    ...teamSeed,
    team_blueprint: blueprint,
    blueprint_id: blueprintId,
    catalog_tags: catalog.tags,
    good_for: catalog.good_for,
    bad_for: catalog.bad_for,
    install_proposal: installProposal,
    install_proposal_state: normalizedInstallProposalState,
    credential_binding_state: normalizedCredentialBindingState,
  };
}

export function buildTeamBlueprintDocument(team = {}, { runtime = null, applyState = 'pending', source = 'telegram', installProposalState = null, credentialBindingState = null } = {}) {
  const normalizedTeam = attachTeamBlueprint(team, { runtime, applyState, source, installProposalState, credentialBindingState });
  const requirements = normalizeManifestRequirements(normalizedTeam.requirements || {});
  const installHints = buildManifestInstallHints(requirements, { hasGocThreadTarget: !!clean(runtime?.map?.threadId || runtime?.threadId || '') });
  const cleanApplyState = cleanState(applyState);
  const capabilitySummary = summarizeCapabilityContract(normalizedTeam.team_blueprint?.capability_contract || {});
  return {
    kind: 'ddalggak_team_blueprint',
    version: 1,
    primary_schema: 'team_blueprint_v1',
    source,
    exported_at: new Date().toISOString(),
    apply_state: cleanApplyState,
    thread_id: clean(runtime?.map?.threadId || runtime?.threadId || '') || undefined,
    service_id: clean(runtime?.map?.serviceId || runtime?.serviceId || '') || undefined,
    summary: {
      agent_count: asArray(normalizedTeam.agents).length,
      participant_count: asArray(normalizedTeam.structure_v2?.participants).length,
      structure_pattern: normalizedTeam.structure_v2?.topology?.pattern || 'hybrid',
      memory_surface_count: asArray(normalizedTeam.memory_plan?.surfaces).length,
      task_archetype: normalizedTeam.team_blueprint?.task_archetype || 'general',
      capability_status: capabilitySummary.capability_status,
      missing_required_tool_count: capabilitySummary.missing_required_tool_count,
      tool_requirements: requirements.summary?.tool_count || 0,
      credential_requirements: requirements.summary?.credential_count || 0,
    },
    requirements: { ...requirements, install_hints: installHints },
    blueprint: normalizedTeam.team_blueprint,
    install_proposal: normalizedTeam.install_proposal,
    install_proposal_state: normalizedTeam.install_proposal_state,
    credential_binding_state: normalizedTeam.credential_binding_state,
    team: normalizedTeam,
  };
}

export function normalizeTeamBlueprintPayload(payload = {}, { runtime = null, applyState = 'pending', source = 'blueprint_import' } = {}) {
  const cleanApplyState = cleanState(applyState || payload?.apply_state || payload?.applyState);
  const teamSeed = deriveTeamSeed(payload, cleanApplyState);
  const normalizedTeam = attachTeamBlueprint(teamSeed, {
    runtime,
    applyState: cleanApplyState,
    source: clean(payload?.source || source) || source,
    installProposalState: payload?.install_proposal_state || payload?.installProposalState || null,
    credentialBindingState: payload?.credential_binding_state || payload?.credentialBindingState || null,
  });
  const document = buildTeamBlueprintDocument(normalizedTeam, {
    runtime,
    applyState: cleanApplyState,
    source: clean(payload?.source || source) || source,
    installProposalState: payload?.install_proposal_state || payload?.installProposalState || null,
    credentialBindingState: payload?.credential_binding_state || payload?.credentialBindingState || null,
  });
  return {
    blueprint: {
      ...document,
      thread_id: clean(payload?.thread_id || payload?.threadId || document.thread_id || '') || document.thread_id,
      service_id: clean(payload?.service_id || payload?.serviceId || document.service_id || '') || document.service_id,
      exported_at: clean(payload?.exported_at || payload?.exportedAt || document.exported_at || '') || document.exported_at,
    },
    team: normalizedTeam,
    apply_state: cleanApplyState,
  };
}



function normalizePreviewArchetype(value = '') {
  const key = cleanId(value);
  if (key === 'implementation' || key === 'review_repair' || key === 'research' || key === 'iterative_improvement') return key;
  return 'research';
}

export function resolveExecutionBlueprintSummary({ team = null, goal = '', taskInterpretation = null, runtimeTeamSnapshot = null, runtime = null } = {}) {
  const sourceTeam = team && typeof team === 'object' ? team : {};
  const snapshot = runtimeTeamSnapshot && typeof runtimeTeamSnapshot === 'object' ? runtimeTeamSnapshot : {};
  const snapshotPlan = asObject(snapshot.team_plan);
  const snapshotStructure = asObject(snapshot.structure_v2 || snapshot.structureV2 || snapshotPlan.structure_v2 || snapshotPlan.structureV2);
  const rawSnapshotMemoryPlan = asObject(snapshot.memory_plan || snapshot.memoryPlan || snapshotPlan.memory_plan || snapshotPlan.memoryPlan || {});
  const snapshotMemoryPlan = Object.keys(rawSnapshotMemoryPlan).length > 0 ? normalizeMemoryPlan(rawSnapshotMemoryPlan) : { surfaces: [] };

  let normalizedTeam = null;
  let source = 'task_archetype_template';
  if (Object.keys(sourceTeam).length > 0 || Object.keys(snapshotStructure).length > 0 || asArray(snapshotMemoryPlan.surfaces).length > 0) {
    const merged = {
      ...sourceTeam,
      task_brief: clean(sourceTeam.task_brief || goal || snapshot?.task_interpretation?.goal || snapshotPlan?.task_interpretation?.goal || ''),
      structure_v2: Object.keys(snapshotStructure).length > 0 ? snapshotStructure : sourceTeam.structure_v2,
      memory_plan: asArray(snapshotMemoryPlan.surfaces).length > 0 ? snapshotMemoryPlan : (sourceTeam.memory_plan || sourceTeam.memoryPlan),
    };
    normalizedTeam = attachTeamBlueprint(merged, { runtime, applyState: 'active', source: 'execution_preview' });
    source = Object.keys(sourceTeam).length > 0 ? 'active_team' : 'runtime_snapshot';
  } else {
    const inferred = inferTaskArchetype({
      team: { task_brief: clean(goal || taskInterpretation?.goal || '') },
      structure: {},
      memoryPlan: {},
    });
    const archetype = normalizePreviewArchetype(taskInterpretation?.task_archetype || taskInterpretation?.taskArchetype || inferred);
    normalizedTeam = attachTeamBlueprint(
      buildTeamSeedFromTaskArchetype(archetype, { taskBrief: clean(goal || taskInterpretation?.goal || '') }),
      { runtime, applyState: 'pending', source: 'task_archetype_template' }
    );
  }

  const blueprint = asObject(normalizedTeam?.team_blueprint);
  const memoryMap = asArray(blueprint.memory_map);
  const topology = asObject(blueprint.topology);
  const executionGraph = asObject(snapshot.execution_graph || snapshotPlan.execution_graph);
  const effectivePattern = cleanId(executionGraph.pattern || topology.execution_pattern || topology.pattern || '');
  const capabilitySummary = summarizeCapabilityContract(blueprint.capability_contract || {});
  return {
    source,
    blueprint_id: clean(blueprint.blueprint_id || normalizedTeam?.blueprint_id || '') || undefined,
    title: clean(blueprint.title || normalizedTeam?.team_name || 'Configured Team') || 'Configured Team',
    task_archetype: clean(blueprint.task_archetype || normalizedTeam?.task_archetype || 'research') || 'research',
    description: clean(blueprint.description || normalizedTeam?.task_brief || goal || ''),
    topology_pattern: clean(topology.pattern || '' ) || undefined,
    execution_pattern: clean(effectivePattern || topology.execution_pattern || topology.pattern || '') || undefined,
    memory_surface_count: memoryMap.length,
    memory_map: memoryMap.slice(0, 8),
    capability_status: capabilitySummary.capability_status,
    required_tool_count: capabilitySummary.required_tool_count,
    optional_tool_count: capabilitySummary.optional_tool_count,
    missing_required_tool_count: capabilitySummary.missing_required_tool_count,
    missing_optional_tool_count: capabilitySummary.missing_optional_tool_count,
    missing_required_tools: capabilitySummary.missing_required_tools,
    missing_optional_tools: capabilitySummary.missing_optional_tools,
  };
}

export function formatExecutionBlueprintSummaryLines(summary = null, { maxSurfaces = 4 } = {}) {
  const row = summary && typeof summary === 'object' ? summary : null;
  if (!row) return [];
  const lines = [
    `- task archetype: ${clean(row.task_archetype || 'research')}`,
    `- template: ${clean(row.title || 'Configured Team')}`,
  ];
  if (clean(row.execution_pattern || row.topology_pattern || '')) lines.push(`- runtime pattern: ${clean(row.execution_pattern || row.topology_pattern)}`);
  if (clean(row.source || '')) lines.push(`- source: ${clean(row.source)}`);
  if (clean(row.capability_status || '')) lines.push(`- capability status: ${clean(row.capability_status)}`);
  if (asArray(row.missing_required_tools).length > 0) lines.push(`- missing required tools: ${asArray(row.missing_required_tools).join(', ')}`);
  if (asArray(row.missing_optional_tools).length > 0) lines.push(`- missing optional tools: ${asArray(row.missing_optional_tools).join(', ')}`);
  const surfaces = asArray(row.memory_map).slice(0, Math.max(1, maxSurfaces));
  if (surfaces.length > 0) {
    lines.push('- memory map:');
    for (const surface of surfaces) {
      const label = clean(surface.surface_id || surface.file_name || 'surface');
      const load = clean(surface.load_policy || 'on_demand') || 'on_demand';
      const write = clean(surface.write_policy || 'shared') || 'shared';
      const roles = uniqStrings(surface.target_roles || [], { limit: 2 });
      lines.push(`  • ${label} · load=${load} · write=${write}${roles.length > 0 ? ` · roles=${roles.join(', ')}` : ''}`);
    }
    if (asArray(row.memory_map).length > surfaces.length) lines.push(`  • ... +${asArray(row.memory_map).length - surfaces.length} surfaces`);
  }
  return lines;
}
export function buildTaskArchetypeBlueprintDocument(taskArchetype = 'implementation', { runtime = null, title = '', taskBrief = '', applyState = 'pending' } = {}) {
  const seed = buildTeamSeedFromTaskArchetype(taskArchetype, { title, taskBrief });
  return buildTeamBlueprintDocument(seed, { runtime, applyState, source: 'task_archetype_template' });
}

export function listTeamBlueprintTemplates({ runtime = null } = {}) {
  return listTeamBlueprintTemplateSeeds().map((template) => ({
    ...template,
    blueprint_document: buildTeamBlueprintDocument(template.seed, { runtime, applyState: 'pending', source: 'task_archetype_template' }),
  }));
}
