export function summarizeRuntimeTeamSnapshotLines(snapshot = null, {
  actionSource = "",
} = {}) {
  const row = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!row) return [];
  const runtimeAgents = Array.isArray(row.runtime_agents) ? row.runtime_agents : [];
  const selectedSkills = Array.isArray(row.selected_skill_ids) ? row.selected_skill_ids : [];
  const contextPacks = Array.isArray(row.context_packs) ? row.context_packs : [];
  const parallelGroups = Array.isArray(row.execution_graph?.parallel_groups)
    ? row.execution_graph.parallel_groups
    : (Array.isArray(row.parallel_groups) ? row.parallel_groups : []);
  const collaborationCells = Array.isArray(row.collaboration_cells) ? row.collaboration_cells : [];
  const checkpoints = Array.isArray(row.checkpoints) ? row.checkpoints : [];
  const supervisorRuntime = row.supervisor_runtime && typeof row.supervisor_runtime === "object"
    ? row.supervisor_runtime
    : null;
  const lines = [
    `- action_source: ${String(actionSource || "unknown")}`,
    `- source: ${String(row.source || "team_builder")}`,
    `- generated_at: ${String(row.generated_at || "")}`,
    `- supervisor: ${supervisorRuntime?.enabled === true ? `${supervisorRuntime.interaction_mode || "enabled"} (${supervisorRuntime.instance_id || "supervisor"})` : "disabled"}`,
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
  lines.push(`- selected_skill_ids: ${selectedSkills.length > 0 ? selectedSkills.join(", ") : "(none)"}`);
  lines.push(`- context_packs: ${contextPacks.length}`);
  lines.push(`- parallel_groups: ${parallelGroups.length}`);
  if (collaborationCells.length > 0) {
    lines.push(`- collaboration_cells: ${collaborationCells.map((cell) => `${cell.pattern}:${cell.member_instance_ids?.length || 0}`).join(", ")}`);
  }
  if (checkpoints.length > 0) {
    lines.push(`- checkpoints: ${checkpoints.map((checkpoint) => `${checkpoint.checkpoint_id}:${checkpoint.status || "planned"}`).join(", ")}`);
  }
  return lines;
}
