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
  if (type === "agent_run" || type === "synthesize_final") {
    return [
      type,
      normalizeText(row.agent || row.agent_id, { lower: true }),
      normalizeText(row.prompt || row.goal),
    ].join("|");
  }
  if (type === "spawn_parallel") {
    return [
      type,
      normalizeText(row.inputs?.parallel_group_id || row.parallel_group_id),
      asArray(row.agents).map((child) => normalizeText(child.agent, { lower: true })).join(","),
    ].join("|");
  }
  if (type === "checkpoint") {
    return [type, normalizeText(row.inputs?.checkpoint_id || row.checkpoint_id)].join("|");
  }
  if (type === "supervisor_decision") {
    return [type, normalizeText(row.inputs?.supervisor_instance_id)].join("|");
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
          agent: "builder",
          prompt: seedInstruction || "continue the requested implementation from the current workspace state.",
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
      { type: "agent_run", agent: "builder", prompt: goal, inputs: {} },
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
  const agentsByInstanceId = new Map();
  for (const agent of runtimeAgentList) {
    const slotId = normalizeText(agent?.slot_id || agent?.slotId);
    const instanceId = normalizeText(agent?.instance_id || agent?.instanceId);
    if (slotId && !agentsBySlotId.has(slotId)) agentsBySlotId.set(slotId, agent);
    if (instanceId && !agentsByInstanceId.has(instanceId)) agentsByInstanceId.set(instanceId, agent);
  }
  return {
    slots,
    slotsById,
    slotsByRole,
    runtimeAgents: runtimeAgentList,
    agentsBySlotId,
    agentsByInstanceId,
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
        const runtimeAgent = index.agentsBySlotId.get(slotId);
        if (!slot) return null;
        return {
          slot_id: slotId,
          role_id: normalizeRoleId(slot?.role_id || slot?.role_label),
          instance_id: normalizeText(node?.instance_id || node?.instanceId || runtimeAgent?.instance_id) || undefined,
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
    instance_id: normalizeText(index.agentsBySlotId.get(slot.slot_id)?.instance_id) || undefined,
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
      for (const toSlotId of toSlotIds) addEdge(fromSlotId, toSlotId, rawEdge?.relation);
    }
  }
  if (edges.length > 0) return edges;

  for (const rawEdge of asArray(teamPlan?.dependencies)) {
    const fromSlotIds = resolveSlotIds(index, rawEdge?.from);
    const toSlotIds = resolveSlotIds(index, rawEdge?.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) addEdge(fromSlotId, toSlotId, "precedes");
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

function buildParallelGroups(teamPlan = {}, runtimeAgents = []) {
  const explicitGroups = asArray(teamPlan?.execution_graph?.parallel_groups);
  if (explicitGroups.length > 0) return explicitGroups.map((group, index) => ({
    parallel_group_id: normalizeText(group?.parallel_group_id || group?.parallelGroupId || `parallel_group_${index + 1}`)
      || `parallel_group_${index + 1}`,
    slot_ids: asArray(group?.slot_ids ?? group?.slotIds).map((slotId) => normalizeText(slotId)).filter(Boolean),
    role_ids: asArray(group?.role_ids ?? group?.roleIds).map((roleId) => normalizeRoleId(roleId)).filter(Boolean),
    instance_ids: asArray(group?.instance_ids ?? group?.instanceIds).map((instanceId) => normalizeText(instanceId)).filter(Boolean),
  })).filter((group) => group.slot_ids.length > 1);
  return topologicalLevels(teamPlan, runtimeAgents)
    .filter((group) => group.length > 1)
    .map((group, index) => ({
      parallel_group_id: `parallel_group_${index + 1}`,
      slot_ids: group,
      role_ids: group.map((slotId) => {
        const slot = asArray(teamPlan?.slots).find((entry) => normalizeText(entry?.slot_id) === slotId);
        return normalizeRoleId(slot?.role_id || slot?.role_label);
      }).filter(Boolean),
      instance_ids: group.map((slotId) => {
        const agent = asArray(runtimeAgents).find((entry) => normalizeText(entry?.slot_id) === slotId);
        return normalizeText(agent?.instance_id);
      }).filter(Boolean),
    }));
}

function slotParallelSignature(slot = {}) {
  return [
    normalizeText(slot?.role_id || slot?.role_label, { lower: true }),
    ...asArray(slot?.required_skill_ids).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(slot?.preferred_skill_ids).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(slot?.required_context_types).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(slot?.required_tool_ids).map((entry) => normalizeText(entry, { lower: true })),
    normalizeText(slot?.purpose, { lower: true }),
  ].filter(Boolean).join("|");
}

function decideParallelCompilation({
  slots = [],
  edges = [],
  taskInterpretation = {},
} = {}) {
  const preference = normalizeText(taskInterpretation?.parallelism_preference, { lower: true }) || "hybrid";
  const slotIds = new Set(asArray(slots).map((slot) => normalizeText(slot?.slot_id)).filter(Boolean));
  const hasIntraGroupDependency = asArray(edges).some((edge) =>
    slotIds.has(normalizeText(edge?.from_slot_id || edge?.fromSlotId))
    && slotIds.has(normalizeText(edge?.to_slot_id || edge?.toSlotId))
  );
  const independent = slots.length > 1
    && slots.every((slot) => slot?.parallelizable === true)
    && !hasIntraGroupDependency;
  const distinctSignatures = new Set(slots.map((slot) => slotParallelSignature(slot))).size;
  const multiSourceHint = slots.some((slot) => {
    const purpose = normalizeText(slot?.purpose, { lower: true });
    const reason = normalizeText(slot?.selection_reason || slot?.selectionReason, { lower: true });
    return purpose.includes("independent")
      || purpose.includes("filing")
      || purpose.includes("news")
      || reason.includes("multi-source")
      || reason.includes("multi source");
  });

  if (!independent) {
    return {
      allowed: false,
      override_reason: "",
    };
  }
  if (preference === "sequential") {
    if (distinctSignatures > 1 || multiSourceHint) {
      return {
        allowed: true,
        override_reason: "parallelism_preference=sequential overridden for differentiated independent slots",
      };
    }
    return {
      allowed: false,
      override_reason: "",
    };
  }
  if (preference === "parallel") {
    return {
      allowed: true,
      override_reason: "",
    };
  }
  return {
    allowed: distinctSignatures > 1 || multiSourceHint,
    override_reason: "",
  };
}

export function deriveParallelGroupsFromRouteActions(actions = []) {
  const groups = [];
  for (const action of asArray(actions)) {
    if (normalizeText(action?.type, { lower: true }) !== "spawn_parallel") continue;
    const children = asArray(action?.agents);
    if (children.length < 2) continue;
    const instanceIds = children
      .map((child) => normalizeText(child?.inputs?.runtime_instance_id || child?.inputs?.runtimeInstanceId))
      .filter(Boolean);
    const slotIds = children
      .map((child) => normalizeText(child?.inputs?.slot_id || child?.inputs?.slotId))
      .filter(Boolean);
    const roleIds = children
      .map((child) => normalizeRoleId(child?.inputs?.role_id || child?.inputs?.roleId || child?.agent))
      .filter(Boolean);
    groups.push({
      parallel_group_id: normalizeText(
        action?.inputs?.parallel_group_id || action?.parallel_group_id || `parallel_group_${groups.length + 1}`
      ) || `parallel_group_${groups.length + 1}`,
      slot_ids: slotIds,
      role_ids: roleIds,
      instance_ids: instanceIds,
    });
  }
  return groups;
}

function createDependencyMap(teamPlan = {}, runtimeAgents = []) {
  const dependencyMap = new Map();
  for (const edge of normalizeEdges(teamPlan, runtimeAgents)) {
    const list = dependencyMap.get(edge.to_slot_id) || [];
    list.push(edge.from_slot_id);
    dependencyMap.set(edge.to_slot_id, list);
  }
  return dependencyMap;
}

function createCheckpointLookup(teamPlan = {}) {
  const bySlotId = new Map();
  for (const checkpoint of asArray(teamPlan?.checkpoints)) {
    for (const slotId of asArray(checkpoint?.target_slot_ids ?? checkpoint?.targetSlotIds)) {
      const list = bySlotId.get(normalizeText(slotId)) || [];
      list.push(checkpoint);
      bySlotId.set(normalizeText(slotId), list);
    }
  }
  return bySlotId;
}

function createCollaborationLookup(teamPlan = {}) {
  const byMemberInstanceId = new Map();
  for (const cell of asArray(teamPlan?.collaboration_cells)) {
    for (const instanceId of asArray(cell?.member_instance_ids)) {
      const key = normalizeText(instanceId);
      if (!key) continue;
      const list = byMemberInstanceId.get(key) || [];
      list.push(cell);
      byMemberInstanceId.set(key, list);
    }
  }
  return byMemberInstanceId;
}

function buildSlotPrompt({
  slot = {},
  runtimeAgent = {},
  roleId = "",
  goal = "",
  seedInstruction = "",
  taskInterpretation = {},
} = {}) {
  const cleanRoleId = normalizeRoleId(roleId || slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  if (cleanRoleId === "builder") {
    return normalizeText(seedInstruction || goal || slot?.purpose || runtimeAgent?.assigned_goal);
  }
  if (cleanRoleId === "synthesizer") {
    return normalizeText(
      slot?.purpose
      || taskInterpretation?.task_summary
      || goal
      || runtimeAgent?.assigned_goal
    );
  }
  return normalizeText(slot?.purpose || runtimeAgent?.assigned_goal || goal || seedInstruction);
}

function buildSlotActionInputs({
  slot = {},
  runtimeAgent = {},
  dependencyMap = new Map(),
  collaborationLookup = new Map(),
  checkpointIds = [],
  parallelGroupId = undefined,
  taskInterpretation = {},
  supervisorRuntime = null,
} = {}) {
  const instanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId);
  const slotId = normalizeText(slot?.slot_id || slot?.slotId);
  const roleId = normalizeRoleId(slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  const slotCollaborationCells = instanceId
    ? asArray(collaborationLookup.get(instanceId))
    : [];
  const managerCell = slotCollaborationCells.find((cell) => cell.pattern === "manager_as_tool");

  return {
    role_id: roleId || undefined,
    role_label: normalizeText(runtimeAgent?.role_label || roleId, { lower: true }) || undefined,
    runtime_instance_id: instanceId || undefined,
    slot_id: slotId || undefined,
    parallel_group_id: parallelGroupId || undefined,
    dependency_slot_ids: asArray(dependencyMap.get(slotId)).filter(Boolean),
    collaboration_cell_ids: slotCollaborationCells.map((cell) => cell.cell_id).filter(Boolean),
    checkpoint_ids: checkpointIds,
    report_back_to_instance_ids: slotCollaborationCells
      .map((cell) => cell.report_back_to_instance_id)
      .filter(Boolean),
    supervisor_instance_id: managerCell?.report_back_to_instance_id
      || (supervisorRuntime?.enabled === true ? supervisorRuntime.instance_id : undefined),
    deliverable_type: normalizeText(slot?.deliverable_type || taskInterpretation?.deliverable_type) || undefined,
    authority_profile_id: normalizeText(
      runtimeAgent?.authority_profile_id || slot?.authority_profile_id,
      { lower: true }
    ) || undefined,
    legacy_transport_agent_id: normalizeText(
      runtimeAgent?.template_id || getTransportRoleId(roleId),
      { lower: true }
    ) || undefined,
  };
}

function buildSlotRunAction({
  slot = {},
  runtimeAgent = {},
  goal = "",
  seedInstruction = "",
  dependencyMap = new Map(),
  collaborationLookup = new Map(),
  checkpointIds = [],
  parallelGroupId = undefined,
  taskInterpretation = {},
  supervisorRuntime = null,
  finalSynthesis = false,
} = {}) {
  const roleId = normalizeRoleId(slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  const prompt = buildSlotPrompt({
    slot,
    runtimeAgent,
    roleId,
    goal,
    seedInstruction,
    taskInterpretation,
  });
  if (!roleId || !prompt) return null;
  return {
    type: finalSynthesis ? "synthesize_final" : "agent_run",
    agent: roleId,
    prompt,
    inputs: {
      ...buildSlotActionInputs({
        slot,
        runtimeAgent,
        dependencyMap,
        collaborationLookup,
        checkpointIds,
        parallelGroupId,
        taskInterpretation,
        supervisorRuntime,
      }),
      final_synthesis: finalSynthesis === true || undefined,
    },
  };
}

function buildCheckpointAction(checkpoint = {}, {
  supervisorRuntime = null,
  targetInstanceIds = [],
} = {}) {
  const checkpointId = normalizeText(checkpoint?.checkpoint_id || checkpoint?.checkpointId);
  if (!checkpointId) return null;
  return {
    type: "checkpoint",
    label: normalizeText(checkpoint?.label || checkpointId) || checkpointId,
    prompt: normalizeText(checkpoint?.label || checkpointId) || checkpointId,
    inputs: {
      checkpoint_id: checkpointId,
      checkpoint_ids: [checkpointId],
      checkpoint_status: normalizeText(checkpoint?.status || "pending", { lower: true }) || "pending",
      target_slot_ids: asArray(checkpoint?.target_slot_ids ?? checkpoint?.targetSlotIds).map((slotId) => normalizeText(slotId)).filter(Boolean),
      trigger_after_instances: asArray(checkpoint?.trigger_after_instances).map((instanceId) => normalizeText(instanceId)).filter(Boolean),
      target_instance_ids: targetInstanceIds,
      approval_required: checkpoint?.approval_required === true,
      human_interrupt_allowed: checkpoint?.human_interrupt_allowed === true,
      supervisor_instance_id: normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId) || undefined,
      supervisor_decision: checkpoint?.supervisor_decision || undefined,
    },
    metadata: {
      kind: normalizeText(checkpoint?.kind, { lower: true }) || undefined,
      completion_signal: checkpoint?.completion_signal || undefined,
      selection_reason: checkpoint?.selection_reason || undefined,
    },
  };
}

function buildSupervisorDecisionAction({
  supervisorRuntime = null,
  slotIds = [],
  instanceIds = [],
  checkpointIds = [],
  label = "",
  summaryKind = "intermediate",
} = {}) {
  if (supervisorRuntime?.enabled !== true) return null;
  const supervisorInstanceId = normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId);
  if (!supervisorInstanceId) return null;
  return {
    type: "supervisor_decision",
    label: normalizeText(label || "Supervisor decision") || "Supervisor decision",
    prompt: normalizeText(label || "Supervisor decision") || "Supervisor decision",
    inputs: {
      supervisor_instance_id: supervisorInstanceId,
      target_slot_ids: asArray(slotIds).map((slotId) => normalizeText(slotId)).filter(Boolean),
      target_instance_ids: asArray(instanceIds).map((instanceId) => normalizeText(instanceId)).filter(Boolean),
      checkpoint_ids: asArray(checkpointIds).map((checkpointId) => normalizeText(checkpointId)).filter(Boolean),
      user_visible: supervisorRuntime?.user_visible === true,
      interaction_mode: normalizeText(supervisorRuntime?.interaction_mode, { lower: true }) || undefined,
      summary_kind: normalizeText(summaryKind, { lower: true }) || "intermediate",
    },
    metadata: {
      report_back: true,
    },
  };
}

function checkpointIdsForSlots(slotIds = [], checkpointLookup = new Map()) {
  const checkpoints = [];
  for (const slotId of slotIds) {
    for (const checkpoint of asArray(checkpointLookup.get(normalizeText(slotId)))) {
      if (!checkpoints.some((entry) => normalizeText(entry?.checkpoint_id) === normalizeText(checkpoint?.checkpoint_id))) {
        checkpoints.push(checkpoint);
      }
    }
  }
  return checkpoints;
}

function findTerminalSynthesizerSlotId(teamPlan = {}, slotOrder = []) {
  const slotsById = new Map(asArray(teamPlan?.slots).map((slot) => [normalizeText(slot?.slot_id), slot]));
  let terminalSlotId = "";
  for (const slotId of slotOrder) {
    const slot = slotsById.get(normalizeText(slotId));
    if (normalizeRoleId(slot?.role_id || slot?.role_label) === "synthesizer") {
      terminalSlotId = normalizeText(slot?.slot_id);
    }
  }
  return terminalSlotId;
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
  const dependencyMap = createDependencyMap(teamPlan, runtimeAgents);
  const collaborationLookup = createCollaborationLookup(teamPlan);
  const checkpointLookup = createCheckpointLookup(teamPlan);
  const supervisorRuntime = teamPlan?.supervisor_runtime && typeof teamPlan.supervisor_runtime === "object"
    ? teamPlan.supervisor_runtime
    : null;
  const edges = normalizeEdges(teamPlan, runtimeAgents);
  const parallelGroups = buildParallelGroups(teamPlan, runtimeAgents);
  const parallelGroupBySlot = new Map();
  for (const group of parallelGroups) {
    for (const slotId of asArray(group.slot_ids)) {
      parallelGroupBySlot.set(normalizeText(slotId), group.parallel_group_id);
    }
  }

  const terminalSynthesizerSlotId = findTerminalSynthesizerSlotId(teamPlan, slotOrder);
  const emittedCheckpointIds = new Set();
  const actions = [];

  for (const levelSlotIds of levels) {
    const runnableSlots = levelSlotIds
      .map((slotId) => index.slotsById.get(normalizeText(slotId)))
      .filter(Boolean)
      .filter((slot) => normalizeText(slot.slot_id) !== terminalSynthesizerSlotId);
    if (runnableSlots.length === 0) continue;

    const levelCheckpointList = checkpointIdsForSlots(
      runnableSlots.map((slot) => slot.slot_id),
      checkpointLookup
    );
    const parallelDecision = decideParallelCompilation({
      slots: runnableSlots,
      edges,
      taskInterpretation,
    });

    if (runnableSlots.length > 1 && parallelDecision.allowed) {
      const children = runnableSlots
        .map((slot) => {
          const runtimeAgent = findRuntimeAgentForSlot(slot, runtimeAgents);
          if (!runtimeAgent) return null;
          return buildSlotRunAction({
            slot,
            runtimeAgent,
            goal,
            seedInstruction,
            dependencyMap,
            collaborationLookup,
            checkpointIds: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
            parallelGroupId: parallelGroupBySlot.get(slot.slot_id),
            taskInterpretation,
            supervisorRuntime,
            finalSynthesis: false,
          });
        })
        .filter(Boolean);
      if (children.length > 0) {
        const slotIds = children.map((child) => normalizeText(child.inputs?.slot_id)).filter(Boolean);
        const instanceIds = children.map((child) => normalizeText(child.inputs?.runtime_instance_id)).filter(Boolean);
        actions.push({
          type: "spawn_parallel",
          label: `Parallel ${children.map((child) => child.agent).join(", ")}`,
          prompt: children.map((child) => child.prompt).join("\n\n"),
          inputs: {
            parallel_group_id: parallelGroupBySlot.get(slotIds[0]) || undefined,
            target_slot_ids: slotIds,
            target_instance_ids: instanceIds,
            checkpoint_ids: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
            supervisor_instance_id: normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId) || undefined,
          },
          agents: children,
          metadata: parallelDecision.override_reason
            ? { parallelism_override_reason: parallelDecision.override_reason }
            : undefined,
        });
        for (const checkpoint of levelCheckpointList) {
          const checkpointId = normalizeText(checkpoint?.checkpoint_id);
          if (!checkpointId || emittedCheckpointIds.has(checkpointId)) continue;
          emittedCheckpointIds.add(checkpointId);
          const checkpointAction = buildCheckpointAction(checkpoint, {
            supervisorRuntime,
            targetInstanceIds: instanceIds,
          });
          if (checkpointAction) actions.push(checkpointAction);
        }
        const supervisorAction = buildSupervisorDecisionAction({
          supervisorRuntime,
          slotIds,
          instanceIds,
          checkpointIds: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
          label: "Supervisor review after parallel group",
          summaryKind: "parallel_report",
        });
        if (supervisorAction) actions.push(supervisorAction);
      }
      continue;
    }

    for (const slot of runnableSlots) {
      const runtimeAgent = findRuntimeAgentForSlot(slot, runtimeAgents);
      if (!runtimeAgent) continue;
      const slotCheckpointList = checkpointIdsForSlots([slot.slot_id], checkpointLookup);
      const action = buildSlotRunAction({
        slot,
        runtimeAgent,
        goal,
        seedInstruction,
        dependencyMap,
        collaborationLookup,
        checkpointIds: slotCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
        parallelGroupId: parallelGroupBySlot.get(slot.slot_id),
        taskInterpretation,
        supervisorRuntime,
        finalSynthesis: false,
      });
      if (action) actions.push(action);

      for (const checkpoint of slotCheckpointList) {
        const checkpointId = normalizeText(checkpoint?.checkpoint_id);
        if (!checkpointId || emittedCheckpointIds.has(checkpointId)) continue;
        emittedCheckpointIds.add(checkpointId);
        const checkpointAction = buildCheckpointAction(checkpoint, {
          supervisorRuntime,
          targetInstanceIds: [runtimeAgent.instance_id].filter(Boolean),
        });
        if (checkpointAction) actions.push(checkpointAction);
      }
    }
  }

  if (terminalSynthesizerSlotId) {
    const synthesizerSlot = index.slotsById.get(terminalSynthesizerSlotId);
    const synthesizerAgent = synthesizerSlot
      ? findRuntimeAgentForSlot(synthesizerSlot, runtimeAgents)
      : null;
    const slotCheckpointList = checkpointIdsForSlots([terminalSynthesizerSlotId], checkpointLookup);
    const synthesisAction = synthesizerSlot && synthesizerAgent
      ? buildSlotRunAction({
        slot: synthesizerSlot,
        runtimeAgent: synthesizerAgent,
        goal,
        seedInstruction,
        dependencyMap,
        collaborationLookup,
        checkpointIds: slotCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
        parallelGroupId: parallelGroupBySlot.get(terminalSynthesizerSlotId),
        taskInterpretation,
        supervisorRuntime,
        finalSynthesis: true,
      })
      : null;
    if (synthesisAction) actions.push(synthesisAction);
    for (const checkpoint of slotCheckpointList) {
      const checkpointId = normalizeText(checkpoint?.checkpoint_id);
      if (!checkpointId || emittedCheckpointIds.has(checkpointId)) continue;
      emittedCheckpointIds.add(checkpointId);
      const checkpointAction = buildCheckpointAction(checkpoint, {
        supervisorRuntime,
        targetInstanceIds: synthesisAction?.inputs?.runtime_instance_id
          ? [synthesisAction.inputs.runtime_instance_id]
          : [],
      });
      if (checkpointAction) actions.push(checkpointAction);
    }
    const supervisorAction = buildSupervisorDecisionAction({
      supervisorRuntime,
      slotIds: [terminalSynthesizerSlotId],
      instanceIds: synthesisAction?.inputs?.runtime_instance_id
        ? [synthesisAction.inputs.runtime_instance_id]
        : [],
      checkpointIds: slotCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
      label: "Supervisor final synthesis review",
      summaryKind: "final_output",
    });
    if (supervisorAction) actions.push(supervisorAction);
  }

  if (normalizeText(mode, { lower: true }) !== "chat" && actions.length < 12) {
    actions.push({ type: "git_summary" });
  }
  return actions.slice(0, 16);
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
  const effectiveParallelGroups = deriveParallelGroupsFromRouteActions(effectiveActions);

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
      parallel_groups: effectiveParallelGroups,
      checkpoints: teamPlan?.checkpoints || [],
      collaboration_cells: teamPlan?.collaboration_cells || [],
      authority_graph: teamPlan?.authority_graph || [],
      selection_explanations: teamPlan?.selection_explanations || [],
      supervisor_runtime: teamPlan?.supervisor_runtime || undefined,
    },
  };
}
