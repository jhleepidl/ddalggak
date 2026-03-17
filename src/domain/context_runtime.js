const VALID_CONTEXT_RUNTIME_MODES = new Set(["shared_memory", "scoped_context"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value = "", { lower = false } = {}) {
  const clean = String(value || "").trim();
  return lower ? clean.toLowerCase() : clean;
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function normalizeContextRuntimeMode(value = "", {
  fallback = "shared_memory",
} = {}) {
  const clean = normalizeText(value, { lower: true });
  return VALID_CONTEXT_RUNTIME_MODES.has(clean) ? clean : fallback;
}

export function isScopedContextMode(value = "") {
  return normalizeContextRuntimeMode(value, { fallback: "shared_memory" }) === "scoped_context";
}

export function inferContextRuntimeMode({
  teamPlan = {},
  runtimeAgents = [],
  taskInterpretation = {},
  scopeSpecs = [],
  collaborationCells = [],
  checkpoints = [],
} = {}) {
  const explicit = normalizeContextRuntimeMode(
    teamPlan?.context_runtime_mode
      || teamPlan?.contextRuntimeMode
      || taskInterpretation?.context_runtime_mode
      || taskInterpretation?.contextRuntimeMode,
    { fallback: "" },
  );
  if (explicit) return explicit;

  if (asArray(scopeSpecs).length > 0) return "scoped_context";

  const slots = asArray(teamPlan?.slots);
  const executionEdges = asArray(teamPlan?.execution_graph?.edges ?? teamPlan?.dependencies);
  const activeRuntimeAgents = asArray(runtimeAgents).filter((agent) => asObject(agent));
  const roleIds = new Set(
    activeRuntimeAgents
      .map((agent) => normalizeText(agent?.role_id || agent?.role_label, { lower: true }))
      .filter(Boolean)
  );
  const highSeparationRoles = ["reviewer", "synthesizer", "operator"].filter((roleId) => roleIds.has(roleId));
  const multiAgent = activeRuntimeAgents.length >= 3 || slots.length >= 3;
  const hasExecutionStructure = executionEdges.length > 0 || asArray(collaborationCells).length > 0 || asArray(checkpoints).length > 0;
  const reviewPolicy = normalizeText(taskInterpretation?.review_policy, { lower: true });
  const reviewHeavy = ["claim_heavy", "required", "strict"].includes(reviewPolicy);

  if (highSeparationRoles.length > 0 || (multiAgent && hasExecutionStructure) || reviewHeavy) {
    return "scoped_context";
  }
  return "shared_memory";
}

export function summarizeLegacyContextState({
  contextRuntimeMode = "shared_memory",
  contextPacks = [],
  scopeSpecs = [],
  materializedScopes = [],
} = {}) {
  const mode = normalizeContextRuntimeMode(contextRuntimeMode, {
    fallback: asArray(scopeSpecs).length > 0 || asArray(materializedScopes).length > 0
      ? "scoped_context"
      : "shared_memory",
  });
  const legacyContextPackCount = asArray(contextPacks).length;
  const legacyContextPacksEnabled = legacyContextPackCount > 0 && !isScopedContextMode(mode);
  return {
    context_runtime_mode: mode,
    legacy_context_pack_count: legacyContextPackCount,
    legacy_context_packs_enabled: legacyContextPacksEnabled,
    legacy_context_strategy: legacyContextPacksEnabled ? "primary" : (legacyContextPackCount > 0 ? "fallback_only" : "disabled"),
  };
}
