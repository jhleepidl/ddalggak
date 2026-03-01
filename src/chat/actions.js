function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function normalizeRisk(raw, fallback = "L1") {
  const key = String(raw || fallback).trim().toUpperCase();
  if (["L0", "L1", "L2", "L3"].includes(key)) return key;
  return fallback;
}

function riskScore(raw) {
  const key = normalizeRisk(raw, "L0");
  if (key === "L3") return 3;
  if (key === "L2") return 2;
  if (key === "L1") return 1;
  return 0;
}

function normalizeNodeIds(raw) {
  if (Array.isArray(raw)) {
    return raw.map((row) => String(row || "").trim()).filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((row) => row.trim()).filter(Boolean);
  }
  return [];
}

function normalizeRunAgent(raw) {
  const row = asObject(raw);
  const agentId = String(row.agent_id || row.agentId || row.agent || "").trim().toLowerCase();
  const goal = String(row.goal || row.prompt || row.task || "").trim();
  if (!agentId || !goal) return null;
  return {
    type: "run_agent",
    agent_id: agentId,
    goal,
    inputs: row.inputs && typeof row.inputs === "object" ? row.inputs : {},
    risk: normalizeRisk(row.risk, "L1"),
  };
}

function normalizeProposeAgent(raw) {
  const row = asObject(raw);
  const draft = asObject(row.agent || row.profile || row.draft || row);
  const agentId = String(
    row.agent_id
    || row.agentId
    || draft.id
    || draft.agent_id
    || ""
  ).trim().toLowerCase();
  if (!agentId) return null;
  return {
    type: "propose_agent",
    agent_id: agentId,
    name: String(row.name || draft.name || agentId).trim() || agentId,
    description: String(row.description || draft.description || "").trim(),
    provider: String(row.provider || draft.provider || "gemini").trim().toLowerCase() || "gemini",
    model: String(row.model || draft.model || row.provider || draft.provider || "gemini").trim(),
    prompt: String(row.prompt || draft.prompt || row.goal || "").trim(),
    meta: draft.meta && typeof draft.meta === "object" ? draft.meta : {},
    risk: normalizeRisk(row.risk, "L2"),
  };
}

function normalizeNeedMoreDetail(raw) {
  const row = asObject(raw);
  const contextSetId = String(row.context_set_id || row.contextSetId || "").trim();
  const depthRaw = Number(row.depth);
  const maxCharsRaw = Number(row.max_chars ?? row.maxChars);
  return {
    type: "need_more_detail",
    context_set_id: contextSetId,
    node_ids: normalizeNodeIds(row.node_ids ?? row.nodeIds),
    depth: Number.isFinite(depthRaw) ? Math.max(1, Math.min(3, Math.floor(depthRaw))) : 1,
    max_chars: Number.isFinite(maxCharsRaw) ? Math.max(1200, Math.min(24000, Math.floor(maxCharsRaw))) : 7000,
    risk: "L0",
  };
}

function normalizeOpenContext(raw) {
  const row = asObject(raw);
  const scope = String(row.scope || row.target || "current").trim().toLowerCase();
  return {
    type: "open_context",
    scope: scope === "global" ? "global" : "current",
    risk: "L0",
  };
}

function normalizeSummarize(raw) {
  const row = asObject(raw);
  return {
    type: "summarize",
    hint: String(row.hint || row.reason || "").trim(),
    risk: "L0",
  };
}

function normalizeSearchPublicAgents(raw) {
  const row = asObject(raw);
  return {
    type: "search_public_agents",
    query: String(row.query || row.keyword || row.q || "").trim(),
    limit: Number.isFinite(Number(row.limit)) ? Math.max(1, Math.min(10, Math.floor(Number(row.limit)))) : 5,
    risk: "L0",
  };
}

function normalizeInstallAgentBlueprint(raw) {
  const row = asObject(raw);
  const blueprintId = String(row.blueprint_id || row.blueprintId || row.id || "").trim();
  const publicNodeId = String(row.public_node_id || row.publicNodeId || row.node_id || row.nodeId || "").trim();
  const override = String(row.agent_id_override || row.agentIdOverride || row.agent_id || "").trim().toLowerCase();
  return {
    type: "install_agent_blueprint",
    blueprint_id: blueprintId,
    public_node_id: publicNodeId,
    agent_id_override: override,
    risk: "L1",
  };
}

function normalizePublishAgent(raw) {
  const row = asObject(raw);
  const agentNodeId = String(row.agent_node_id || row.agentNodeId || row.node_id || row.nodeId || "").trim();
  const agentId = String(row.agent_id || row.agentId || row.agent || "").trim().toLowerCase();
  return {
    type: "publish_agent",
    agent_node_id: agentNodeId,
    agent_id: agentId,
    risk: "L1",
  };
}

function normalizeToggleAgent(raw, enabled = true) {
  const row = asObject(raw);
  const agentId = String(row.agent_id || row.agentId || row.agent || row.id || "").trim().toLowerCase();
  if (!agentId) return null;
  return {
    type: enabled ? "enable_agent" : "disable_agent",
    agent_id: agentId,
    risk: "L1",
  };
}

function normalizeToggleTool(raw, enabled = true) {
  const row = asObject(raw);
  const toolId = String(row.tool_id || row.toolId || row.tool || row.id || row.name || "").trim().toLowerCase();
  if (!toolId) return null;
  return {
    type: enabled ? "enable_tool" : "disable_tool",
    tool_id: toolId,
    risk: "L1",
  };
}

function normalizeListAgents(raw) {
  const row = asObject(raw);
  return {
    type: "list_agents",
    include_disabled: row.include_disabled !== false,
    risk: "L0",
  };
}

function normalizeListTools(raw) {
  const row = asObject(raw);
  return {
    type: "list_tools",
    include_disabled: row.include_disabled !== false,
    risk: "L0",
  };
}

function normalizeCreateAgent(raw) {
  const row = asObject(raw);
  const draft = asObject(row.agent || row.profile || row);
  const agentId = String(
    row.agent_id
    || row.agentId
    || draft.id
    || draft.agent_id
    || ""
  ).trim().toLowerCase();
  if (!agentId) return null;
  return {
    type: "create_agent",
    agent: {
      id: agentId,
      name: String(draft.name || agentId).trim() || agentId,
      description: String(draft.description || "").trim(),
      provider: String(draft.provider || "gemini").trim().toLowerCase() || "gemini",
      model: String(draft.model || draft.provider || "gemini").trim() || "gemini",
      prompt: String(draft.prompt || "").trim(),
      meta: draft.meta && typeof draft.meta === "object" ? draft.meta : {},
    },
    format: String(row.format || "json").trim() || "json",
    risk: normalizeRisk(row.risk, "L2"),
  };
}

function normalizeUpdateAgent(raw) {
  const row = asObject(raw);
  const agentId = String(row.agent_id || row.agentId || row.id || "").trim().toLowerCase();
  const patchRaw = asObject(row.patch || row.agent || row.profile_patch);
  if (!agentId || Object.keys(patchRaw).length === 0) return null;
  return {
    type: "update_agent",
    agentId,
    patch: patchRaw,
    format: String(row.format || "json").trim() || "json",
    risk: normalizeRisk(row.risk, "L2"),
  };
}

function normalizeGetStatus(raw) {
  const row = asObject(raw);
  return {
    type: "get_status",
    detail: String(row.detail || "summary").trim().toLowerCase() === "full" ? "full" : "summary",
    risk: "L0",
  };
}

function normalizeInterrupt(raw) {
  const row = asObject(raw);
  const mode = String(row.mode || row.interrupt_mode || "").trim().toLowerCase();
  return {
    type: "interrupt",
    mode: mode === "cancel" ? "cancel" : "replan",
    note: String(row.note || row.reason || "").trim(),
    risk: "L0",
  };
}

function normalizeSpawnAgents(raw) {
  const row = asObject(raw);
  const entries = Array.isArray(row.agents)
    ? row.agents
    : (Array.isArray(row.children) ? row.children : []);
  const children = [];
  for (const entry of entries) {
    const child = asObject(entry);
    const agentId = String(child.agent_id || child.agentId || child.agent || "").trim().toLowerCase();
    const goal = String(child.goal || child.prompt || child.task || "").trim();
    if (!agentId || !goal) continue;
    children.push({
      agent_id: agentId,
      goal,
      inputs: child.inputs && typeof child.inputs === "object" ? child.inputs : {},
      risk: normalizeRisk(child.risk, "L1"),
    });
    if (children.length >= 8) break;
  }
  if (children.length === 0) return null;
  return {
    type: "spawn_agents",
    summary: String(row.summary || row.goal || row.reason || "").trim(),
    agents: children,
    max_parallel: Number.isFinite(Number(row.max_parallel))
      ? Math.max(1, Math.min(8, Math.floor(Number(row.max_parallel))))
      : null,
    risk: normalizeRisk(row.risk, "L1"),
  };
}

export function normalizeAction(raw) {
  const row = asObject(raw);
  const type = String(row.type || "").trim().toLowerCase();
  if (!type) return null;

  if (type === "run_agent" || type === "agent_run") return normalizeRunAgent(row);
  if (type === "propose_agent" || type === "create_agent" || type === "invite_agent") return normalizeProposeAgent(row);
  if (type === "need_more_detail" || type === "expand_context") return normalizeNeedMoreDetail(row);
  if (type === "open_context" || type === "context") return normalizeOpenContext(row);
  if (type === "summarize" || type === "summary") return normalizeSummarize(row);
  if (type === "search_public_agents" || type === "find_public_agents") return normalizeSearchPublicAgents(row);
  if (type === "install_agent_blueprint" || type === "install_public_agent") return normalizeInstallAgentBlueprint(row);
  if (type === "publish_agent" || type === "request_publish_agent") return normalizePublishAgent(row);
  if (type === "disable_agent") return normalizeToggleAgent(row, false);
  if (type === "enable_agent") return normalizeToggleAgent(row, true);
  if (type === "disable_tool") return normalizeToggleTool(row, false);
  if (type === "enable_tool") return normalizeToggleTool(row, true);
  if (type === "list_agents") return normalizeListAgents(row);
  if (type === "list_tools") return normalizeListTools(row);
  if (type === "create_agent") return normalizeCreateAgent(row);
  if (type === "update_agent") return normalizeUpdateAgent(row);
  if (type === "get_status" || type === "status") return normalizeGetStatus(row);
  if (type === "interrupt" || type === "cancel") return normalizeInterrupt(row);
  if (type === "spawn_agents" || type === "fork_join" || type === "spawn") return normalizeSpawnAgents(row);
  return null;
}

export function normalizeActionPlan(rawPlan = {}, { maxActions = 4 } = {}) {
  const plan = asObject(rawPlan);
  const actionsRaw = Array.isArray(plan.actions) ? plan.actions : [];
  const normalized = [];
  for (const action of actionsRaw) {
    if (normalized.length >= maxActions) break;
    const parsed = normalizeAction(action);
    if (!parsed) continue;
    normalized.push(parsed);
  }
  const finalStyle = String(plan.final_response_style || "").trim().toLowerCase();
  return {
    reason: String(plan.reason || "").trim() || "supervisor decision",
    actions: normalized,
    final_response_style: finalStyle === "detailed" ? "detailed" : "concise",
  };
}

export function defaultAllowlist() {
  return new Set([
    "run_agent",
    "propose_agent",
    "need_more_detail",
    "open_context",
    "summarize",
    "search_public_agents",
    "install_agent_blueprint",
    "publish_agent",
    "disable_agent",
    "enable_agent",
    "disable_tool",
    "enable_tool",
    "list_agents",
    "list_tools",
    "create_agent",
    "update_agent",
    "get_status",
    "interrupt",
    "spawn_agents",
  ]);
}

export function parseAllowlist(jobConfig = {}, tools = []) {
  const cfg = asObject(jobConfig);
  const raw = cfg.allowed_actions || cfg.allow_actions || cfg.actions_allowlist || cfg.action_allowlist;
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set(defaultAllowlist());
  for (const row of list) {
    const key = String(row || "").trim().toLowerCase();
    if (!key) continue;
    set.add(key);
  }

  for (const spec of Array.isArray(tools) ? tools : []) {
    const row = asObject(spec);
    const actionTypes = Array.isArray(row.action_types) ? row.action_types : [];
    for (const actionType of actionTypes) {
      const key = String(actionType || "").trim().toLowerCase();
      if (key) set.add(key);
    }
  }
  return set;
}

export function isActionAllowed(action, allowlist) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) return false;
  if (!(allowlist instanceof Set)) return defaultAllowlist().has(type);
  return allowlist.has(type);
}

export function actionNeedsApproval(action, {
  approval = {},
  provider = "",
} = {}) {
  if (action && (action.approved === true || action._approved === true)) {
    return { required: false, reason: "" };
  }
  const policy = asObject(approval);
  const requiredRisks = Array.isArray(policy.require_for_risk)
    ? policy.require_for_risk.map((row) => normalizeRisk(row, "L3"))
    : ["L3"];
  const risk = normalizeRisk(action?.risk, "L0");
  const requiresByRisk = requiredRisks.some((row) => riskScore(risk) >= riskScore(row));
  if (requiresByRisk) {
    return { required: true, reason: `risk=${risk}` };
  }

  const normalizedProvider = String(provider || "").trim().toLowerCase();
  if (policy.require_file_write && action?.type === "run_agent" && normalizedProvider === "codex") {
    return { required: true, reason: "provider=codex(file-write policy)" };
  }
  return { required: false, reason: "" };
}
