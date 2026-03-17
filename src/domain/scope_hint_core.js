import { normalizeNodeIds } from "../shared/normalize.js";

export const SCOPE_HINT_MODES = ["shared_only", "unfold_query", "add_nodes", "remove_nodes"];

export function dedupeScopeNodeIds(nodeIds = [], { max = 200 } = {}) {
  return normalizeNodeIds(nodeIds, { max });
}

export function normalizeScopeHintCore(rawScope, { fallbackBudget = 1200 } = {}) {
  const row = rawScope && typeof rawScope === "object" ? rawScope : {};
  const query = String(row.query || row.prompt || "").trim();
  const addNodeIds = dedupeScopeNodeIds(row.add_node_ids ?? row.addNodeIds, { max: 120 });
  const removeNodeIds = dedupeScopeNodeIds(row.remove_node_ids ?? row.removeNodeIds, { max: 120 });
  const modeRaw = String(row.mode || "").trim().toLowerCase();
  const inferredMode = query
    ? "unfold_query"
    : (addNodeIds.length > 0 ? "add_nodes" : (removeNodeIds.length > 0 ? "remove_nodes" : "shared_only"));
  const mode = SCOPE_HINT_MODES.includes(modeRaw) ? modeRaw : inferredMode;
  const budgetRaw = Number(row.budget_tokens ?? row.budgetTokens);
  const closureDirectionRaw = String((row.closure_direction ?? row.closureDirection) || "").trim().toLowerCase();
  const maxClosureRaw = Number(row.max_closure_nodes ?? row.maxClosureNodes);
  const closureEdgeTypes = Array.isArray(row.closure_edge_types ?? row.closureEdgeTypes)
    ? (row.closure_edge_types ?? row.closureEdgeTypes)
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .slice(0, 16)
    : [];

  return {
    mode,
    query: query || undefined,
    add_node_ids: addNodeIds.length > 0 ? addNodeIds : undefined,
    remove_node_ids: removeNodeIds.length > 0 ? removeNodeIds : undefined,
    budget_tokens: Number.isFinite(budgetRaw)
      ? Math.max(200, Math.min(12000, Math.floor(budgetRaw)))
      : Math.max(200, Math.min(12000, Math.floor(Number(fallbackBudget) || 1200))),
    closure_edge_types: closureEdgeTypes.length > 0 ? closureEdgeTypes : undefined,
    closure_direction: ["both", "forward", "backward"].includes(closureDirectionRaw)
      ? closureDirectionRaw
      : "both",
    max_closure_nodes: Number.isFinite(maxClosureRaw)
      ? Math.max(10, Math.min(2000, Math.floor(maxClosureRaw)))
      : 180,
  };
}

export function defaultScopeHintForRole({
  roleType = "researcher",
  roleLabel = "",
  goal = "",
  recentArtifactNodeIds = [],
} = {}) {
  const cleanRoleType = String(roleType || roleLabel || "").trim().toLowerCase();
  const query = String(goal || "").trim().slice(0, 280) || undefined;

  if (["planner", "router", "operator", "context_curator"].includes(cleanRoleType)) {
    return {
      mode: "shared_only",
      budget_tokens: 900,
    };
  }

  if (cleanRoleType === "researcher") {
    return {
      mode: "unfold_query",
      query: query || "최근 사용자 요구 관련 핵심 맥락",
      budget_tokens: 1200,
    };
  }

  if (cleanRoleType === "synthesizer" || cleanRoleType === "messenger") {
    const artifactIds = dedupeScopeNodeIds(recentArtifactNodeIds).slice(0, 4);
    return {
      mode: "unfold_query",
      query: query || "upstream 결과를 종합하는 데 필요한 핵심 맥락",
      add_node_ids: artifactIds.length > 0 ? artifactIds : undefined,
      budget_tokens: 1000,
    };
  }

  if (["builder", "coder", "reviewer", "verifier"].includes(cleanRoleType)) {
    const artifactIds = dedupeScopeNodeIds(recentArtifactNodeIds).slice(0, 3);
    return {
      mode: "unfold_query",
      query: query || "코드 변경과 직접 연관된 맥락",
      add_node_ids: artifactIds.length > 0 ? artifactIds : undefined,
      budget_tokens: ["builder", "coder"].includes(cleanRoleType) ? 1400 : 1200,
    };
  }

  return {
    mode: "unfold_query",
    query: query || undefined,
    budget_tokens: 1200,
  };
}

export function defaultScopeHintForAgent({ agentId = "", goal = "", recentArtifactNodeIds = [] } = {}) {
  return defaultScopeHintForRole({
    roleType: String(agentId || "").trim().toLowerCase(),
    goal,
    recentArtifactNodeIds,
  });
}

export function resolveEffectiveScopeHint(rawScope, {
  roleType = "",
  roleLabel = "",
  agentId = "",
  goal = "",
  recentArtifactNodeIds = [],
} = {}) {
  const hasUserScope = !!(rawScope && typeof rawScope === "object" && Object.keys(rawScope).length > 0);
  const defaultSpec = defaultScopeHintForRole({
    roleType: roleType || agentId,
    roleLabel,
    goal,
    recentArtifactNodeIds,
  });
  const base = hasUserScope ? rawScope : defaultSpec;
  const fallbackBudget = hasUserScope
    ? Number(rawScope?.budget_tokens ?? rawScope?.budgetTokens)
    : Number(defaultSpec?.budget_tokens || 1200);
  return normalizeScopeHintCore(base, { fallbackBudget });
}

export function validateScopeHint(rawScope) {
  const spec = normalizeScopeHintCore(rawScope);
  const errors = [];
  if (!SCOPE_HINT_MODES.includes(String(spec?.mode || ""))) errors.push("invalid_mode");
  if (!Number.isFinite(Number(spec?.budget_tokens))) errors.push("invalid_budget_tokens");
  return {
    ok: errors.length === 0,
    errors,
    scope_hint: spec,
  };
}
