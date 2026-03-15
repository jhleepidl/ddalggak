import { getTransportRoleId, normalizeRoleId } from "../compatibility/legacy_roles.js";

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function actionSignature(action = {}) {
  const row = action && typeof action === "object" ? action : {};
  const type = normalizeText(row.type, { lower: true });
  if (type === "agent_run") {
    return [
      type,
      normalizeText(row.agent || row.agent_id, { lower: true }),
      normalizeText(row.prompt || row.goal),
    ].join("|");
  }
  if (type === "chatgpt_prompt") {
    return [type, normalizeText(row.question)].join("|");
  }
  return type;
}

function sameActionPlan(a = [], b = []) {
  const aList = Array.isArray(a) ? a : [];
  const bList = Array.isArray(b) ? b : [];
  if (aList.length !== bList.length) return false;
  for (let index = 0; index < aList.length; index += 1) {
    if (actionSignature(aList[index]) !== actionSignature(bList[index])) return false;
  }
  return true;
}

export function createDefaultRunRoute(mode, goal, seedInstruction = "") {
  const cleanMode = normalizeText(mode || "run", { lower: true }) || "run";
  if (cleanMode === "continue") {
    return {
      actions: [
        {
          type: "agent_run",
          agent: "coder",
          prompt: seedInstruction || "run/shared docs and continue the requested implementation.",
          inputs: {},
        },
        { type: "git_summary" },
      ],
      reason: "fallback: continue default",
      mode: cleanMode,
    };
  }

  return {
    actions: [
      { type: "agent_run", agent: "researcher", prompt: goal, inputs: {} },
      { type: "agent_run", agent: "coder", prompt: goal, inputs: {} },
      { type: "git_summary" },
    ],
    reason: "fallback: run default",
    mode: cleanMode,
  };
}

export function findExecutionOrder(teamPlan = {}) {
  const explicit = asArray(teamPlan?.execution_order);
  if (explicit.length > 0) return explicit;
  const graphOrder = asArray(teamPlan?.execution_graph?.order);
  if (graphOrder.length > 0) return graphOrder;
  const slots = asArray(teamPlan?.slots).map((slot) => normalizeText(slot?.role_id || slot?.slot_id));
  if (slots.length > 0) return slots;
  return asArray(teamPlan?.roles).map((role) => normalizeText(role?.id || role?.role_id || role?.role_label));
}

export function mapTeamPlanToRouteActions(teamBuild = {}, {
  mode = "run",
  goal = "",
  seedInstruction = "",
} = {}) {
  const runtimeAgents = asArray(teamBuild?.runtime_agents);
  if (runtimeAgents.length === 0) return [];

  const order = findExecutionOrder(teamBuild?.team_plan || {});
  const actions = [];
  for (const roleOrSlot of order) {
    const key = normalizeText(roleOrSlot, { lower: true });
    const match = runtimeAgents.find((agent) => {
      const roleId = normalizeText(agent?.role_id, { lower: true });
      const roleLabel = normalizeText(agent?.role_label, { lower: true });
      const slotId = normalizeText(agent?.slot_id, { lower: true });
      return key && (key === roleId || key === roleLabel || key === slotId);
    });
    if (!match) continue;
    const roleId = normalizeRoleId(match.role_id || match.role_label);
    const prompt = normalizeText(
      roleId === "builder"
        ? (seedInstruction || goal)
        : goal
    );
    if (!prompt) continue;
    const targetAgent = normalizeText(
      match.template_id
      || (match.synthesized === true ? "" : getTransportRoleId(roleId)),
      { lower: true }
    );
    if (!targetAgent) continue;
    actions.push({
      type: "agent_run",
      agent: targetAgent,
      prompt,
      inputs: {
        role_id: roleId || undefined,
        role_label: normalizeText(match.role_label || roleId, { lower: true }) || undefined,
        runtime_instance_id: normalizeText(match.instance_id) || undefined,
        slot_id: normalizeText(match.slot_id) || undefined,
      },
    });
    if (actions.length >= 4) break;
  }

  if (normalizeText(mode, { lower: true }) !== "chat" && actions.length < 4) {
    actions.push({ type: "git_summary" });
  }
  return actions.slice(0, 4);
}

export function shouldUseGeneratedTeamActions({
  normalizedRoute = null,
  defaultRoute = null,
  teamActions = [],
  hasExplicitRoutePlan = true,
} = {}) {
  if (!hasExplicitRoutePlan) {
    return Array.isArray(teamActions) && teamActions.length > 0;
  }
  const explicitActions = Array.isArray(normalizedRoute?.actions) ? normalizedRoute.actions : [];
  if (!Array.isArray(teamActions) || teamActions.length === 0) return false;
  if (explicitActions.length === 0) return true;

  const reason = normalizeText(normalizedRoute?.reason, { lower: true });
  if (reason.includes("fallback")) return true;

  const fallbackActions = Array.isArray(defaultRoute?.actions) ? defaultRoute.actions : [];
  if (fallbackActions.length > 0 && sameActionPlan(explicitActions, fallbackActions)) return true;

  return false;
}
