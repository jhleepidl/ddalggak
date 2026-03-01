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

export function normalizeAction(raw) {
  const row = asObject(raw);
  const type = String(row.type || "").trim().toLowerCase();
  if (!type) return null;

  if (type === "run_agent" || type === "agent_run") return normalizeRunAgent(row);
  if (type === "propose_agent" || type === "create_agent" || type === "invite_agent") return normalizeProposeAgent(row);
  if (type === "need_more_detail" || type === "expand_context") return normalizeNeedMoreDetail(row);
  if (type === "open_context" || type === "context") return normalizeOpenContext(row);
  if (type === "summarize" || type === "summary") return normalizeSummarize(row);
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
  return new Set(["run_agent", "propose_agent", "need_more_detail", "open_context", "summarize"]);
}

export function parseAllowlist(jobConfig = {}, tools = []) {
  const cfg = asObject(jobConfig);
  const raw = cfg.allowed_actions || cfg.allow_actions || cfg.actions_allowlist || cfg.action_allowlist;
  const list = Array.isArray(raw) ? raw : [];
  const set = new Set(
    list
      .map((row) => String(row || "").trim().toLowerCase())
      .filter(Boolean)
  );
  if (set.size === 0) {
    for (const value of defaultAllowlist()) set.add(value);
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
