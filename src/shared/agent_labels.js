function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

export function normalizeAgentId(value = "") {
  return String(value || "").trim().toLowerCase();
}

function normalizeAgentName(value = "") {
  return String(value || "").trim();
}

function pushAgentRows(index, rows = []) {
  for (const rowRaw of (Array.isArray(rows) ? rows : [])) {
    const row = asObject(rowRaw);
    const ids = [
      row.id,
      row.agent_id,
      row.agentId,
      row.instance_id,
      row.instanceId,
      row.runtime_instance_id,
      row.runtimeInstanceId,
      row.template_id,
      row.templateId,
      row.preset_id,
      row.presetId,
      row.slot_id,
      row.slotId,
    ]
      .map((value) => normalizeAgentId(value))
      .filter(Boolean);
    for (const id of ids) {
      if (!index.has(id)) index.set(id, row);
    }
  }
}

export function buildAgentDisplayIndex(...sources) {
  const index = new Map();
  for (const sourceRaw of sources) {
    if (!sourceRaw) continue;
    if (Array.isArray(sourceRaw)) {
      pushAgentRows(index, sourceRaw);
      continue;
    }
    const source = asObject(sourceRaw);
    pushAgentRows(index, source.agents);
    pushAgentRows(index, source.agentsCatalog);
    pushAgentRows(index, source.runtime_agents);
    pushAgentRows(index, source.runtimeAgents);
  }
  return index;
}

function inferAgentName(row = {}, fallbackId = "") {
  const entry = asObject(row);
  return normalizeAgentName(
    entry.display_label
    || entry.displayLabel
    || entry.logical_label
    || entry.logicalLabel
    || entry.name
    || entry.title
    || entry.role_label
    || entry.roleLabel
    || entry.preset_id
    || entry.presetId
    || entry.slot_id
    || entry.slotId
    || entry.system_key
    || entry.systemKey
    || fallbackId
  );
}

function inferAgentMeta(row = {}) {
  const entry = asObject(row);
  const parts = [];
  const slotId = normalizeAgentId(entry.slot_id || entry.slotId);
  const roleId = normalizeAgentId(entry.role_id || entry.roleId || entry.role_label || entry.roleLabel);
  const presetId = normalizeAgentId(entry.preset_id || entry.presetId || entry.template_id || entry.templateId);
  if (slotId) parts.push(`slot:${slotId}`);
  if (roleId) parts.push(`role:${roleId}`);
  if (presetId) parts.push(entry.synthesized === true ? "synthesized" : `preset:${presetId}`);
  return parts.join(", ");
}

export function formatAgentDisplayName(agentId = "", agentIndex = new Map(), {
  nameHint = "",
  includeShortId = true,
} = {}) {
  const id = normalizeAgentId(agentId);
  if (!id) return "@unknown";
  const shortId = id.slice(0, 8) || "unknown";
  const row = agentIndex instanceof Map ? agentIndex.get(id) : null;
  const rowName = inferAgentName(row, "");
  const rowMeta = inferAgentMeta(row);
  const hintName = normalizeAgentName(nameHint);
  const displayName = rowMeta && rowName ? `${rowName} (${rowMeta})` : (rowName || hintName);
  if (!displayName) return `@${shortId}`;
  if (!includeShortId) return displayName;
  return `${displayName} [${shortId}]`;
}

export function formatChatAgentDisplayName(agentId = "", agentIndex = new Map(), {
  nameHint = "",
} = {}) {
  return formatAgentDisplayName(agentId, agentIndex, {
    nameHint,
    includeShortId: false,
  });
}

export function resolveActionAgentId(action = {}) {
  const row = asObject(action);
  const type = String(row.type || "").trim().toLowerCase();
  if (!type) {
    return normalizeAgentId(
      row.agent_id
      || row.agentId
      || row.agent
      || row.id
      || ""
    );
  }
  if (type === "run_agent" || type === "agent_run" || type === "propose_agent") {
    return normalizeAgentId(row.agent_id || row.agent || row.id);
  }
  if ([
    "add_agent_to_conversation",
    "remove_agent_from_conversation",
    "enable_agent",
    "disable_agent",
    "fork_agent",
    "publish_agent",
  ].includes(type)) {
    return normalizeAgentId(row.agent_id || row.agent || row.id || row.agentId);
  }
  if (type === "create_agent" || type === "update_agent") {
    return normalizeAgentId(
      row.agent_id
      || row.agentId
      || row.agent?.id
      || row.agent?.agent_id
      || row.id
    );
  }
  if (type === "create_agent_definition") {
    return normalizeAgentId(
      row.agent_id
      || row.agentId
      || row.agent_spec?.id
      || row.agentSpec?.id
      || row.agent?.id
      || row.id
    );
  }
  return "";
}

export function resolveActionAgentNameHint(action = {}) {
  const row = asObject(action);
  const type = String(row.type || "").trim().toLowerCase();
  if (type === "propose_agent") {
    return normalizeAgentName(row.name || row.agent?.name || row.profile?.name || "");
  }
  if (type === "create_agent_definition") {
    return normalizeAgentName(
      row.agent_spec?.name
      || row.agentSpec?.name
      || row.agent?.name
      || row.name
      || ""
    );
  }
  if (type === "create_agent" || type === "update_agent") {
    return normalizeAgentName(row.agent?.name || row.name || "");
  }
  return "";
}
