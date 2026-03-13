function deepFreeze(value) {
  if (!value || typeof value !== "object") return value;
  for (const entry of Object.values(value)) {
    deepFreeze(entry);
  }
  return Object.freeze(value);
}

export const runtimeAuthorityContractFixtures = deepFreeze({
  standalone: {
    mode: "standalone",
    plan_source: "local",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: false,
    fallback_reason: null,
  },
  goc: {
    mode: "goc",
    plan_source: "local",
    context_source: "goc",
    agent_catalog_source: "goc",
    conversation_team_source: "goc",
    skill_catalog_source: "mixed",
    degraded_mode: false,
    fallback_reason: null,
  },
  local_fallback: {
    mode: "standalone",
    plan_source: "local_fallback",
    context_source: "local",
    agent_catalog_source: "local",
    conversation_team_source: "local",
    skill_catalog_source: "local",
    degraded_mode: true,
    fallback_reason: "goc unavailable",
  },
  goc_planner_fallback: {
    mode: "goc",
    plan_source: "local_fallback",
    context_source: "goc",
    agent_catalog_source: "goc",
    conversation_team_source: "goc",
    skill_catalog_source: "mixed",
    degraded_mode: true,
    fallback_reason: "remote planner timeout",
  },
});

export function cloneRuntimeAuthorityFixture(name = "standalone") {
  const fixture = runtimeAuthorityContractFixtures[name] || runtimeAuthorityContractFixtures.standalone;
  return { ...fixture };
}

export function buildRuntimeAuthorityMetadataFixture(authority = "standalone", overrides = {}) {
  const contract = typeof authority === "string"
    ? cloneRuntimeAuthorityFixture(authority)
    : { ...(authority || {}) };
  return {
    runtime_authority: contract,
    mode: contract.mode,
    plan_source: contract.plan_source,
    context_source: contract.context_source,
    agent_catalog_source: contract.agent_catalog_source,
    conversation_team_source: contract.conversation_team_source,
    skill_catalog_source: contract.skill_catalog_source,
    degraded_mode: contract.degraded_mode,
    fallback_reason: contract.fallback_reason,
    ...overrides,
  };
}
