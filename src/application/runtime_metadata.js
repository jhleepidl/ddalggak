function normalizeRuntimeAgent(agent = {}) {
  const row = agent && typeof agent === "object" ? agent : {};
  return {
    instance_id: String(row.instance_id || "").trim(),
    template_id: String(row.template_id || "").trim().toLowerCase() || undefined,
    role_label: String(row.role_label || "").trim(),
    provider: String(row.provider || "").trim().toLowerCase() || undefined,
    model: String(row.model || "").trim() || undefined,
    assigned_goal: String(row.assigned_goal || "").trim() || undefined,
    capability_tags: Array.isArray(row.capability_tags)
      ? row.capability_tags.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean)
      : [],
    lens_spec: row.lens_spec && typeof row.lens_spec === "object" ? row.lens_spec : undefined,
    status: String(row.status || "ready").trim().toLowerCase() || "ready",
    ephemeral: row.ephemeral === true,
    fallback: row.fallback === true,
  };
}

export function createRuntimeTeamSnapshot({
  teamPlan = null,
  runtimeAgents = [],
  source = "team_builder",
  generatedAt = new Date().toISOString(),
} = {}) {
  return {
    team_plan: teamPlan && typeof teamPlan === "object" ? teamPlan : null,
    runtime_agents: (Array.isArray(runtimeAgents) ? runtimeAgents : [])
      .map((agent) => normalizeRuntimeAgent(agent))
      .filter((agent) => agent.instance_id || agent.template_id || agent.role_label),
    generated_at: String(generatedAt || new Date().toISOString()),
    source: String(source || "team_builder").trim() || "team_builder",
  };
}

export function attachRuntimeTeamSnapshot(payload = {}, snapshot = null, {
  key = "runtime_team_snapshot",
} = {}) {
  const row = payload && typeof payload === "object" ? payload : {};
  const next = snapshot && typeof snapshot === "object" ? snapshot : null;
  return {
    ...row,
    [key]: next,
  };
}
