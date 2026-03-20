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
  const graphNodeMap = new Map(
    normalizeExecutionGraphNodes(teamPlan, runtimeAgents)
      .map((node) => [normalizeText(node.slot_id || node.participant_id), node])
      .filter((entry) => entry[0])
  );
  const edges = [];
  const addEdge = (fromSlotId = "", toSlotId = "", relation = "precedes", condition = "") => {
    if (!fromSlotId || !toSlotId || fromSlotId === toSlotId) return;
    if (edges.some((edge) => edge.from_slot_id === fromSlotId && edge.to_slot_id === toSlotId && edge.relation === (normalizeText(relation || "precedes", { lower: true }) || "precedes"))) return;
    const fromSlot = index.slotsById.get(fromSlotId);
    const toSlot = index.slotsById.get(toSlotId);
    const fromNode = graphNodeMap.get(fromSlotId);
    const toNode = graphNodeMap.get(toSlotId);
    edges.push({
      from_slot_id: fromSlotId,
      to_slot_id: toSlotId,
      from: normalizeRoleId(fromSlot?.role_id || fromSlot?.role_label || fromNode?.role_id || fromNode?.label || fromSlotId),
      to: normalizeRoleId(toSlot?.role_id || toSlot?.role_label || toNode?.role_id || toNode?.label || toSlotId),
      relation: normalizeText(relation || "precedes", { lower: true }) || "precedes",
      condition: normalizeText(condition),
    });
  };

  for (const rawEdge of rawEdges) {
    const fromSlotIds = resolveSlotIds(index, rawEdge?.from_slot_id || rawEdge?.fromSlotId || rawEdge?.from);
    const toSlotIds = resolveSlotIds(index, rawEdge?.to_slot_id || rawEdge?.toSlotId || rawEdge?.to);
    const resolvedFrom = fromSlotIds.length > 0
      ? fromSlotIds
      : [normalizeText(rawEdge?.from_slot_id || rawEdge?.fromSlotId || rawEdge?.from)].filter(Boolean);
    const resolvedTo = toSlotIds.length > 0
      ? toSlotIds
      : [normalizeText(rawEdge?.to_slot_id || rawEdge?.toSlotId || rawEdge?.to)].filter(Boolean);
    for (const fromSlotId of resolvedFrom) {
      for (const toSlotId of resolvedTo) addEdge(fromSlotId, toSlotId, rawEdge?.relation || rawEdge?.kind, rawEdge?.condition);
    }
  }
  if (edges.length > 0) return edges;

  for (const rawEdge of asArray(teamPlan?.dependencies)) {
    const fromSlotIds = resolveSlotIds(index, rawEdge?.from);
    const toSlotIds = resolveSlotIds(index, rawEdge?.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) addEdge(fromSlotId, toSlotId, "precedes", rawEdge?.condition);
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

function normalizeExecutionGraphNodes(teamPlan = {}, runtimeAgents = []) {
  const graph = teamPlan?.execution_graph && typeof teamPlan.execution_graph === 'object'
    ? teamPlan.execution_graph
    : {};
  const explicitNodes = asArray(graph.nodes)
    .map((node, index) => {
      const slotId = normalizeText(node?.slot_id || node?.slotId || node?.participant_id || node?.participantId || node?.id);
      if (!slotId) return null;
      return {
        node_id: normalizeText(node?.node_id || node?.nodeId || `node_${index + 1}`) || `node_${index + 1}`,
        slot_id: slotId,
        participant_id: normalizeText(node?.participant_id || node?.participantId || slotId) || slotId,
        kind: normalizeText(node?.kind || 'task', { lower: true }) || 'task',
        label: normalizeText(node?.label || node?.name || slotId) || slotId,
        role_id: normalizeRoleId(node?.role_id || node?.roleId || ''),
      };
    })
    .filter(Boolean);
  if (explicitNodes.length > 0) return explicitNodes;
  return normalizeNodes(teamPlan, runtimeAgents).map((node, index) => ({
    node_id: `node_${index + 1}`,
    slot_id: normalizeText(node.slot_id),
    participant_id: normalizeText(node.slot_id),
    kind: 'task',
    label: normalizeText(node.slot_id),
    role_id: normalizeRoleId(node.role_id),
  }));
}

function topologicalLevelsForExecutionNodes(teamPlan = {}, runtimeAgents = []) {
  const nodes = normalizeExecutionGraphNodes(teamPlan, runtimeAgents);
  const ids = [...new Set(nodes.map((node) => normalizeText(node.slot_id || node.participant_id)).filter(Boolean))];
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const edges = normalizeEdges(teamPlan, runtimeAgents);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of edges) {
    const fromId = normalizeText(edge?.from_slot_id || edge?.fromSlotId || edge?.from);
    const toId = normalizeText(edge?.to_slot_id || edge?.toSlotId || edge?.to);
    if (!fromId || !toId || fromId === toId || !idSet.has(fromId) || !idSet.has(toId)) continue;
    outgoing.get(fromId)?.push(toId);
    incoming.set(toId, (incoming.get(toId) || 0) + 1);
  }
  const remaining = new Set(ids);
  const levels = [];
  while (remaining.size > 0) {
    const ready = ids.filter((id) => remaining.has(id) && (incoming.get(id) || 0) === 0);
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

function createEdgeConditionMaps(edges = []) {
  const incomingBySlot = new Map();
  const outgoingBySlot = new Map();
  for (const edge of asArray(edges)) {
    const fromSlotId = normalizeText(edge?.from_slot_id || edge?.fromSlotId || edge?.from);
    const toSlotId = normalizeText(edge?.to_slot_id || edge?.toSlotId || edge?.to);
    const condition = normalizeText(edge?.condition);
    const relation = normalizeText(edge?.relation || edge?.kind, { lower: true }) || 'precedes';
    if (!fromSlotId || !toSlotId) continue;
    const descriptor = { from_slot_id: fromSlotId, to_slot_id: toSlotId, condition, relation };
    if (!incomingBySlot.has(toSlotId)) incomingBySlot.set(toSlotId, []);
    incomingBySlot.get(toSlotId).push(descriptor);
    if (!outgoingBySlot.has(fromSlotId)) outgoingBySlot.set(fromSlotId, []);
    outgoingBySlot.get(fromSlotId).push(descriptor);
  }
  return { incomingBySlot, outgoingBySlot };
}

function createParticipantDescriptorMap(teamBuild = {}, teamPlan = {}) {
  const runtimeSnapshot = teamBuild?.runtime_team_snapshot && typeof teamBuild.runtime_team_snapshot === 'object'
    ? teamBuild.runtime_team_snapshot
    : null;
  const structures = [
    teamBuild?.structure_v2,
    runtimeSnapshot?.structure_v2,
    teamPlan?.structure_v2,
  ].filter((entry) => entry && typeof entry === 'object');
  const lists = [
    teamBuild?.runtime_participants,
    teamBuild?.non_executable_participants,
    runtimeSnapshot?.runtime_participants,
    runtimeSnapshot?.non_executable_participants,
  ];
  const rows = [];
  for (const structure of structures) rows.push(...asArray(structure?.participants));
  for (const list of lists) rows.push(...asArray(list));
  const out = new Map();
  for (const row of rows) {
    const participantId = normalizeText(row?.participant_id || row?.id || row?.slot_id || row?.slotId);
    if (!participantId || out.has(participantId)) continue;
    out.set(participantId, row);
  }
  return out;
}


function pickRuntimeRepairLoopTargets({
  incomingConditions = [],
  outgoingConditions = [],
  slotsById = new Map(),
  runtimeAgents = [],
} = {}) {
  const runtimeList = asArray(runtimeAgents);
  const bySlotId = new Map();
  for (const agent of runtimeList) {
    const slotId = normalizeText(agent?.slot_id || agent?.slotId);
    if (slotId && !bySlotId.has(slotId)) bySlotId.set(slotId, agent);
  }
  const materialize = (slotId = '') => {
    const cleanSlotId = normalizeText(slotId);
    if (!cleanSlotId) return null;
    const slot = slotsById instanceof Map ? (slotsById.get(cleanSlotId) || {}) : {};
    const runtimeAgent = bySlotId.get(cleanSlotId) || null;
    return {
      slot_id: cleanSlotId,
      role_id: normalizeRoleId(slot?.role_id || slot?.role_label || runtimeAgent?.role_id || runtimeAgent?.role_label),
      agent_id: normalizeRoleId(runtimeAgent?.role_id || runtimeAgent?.role_label) || '',
      runtime_instance_id: normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId),
    };
  };
  const incomingCandidates = asArray(incomingConditions).map((edge) => materialize(edge?.from_slot_id)).filter(Boolean);
  const outgoingCandidates = asArray(outgoingConditions).map((edge) => materialize(edge?.to_slot_id)).filter(Boolean);
  const pick = (candidates = [], preferredRoles = []) => {
    const list = asArray(candidates).filter((entry) => entry?.agent_id || entry?.slot_id);
    for (const preferred of preferredRoles) {
      const found = list.find((entry) => entry.role_id === preferred || entry.agent_id === preferred);
      if (found) return found;
    }
    return list[0] || null;
  };
  const repair = pick(incomingCandidates, ['builder', 'coder', 'developer', 'implementer', 'operator']);
  const verifier = pick(outgoingCandidates, ['reviewer', 'judge', 'synthesizer', 'researcher']);
  return {
    repair,
    verifier,
  };
}

function structuralNodeActionType(kind = '') {
  const normalizedKind = normalizeText(kind, { lower: true });
  if (normalizedKind === 'gate') return 'gate_wait';
  if (normalizedKind === 'human') return 'human_checkpoint';
  if (normalizedKind === 'tool' || normalizedKind === 'tool_proxy') return 'tool_proxy_call';
  if (normalizedKind === 'memory' || normalizedKind === 'memory_node') return 'memory_sync';
  return '';
}

function buildStructuralNodeAction({
  node = {},
  participant = {},
  graphDescriptor = {},
  edgeConditionMaps = {},
  checkpointIds = [],
  supervisorRuntime = null,
  compatibilityFallback = false,
  slotsById = new Map(),
  runtimeAgents = [],
} = {}) {
  const slotId = normalizeText(node?.slot_id || node?.participant_id || participant?.participant_id);
  const participantId = normalizeText(node?.participant_id || participant?.participant_id || slotId);
  const roleId = normalizeRoleId(participant?.role || node?.role_id || node?.roleId);
  const gateRole = normalizeText(participant?.role || node?.role_id || node?.roleId, { lower: true });
  const nodeKind = normalizeText(participant?.kind || node?.kind, { lower: true }) || 'task';
  const actionType = structuralNodeActionType(nodeKind);
  if (!actionType || !slotId) return null;
  const incomingConditions = asArray(edgeConditionMaps?.incomingBySlot?.get(slotId))
    .filter((edge) => normalizeText(edge?.condition))
    .map((edge) => ({ from_slot_id: edge.from_slot_id, condition: edge.condition, relation: edge.relation }));
  const outgoingConditions = asArray(edgeConditionMaps?.outgoingBySlot?.get(slotId))
    .filter((edge) => normalizeText(edge?.condition))
    .map((edge) => ({ to_slot_id: edge.to_slot_id, condition: edge.condition, relation: edge.relation }));
  const label = normalizeText(participant?.name || node?.label || slotId) || slotId;
  const repairTargets = actionType === 'tool_proxy_call'
    ? pickRuntimeRepairLoopTargets({
      incomingConditions,
      outgoingConditions,
      slotsById,
      runtimeAgents,
    })
    : { repair: null, verifier: null };
  return {
    type: actionType,
    label,
    prompt: label,
    inputs: {
      slot_id: slotId,
      participant_id: participantId || undefined,
      role_id: roleId || undefined,
      node_kind: nodeKind,
      checkpoint_ids: asArray(checkpointIds).map((checkpointId) => normalizeText(checkpointId)).filter(Boolean),
      supervisor_instance_id: normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId) || undefined,
      gate_type: actionType === 'gate_wait' ? (gateRole || roleId || 'approval') : undefined,
      approval_required: actionType === 'gate_wait' ? ['approval', 'mutating_confirm'].includes(gateRole || roleId) : (actionType === 'human_checkpoint'),
      required_tool_ids: actionType === 'tool_proxy_call'
        ? asArray(participant?.recommended_tool_ids || participant?.required_tool_ids || participant?.tool_ids).map((toolId) => normalizeText(toolId, { lower: true })).filter(Boolean)
        : undefined,
      memory_keys: actionType === 'memory_sync'
        ? asArray(participant?.memory_keys || participant?.bound_memory_keys).map((key) => normalizeText(key)).filter(Boolean)
        : undefined,
      incoming_conditions: incomingConditions,
      outgoing_conditions: outgoingConditions,
      structure_pattern: graphDescriptor.pattern || undefined,
      topology_validation_fallback: compatibilityFallback || undefined,
      summary_kind: actionType === 'memory_sync' ? 'memory_sync' : 'control_checkpoint',
      repair_target_agent_id: actionType === 'tool_proxy_call' ? (repairTargets.repair?.agent_id || undefined) : undefined,
      repair_target_slot_id: actionType === 'tool_proxy_call' ? (repairTargets.repair?.slot_id || undefined) : undefined,
      repair_target_runtime_instance_id: actionType === 'tool_proxy_call' ? (repairTargets.repair?.runtime_instance_id || undefined) : undefined,
      verifier_agent_id: actionType === 'tool_proxy_call' ? (repairTargets.verifier?.agent_id || undefined) : undefined,
      verifier_slot_id: actionType === 'tool_proxy_call' ? (repairTargets.verifier?.slot_id || undefined) : undefined,
      verifier_runtime_instance_id: actionType === 'tool_proxy_call' ? (repairTargets.verifier?.runtime_instance_id || undefined) : undefined,
      repair_attempt_limit: actionType === 'tool_proxy_call' && repairTargets.repair?.agent_id ? 1 : undefined,
    },
    metadata: {
      structure_pattern: graphDescriptor.pattern || undefined,
      stage_mode: 'structural_node',
      topology_validation_fallback: compatibilityFallback || undefined,
    },
  };
}

function buildCommitteeConsensusAction({
  graphDescriptor = {},
  checkpointIds = [],
  supervisorRuntime = null,
  memberSlotIds = [],
  chairSlotId = '',
  compatibilityFallback = false,
} = {}) {
  if (normalizeText(graphDescriptor?.pattern, { lower: true }) !== 'committee') return null;
  const cleanMemberSlotIds = asArray(memberSlotIds).map((slotId) => normalizeText(slotId)).filter(Boolean);
  if (cleanMemberSlotIds.length === 0) return null;
  const consensusMode = normalizeText(graphDescriptor?.committee?.mode, { lower: true }) || 'majority';
  const quorumRaw = Number(graphDescriptor?.committee?.quorum);
  const quorum = Number.isFinite(quorumRaw)
    ? Math.max(1, Math.floor(quorumRaw))
    : (consensusMode === 'unanimous' ? cleanMemberSlotIds.length : Math.ceil(cleanMemberSlotIds.length / 2));
  return {
    type: 'committee_consensus',
    label: 'Committee consensus check',
    prompt: `Evaluate committee readiness before the chair produces the final decision (mode=${consensusMode}${quorum ? `, quorum=${quorum}` : ''}).`,
    inputs: {
      member_slot_ids: cleanMemberSlotIds,
      chair_slot_id: normalizeText(chairSlotId) || undefined,
      consensus_mode: consensusMode,
      committee_quorum: quorum,
      checkpoint_ids: asArray(checkpointIds).map((checkpointId) => normalizeText(checkpointId)).filter(Boolean),
      supervisor_instance_id: normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId) || undefined,
      structure_pattern: graphDescriptor.pattern || undefined,
      topology_validation_fallback: compatibilityFallback || undefined,
      summary_kind: 'committee_consensus',
    },
    metadata: {
      structure_pattern: graphDescriptor.pattern || undefined,
      stage_mode: 'committee_consensus',
      topology_validation_fallback: compatibilityFallback || undefined,
    },
  };
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

function findScopeSpecForSlot(slot = {}, runtimeAgent = {}, teamPlan = {}) {
  const scopeSpecs = asArray(teamPlan?.scope_specs ?? teamPlan?.scopeSpecs);
  const instanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId);
  const slotId = normalizeText(slot?.slot_id || slot?.slotId || runtimeAgent?.slot_id || runtimeAgent?.slotId);
  const roleId = normalizeRoleId(slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  return scopeSpecs.find((scope) => normalizeText(scope?.target_instance_id || scope?.targetInstanceId) === instanceId)
    || scopeSpecs.find((scope) => normalizeText(scope?.target_slot_id || scope?.targetSlotId) === slotId)
    || scopeSpecs.find((scope) => normalizeRoleId(scope?.role_id || scope?.roleId) === roleId)
    || null;
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
  incomingConditions = [],
  outgoingConditions = [],
} = {}) {
  const cleanRoleId = normalizeRoleId(roleId || slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  let prompt = '';
  if (cleanRoleId === "builder") {
    prompt = normalizeText(seedInstruction || goal || slot?.purpose || runtimeAgent?.assigned_goal);
  } else if (cleanRoleId === "synthesizer") {
    prompt = normalizeText(
      slot?.purpose
      || taskInterpretation?.task_summary
      || goal
      || runtimeAgent?.assigned_goal
    );
  } else {
    prompt = normalizeText(slot?.purpose || runtimeAgent?.assigned_goal || goal || seedInstruction);
  }
  const incoming = asArray(incomingConditions).filter((entry) => normalizeText(entry?.condition));
  const outgoing = asArray(outgoingConditions).filter((entry) => normalizeText(entry?.condition));
  if (incoming.length > 0) {
    prompt = appendPromptSuffix(prompt, `Only execute this step when these route conditions are satisfied: ${incoming.map((entry) => `${entry.condition} (from ${entry.from_slot_id || 'upstream'})`).join('; ')}.`);
  }
  if (outgoing.length > 0) {
    const routeSignalExample = JSON.stringify({ signals: [outgoing[0]?.condition || 'condition_name'] });
    prompt = appendPromptSuffix(prompt, `Your output will be used for conditional routing with these branches: ${outgoing.map((entry) => `${entry.condition} -> ${entry.to_slot_id || 'next'}`).join('; ')}. When you know which branch conditions are satisfied, include a ROUTE_SIGNALS_JSON block with exact condition strings. Example: ROUTE_SIGNALS_JSON ${routeSignalExample}. Only include the conditions that should be activated.`);
  }
  return prompt;
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
  scopeSpec = null,
  incomingConditions = [],
  outgoingConditions = [],
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
    display_label: normalizeText(runtimeAgent?.display_label || slot?.display_label) || undefined,
    runtime_instance_id: instanceId || undefined,
    slot_id: slotId || undefined,
    slot_label: normalizeText(slot?.display_label) || undefined,
    slot_purpose: normalizeText(slot?.purpose) || undefined,
    preset_id: normalizeText(runtimeAgent?.preset_id || runtimeAgent?.presetId, { lower: true }) || undefined,
    attached_skill_ids: asArray(runtimeAgent?.attached_skill_ids ?? runtimeAgent?.attachedSkillIds).filter(Boolean),
    provider: normalizeText(runtimeAgent?.provider, { lower: true }) || undefined,
    model: normalizeText(runtimeAgent?.model) || undefined,
    personality_profile: runtimeAgent?.personality_profile && typeof runtimeAgent.personality_profile === 'object'
      ? runtimeAgent.personality_profile
      : (runtimeAgent?.personalityProfile && typeof runtimeAgent.personalityProfile === 'object' ? runtimeAgent.personalityProfile : undefined),
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
    scope_id: normalizeText(scopeSpec?.scope_id || scopeSpec?.scopeId) || undefined,
    memory_grants: scopeSpec?.memory_grants && typeof scopeSpec.memory_grants === "object"
      ? scopeSpec.memory_grants
      : undefined,
    visibility_mode: normalizeText(scopeSpec?.visibility_mode || scopeSpec?.visibilityMode, { lower: true }) || undefined,
    legacy_transport_agent_id: normalizeText(
      runtimeAgent?.template_id || getTransportRoleId(roleId),
      { lower: true }
    ) || undefined,
    incoming_conditions: asArray(incomingConditions).filter((entry) => entry && typeof entry === 'object'),
    outgoing_conditions: asArray(outgoingConditions).filter((entry) => entry && typeof entry === 'object'),
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
  scopeSpec = null,
  incomingConditions = [],
  outgoingConditions = [],
} = {}) {
  const roleId = normalizeRoleId(slot?.role_id || runtimeAgent?.role_id || runtimeAgent?.role_label);
  const prompt = buildSlotPrompt({
    slot,
    runtimeAgent,
    roleId,
    goal,
    seedInstruction,
    taskInterpretation,
    incomingConditions,
    outgoingConditions,
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
        scopeSpec,
        incomingConditions,
        outgoingConditions,
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

function resolveExplicitFinalSlotId(teamPlan = {}, slotOrder = [], runtimeAgents = []) {
  const index = createPlanIndex(teamPlan, runtimeAgents);
  const explicitRefs = [
    teamPlan?.execution_graph?.final_participant_id,
    teamPlan?.execution_graph?.final_slot_id,
    teamPlan?.execution_graph?.finalSlotId,
    teamPlan?.final_answer_owner,
    teamPlan?.finalAnswerOwner,
  ];
  for (const ref of explicitRefs) {
    const slotIds = resolveSlotIds(index, ref);
    if (slotIds.length > 0) return slotIds[0];
  }
  return '';
}

function findTerminalFinalSlotId(teamPlan = {}, slotOrder = [], runtimeAgents = []) {
  const slotsById = new Map(asArray(teamPlan?.slots).map((slot) => [normalizeText(slot?.slot_id), slot]));
  const explicitFinal = resolveExplicitFinalSlotId(teamPlan, slotOrder, runtimeAgents);
  if (explicitFinal) return explicitFinal;
  let terminalSynthesizerSlotId = '';
  for (const slotId of slotOrder) {
    const slot = slotsById.get(normalizeText(slotId));
    if (normalizeRoleId(slot?.role_id || slot?.role_label) === 'synthesizer') {
      terminalSynthesizerSlotId = normalizeText(slot?.slot_id);
    }
  }
  if (terminalSynthesizerSlotId) return terminalSynthesizerSlotId;
  return '';
}

function createSequentialLevelsFromOrder(slotOrder = []) {
  return asArray(slotOrder).map((slotId) => [normalizeText(slotId)]).filter((group) => group[0]);
}

function extractExecutionGraphDescriptor(teamPlan = {}, runtimeAgents = []) {
  const graph = teamPlan?.execution_graph && typeof teamPlan.execution_graph === 'object'
    ? teamPlan.execution_graph
    : {};
  const validation = graph.validation && typeof graph.validation === 'object' ? graph.validation : {};
  const errors = asArray(validation.errors).map((entry) => normalizeText(entry)).filter(Boolean);
  const warnings = asArray(validation.warnings).map((entry) => normalizeText(entry)).filter(Boolean);
  const pattern = normalizeText(graph.pattern || graph.execution_pattern, { lower: true }) || 'hybrid';
  const debate = graph.debate && typeof graph.debate === 'object' ? graph.debate : null;
  const committee = graph.committee && typeof graph.committee === 'object' ? graph.committee : null;
  const finalSlotId = resolveExplicitFinalSlotId(teamPlan, findExecutionOrder(teamPlan, runtimeAgents), runtimeAgents);
  return {
    pattern,
    validation: {
      errors,
      warnings,
      pattern_ready: validation.pattern_ready !== false && errors.length === 0,
      strict_pattern_ready: validation.strict_pattern_ready === true,
    },
    cyclic_topology: graph.cyclic_topology === true,
    final_slot_id: finalSlotId,
    debate: debate ? {
      rounds: Number.isFinite(Number(debate.rounds)) ? Math.max(1, Math.min(6, Math.floor(Number(debate.rounds)))) : 1,
      adjudicator_slot_id: normalizeText(debate.adjudicator_participant_id || debate.adjudicator_slot_id),
      debater_slot_ids: asArray(debate.debater_participant_ids || debate.debater_slot_ids).map((entry) => normalizeText(entry)).filter(Boolean),
      rebuttal_required: debate.rebuttal_required !== false,
    } : null,
    committee: committee ? {
      mode: normalizeText(committee.mode, { lower: true }) || 'majority',
      quorum: Number.isFinite(Number(committee.quorum)) ? Math.max(1, Math.floor(Number(committee.quorum))) : undefined,
      chair_slot_id: normalizeText(committee.chair_participant_id || committee.chair_slot_id),
      member_slot_ids: asArray(committee.member_participant_ids || committee.member_slot_ids).map((entry) => normalizeText(entry)).filter(Boolean),
    } : null,
  };
}

function appendPromptSuffix(prompt = '', suffix = '') {
  const base = normalizeText(prompt);
  const extra = normalizeText(suffix);
  if (!base) return extra;
  if (!extra) return base;
  return `${base}

${extra}`;
}

function annotateAction(action = null, metadata = {}, inputPatch = {}) {
  const row = action && typeof action === 'object' ? action : null;
  if (!row) return null;
  return {
    ...row,
    inputs: {
      ...(row.inputs && typeof row.inputs === 'object' ? row.inputs : {}),
      ...(inputPatch && typeof inputPatch === 'object' ? inputPatch : {}),
    },
    metadata: {
      ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}),
      ...(metadata && typeof metadata === 'object' ? metadata : {}),
    },
  };
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
  const graphDescriptor = extractExecutionGraphDescriptor(teamPlan, runtimeAgents);
  const compatibilityFallback = graphDescriptor.cyclic_topology === true || graphDescriptor.validation.errors.length > 0;
  const participantDescriptorMap = createParticipantDescriptorMap(teamBuild, teamPlan);
  const graphNodes = normalizeExecutionGraphNodes(teamPlan, runtimeAgents);
  const graphNodeBySlotId = new Map(graphNodes.map((node) => [normalizeText(node.slot_id || node.participant_id), node]));
  const executionLevels = compatibilityFallback
    ? createSequentialLevelsFromOrder(slotOrder)
    : (() => {
      const derivedLevels = topologicalLevelsForExecutionNodes(teamPlan, runtimeAgents);
      return derivedLevels.length > 0 ? derivedLevels : topologicalLevels(teamPlan, runtimeAgents);
    })();
  const dependencyMap = createDependencyMap(teamPlan, runtimeAgents);
  const collaborationLookup = createCollaborationLookup(teamPlan);
  const checkpointLookup = createCheckpointLookup(teamPlan);
  const supervisorRuntime = teamPlan?.supervisor_runtime && typeof teamPlan.supervisor_runtime === "object"
    ? teamPlan.supervisor_runtime
    : null;
  const edges = normalizeEdges(teamPlan, runtimeAgents);
  const edgeConditionMaps = createEdgeConditionMaps(edges);
  const parallelGroups = buildParallelGroups(teamPlan, runtimeAgents);
  const parallelGroupBySlot = new Map();
  for (const group of parallelGroups) {
    for (const slotId of asArray(group.slot_ids)) {
      parallelGroupBySlot.set(normalizeText(slotId), group.parallel_group_id);
    }
  }

  const terminalFinalSlotId = findTerminalFinalSlotId(teamPlan, slotOrder, runtimeAgents);
  const emittedCheckpointIds = new Set();
  const actions = [];

  const pushCheckpointActions = (slotIds = [], targetInstanceIds = []) => {
    const slotCheckpointList = checkpointIdsForSlots(slotIds, checkpointLookup);
    for (const checkpoint of slotCheckpointList) {
      const checkpointId = normalizeText(checkpoint?.checkpoint_id);
      if (!checkpointId || emittedCheckpointIds.has(checkpointId)) continue;
      emittedCheckpointIds.add(checkpointId);
      const checkpointAction = buildCheckpointAction(checkpoint, {
        supervisorRuntime,
        targetInstanceIds,
      });
      if (checkpointAction) actions.push(checkpointAction);
    }
    return slotCheckpointList;
  };

  const makeSlotAction = ({
    slot,
    runtimeAgent,
    finalSynthesis = false,
    promptSuffix = '',
    metadata = {},
    inputPatch = {},
    summaryKind = undefined,
  } = {}) => {
    if (!slot || !runtimeAgent) return null;
    const scopeSpec = findScopeSpecForSlot(slot, runtimeAgent, teamPlan);
    const slotId = normalizeText(slot.slot_id);
    let action = buildSlotRunAction({
      slot,
      runtimeAgent,
      goal,
      seedInstruction,
      dependencyMap,
      collaborationLookup,
      checkpointIds: checkpointIdsForSlots([slot.slot_id], checkpointLookup).map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
      parallelGroupId: parallelGroupBySlot.get(slot.slot_id),
      taskInterpretation,
      supervisorRuntime,
      finalSynthesis,
      scopeSpec,
      incomingConditions: asArray(edgeConditionMaps.incomingBySlot.get(slotId)).filter((entry) => normalizeText(entry?.condition)),
      outgoingConditions: asArray(edgeConditionMaps.outgoingBySlot.get(slotId)).filter((entry) => normalizeText(entry?.condition)),
    });
    if (!action) return null;
    if (promptSuffix) action = { ...action, prompt: appendPromptSuffix(action.prompt, promptSuffix) };
    return annotateAction(action, metadata, {
      structure_pattern: graphDescriptor.pattern || undefined,
      topology_validation_fallback: compatibilityFallback || undefined,
      summary_kind: summaryKind || undefined,
      ...(inputPatch && typeof inputPatch === 'object' ? inputPatch : {}),
    });
  };

  const buildGenericActions = () => {
    for (const levelSlotIds of executionLevels) {
      const structuralNodes = levelSlotIds
        .map((slotId) => graphNodeBySlotId.get(normalizeText(slotId)))
        .filter(Boolean)
        .filter((node) => {
          const nodeKind = normalizeText(node?.kind, { lower: true });
          return structuralNodeActionType(nodeKind) !== '';
        });
      const runnableSlots = levelSlotIds
        .map((slotId) => index.slotsById.get(normalizeText(slotId)))
        .filter(Boolean)
        .filter((slot) => normalizeText(slot.slot_id) !== terminalFinalSlotId);
      if (runnableSlots.length === 0 && structuralNodes.length === 0) continue;

      const levelCheckpointList = checkpointIdsForSlots(
        [...runnableSlots.map((slot) => slot.slot_id), ...structuralNodes.map((node) => normalizeText(node.slot_id || node.participant_id))],
        checkpointLookup
      );
      for (const node of structuralNodes) {
        const slotId = normalizeText(node.slot_id || node.participant_id);
        const participant = participantDescriptorMap.get(normalizeText(node.participant_id || slotId)) || participantDescriptorMap.get(slotId) || {};
        const action = buildStructuralNodeAction({
          node,
          participant,
          graphDescriptor,
          edgeConditionMaps,
          checkpointIds: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
          supervisorRuntime,
          compatibilityFallback,
          slotsById: index.slotsById,
          runtimeAgents,
        });
        if (action) actions.push(action);
        pushCheckpointActions([slotId], []);
      }
      if (runnableSlots.length === 0) continue;

      const parallelDecision = compatibilityFallback
        ? { allowed: false, override_reason: '' }
        : decideParallelCompilation({
          slots: runnableSlots,
          edges,
          taskInterpretation,
        });

      if (runnableSlots.length > 1 && parallelDecision.allowed) {
        const children = runnableSlots
          .map((slot) => {
            const runtimeAgent = findRuntimeAgentForSlot(slot, runtimeAgents);
            if (!runtimeAgent) return null;
            const scopeSpec = findScopeSpecForSlot(slot, runtimeAgent, teamPlan);
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
              scopeSpec,
              incomingConditions: asArray(edgeConditionMaps.incomingBySlot.get(normalizeText(slot.slot_id))).filter((entry) => normalizeText(entry?.condition)),
              outgoingConditions: asArray(edgeConditionMaps.outgoingBySlot.get(normalizeText(slot.slot_id))).filter((entry) => normalizeText(entry?.condition)),
            });
          })
          .filter(Boolean)
          .map((child) => annotateAction(child, {
            structure_pattern: graphDescriptor.pattern || undefined,
          }, {
            structure_pattern: graphDescriptor.pattern || undefined,
            topology_validation_fallback: compatibilityFallback || undefined,
          }));
        if (children.length > 0) {
          const slotIds = children.map((child) => normalizeText(child.inputs?.slot_id)).filter(Boolean);
          const instanceIds = children.map((child) => normalizeText(child.inputs?.runtime_instance_id)).filter(Boolean);
          actions.push({
            type: 'spawn_parallel',
            label: `Parallel ${children.map((child) => child.agent).join(', ')}`,
            prompt: children.map((child) => child.prompt).join('\n\n'),
            inputs: {
              parallel_group_id: parallelGroupBySlot.get(slotIds[0]) || undefined,
              target_slot_ids: slotIds,
              target_instance_ids: instanceIds,
              checkpoint_ids: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
              supervisor_instance_id: normalizeText(supervisorRuntime?.instance_id || supervisorRuntime?.instanceId) || undefined,
              structure_pattern: graphDescriptor.pattern || undefined,
            },
            agents: children,
            metadata: {
              ...(parallelDecision.override_reason ? { parallelism_override_reason: parallelDecision.override_reason } : {}),
              ...(compatibilityFallback ? { topology_validation_fallback: true } : {}),
            },
          });
          pushCheckpointActions(slotIds, instanceIds);
          const supervisorAction = buildSupervisorDecisionAction({
            supervisorRuntime,
            slotIds,
            instanceIds,
            checkpointIds: levelCheckpointList.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
            label: 'Supervisor review after parallel group',
            summaryKind: 'parallel_report',
          });
          if (supervisorAction) actions.push(supervisorAction);
        }
        continue;
      }

      for (const slot of runnableSlots) {
        const runtimeAgent = findRuntimeAgentForSlot(slot, runtimeAgents);
        if (!runtimeAgent) continue;
        const action = makeSlotAction({
          slot,
          runtimeAgent,
          metadata: {
            stage_mode: runnableSlots.length > 1 ? 'parallel_degraded' : 'serial',
          },
        });
        if (action) actions.push(action);
        pushCheckpointActions([slot.slot_id], [runtimeAgent.instance_id].filter(Boolean));
      }
    }
  };

  const buildDebateActions = () => {
    const debate = graphDescriptor.debate;
    const adjudicatorSlotId = normalizeText(debate?.adjudicator_slot_id || terminalFinalSlotId);
    const debaterSlotIds = (debate?.debater_slot_ids?.length > 0
      ? debate.debater_slot_ids
      : slotOrder.filter((slotId) => normalizeText(slotId) !== adjudicatorSlotId)
    ).filter(Boolean);
    const rounds = Number.isFinite(Number(debate?.rounds)) ? Math.max(1, Math.min(6, Math.floor(Number(debate.rounds)))) : 1;

    for (let round = 1; round <= rounds; round += 1) {
      for (const slotId of debaterSlotIds) {
        const slot = index.slotsById.get(normalizeText(slotId));
        const runtimeAgent = slot ? findRuntimeAgentForSlot(slot, runtimeAgents) : null;
        if (!slot || !runtimeAgent) continue;
        const action = makeSlotAction({
          slot,
          runtimeAgent,
          promptSuffix: round === 1
            ? 'Debate round 1: present your strongest case and cite the most relevant evidence for your side.'
            : `Debate round ${round}: rebut prior arguments, address weaknesses, and update your position with the strongest remaining evidence.`,
          metadata: {
            debate_round: round,
            debate_role: 'debater',
            rebuttal_required: debate?.rebuttal_required !== false,
          },
          inputPatch: {
            debate_round: round,
            debate_role: 'debater',
            debate_adjudicator_slot_id: adjudicatorSlotId || undefined,
          },
          summaryKind: round === rounds ? 'debate_round_final' : 'debate_round',
        });
        if (action) actions.push(action);
        pushCheckpointActions([slot.slot_id], [runtimeAgent.instance_id].filter(Boolean));
      }
      const supervisorAction = buildSupervisorDecisionAction({
        supervisorRuntime,
        slotIds: debaterSlotIds,
        instanceIds: debaterSlotIds.map((slotId) => normalizeText(findRuntimeAgentForSlot(index.slotsById.get(slotId), runtimeAgents)?.instance_id)).filter(Boolean),
        checkpointIds: [],
        label: `Supervisor review after debate round ${round}`,
        summaryKind: 'debate_round',
      });
      if (supervisorAction && rounds > 1) actions.push(supervisorAction);
    }

    const adjudicatorSlot = index.slotsById.get(adjudicatorSlotId);
    const adjudicatorAgent = adjudicatorSlot ? findRuntimeAgentForSlot(adjudicatorSlot, runtimeAgents) : null;
    if (adjudicatorSlot && adjudicatorAgent) {
      const finalAction = makeSlotAction({
        slot: adjudicatorSlot,
        runtimeAgent: adjudicatorAgent,
        finalSynthesis: true,
        promptSuffix: `Adjudicate the debate after ${rounds} round(s). Weigh both sides, resolve conflicts in evidence, and produce the final answer for the user.`,
        metadata: {
          debate_role: 'adjudicator',
          debate_rounds: rounds,
        },
        inputPatch: {
          debate_rounds: rounds,
          debate_role: 'adjudicator',
        },
        summaryKind: 'final_output',
      });
      if (finalAction) actions.push(finalAction);
      const checkpoints = pushCheckpointActions([adjudicatorSlot.slot_id], [adjudicatorAgent.instance_id].filter(Boolean));
      const supervisorAction = buildSupervisorDecisionAction({
        supervisorRuntime,
        slotIds: [adjudicatorSlot.slot_id],
        instanceIds: [adjudicatorAgent.instance_id].filter(Boolean),
        checkpointIds: checkpoints.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
        label: 'Supervisor final debate review',
        summaryKind: 'final_output',
      });
      if (supervisorAction) actions.push(supervisorAction);
    }
  };

  if (graphDescriptor.pattern === 'debate' && graphDescriptor.debate && graphDescriptor.debate.rounds > 1) {
    buildDebateActions();
  } else {
    buildGenericActions();
    if (terminalFinalSlotId) {
      const finalSlot = index.slotsById.get(terminalFinalSlotId);
      const finalAgent = finalSlot ? findRuntimeAgentForSlot(finalSlot, runtimeAgents) : null;
      if (finalSlot && finalAgent) {
        const committeeMemberSlotIds = graphDescriptor.pattern === 'committee'
          ? ((graphDescriptor.committee?.member_slot_ids?.length > 0 ? graphDescriptor.committee.member_slot_ids : slotOrder.filter((slotId) => normalizeText(slotId) !== terminalFinalSlotId)).filter(Boolean))
          : [];
        const promptSuffix = graphDescriptor.pattern === 'committee'
          ? `Synthesize committee member outputs and make the final decision using consensus mode=${graphDescriptor.committee?.mode || 'majority'}${graphDescriptor.committee?.quorum ? ` quorum=${graphDescriptor.committee.quorum}` : ''}.`
          : (graphDescriptor.pattern === 'graph' && compatibilityFallback
            ? 'Topology validation failed, so this final step is running in compatibility fallback mode. Produce a cautious final answer and call out any uncertainty in upstream routing.'
            : '');
        if (graphDescriptor.pattern === 'committee') {
          const consensusAction = buildCommitteeConsensusAction({
            graphDescriptor,
            checkpointIds: checkpointIdsForSlots(committeeMemberSlotIds, checkpointLookup).map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
            supervisorRuntime,
            memberSlotIds: committeeMemberSlotIds,
            chairSlotId: terminalFinalSlotId,
            compatibilityFallback,
          });
          if (consensusAction) actions.push(consensusAction);
        }
        const finalAction = makeSlotAction({
          slot: finalSlot,
          runtimeAgent: finalAgent,
          finalSynthesis: true,
          promptSuffix,
          metadata: graphDescriptor.pattern === 'committee'
            ? { committee_role: 'chair', consensus_mode: graphDescriptor.committee?.mode || 'majority', committee_member_slot_ids: committeeMemberSlotIds }
            : {},
          inputPatch: graphDescriptor.pattern === 'committee'
            ? { committee_role: 'chair', consensus_mode: graphDescriptor.committee?.mode || 'majority', committee_quorum: graphDescriptor.committee?.quorum, committee_member_slot_ids: committeeMemberSlotIds }
            : {},
          summaryKind: 'final_output',
        });
        if (finalAction) actions.push(finalAction);
        const checkpoints = pushCheckpointActions([terminalFinalSlotId], [finalAgent.instance_id].filter(Boolean));
        const supervisorAction = buildSupervisorDecisionAction({
          supervisorRuntime,
          slotIds: [terminalFinalSlotId],
          instanceIds: finalAction?.inputs?.runtime_instance_id
            ? [finalAction.inputs.runtime_instance_id]
            : [],
          checkpointIds: checkpoints.map((checkpoint) => checkpoint.checkpoint_id).filter(Boolean),
          label: graphDescriptor.pattern === 'committee' ? 'Supervisor committee decision review' : 'Supervisor final synthesis review',
          summaryKind: 'final_output',
        });
        if (supervisorAction) actions.push(supervisorAction);
      }
    }
  }

  if (compatibilityFallback && actions[0]) {
    actions[0] = annotateAction(actions[0], {
      topology_validation_errors: graphDescriptor.validation.errors,
      topology_validation_warnings: graphDescriptor.validation.warnings,
    }, {
      topology_validation_fallback: true,
    });
  }

  if (normalizeText(mode, { lower: true }) !== 'chat' && actions.length < 12) {
    actions.push({ type: 'git_summary' });
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
