function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

function uniqIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function pickStringFromRows(rows = [], keys = []) {
  for (const sourceRaw of rows) {
    const source = asObject(sourceRaw);
    for (const key of keys) {
      const value = source[key];
      const text = cleanId(value);
      if (text) return text;
    }
  }
  return "";
}

function pickBooleanFromRows(rows = [], keys = [], fallback = false) {
  for (const sourceRaw of rows) {
    const source = asObject(sourceRaw);
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "boolean") return value;
    }
  }
  return fallback;
}

function normalizeVisibility(agent = {}) {
  const visibility = pickStringFromRows([
    agent,
    agent?.meta,
    agent?.raw,
    agent?.raw?.meta,
    agent?.origin,
  ], ["visibility", "scope"]);
  if (["public", "published", "shared"].includes(visibility)) return "public";
  if (["installed", "install", "unlisted"].includes(visibility)) return "installed";
  if (visibility === "private") return "private";
  return "";
}

function extractLogicalSignals(agent = {}) {
  const row = asObject(agent);
  const meta = asObject(row.meta);
  const raw = asObject(row.raw);
  const rawMeta = asObject(raw.meta);
  const payload = asObject(
    raw.payload_json
    || raw.payloadJson
    || raw.payload
    || raw.meta_json
    || raw.metaJson
  );
  const payloadMeta = asObject(payload.meta);
  const origin = asObject(
    row.origin
    || payload.origin
    || raw.origin
    || meta.origin
    || rawMeta.origin
    || payloadMeta.origin
  );

  const rawAgentId = cleanId(row.id || row.agent_id || row.agentId);
  const systemKey = pickStringFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
  ], ["system_key", "systemKey"]);
  const sourceAgentId = pickStringFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
  ], ["source_agent_id", "sourceAgentId"]);
  const defaultRole = pickStringFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
  ], ["default_role", "defaultRole", "role_key", "roleKey", "role"]);
  const publicNodeId = pickStringFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
    origin,
  ], ["public_node_id", "publicNodeId"]);
  const blueprintId = pickStringFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
    origin,
  ], ["blueprint_id", "blueprintId"]);
  const visibility = normalizeVisibility(row);
  const published = pickBooleanFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
  ], ["published", "is_published", "isPublished", "public"], false);
  const installedFromPublic = pickBooleanFromRows([
    row,
    meta,
    raw,
    rawMeta,
    payload,
    payloadMeta,
  ], ["installed_from_public", "installedFromPublic"], false);
  const logicalAgentId = sourceAgentId
    || systemKey
    || defaultRole
    || (publicNodeId ? `public:${publicNodeId}` : "")
    || (blueprintId ? `blueprint:${blueprintId}` : "")
    || rawAgentId;
  const commandRef = systemKey
    || sourceAgentId
    || defaultRole
    || rawAgentId;
  const identitySource = sourceAgentId
    ? "source_agent_id"
    : (systemKey
      ? "system_key"
      : (defaultRole
        ? "default_role"
        : (publicNodeId
          ? "public_node_id"
          : (blueprintId ? "blueprint_id" : "raw_id"))));

  return {
    raw_agent_id: rawAgentId,
    logical_agent_id: logicalAgentId,
    command_ref: commandRef || rawAgentId,
    system_key: systemKey,
    source_agent_id: sourceAgentId,
    default_role: defaultRole,
    public_node_id: publicNodeId,
    blueprint_id: blueprintId,
    visibility,
    published,
    installed_from_public: installedFromPublic,
    identity_source: identitySource,
    aliases: uniqIds([
      rawAgentId,
      logicalAgentId,
      commandRef,
      systemKey,
      sourceAgentId,
      defaultRole,
      publicNodeId,
      blueprintId,
      rawAgentId.slice(0, 8),
    ]),
  };
}

function representativeScore(agent = {}, {
  preferredRawIds = [],
} = {}) {
  const info = extractLogicalSignals(agent);
  const preferred = new Set(uniqIds(preferredRawIds));
  const visibility = info.visibility;
  let score = 0;
  if (preferred.has(info.raw_agent_id)) score += 1000;
  if (visibility === "installed") score += 200;
  if (visibility === "private") score += 160;
  if (info.installed_from_public) score += 140;
  if (visibility === "public" || info.published === true) score += 80;
  if (info.system_key) score += 20;
  if (info.source_agent_id) score += 15;
  if (info.raw_agent_id === info.command_ref) score += 5;
  return score;
}

function compareRepresentativeAgents(a = {}, b = {}, options = {}) {
  const scoreA = representativeScore(a, options);
  const scoreB = representativeScore(b, options);
  if (scoreA !== scoreB) return scoreB - scoreA;
  return String(a?.id || a?.agent_id || "").localeCompare(String(b?.id || b?.agent_id || ""));
}

export function describeLogicalAgent(agent = {}) {
  return extractLogicalSignals(agent);
}

export function buildLogicalAgentCatalogIndex(catalogRows = [], {
  preferredRawIds = [],
} = {}) {
  const groups = new Map();
  for (const row of asArray(catalogRows)) {
    const info = extractLogicalSignals(row);
    if (!info.raw_agent_id) continue;
    const logicalId = info.logical_agent_id || info.raw_agent_id;
    if (!logicalId) continue;
    if (!groups.has(logicalId)) {
      groups.set(logicalId, {
        logical_agent_id: logicalId,
        command_ref: info.command_ref || info.raw_agent_id,
        identity_source: info.identity_source,
        raw_agent_ids: [],
        aliases: new Set(),
        rows: [],
      });
    }
    const group = groups.get(logicalId);
    group.rows.push(row);
    group.raw_agent_ids.push(info.raw_agent_id);
    for (const alias of info.aliases) {
      if (alias) group.aliases.add(alias);
    }
    if (!group.command_ref && info.command_ref) group.command_ref = info.command_ref;
  }

  const agents = [];
  const byLogicalId = new Map();
  const rawIdToLogicalId = new Map();
  const aliasMap = new Map();

  for (const group of groups.values()) {
    const rows = [...group.rows].sort((a, b) => compareRepresentativeAgents(a, b, {
      preferredRawIds,
    }));
    const representative = rows[0];
    const repInfo = extractLogicalSignals(representative);
    const logicalAgent = {
      ...representative,
      logical_agent_id: group.logical_agent_id,
      command_ref: group.command_ref || repInfo.command_ref || repInfo.raw_agent_id,
      representative_agent_id: repInfo.raw_agent_id,
      logical_aliases: uniqIds([...group.aliases]),
      logical_identity_source: group.identity_source || repInfo.identity_source,
      logical_member_agent_ids: uniqIds(group.raw_agent_ids),
      logical_visibility: repInfo.visibility || undefined,
      logical_published: repInfo.published === true,
      logical_system_key: repInfo.system_key || undefined,
      logical_source_agent_id: repInfo.source_agent_id || undefined,
      logical_blueprint_id: repInfo.blueprint_id || undefined,
      logical_public_node_id: repInfo.public_node_id || undefined,
      raw_variants: rows,
    };
    agents.push(logicalAgent);
    byLogicalId.set(group.logical_agent_id, logicalAgent);
    for (const rawAgentId of logicalAgent.logical_member_agent_ids) {
      rawIdToLogicalId.set(rawAgentId, group.logical_agent_id);
    }
    for (const alias of logicalAgent.logical_aliases) {
      if (!aliasMap.has(alias)) aliasMap.set(alias, new Set());
      aliasMap.get(alias).add(group.logical_agent_id);
    }
  }

  return {
    agents,
    byLogicalId,
    rawIdToLogicalId,
    aliasMap,
  };
}

export function resolveLogicalAgentRef(agentRef = "", logicalCatalog = null) {
  const catalog = logicalCatalog && typeof logicalCatalog === "object"
    ? logicalCatalog
    : buildLogicalAgentCatalogIndex([]);
  const query = cleanId(String(agentRef || "").replace(/^@+/, ""));
  if (!query) return null;

  const exactLogicalIds = catalog.aliasMap instanceof Map && catalog.aliasMap.has(query)
    ? [...catalog.aliasMap.get(query)]
    : [];
  if (exactLogicalIds.length === 1) {
    const logicalAgent = catalog.byLogicalId.get(exactLogicalIds[0]) || null;
    if (!logicalAgent) return null;
    return {
      ref: query,
      logical_agent: logicalAgent,
      match_type: "exact",
    };
  }
  if (exactLogicalIds.length > 1) {
    return {
      ref: query,
      ambiguous: true,
      candidates: exactLogicalIds
        .map((logicalId) => catalog.byLogicalId.get(logicalId))
        .filter(Boolean),
    };
  }

  const prefixMatches = [];
  for (const logicalAgent of asArray(catalog.agents)) {
    const aliases = uniqIds(logicalAgent.logical_aliases);
    if (aliases.some((alias) => alias.startsWith(query))) {
      prefixMatches.push(logicalAgent);
    }
  }
  if (prefixMatches.length === 1) {
    return {
      ref: query,
      logical_agent: prefixMatches[0],
      match_type: "prefix",
    };
  }
  if (prefixMatches.length > 1) {
    return {
      ref: query,
      ambiguous: true,
      candidates: prefixMatches,
    };
  }
  return null;
}

export function logicalAgentCommandRef(agent = {}) {
  const info = extractLogicalSignals(agent);
  return info.command_ref || info.raw_agent_id || "";
}

