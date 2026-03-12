function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

function normalizeActionType(raw = "") {
  const type = cleanId(raw);
  if (type === "add" || type === "remove" || type === "enable" || type === "disable") {
    return type;
  }
  return "";
}

function normalizeCatalogIds(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const id = cleanId(row?.id || row?.agent_id || row?.agentId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function normalizeMemberIds(rows = []) {
  const members = [];
  const enabled = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const id = cleanId(row?.agent_id || row?.agentId || row?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    members.push(id);
    if (row?.enabled !== false) enabled.push(id);
  }
  return {
    member_agent_ids: members,
    enabled_member_agent_ids: enabled,
  };
}

export function requiresCatalogValidationForTeamMutation(actionType = "") {
  const type = cleanId(actionType);
  return type === "add" || type === "enable";
}

export function createConversationTeamMutationValidationError(validation = {}) {
  const row = validation && typeof validation === "object" ? validation : {};
  const message = String(
    row.message
    || row.error
    || "conversation team mutation was rejected by catalog validation"
  ).trim();
  const error = new Error(message || "conversation team mutation validation failed");
  error.code = String(row.code || "conversation_team_mutation_validation_failed").trim();
  error.validation = row;
  return error;
}

export function validateConversationTeamMutationAgainstCatalog({
  actionType = "",
  agentId = "",
  catalogRows = [],
} = {}) {
  const type = cleanId(actionType);
  const id = cleanId(agentId);
  if (!id) {
    return {
      ok: false,
      code: "invalid_agent_id",
      action_type: type || undefined,
      agent_id: id,
      message: "agent_id is required",
      available_agent_ids: normalizeCatalogIds(catalogRows),
    };
  }
  if (!requiresCatalogValidationForTeamMutation(type)) {
    return {
      ok: true,
      action_type: type,
      agent_id: id,
      available_agent_ids: normalizeCatalogIds(catalogRows),
    };
  }
  const catalogIds = normalizeCatalogIds(catalogRows);
  if (catalogIds.includes(id)) {
    return {
      ok: true,
      action_type: type,
      agent_id: id,
      available_agent_ids: catalogIds,
    };
  }
  return {
    ok: false,
    code: "unknown_agent",
    action_type: type,
    agent_id: id,
    available_agent_ids: catalogIds,
    message: `Unknown agent id: @${id}. Run /agents registry and choose an existing agent id.`,
  };
}

export async function applyValidatedConversationTeamMutation({
  teamStore = null,
  actionType = "",
  agentId = "",
  mutationOptions = {},
  catalogRows = [],
  requireCatalogValidation = false,
} = {}) {
  const type = normalizeActionType(actionType);
  if (!type) throw new Error(`unsupported action type: ${String(actionType || "")}`);
  if (!teamStore || typeof teamStore !== "object") {
    throw new Error("teamStore is required");
  }

  const id = cleanId(agentId);
  const validation = !id
    ? {
      ok: false,
      code: "invalid_agent_id",
      action_type: type,
      agent_id: id,
      message: "agent_id is required",
      available_agent_ids: normalizeCatalogIds(catalogRows),
    }
    : (requireCatalogValidation
      ? validateConversationTeamMutationAgainstCatalog({
        actionType: type,
        agentId: id,
        catalogRows,
      })
      : {
        ok: true,
        action_type: type,
        agent_id: id,
        available_agent_ids: normalizeCatalogIds(catalogRows),
      });
  if (!validation.ok) {
    return {
      ok: false,
      action_type: type,
      agent_id: id,
      validation,
      result: null,
    };
  }

  const options = asObject(mutationOptions);
  let result = null;
  if (type === "add") {
    if (typeof teamStore.addAgent !== "function") {
      throw new Error("teamStore.addAgent is unavailable");
    }
    result = await teamStore.addAgent({
      ...options,
      agentId: id,
      enabled: options.enabled !== false,
    });
  } else if (type === "remove") {
    if (typeof teamStore.removeAgent !== "function") {
      throw new Error("teamStore.removeAgent is unavailable");
    }
    result = await teamStore.removeAgent({
      ...options,
      agentId: id,
    });
  } else {
    if (typeof teamStore.setAgentEnabled !== "function") {
      throw new Error("teamStore.setAgentEnabled is unavailable");
    }
    result = await teamStore.setAgentEnabled({
      ...options,
      agentId: id,
      enabled: type !== "disable",
    });
  }

  return {
    ok: true,
    action_type: type,
    agent_id: id,
    validation,
    result,
  };
}

export function reconcileConversationTeamWithCatalog({
  conversationRows = [],
  catalogRows = [],
} = {}) {
  const { member_agent_ids, enabled_member_agent_ids } = normalizeMemberIds(conversationRows);
  const catalogIds = normalizeCatalogIds(catalogRows);
  const catalogSet = new Set(catalogIds);
  const active_enabled_agent_ids = enabled_member_agent_ids.filter((id) => catalogSet.has(id));
  const activeSet = new Set(active_enabled_agent_ids);
  const disabled_member_agent_ids = member_agent_ids.filter((id) => catalogSet.has(id) && !activeSet.has(id));
  const unknown_member_agent_ids = member_agent_ids.filter((id) => !catalogSet.has(id));
  return {
    catalog_agent_ids: catalogIds,
    member_agent_ids,
    enabled_member_agent_ids,
    active_enabled_agent_ids,
    disabled_member_agent_ids,
    unknown_member_agent_ids,
  };
}
