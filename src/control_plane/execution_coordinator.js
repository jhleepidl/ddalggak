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

function createPlanIndex(teamPlan = {}, runtimeAgents = []) {
  const slots = asArray(teamPlan?.slots).filter((slot) => normalizeText(slot?.slot_id));
  const runtimeAgentList = asArray(runtimeAgents);
  const slotsById = new Map(slots.map((slot) => [normalizeText(slot.slot_id), slot]));
  const slotsByRole = new Map();
  for (const slot of slots) {
    const roleId = normalizeRoleId(slot?.role_id || slot?.role_label);
    if (!roleId) continue;
    const list = slotsByRole.get(roleId) || [];
    list.push(slot);
    slotsByRole.set(roleId, list);
  }
  const agentsBySlotId = new Map();
  for (const agent of runtimeAgentList) {
    const slotId = normalizeText(agent?.slot_id || agent?.slotId);
    if (slotId && !agentsBySlotId.has(slotId)) {
      agentsBySlotId.set(slotId, agent);
    }
  }
  return {
    slots,
    slotsById,
    slotsByRole,
    runtimeAgents: runtimeAgentList,
    agentsBySlotId,
  };
}

function resolveSlotIds(index = {}, rawRef = "") {
  const slotRef = normalizeText(rawRef);
  if (slotRef && index.slotsById.has(slotRef)) return [slotRef];
  const roleId = normalizeRoleId(rawRef);
  if (!roleId) return [];
  return asArray(index.slotsByRole.get(roleId)).map((slot) => normalizeText(slot.slot_id)).filter(Boolean);
}

function normalizeNodes(teamPlan = {}, runtimeAgents = []) {
  const index = createPlanIndex(teamPlan, runtimeAgents);
  const explicitNodes = asArray(teamPlan?.execution_graph?.nodes)
    .map((node) => {
      const slotIds = resolveSlotIds(index, node?.slot_id || node?.slotId || node?.role_id || node?.roleId);
      return slotIds.map((slotId) => {
        const slot = index.slotsById.get(slotId);
        if (!slot) return null;
        return {
          slot_id: slotId,
          role_id: normalizeRoleId(slot?.role_id || slot?.role_label),
          parallelizable: slot?.parallelizable === true,
        };
      });
    })
    .flat()
    .filter(Boolean);
  if (explicitNodes.length > 0) return explicitNodes;
  return index.slots.map((slot) => ({
    slot_id: normalizeText(slot.slot_id),
    role_id: normalizeRoleId(slot?.role_id || slot?.role_label),
    parallelizable: slot?.parallelizable === true,
  })).filter((slot) => slot.slot_id && slot.role_id);
}

function normalizeEdges(teamPlan = {}, runtimeAgents = []) {
  const index = createPlanIndex(teamPlan, runtimeAgents);
  const rawEdges = asArray(teamPlan?.execution_graph?.edges);
  const edges = [];
  const addEdge = (fromSlotId = "", toSlotId = "", relation = "precedes") => {
    if (!fromSlotId || !toSlotId || fromSlotId === toSlotId) return;
    if (edges.some((edge) => edge.from_slot_id === fromSlotId && edge.to_slot_id === toSlotId)) return;
    const fromSlot = index.slotsById.get(fromSlotId);
    const toSlot = index.slotsById.get(toSlotId);
    if (!fromSlot || !toSlot) return;
    edges.push({
      from_slot_id: fromSlotId,
      to_slot_id: toSlotId,
      from: normalizeRoleId(fromSlot?.role_id || fromSlot?.role_label),
      to: normalizeRoleId(toSlot?.role_id || toSlot?.role_label),
      relation: normalizeText(relation || "precedes", { lower: true }) || "precedes",
    });
  };

  for (const rawEdge of rawEdges) {
    const fromSlotIds = resolveSlotIds(index, rawEdge?.from_slot_id || rawEdge?.fromSlotId || rawEdge?.from);
    const toSlotIds = resolveSlotIds(index, rawEdge?.to_slot_id || rawEdge?.toSlotId || rawEdge?.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) {
        addEdge(fromSlotId, toSlotId, rawEdge?.relation);
      }
    }
  }
  if (edges.length > 0) return edges;

  for (const rawEdge of asArray(teamPlan?.dependencies)) {
    const fromSlotIds = resolveSlotIds(index, rawEdge?.from);
    const toSlotIds = resolveSlotIds(index, rawEdge?.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) {
        addEdge(fromSlotId, toSlotId, "precedes");
      }
    }
  }
  return edges;
}

function topologicalLevels(teamPlan = {}, runtimeAgents = []) {
  const nodes = normalizeNodes(teamPlan, runtimeAgents);
  const slotIds = [...new Set(nodes.map((node) => node.slot_id))];
  const edges = normalizeEdges(teamPlan, runtimeAgents);
  const incoming = new Map(slotIds.map((id) => [id, 0]));
  const outgoing = new Map(slotIds.map((id) => [id, []]));
  for (const edge of edges) {
    if (!incoming.has(edge.from_slot_id) || !incoming.has(edge.to_slot_id)) continue;
    incoming.set(edge.to_slot_id, (incoming.get(edge.to_slot_id) || 0) + 1);
    outgoing.get(edge.from_slot_id).push(edge.to_slot_id);
  }
  const remaining = new Set(slotIds);
  const levels = [];
  while (remaining.size > 0) {
    const ready = slotIds.filter((id) => remaining.has(id) && (incoming.get(id) || 0) === 0);
    if (ready.length === 0) {
      levels.push([...remaining]);
      break;
    }
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const child of outgoing.get(id) || []) {
        incoming.set(child, Math.max(0, (incoming.get(child) || 0) - 1));
      }
    }
  }
  return levels;
}

export function findExecutionOrder(teamPlan = {}, runtimeAgents = []) {
  const index = createPlanIndex(teamPlan, runtimeAgents);
  const explicitOrder = [];
  for (const entry of asArray(teamPlan?.execution_graph?.order)) {
    for (const slotId of resolveSlotIds(index, entry)) {
      if (!explicitOrder.includes(slotId)) explicitOrder.push(slotId);
    }
  }
  if (explicitOrder.length > 0) {
    for (const slot of index.slots) {
      if (!explicitOrder.includes(slot.slot_id)) explicitOrder.push(slot.slot_id);
    }
    return explicitOrder;
  }

  const legacyOrder = [];
  for (const entry of asArray(teamPlan?.execution_order)) {
    for (const slotId of resolveSlotIds(index, entry)) {
      if (!legacyOrder.includes(slotId)) legacyOrder.push(slotId);
    }
  }
  if (legacyOrder.length > 0) {
    for (const slot of index.slots) {
      if (!legacyOrder.includes(slot.slot_id)) legacyOrder.push(slot.slot_id);
    }
    return legacyOrder;
  }

  return topologicalLevels(teamPlan, runtimeAgents).flat();
}

function findRuntimeAgentForSlot(slot = {}, runtimeAgents = []) {
  const slotId = normalizeText(slot?.slot_id || slot?.slotId);
  const roleId = normalizeRoleId(slot?.role_id || slot?.role_label);
  if (slotId) {
    const bySlot = asArray(runtimeAgents).find((agent) => normalizeText(agent?.slot_id || agent?.slotId) === slotId);
    if (bySlot) return bySlot;
  }
  if (roleId) {
    const byRole = asArray(runtimeAgents).find((agent) => normalizeRoleId(agent?.role_id || agent?.role_label) === roleId);
    if (byRole) return byRole;
  }
  return null;
}

export function mapTeamPlanToRouteActions(teamBuild = {}, {
  mode = "run",
  goal = "",
  seedInstruction = "",
  taskInterpretation = {},
} = {}) {
  const teamPlan = teamBuild?.team_plan || {};
  const runtimeAgents = asArray(teamBuild?.runtime_agents);
  if (runtimeAgents.length === 0) return [];

  const index = createPlanIndex(teamPlan, runtimeAgents);
  const slotOrder = findExecutionOrder(teamPlan, runtimeAgents);
  const levels = topologicalLevels(teamPlan, runtimeAgents);
  const parallelGroupBySlot = new Map();
  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    if (levels[levelIndex].length <= 1) continue;
    const groupId = `parallel_group_${levelIndex + 1}`;
    for (const slotId of levels[levelIndex]) parallelGroupBySlot.set(slotId, groupId);
  }
  const dependencyMap = new Map();
  for (const edge of normalizeEdges(teamPlan, runtimeAgents)) {
    const list = dependencyMap.get(edge.to_slot_id) || [];
    list.push(edge.from_slot_id);
    dependencyMap.set(edge.to_slot_id, list);
  }

  const actions = [];
  for (const slotId of slotOrder) {
    const slot = index.slotsById.get(slotId);
    if (!slot) continue;
    const match = findRuntimeAgentForSlot(slot, runtimeAgents);
    if (!match) continue;
    const roleId = normalizeRoleId(slot?.role_id || match?.role_id || match?.role_label);
    const prompt = normalizeText(
      roleId === "builder"
        ? (seedInstruction || goal || slot?.purpose || match?.assigned_goal)
        : (slot?.purpose || match?.assigned_goal || goal || seedInstruction)
    );
    if (!prompt) continue;
    const targetAgent = normalizeText(
      match.template_id
      || getTransportRoleId(roleId)
      || match.role_label
      || roleId,
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
        slot_id: normalizeText(slotId) || undefined,
        parallel_group_id: parallelGroupBySlot.get(slotId) || undefined,
        dependency_slot_ids: asArray(dependencyMap.get(slotId)).filter(Boolean),
        deliverable_type: normalizeText(slot?.deliverable_type || taskInterpretation?.deliverable_type) || undefined,
      },
    });
    if (actions.length >= 8) break;
  }

  if (normalizeText(mode, { lower: true }) !== "chat" && actions.length < 8) {
    actions.push({ type: "git_summary" });
  }
  return actions.slice(0, 8);
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

function classifyActionSource({
  useTeamActions = false,
  explicitActions = [],
} = {}) {
  if (useTeamActions) return "generated_team_actions";
  if (Array.isArray(explicitActions) && explicitActions.length > 0) return "explicit_route_plan";
  return "default_fallback_route";
}

export function coordinateExecutionPlan({
  mode = "run",
  goal = "",
  seedInstruction = "",
  routePlan = null,
  teamPlan = null,
  runtimeAgents = [],
  taskInterpretation = {},
} = {}) {
  const defaultRoute = createDefaultRunRoute(mode, goal, seedInstruction);
  const normalizedRoute = routePlan && typeof routePlan === "object" ? routePlan : { actions: [], reason: "" };
  const hasExplicitRoutePlan = !!(routePlan && typeof routePlan === "object");
  const teamActions = mapTeamPlanToRouteActions({
    team_plan: teamPlan,
    runtime_agents: runtimeAgents,
  }, {
    mode,
    goal,
    seedInstruction,
    taskInterpretation,
  });
  const useTeamActions = shouldUseGeneratedTeamActions({
    normalizedRoute,
    defaultRoute,
    teamActions,
    hasExplicitRoutePlan,
  });
  const explicitActions = Array.isArray(normalizedRoute.actions) ? normalizedRoute.actions : [];
  const effectiveActions = useTeamActions
    ? teamActions
    : (explicitActions.length > 0 ? explicitActions : defaultRoute.actions);
  const actionSource = classifyActionSource({
    useTeamActions,
    explicitActions,
  });
  const levels = topologicalLevels(teamPlan, runtimeAgents);
  const parallelGroups = levels
    .filter((group) => group.length > 1)
    .map((group, index) => ({
      parallel_group_id: `parallel_group_${index + 1}`,
      slot_ids: group,
      role_ids: group.map((slotId) => {
        const slot = asArray(teamPlan?.slots).find((entry) => normalizeText(entry?.slot_id) === slotId);
        return normalizeRoleId(slot?.role_id || slot?.role_label);
      }).filter(Boolean),
    }));

  return {
    action_source: actionSource,
    default_route: defaultRoute,
    route_plan: {
      ...(normalizedRoute || {}),
      mode: normalizeText(mode, { lower: true }) || "run",
      actions: effectiveActions,
      action_source: actionSource,
      reason: normalizeText(
        actionSource === "default_fallback_route"
          ? (defaultRoute.reason || "fallback route")
          : (normalizedRoute.reason || "generated route")
      ) || "generated route",
      execution_graph: teamPlan?.execution_graph || undefined,
      parallel_groups: parallelGroups,
      checkpoints: teamPlan?.checkpoints || [],
      supervisor_runtime: teamPlan?.supervisor_runtime || undefined,
    },
  };
}
