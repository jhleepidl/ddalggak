export function summarizeRuntimeTeamSnapshotLines(snapshot = null, {
  actionSource = "",
} = {}) {
  const row = snapshot && typeof snapshot === "object" ? snapshot : null;
  if (!row) return [];
  const runtimeAgents = Array.isArray(row.runtime_agents) ? row.runtime_agents : [];
  const selectedSkills = Array.isArray(row.selected_skill_ids) ? row.selected_skill_ids : [];
  const contextPacks = Array.isArray(row.context_packs) ? row.context_packs : [];
  const lines = [
    `- action_source: ${String(actionSource || "unknown")}`,
    `- source: ${String(row.source || "team_builder")}`,
    `- generated_at: ${String(row.generated_at || "")}`,
    `- roles: ${runtimeAgents.map((agent) => `${agent.role_label || "role"}:${agent.template_id || "ephemeral"}`).join(", ") || "(none)"}`,
  ];
  lines.push(`- selected_skill_ids: ${selectedSkills.length > 0 ? selectedSkills.join(", ") : "(none)"}`);
  lines.push(`- context_packs: ${contextPacks.length}`);
  return lines;
}

