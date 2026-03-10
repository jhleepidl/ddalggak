function normalizeAgentId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeMembershipMap(rawMembership = null) {
  if (rawMembership instanceof Map) return new Map(rawMembership);
  const map = new Map();
  for (const row of (Array.isArray(rawMembership) ? rawMembership : [])) {
    const agentId = normalizeAgentId(row?.agent_id || row?.agentId || row?.id);
    if (!agentId) continue;
    const enabled = row?.enabled !== false;
    if (!map.has(agentId)) {
      map.set(agentId, enabled);
      continue;
    }
    map.set(agentId, map.get(agentId) || enabled);
  }
  return map;
}

function getMembershipMutationActionKey(action = {}) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (![
    "add_agent_to_conversation",
    "remove_agent_from_conversation",
    "enable_agent",
    "disable_agent",
  ].includes(type)) return "";
  const agentId = normalizeAgentId(action.agent_id || action.agentId || action.agent || action.id);
  if (!agentId) return "";
  return `${type}:${agentId}`;
}

function toActionAgentIdSet(ids = []) {
  const out = [];
  const seen = new Set();
  for (const row of (Array.isArray(ids) ? ids : [])) {
    const id = normalizeAgentId(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function buildExplicitTeamReconfigurationActions({
  currentMembership = null,
  desiredAgentIds = [],
  existingActions = [],
  allowRemoval = true,
  removalMode = "remove",
} = {}) {
  const membership = normalizeMembershipMap(currentMembership);
  const desired = toActionAgentIdSet(desiredAgentIds);
  const desiredSet = new Set(desired);
  const removalPolicy = String(removalMode || "").trim().toLowerCase() === "disable" ? "disable" : "remove";
  const existingKeys = new Set(
    (Array.isArray(existingActions) ? existingActions : [])
      .map((action) => getMembershipMutationActionKey(action))
      .filter(Boolean)
  );
  const emittedKeys = new Set();
  const nextActions = [];
  const stats = {
    added: 0,
    enabled: 0,
    removed: 0,
    disabled: 0,
  };

  const appendUnique = (action) => {
    const key = getMembershipMutationActionKey(action);
    if (!key) return;
    if (existingKeys.has(key) || emittedKeys.has(key)) return;
    emittedKeys.add(key);
    nextActions.push(action);
  };

  for (const agentId of desired) {
    if (!membership.has(agentId)) {
      appendUnique({
        type: "add_agent_to_conversation",
        agent_id: agentId,
        enabled: true,
        risk: "L2",
      });
      stats.added += 1;
      membership.set(agentId, true);
      continue;
    }
    if (membership.get(agentId) === true) continue;
    appendUnique({
      type: "enable_agent",
      agent_id: agentId,
      risk: "L1",
    });
    stats.enabled += 1;
    membership.set(agentId, true);
  }

  if (allowRemoval !== true) {
    return {
      actions: nextActions,
      stats,
    };
  }

  for (const [agentId, enabled] of membership.entries()) {
    if (desiredSet.has(agentId)) continue;
    if (removalPolicy === "disable") {
      if (enabled !== true) continue;
      appendUnique({
        type: "disable_agent",
        agent_id: agentId,
        risk: "L1",
      });
      stats.disabled += 1;
      continue;
    }
    appendUnique({
      type: "remove_agent_from_conversation",
      agent_id: agentId,
      risk: "L2",
    });
    stats.removed += 1;
  }

  return {
    actions: nextActions,
    stats,
  };
}
