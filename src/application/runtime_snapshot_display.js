export function summarizeRuntimeTeamSnapshotLines(snapshot = null, {
  actionSource = "",
} = {}) {
  const row = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!row) return [];
  const runtimeAgents = Array.isArray(row.runtime_agents) ? row.runtime_agents : [];
  const runtimeParticipants = Array.isArray(row.runtime_participants) ? row.runtime_participants : [];
  const nonExecutableParticipants = Array.isArray(row.non_executable_participants) ? row.non_executable_participants : [];
  const topologyPattern = String(row.topology_pattern || row.execution_graph?.pattern || row.structure_v2?.topology?.pattern || '').trim().toLowerCase();
  const selectedSkills = Array.isArray(row.selected_skill_ids) ? row.selected_skill_ids : [];
  const contextPacks = Array.isArray(row.context_packs) ? row.context_packs : [];
  const scopeSpecs = Array.isArray(row.scope_specs) ? row.scope_specs : [];
  const materializedScopes = Array.isArray(row.materialized_scopes) ? row.materialized_scopes : [];
  const authoritativeScopeCount = materializedScopes.filter((item) => String(item?.lineage?.compiler || '').trim().toLowerCase() === 'goc_scope_materializer').length;
  const emptyScopeCount = materializedScopes.filter((item) => item?.lineage?.empty_scope === true).length;
  const parallelGroups = Array.isArray(row.execution_graph?.parallel_groups)
    ? row.execution_graph.parallel_groups
    : (Array.isArray(row.parallel_groups) ? row.parallel_groups : []);
  const stages = Array.isArray(row.execution_graph?.stages) ? row.execution_graph.stages : [];
  const executionOrder = Array.isArray(row.execution_graph?.order) ? row.execution_graph.order : [];
  const validation = row.execution_graph?.validation && typeof row.execution_graph.validation === 'object'
    ? row.execution_graph.validation
    : (row.structure_v2?.validation && typeof row.structure_v2.validation === 'object' ? row.structure_v2.validation : null);
  const collaborationCells = Array.isArray(row.collaboration_cells) ? row.collaboration_cells : [];
  const checkpoints = Array.isArray(row.checkpoints) ? row.checkpoints : [];
  const supervisorRuntime = row.supervisor_runtime && typeof row.supervisor_runtime === "object"
    ? row.supervisor_runtime
    : null;
  const blueprintSummary = row.blueprint_summary && typeof row.blueprint_summary === 'object' ? row.blueprint_summary : (row.team_plan?.blueprint_summary && typeof row.team_plan.blueprint_summary === 'object' ? row.team_plan.blueprint_summary : null);
  const lines = [
    `- action_source: ${String(actionSource || "unknown")}`,
    `- source: ${String(row.source || "team_builder")}`,
    `- generated_at: ${String(row.generated_at || "")}`,
    `- supervisor: ${supervisorRuntime?.enabled === true ? `${supervisorRuntime.interaction_mode || "enabled"} (${supervisorRuntime.instance_id || "supervisor"})` : "disabled"}`,
    `- topology_pattern: ${topologyPattern || '(unknown)'}`,
    `- runtime_participants: ${runtimeParticipants.length} executable=${runtimeParticipants.filter((entry) => entry?.executable === true).length} non_executable=${nonExecutableParticipants.length}`,
  ];
  for (const agent of runtimeAgents.slice(0, 4)) {
    const dominantSkills = Array.isArray(agent.attached_skill_ids) ? agent.attached_skill_ids.slice(0, 2).join(", ") : "";
    lines.push(
      `- agent: ${agent.role_label || "role"} slot=${agent.slot_id || "-"} label=${agent.display_label || agent.role_label || "-"} `
      + `kind=${agent.synthesized === true ? "synthesized" : `preset:${agent.preset_id || agent.template_id || "-"}`}`
      + `${dominantSkills ? ` skills=${dominantSkills}` : ""}`
      + `${agent.selection_reason ? ` reason=${agent.selection_reason}` : ""}`
    );
  }
  if (blueprintSummary?.task_archetype || blueprintSummary?.title) {
    lines.push(`- task_archetype: ${String(blueprintSummary.task_archetype || '(unknown)')}`);
    if (blueprintSummary?.title) lines.push(`- template: ${String(blueprintSummary.title)}`);
    if (blueprintSummary?.execution_pattern || blueprintSummary?.topology_pattern) lines.push(`- template_pattern: ${String(blueprintSummary.execution_pattern || blueprintSummary.topology_pattern)}`);
    const memoryMap = Array.isArray(blueprintSummary?.memory_map) ? blueprintSummary.memory_map.slice(0, 4) : [];
    if (memoryMap.length > 0) lines.push(`- memory_map: ${memoryMap.map((surface) => String(surface?.surface_id || surface?.file_name || '?')).join(', ')}`);
  }
  lines.push(`- selected_skill_ids: ${selectedSkills.length > 0 ? selectedSkills.join(", ") : "(none)"}`);
  lines.push(`- context_packs: ${contextPacks.length}`);
  lines.push(`- scopes: ${scopeSpecs.length}`);
  lines.push(`- materialized_scopes: ${materializedScopes.length} authoritative=${authoritativeScopeCount} empty=${emptyScopeCount}`);
  lines.push(`- parallel_groups: ${parallelGroups.length}`);
  if (stages.length > 0) {
    lines.push(`- stages: ${stages.map((stage) => `${stage.stage_id}:${stage.participant_ids?.length || 0}:${stage.mode || 'serial'}`).join(', ')}`);
  }
  if (executionOrder.length > 0) {
    lines.push(`- execution_order: ${executionOrder.join(' -> ')}`);
  }
  if (validation && (Array.isArray(validation.errors) || Array.isArray(validation.warnings))) {
    lines.push(`- structure_validation: errors=${Array.isArray(validation.errors) ? validation.errors.length : 0} warnings=${Array.isArray(validation.warnings) ? validation.warnings.length : 0} pattern_ready=${validation.pattern_ready === false ? 'no' : 'yes'} strict_ready=${validation.strict_pattern_ready === true ? 'yes' : 'no'}`);
  }
  if (collaborationCells.length > 0) {
    lines.push(`- collaboration_cells: ${collaborationCells.map((cell) => `${cell.pattern}:${cell.member_instance_ids?.length || 0}`).join(", ")}`);
  }
  if (checkpoints.length > 0) {
    lines.push(`- checkpoints: ${checkpoints.map((checkpoint) => `${checkpoint.checkpoint_id}:${checkpoint.status || "planned"}`).join(", ")}`);
  }
  return lines;
}
