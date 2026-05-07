import {
  getTeamConfigApi,
  getTeamBlueprintApi,
  installTeamBlueprintApi,
  buildTeamPublishCandidateApi,
  setTeamConfigApi,
  validateTeamBlueprintApi,
} from './goc_client_team_api.js';
import { normalizeHarnessPackage } from './shared/openharness_contracts.js';

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function parseJsonMaybe(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const RETRYABLE_STATUSES = new Set([400, 404, 405, 415, 422, 501]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUSES.has(Number(status));
}

function looksLikeHtmlDocument(text) {
  const raw = String(text || "").trim().toLowerCase();
  return raw.startsWith("<!doctype html") || raw.startsWith("<html");
}

function makeCompiledHtmlError(data) {
  const err = new Error("compiled_text looks like HTML; check GOC_API_BASE/proxy");
  err.status = 502;
  err.data = data;
  return err;
}

function pick(obj, keys) {
  const src = asObject(obj);
  for (const key of keys) {
    const value = src[key];
    if (typeof value === "undefined" || value === null) continue;
    if (typeof value === "string" && !value.trim()) continue;
    return value;
  }
  return null;
}

function pickId(entity) {
  const id = pick(entity, [
    "id",
    "thread_id",
    "threadId",
    "context_set_id",
    "contextSetId",
    "resource_id",
    "resourceId",
    "node_id",
    "nodeId",
    "uuid",
  ]);
  return id ? String(id) : null;
}

function toQuery(params = {}) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "undefined" || value === null || value === "") continue;
    q.set(key, String(value));
  }
  const out = q.toString();
  return out ? `?${out}` : "";
}

function normalizeArrayResponse(data) {
  if (Array.isArray(data)) return data;
  const obj = asObject(data);
  const candidates = ["items", "data", "threads", "context_sets", "contextSets", "resources", "nodes", "results"];
  for (const key of candidates) {
    if (Array.isArray(obj[key])) return obj[key];
  }
  return [];
}

function normalizeEntity(data, keys = []) {
  const obj = asObject(data);
  for (const key of keys) {
    if (obj[key] && typeof obj[key] === "object") return asObject(obj[key]);
  }
  return obj;
}

function normalizeGraphNodes(data) {
  const obj = asObject(data);
  if (Array.isArray(obj.nodes)) return obj.nodes;
  if (obj.graph && typeof obj.graph === "object" && Array.isArray(obj.graph.nodes)) {
    return obj.graph.nodes;
  }
  return normalizeArrayResponse(data);
}

function isGraphResourceNode(entity) {
  const row = asObject(entity);
  const hint = String(
    pick(row, ["node_type", "nodeType", "entity_type", "entityType", "type", "kind", "node_kind", "nodeKind", "label"])
    || ""
  ).trim().toLowerCase();
  if (hint.includes("resource")) return true;
  if (pick(row, ["resource_kind", "resourceKind"])) return true;
  if (typeof row.payload_json !== "undefined" || typeof row.payloadJson !== "undefined" || typeof row.payload !== "undefined") {
    return true;
  }
  return false;
}

function isGraphMessageNode(entity) {
  const row = asObject(entity);
  const hint = String(
    pick(row, ["node_type", "nodeType", "entity_type", "entityType", "type", "kind", "node_kind", "nodeKind", "label"])
    || ""
  ).trim().toLowerCase();
  if (hint.includes("message")) return true;
  const payload = normalizePayloadObject(pick(row, ["payload_json", "payloadJson", "payload", "meta_json", "metaJson", "meta"]));
  const role = String(
    pick(row, ["role", "author_role", "authorRole"])
    || pick(payload, ["role"])
    || ""
  ).trim().toLowerCase();
  return ["user", "assistant", "system", "tool"].includes(role);
}

function normalizePayloadObject(raw) {
  if (raw && typeof raw === "object") return asObject(raw);
  if (typeof raw === "string") return asObject(parseJsonMaybe(raw));
  return {};
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return fallback;
  if (["1", "true", "yes", "on"].includes(key)) return true;
  if (["0", "false", "no", "off"].includes(key)) return false;
  return fallback;
}

function clampInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function normalizeApiBaseUrl(rawBase = '') {
  const trimmed = String(rawBase || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/i, '');
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return trimmed.replace(/\/api$/i, '');
  }
}

const LEGACY_GOC_EXACT_API_PATHS = new Set([
  '/api/thread',
  '/api/threads:ensure',
  // Historical global graph aliases. Current GoC backend exposes these as
  // thread-scoped routes: /api/threads/:thread_id/{nodes,edges,messages,resources}.
  '/api/nodes',
  '/api/edges',
  '/api/messages',
  '/api/resources',
  '/api/nodes/edges',
]);

function isLegacyGocApiPath(pathname = '') {
  const pathOnly = String(pathname || '').trim().split('?')[0].replace(/\/+$/, '') || '/';
  if (!pathOnly.startsWith('/api/')) return true;
  if (LEGACY_GOC_EXACT_API_PATHS.has(pathOnly)) return true;
  if (pathOnly.startsWith('/api/thread/')) return true;
  return false;
}

function filterLegacyGocAttempts(attempts = [], { allowLegacy = false } = {}) {
  const rows = Array.isArray(attempts) ? attempts : [];
  if (allowLegacy) return rows;
  return rows.filter((attempt) => !isLegacyGocApiPath(attempt?.path));
}

function sanitizeScopeMaterializationSnapshot(snapshot = {}) {
  const row = asObject(snapshot);
  const cleanScopeSpecs = asArray(row.scope_specs ?? row.scopeSpecs).slice(0, 64).map((entry, index) => {
    const item = asObject(entry);
    const scopeId = String(item.scope_id || item.scopeId || `scope_${index + 1}`).trim();
    const selection = asObject(item.node_selection || item.nodeSelection);
    const budget = asObject(item.budget);
    const grants = asObject(item.memory_grants || item.memoryGrants);
    return {
      scope_id: scopeId,
      target_instance_id: String(item.target_instance_id || item.targetInstanceId || '').trim() || undefined,
      target_slot_id: String(item.target_slot_id || item.targetSlotId || '').trim() || undefined,
      role_id: String(item.role_id || item.roleId || '').trim().toLowerCase() || undefined,
      visibility_mode: String(item.visibility_mode || item.visibilityMode || 'scoped').trim().toLowerCase() || 'scoped',
      context_types: normalizeStringList(item.context_types || item.contextTypes).slice(0, 16),
      node_selection: {
        strategy: String(selection.strategy || selection.mode || 'query_plus_closure').trim() || 'query_plus_closure',
        query: String(selection.query || '').trim().slice(0, 512) || undefined,
        closure_edge_types: normalizeStringList(selection.closure_edge_types || selection.closureEdgeTypes).slice(0, 24),
        max_nodes: clampInteger(selection.max_nodes || selection.maxNodes, 80, { min: 1, max: 128 }),
      },
      memory_grants: {
        shared_summary: grants.shared_summary === true,
        global_memory: grants.global_memory === true,
        conversation_tail: grants.conversation_tail === true,
        upstream_results: grants.upstream_results === true,
        upstream_summaries: grants.upstream_summaries === true || grants.upstream_summary === true,
        user_pinned_nodes: grants.user_pinned_nodes === true,
        explicit_uploaded_files: grants.explicit_uploaded_files === true,
      },
      budget: (() => {
        const softTokens = clampInteger(budget.soft_tokens || budget.softTokens, 1800, { min: 200, max: 6000 });
        const hardTokens = clampInteger(
          budget.hard_tokens || budget.hardTokens,
          Math.max(2600, softTokens + 600),
          { min: Math.max(200, softTokens), max: 8000 }
        );
        return {
          soft_tokens: softTokens,
          hard_tokens: hardTokens,
        };
      })(),
      selection_reason: String(item.selection_reason || item.selectionReason || '').trim().slice(0, 512) || undefined,
    };
  });
  const cleanRuntimeAgents = asArray(row.runtime_agents ?? row.runtimeAgents).slice(0, 64).map((entry) => {
    const item = asObject(entry);
    return {
      instance_id: String(item.instance_id || item.instanceId || '').trim() || undefined,
      slot_id: String(item.slot_id || item.slotId || '').trim() || undefined,
      role_id: String(item.role_id || item.roleId || item.role_label || '').trim().toLowerCase() || undefined,
      scope_id: String(item.scope_id || item.scopeId || '').trim() || undefined,
    };
  });
  return {
    context_runtime_mode: String(row.context_runtime_mode || row.contextRuntimeMode || '').trim().toLowerCase() || undefined,
    scope_specs: cleanScopeSpecs,
    runtime_agents: cleanRuntimeAgents,
  };
}

function normalizeNodeIdList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => String(row ?? "").trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeCompiledExplainPayload(data) {
  if (typeof data === "string") {
    if (looksLikeHtmlDocument(data)) throw makeCompiledHtmlError(data);
    return {
      compiled_text: data,
      explain: null,
      active_node_ids: [],
      raw: data,
    };
  }

  const row = asObject(data);
  const nested = normalizeEntity(row, ["compiled", "result", "data"]);
  const src = Object.keys(nested).length > 0 ? nested : row;

  const compiledText = String(
    pick(src, ["compiled_text", "compiledText", "text", "content"])
    || pick(row, ["compiled_text", "compiledText", "text", "content"])
    || ""
  );
  if (compiledText && looksLikeHtmlDocument(compiledText)) throw makeCompiledHtmlError(compiledText);

  const explain = pick(src, ["explain", "explanation", "explain_data", "details"])
    ?? pick(row, ["explain", "explanation", "explain_data", "details"])
    ?? null;

  const activeNodeIds = normalizeNodeIdList(
    pick(src, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
    || pick(row, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
  );

  if (!compiledText && data && typeof data === "object") {
    return {
      compiled_text: JSON.stringify(data, null, 2),
      explain: explain ?? null,
      active_node_ids: activeNodeIds,
      raw: data,
    };
  }

  return {
    compiled_text: compiledText,
    explain: explain ?? null,
    active_node_ids: activeNodeIds,
    raw: data,
  };
}

function normalizeStringList(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((row) => String(row || "").trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((row) => row.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeCompiledMeta(data, normalized = null) {
  const payload = normalized || normalizeCompiledExplainPayload(data);
  const row = asObject(data);
  const nested = normalizeEntity(row, ["compiled", "result", "data"]);
  const src = Object.keys(nested).length > 0 ? nested : row;
  const explain = asObject(payload?.explain);
  const meta = asObject(
    pick(src, ["meta", "meta_json", "metaJson", "stats", "usage"])
    || pick(explain, ["meta", "stats", "usage"])
  );
  const tokenEstimateRaw = Number(
    pick(src, ["token_estimate", "tokenEstimate", "estimated_tokens", "estimatedTokens", "tokens"])
    || pick(meta, ["token_estimate", "tokenEstimate", "estimated_tokens", "estimatedTokens", "tokens"])
    || pick(explain, ["token_estimate", "tokenEstimate", "estimated_tokens", "estimatedTokens", "tokens"])
  );
  const tokenEstimate = Number.isFinite(tokenEstimateRaw)
    ? Math.max(0, Math.floor(tokenEstimateRaw))
    : null;

  const contextVersion = String(
    pick(src, ["context_version", "contextVersion", "version", "rev", "etag"])
    || pick(meta, ["context_version", "contextVersion", "version", "rev", "etag"])
    || ""
  ).trim();
  const activeNodeIds = normalizeNodeIdList(
    pick(src, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
    || pick(meta, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
    || pick(explain, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
    || payload?.active_node_ids
  );
  const typeBreakdownRaw = pick(src, ["node_type_breakdown", "type_breakdown", "active_type_breakdown"])
    || pick(meta, ["node_type_breakdown", "type_breakdown", "active_type_breakdown"])
    || pick(explain, ["node_type_breakdown", "type_breakdown", "active_type_breakdown"]);
  const typeBreakdown = typeBreakdownRaw && typeof typeBreakdownRaw === "object"
    ? asObject(typeBreakdownRaw)
    : {};
  return {
    token_estimate: tokenEstimate,
    active_node_ids: activeNodeIds,
    context_version: contextVersion,
    node_type_breakdown: typeBreakdown,
  };
}

function normalizeConversation(entity, fallbackThreadId = "") {
  const row = asObject(entity);
  const threadId = String(
    pick(row, ["thread_id", "threadId"])
    || pick(row.thread, ["id", "thread_id", "threadId"])
    || fallbackThreadId
    || ""
  ).trim();
  const id = String(
    pick(row, ["id", "conversation_id", "conversationId"])
    || (threadId ? `thread:${threadId}` : "")
  ).trim();
  return {
    id,
    thread_id: threadId,
    title: String(pick(row, ["title", "name"]) || ""),
    created_at: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
    updated_at: String(pick(row, ["updated_at", "updatedAt", "ts", "timestamp"]) || ""),
    raw: row,
  };
}

function normalizeConversationAgent(entity, fallbackThreadId = "") {
  const row = asObject(entity);
  const payload = normalizePayloadObject(pick(row, ["payload_json", "payloadJson", "payload", "meta_json", "metaJson", "meta"]));
  const rowAgent = asObject(row.agent);
  const payloadAgent = asObject(payload.agent);
  const threadId = String(
    pick(row, ["thread_id", "threadId"])
    || pick(payload, ["thread_id", "threadId"])
    || fallbackThreadId
    || ""
  ).trim();
  const conversationId = String(
    pick(row, ["conversation_id", "conversationId"])
    || pick(payload, ["conversation_id", "conversationId"])
    || ""
  ).trim();
  const agentId = String(
    pick(row, ["agent_id", "agentId"])
    || pick(rowAgent, ["id", "agent_id", "agentId"])
    || pick(payload, ["agent_id", "agentId"])
    || pick(payloadAgent, ["id", "agent_id", "agentId"])
    || ""
  ).trim().toLowerCase();
  const enabled = parseBooleanLike(
    pick(row, ["enabled", "is_enabled", "isEnabled", "active"])
    ?? pick(payload, ["enabled", "is_enabled", "isEnabled", "active"]),
    true
  );
  const orderIndexRaw = Number(
    pick(row, ["order_index", "orderIndex", "order", "sort_order", "sortOrder", "position"])
    ?? pick(payload, ["order_index", "orderIndex", "order", "sort_order", "sortOrder", "position"])
  );
  const overridesRaw = (
    pick(row, ["overrides_json", "overridesJson", "overrides"])
    ?? pick(payload, ["overrides_json", "overridesJson", "overrides"])
  );
  const overridesJson = normalizePayloadObject(overridesRaw);
  const orderIndex = Number.isFinite(orderIndexRaw) ? Math.floor(orderIndexRaw) : null;
  return {
    id: String(pick(row, ["id", "membership_id", "membershipId"]) || `${threadId}:${agentId}`).trim(),
    thread_id: threadId,
    conversation_id: conversationId,
    agent_id: agentId,
    enabled,
    order_index: orderIndex,
    overrides_json: overridesJson,
    order: orderIndex,
    overrides: overridesJson,
    created_at: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
    updated_at: String(pick(row, ["updated_at", "updatedAt", "ts", "timestamp"]) || ""),
    raw: row,
  };
}

function normalizeConversationTarget(rawTarget = {}, fallback = {}) {
  const row = rawTarget && typeof rawTarget === "object"
    ? rawTarget
    : { thread_id: rawTarget };
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const threadId = String(
    pick(row, ["thread_id", "threadId"])
    || pick(base, ["thread_id", "threadId"])
    || ""
  ).trim();
  const conversationId = String(
    pick(row, ["conversation_id", "conversationId", "id"])
    || pick(base, ["conversation_id", "conversationId", "id"])
    || ""
  ).trim();
  return {
    thread_id: threadId,
    conversation_id: conversationId,
  };
}

function buildConversationIdentityPatchBody(baseBody = {}, target = {}) {
  const identity = {};
  if (target.thread_id) {
    identity.thread_id = target.thread_id;
    identity.threadId = target.thread_id;
  }
  if (target.conversation_id) {
    identity.conversation_id = target.conversation_id;
    identity.conversationId = target.conversation_id;
  }
  return {
    ...identity,
    ...(baseBody && typeof baseBody === "object" ? baseBody : {}),
  };
}

function buildConversationIdentityQuery(target = {}) {
  const query = {};
  if (target.thread_id) query.thread_id = target.thread_id;
  if (target.conversation_id) query.conversation_id = target.conversation_id;
  return query;
}

function extractConversationAgentsArray(data) {
  if (Array.isArray(data)) return data;
  const root = asObject(data);
  const roots = [
    root,
    asObject(root.data),
    asObject(root.result),
    asObject(root.team),
    asObject(root.thread_team),
    asObject(root.threadTeam),
  ];
  for (const row of roots) {
    if (Array.isArray(row?.members)) return row.members;
    if (Array.isArray(row?.team?.members)) return row.team.members;
    if (Array.isArray(row?.team?.items)) return row.team.items;
    if (Array.isArray(row?.conversation?.agents)) return row.conversation.agents;
    if (Array.isArray(row?.conversation?.items)) return row.conversation.items;
    if (Array.isArray(row?.agents)) return row.agents;
    if (Array.isArray(row?.items)) return row.items;
  }
  return normalizeArrayResponse(data);
}

function buildCanonicalTeamListAttempts(target = {}) {
  const tid = String(target.thread_id || "").trim();
  const cid = String(target.conversation_id || "").trim();
  return [
    ...(tid ? [
      { path: `/api/threads/${encodeURIComponent(tid)}/team` },
      { path: `/threads/${encodeURIComponent(tid)}/team` },
      { path: `/api/threads/${encodeURIComponent(tid)}/team/members` },
      { path: `/threads/${encodeURIComponent(tid)}/team/members` },
      { path: `/api/threads/${encodeURIComponent(tid)}/conversation/agents` },
      { path: `/threads/${encodeURIComponent(tid)}/conversation/agents` },
    ] : []),
    ...(cid ? [
      { path: `/api/conversations/${encodeURIComponent(cid)}/agents` },
    ] : []),
    { path: "/api/conversation_agents", query: buildConversationIdentityQuery(target) },
    { path: "/api/conversation-agents", query: buildConversationIdentityQuery(target) },
    { path: "/conversation_agents", query: buildConversationIdentityQuery(target) },
  ];
}

function buildCanonicalTeamAddAttempts(target = {}, addBody = {}, body = {}) {
  const tid = String(target.thread_id || "").trim();
  const cid = String(target.conversation_id || "").trim();
  return [
    ...(tid ? [
      { path: `/api/threads/${encodeURIComponent(tid)}/team/members`, body: addBody },
      { path: `/threads/${encodeURIComponent(tid)}/team/members`, body: addBody },
      { path: `/api/threads/${encodeURIComponent(tid)}/conversation/agents`, body: addBody },
      { path: `/threads/${encodeURIComponent(tid)}/conversation/agents`, body: addBody },
    ] : []),
    ...(cid ? [
      { path: `/api/conversations/${encodeURIComponent(cid)}/agents`, body: addBody },
    ] : []),
    { path: "/api/conversation_agents", body },
    { path: "/api/conversation-agents", body },
    { path: "/conversation_agents", body },
  ];
}

function buildCanonicalTeamPatchAttempts(target = {}, agentId = "", patchBody = {}, patchBodyWithIdentity = {}) {
  const tid = String(target.thread_id || "").trim();
  const cid = String(target.conversation_id || "").trim();
  const aid = String(agentId || "").trim().toLowerCase();
  return [
    ...(tid ? [
      { path: `/api/threads/${encodeURIComponent(tid)}/team/members/${encodeURIComponent(aid)}`, body: patchBody },
      { path: `/threads/${encodeURIComponent(tid)}/team/members/${encodeURIComponent(aid)}`, body: patchBody },
      { path: `/api/threads/${encodeURIComponent(tid)}/conversation/agents/${encodeURIComponent(aid)}`, body: patchBody },
      { path: `/threads/${encodeURIComponent(tid)}/conversation/agents/${encodeURIComponent(aid)}`, body: patchBody },
    ] : []),
    ...(cid ? [
      { path: `/api/conversations/${encodeURIComponent(cid)}/agents/${encodeURIComponent(aid)}`, body: patchBody },
    ] : []),
    { path: "/api/conversation_agents", body: patchBodyWithIdentity },
    { path: "/api/conversation-agents", body: patchBodyWithIdentity },
  ];
}

function buildCanonicalTeamDeleteAttempts(target = {}, agentId = "", body = {}) {
  const tid = String(target.thread_id || "").trim();
  const cid = String(target.conversation_id || "").trim();
  const aid = String(agentId || "").trim().toLowerCase();
  return [
    ...(tid ? [
      { path: `/api/threads/${encodeURIComponent(tid)}/team/members/${encodeURIComponent(aid)}` },
      { path: `/threads/${encodeURIComponent(tid)}/team/members/${encodeURIComponent(aid)}` },
      { path: `/api/threads/${encodeURIComponent(tid)}/conversation/agents/${encodeURIComponent(aid)}` },
      { path: `/threads/${encodeURIComponent(tid)}/conversation/agents/${encodeURIComponent(aid)}` },
    ] : []),
    ...(cid ? [
      { path: `/api/conversations/${encodeURIComponent(cid)}/agents/${encodeURIComponent(aid)}` },
    ] : []),
    { path: "/api/conversation_agents", body },
    { path: "/api/conversation-agents", body },
    { path: "/conversation_agents", body },
  ];
}

function normalizeCatalogAgent(entity) {
  const row = asObject(entity);
  const payload = normalizePayloadObject(pick(row, ["payload_json", "payloadJson", "payload", "meta_json", "metaJson", "meta"]));
  const modelRaw = String(
    pick(row, ["model", "model_name", "modelName"])
    || pick(payload, ["model", "model_name", "modelName"])
    || ""
  ).trim();
  const modelParts = modelRaw.includes(":")
    ? [modelRaw.slice(0, modelRaw.indexOf(":")).trim(), modelRaw.slice(modelRaw.indexOf(":") + 1).trim()]
    : ["", modelRaw];
  const providerFromModel = modelParts[0];
  const modelNameFromModel = modelParts[1];
  const id = String(
    pick(row, ["id", "agent_id", "agentId"])
    || pick(payload, ["id", "agent_id", "agentId"])
    || ""
  ).trim().toLowerCase();
  const provider = String(
    pick(row, ["provider"])
    || pick(payload, ["provider"])
    || providerFromModel
    || "gemini"
  ).trim().toLowerCase();
  const model = modelNameFromModel || modelRaw || provider || "gemini";
  return {
    id,
    name: String(
      pick(row, ["name", "title"])
      || pick(payload, ["name", "title"])
      || id
    ).trim(),
    description: String(
      pick(row, ["description"])
      || pick(payload, ["description"])
      || ""
    ).trim(),
    provider: provider || "gemini",
    model: model || provider || "gemini",
    system_key: String(
      pick(row, ["system_key", "systemKey"])
      || pick(payload, ["system_key", "systemKey"])
      || ""
    ).trim().toLowerCase(),
    source_agent_id: String(
      pick(row, ["source_agent_id", "sourceAgentId"])
      || pick(payload, ["source_agent_id", "sourceAgentId"])
      || pick(asObject(pick(payload, ["meta"])), ["source_agent_id", "sourceAgentId"])
      || ""
    ).trim().toLowerCase(),
    prompt: String(
      pick(row, ["prompt", "system_prompt", "systemPrompt", "base_prompt", "basePrompt", "instruction"])
      || pick(payload, ["prompt", "system_prompt", "systemPrompt", "base_prompt", "basePrompt", "instruction"])
      || ""
    ).trim(),
    instruction: String(
      pick(row, ["instruction"])
      || pick(payload, ["instruction"])
      || ""
    ).trim(),
    tools: normalizeStringList(
      pick(row, ["tools", "tool_ids", "toolIds"])
      || pick(payload, ["tools", "tool_ids", "toolIds"])
    ),
    scope: String(
      pick(row, ["scope", "visibility"])
      || pick(payload, ["scope", "visibility"])
      || ""
    ).trim().toLowerCase(),
    visibility: String(
      pick(row, ["visibility", "scope"])
      || pick(payload, ["visibility", "scope"])
      || ""
    ).trim().toLowerCase(),
    published: parseBooleanLike(
      pick(row, ["published", "is_published", "isPublished", "public"])
      ?? pick(payload, ["published", "is_published", "isPublished", "public"]),
      false
    ),
    installed_from_public: parseBooleanLike(
      pick(row, ["installed_from_public", "installedFromPublic"])
      ?? pick(payload, ["installed_from_public", "installedFromPublic"]),
      false
    ),
    origin: asObject(
      pick(row, ["origin"])
      || pick(payload, ["origin"])
    ),
    public_node_id: String(
      pick(row, ["public_node_id", "publicNodeId"])
      || pick(payload, ["public_node_id", "publicNodeId"])
      || pick(asObject(pick(row, ["origin"]) || pick(payload, ["origin"])), ["public_node_id", "publicNodeId"])
      || ""
    ).trim().toLowerCase(),
    blueprint_id: String(
      pick(row, ["blueprint_id", "blueprintId"])
      || pick(payload, ["blueprint_id", "blueprintId"])
      || pick(asObject(pick(row, ["origin"]) || pick(payload, ["origin"])), ["blueprint_id", "blueprintId"])
      || ""
    ).trim().toLowerCase(),
    created_at: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
    updated_at: String(pick(row, ["updated_at", "updatedAt", "ts", "timestamp"]) || ""),
    raw: row,
  };
}

function normalizeAgentsScope(scope = "") {
  const key = String(scope || "").trim().toLowerCase();
  if (["public", "published", "shared"].includes(key)) return "public";
  if (["installed", "install"].includes(key)) return "installed";
  return "my";
}

function buildAgentCatalogPayload(def = {}, { requireName = false, forPatch = false } = {}) {
  const row = asObject(def);
  const hasName = typeof row.name === "string" || typeof row.title === "string";
  const hasDescription = typeof row.description === "string";
  const hasPrompt = typeof row.prompt === "string" || typeof row.system_prompt === "string" || typeof row.systemPrompt === "string";
  const hasInstruction = typeof row.instruction === "string";
  const hasTools = Array.isArray(row.tools) || Array.isArray(row.tool_ids) || Array.isArray(row.toolIds);
  const hasProvider = typeof row.provider === "string";
  const hasModel = typeof row.model === "string";
  const hasVisibility = typeof row.visibility === "string" || typeof row.scope === "string";
  const name = String(row.name || row.title || "").trim();
  const description = String(row.description || "").trim();
  const systemPrompt = String(
    row.system_prompt
    || row.systemPrompt
    || row.prompt
    || ""
  ).trim();
  const instruction = String(row.instruction || "").trim();
  const tools = normalizeStringList(row.tools || row.tool_ids || row.toolIds);
  const provider = String(row.provider || "").trim().toLowerCase();
  const model = String(row.model || "").trim();
  let modelRef = "";
  if (provider && model && !model.includes(":")) modelRef = `${provider}:${model}`;
  else if (model) modelRef = model;
  else if (provider) modelRef = provider;

  const visibilityRaw = String(row.visibility || row.scope || "").trim().toLowerCase();
  const visibilityAlias = visibilityRaw === "installed" ? "unlisted" : visibilityRaw;
  const visibility = ["public", "private", "unlisted"].includes(visibilityAlias)
    ? visibilityAlias
    : "private";

  if (requireName && !name) {
    throw new Error("createAgent requires name");
  }

  const payload = {
    name: forPatch ? (hasName ? (name || "") : undefined) : (name || undefined),
    description: forPatch ? (hasDescription ? description : undefined) : (description || undefined),
    system_prompt: forPatch ? (hasPrompt ? systemPrompt : undefined) : (systemPrompt || undefined),
    instruction: forPatch ? (hasInstruction ? instruction : undefined) : instruction,
    tools: forPatch ? (hasTools ? tools : undefined) : tools,
    model: forPatch ? ((hasModel || hasProvider) ? (modelRef || "") : undefined) : (modelRef || undefined),
    visibility: forPatch ? (hasVisibility ? visibility : undefined) : visibility,
  };
  if (row.meta && typeof row.meta === "object") {
    payload.meta = row.meta;
  }
  return payload;
}

export class GocClient {
  constructor({ apiBase, serviceKey, actorTelegramUserId, requestTimeoutMs, allowLegacyApiPaths } = {}) {
    const base = String(apiBase || process.env.GOC_API_BASE || "").trim();
    const key = String(serviceKey || process.env.GOC_SERVICE_KEY || "").trim();
    if (!base) throw new Error("Missing GOC_API_BASE");
    if (!key) throw new Error("Missing GOC_SERVICE_KEY");
    let parsedBase;
    try {
      parsedBase = new URL(base);
    } catch {
      throw new Error("Invalid GOC_API_BASE");
    }
    if (!["http:", "https:"].includes(parsedBase.protocol)) {
      throw new Error("GOC_API_BASE must use http or https");
    }
    this.apiBase = normalizeApiBaseUrl(base);
    this.serviceKey = key;
    this.actorTelegramUserId = String(actorTelegramUserId || "").trim();
    this.requestTimeoutMs = clampInteger(requestTimeoutMs || process.env.GOC_REQUEST_TIMEOUT_MS, 15000, { min: 1000, max: 120000 });
    this.allowLegacyApiPaths = parseBooleanLike(
      typeof allowLegacyApiPaths === 'undefined'
        ? (process.env.GOC_ENABLE_LEGACY_API_PATHS ?? process.env.GOC_ALLOW_LEGACY_API_PATHS)
        : allowLegacyApiPaths,
      false,
    );
  }

  setActorTelegramUserId(telegramUserId) {
    this.actorTelegramUserId = String(telegramUserId || "").trim();
    return this.actorTelegramUserId;
  }

  _url(pathname, query = {}) {
    const full = pathname.startsWith("http://") || pathname.startsWith("https://")
      ? pathname
      : `${this.apiBase}${pathname.startsWith("/") ? "" : "/"}${pathname}`;
    return `${full}${toQuery(query)}`;
  }

  async _request({ method = "GET", path, query, body }) {
    const url = this._url(path, query);
    const headers = {
      Authorization: `ServiceKey ${this.serviceKey}`,
      Accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    };
    if (this.actorTelegramUserId) {
      headers["X-Acting-Telegram-User-Id"] = this.actorTelegramUserId;
    }
    const init = { method, headers };
    if (typeof body !== "undefined") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('GoC request timed out')), this.requestTimeoutMs);
    init.signal = controller.signal;
    try {
      const response = await fetch(url, init);
      const text = await response.text();
      const json = parseJsonMaybe(text);
      const data = json ?? text;
      if (!response.ok) {
        const err = new Error(`GoC API ${method} ${url} failed (${response.status})`);
        err.status = response.status;
        err.data = data;
        throw err;
      }
      return data;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const err = new Error(`GoC API ${method} ${url} timed out`);
        err.status = 504;
        throw err;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async _requestAny({ method, attempts = [] }) {
    const plannedAttempts = filterLegacyGocAttempts(attempts, { allowLegacy: this.allowLegacyApiPaths });
    const skippedLegacyCount = Math.max(0, (Array.isArray(attempts) ? attempts.length : 0) - plannedAttempts.length);
    const errors = [];
    for (const attempt of plannedAttempts) {
      try {
        return await this._request({
          method,
          path: attempt.path,
          query: attempt.query,
          body: attempt.body,
        });
      } catch (e) {
        errors.push({ error: e, attempt });
        const status = Number(e?.status);
        if (!isRetryableStatus(status)) break;
      }
    }
    if (plannedAttempts.length === 0 && skippedLegacyCount > 0) {
      const err = new Error('GoC API call has only legacy routes; set GOC_ENABLE_LEGACY_API_PATHS=1 to re-enable them');
      err.status = 404;
      err.attempts = [];
      throw err;
    }
    if (errors.length) {
      const last = errors[errors.length - 1]?.error || new Error("GoC API call failed");
      const attempted = errors
        .map((entry, index) => {
          const path = String(entry?.attempt?.path || '').trim() || '(unknown path)';
          const status = Number(entry?.error?.status);
          return `${index + 1}) ${method} ${path} -> ${Number.isFinite(status) ? status : 'error'}`;
        })
        .join('; ');
      const omitted = skippedLegacyCount > 0
        ? `; skipped ${skippedLegacyCount} legacy route${skippedLegacyCount === 1 ? '' : 's'} (set GOC_ENABLE_LEGACY_API_PATHS=1 to re-enable)`
        : '';
      const message = `${String(last?.message || 'GoC API call failed')}; attempted routes: ${attempted}${omitted}`;
      const err = new Error(message);
      err.status = last.status;
      err.data = last.data;
      err.cause = last;
      err.attempts = errors.map((entry) => ({
        path: entry?.attempt?.path,
        status: entry?.error?.status,
        message: entry?.error?.message,
      }));
      throw err;
    }
    throw new Error("GoC API call failed: no attempts");
  }

  normalizeThread(entity) {
    const row = asObject(entity);
    const metaRaw = pick(row, ["meta_json", "metaJson", "meta"]);
    const meta = metaRaw && typeof metaRaw === "object"
      ? asObject(metaRaw)
      : asObject(parseJsonMaybe(String(metaRaw || "")));
    return {
      id: pickId(row),
      title: String(pick(row, ["title", "name"]) || ""),
      externalRef: String(pick(row, ["external_ref", "externalRef", "ref"]) || ""),
      meta,
      raw: row,
    };
  }

  normalizeContextSet(entity) {
    const row = asObject(entity);
    const payloadRaw = pick(row, ["payload_json", "payloadJson", "payload", "meta_json", "metaJson", "meta"]);
    const payload = normalizePayloadObject(payloadRaw);
    const activeNodeIds = normalizeNodeIdList(
      pick(row, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
      || pick(payload, ["active_node_ids", "activeNodeIds", "node_ids", "nodeIds"])
    );
    return {
      id: pickId(row),
      name: String(pick(row, ["name", "title"]) || ""),
      version: String(
        pick(row, ["version", "context_version", "contextVersion", "rev", "etag"])
        || pick(payload, ["version", "context_version", "contextVersion", "rev", "etag"])
        || ""
      ).trim(),
      activeNodeIds,
      payload,
      raw: row,
    };
  }

  normalizeResource(entity) {
    const row = asObject(entity);
    const payloadRaw = pick(row, ["payload_json", "payloadJson", "payload"]);
    const payload = normalizePayloadObject(payloadRaw);
    return {
      id: pickId(row),
      name: String(pick(row, ["name", "title"]) || ""),
      text: String(pick(row, ["raw_text", "rawText", "text", "content", "summary", "compiled_text"]) || ""),
      summary: String(pick(row, ["summary", "text", "content", "raw_text", "rawText"]) || ""),
      uri: String(pick(row, ["uri", "url"]) || ""),
      resourceKind: String(
        pick(row, ["resource_kind", "resourceKind", "kind"])
        || pick(payload, ["resource_kind", "resourceKind", "kind"])
        || ""
      ).trim().toLowerCase(),
      contextSetId: String(
        pick(row, ["context_set_id", "contextSetId", "ctx_id", "ctxId"])
        || pick(payload, ["context_set_id", "contextSetId", "ctx_id", "ctxId"])
        || ""
      ).trim(),
      createdAt: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
      payload,
      raw: row,
    };
  }

  normalizeNode(entity) {
    const row = asObject(entity);
    const payloadRaw = pick(row, ["payload_json", "payloadJson", "payload"]);
    const payload = normalizePayloadObject(payloadRaw);
    return {
      id: pickId(row),
      name: String(pick(row, ["name", "title"]) || ""),
      summary: String(pick(row, ["summary", "text", "content"]) || ""),
      createdAt: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
      type: String(
        pick(row, ["type", "node_type", "nodeType", "kind", "label"])
        || pick(payload, ["type", "node_type", "nodeType", "kind"])
        || ""
      ).trim(),
      resourceKind: String(
        pick(row, ["resource_kind", "resourceKind"])
        || pick(payload, ["resource_kind", "resourceKind", "kind"])
        || ""
      ).trim().toLowerCase(),
      contextSetId: String(
        pick(row, ["context_set_id", "contextSetId", "ctx_id", "ctxId"])
        || pick(payload, ["context_set_id", "contextSetId", "ctx_id", "ctxId"])
        || ""
      ).trim(),
      payload,
      raw: row,
    };
  }

  normalizeMessage(entity) {
    const row = asObject(entity);
    const payload = normalizePayloadObject(pick(row, ["payload_json", "payloadJson", "payload", "meta_json", "metaJson", "meta"]));
    const roleRaw = String(
      pick(row, ["role", "author_role", "authorRole"])
      || pick(payload, ["role"])
      || ""
    ).trim().toLowerCase();
    const role = ["user", "assistant", "system", "tool"].includes(roleRaw) ? roleRaw : "user";
    const text = String(
      pick(row, ["text", "content", "raw_text", "rawText", "summary"])
      || pick(payload, ["text", "content"])
      || ""
    );
    return {
      id: pickId(row),
      role,
      text,
      replyTo: String(
        pick(row, ["reply_to", "replyTo", "reply_to_message_id", "replyToMessageId"])
        || pick(payload, ["reply_to", "replyTo"])
        || ""
      ).trim(),
      createdAt: String(pick(row, ["created_at", "createdAt", "ts", "timestamp"]) || ""),
      payload,
      raw: row,
    };
  }

  async createThread(title) {
    const cleanTitle = String(title || "").trim();
    if (!cleanTitle) throw new Error("createThread requires title");

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/threads", body: { title: cleanTitle } },
        { path: "/threads", body: { title: cleanTitle } },
        { path: "/v1/threads", body: { title: cleanTitle } },
        { path: "/api/thread", body: { title: cleanTitle } },
      ],
    });
    const entity = normalizeEntity(data, ["thread", "data"]);
    let thread = this.normalizeThread(entity);
    if (!thread.id) {
      const candidates = normalizeArrayResponse(data);
      for (const row of candidates) {
        const normalized = this.normalizeThread(normalizeEntity(row, ["thread", "data"]));
        if (normalized.id) {
          thread = normalized;
          break;
        }
      }
    }
    if (!thread.id) {
      try {
        const found = await this.findThreadByTitle(cleanTitle);
        if (found?.id) thread = found;
      } catch {}
    }
    if (!thread.id) throw new Error("GoC createThread returned no id");
    return thread;
  }

  async createMemorySurface(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("createMemorySurface requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/surfaces`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/surfaces`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/surfaces`, body },
      ],
    });
  }

  async recordMemoryTopology(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("recordMemoryTopology requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/topology`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/topology`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/topology`, body },
      ],
    });
  }

  async recordMemoryDemand(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("recordMemoryDemand requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/demand`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/demand`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/demand`, body },
      ],
    });
  }

  async previewMemoryMaterialization(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("previewMemoryMaterialization requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/preview`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/preview`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/preview`, body },
      ],
    });
  }

  async saveMemoryMaterializationCandidates(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("saveMemoryMaterializationCandidates requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/candidates`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/candidates`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/candidates`, body },
      ],
    });
  }

  async listMemoryMaterializationModules(threadId) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("listMemoryMaterializationModules requires threadId");
    return await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules` },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules` },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules` },
      ],
    });
  }

  async createMemoryMaterializationShadowModule(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("createMemoryMaterializationShadowModule requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules/shadow`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules/shadow`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/materialization/modules/shadow`, body },
      ],
    });
  }


  async recordRuntimeProposals(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("recordRuntimeProposals requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/proposals`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/proposals`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/proposals`, body },
      ],
    });
  }

  async listRuntimeProposals(threadId, { status = '', kind = '', includeClosed = false, limit = 100 } = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("listRuntimeProposals requires threadId");
    return await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/proposals`, query: { status, kind, include_closed: includeClosed ? 1 : 0, limit } },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/proposals`, query: { status, kind, include_closed: includeClosed ? 1 : 0, limit } },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/proposals`, query: { status, kind, include_closed: includeClosed ? 1 : 0, limit } },
      ],
    });
  }

  async applyRuntimeProposalAction(threadId, proposalId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    const cleanProposalId = String(proposalId || "").trim();
    if (!cleanThreadId || !cleanProposalId) throw new Error("applyRuntimeProposalAction requires threadId and proposalId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/proposals/${encodeURIComponent(cleanProposalId)}/action`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/proposals/${encodeURIComponent(cleanProposalId)}/action`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/proposals/${encodeURIComponent(cleanProposalId)}/action`, body },
      ],
    });
  }

  async createMemoryNode(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("createMemoryNode requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/nodes`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/nodes`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/nodes`, body },
      ],
    });
  }

  async createMemoryProjection(threadId, body = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("createMemoryProjection requires threadId");
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/memory/project`, body },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/memory/project`, body },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/memory/project`, body },
      ],
    });
  }

  async getRunStudioRunBundle(threadId, { contextSetId = "", runId = "" } = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("getRunStudioRunBundle requires threadId");
    const query = {};
    const cleanContextSetId = String(contextSetId || "").trim();
    const cleanRunId = String(runId || "").trim();
    if (cleanContextSetId) query.context_set_id = cleanContextSetId;
    if (cleanRunId) query.run_id = cleanRunId;
    return await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/run_studio/run_bundle`, query },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/run_studio/run_bundle`, query },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/run_studio/run_bundle`, query },
      ],
    });
  }

  async getHarnessSpec(threadId) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("getHarnessSpec requires threadId");
    return await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/harness_spec` },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/harness_spec` },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/harness_spec` },
      ],
    });
  }

  async getHarnessPackage(threadId) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("getHarnessPackage requires threadId");
    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/harness_package` },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/harness_package` },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/harness_package` },
      ],
    });
    return normalizeHarnessPackage(data);
  }

  async updateHarnessSpec(threadId, harnessSpec = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("updateHarnessSpec requires threadId");
    return await this._requestAny({
      method: "PUT",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/harness_spec`, body: { harness_spec: harnessSpec } },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/harness_spec`, body: { harness_spec: harnessSpec } },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/harness_spec`, body: { harness_spec: harnessSpec } },
      ],
    });
  }

  async installHarnessPackage(threadId, harnessPackage = {}, applyState = 'active') {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('installHarnessPackage requires threadId');
    const pkg = normalizeHarnessPackage(harnessPackage);
    try {
      const data = await this._requestAny({
        method: 'POST',
        attempts: [
          { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/harness_package/install`, body: { package: pkg, apply_state: applyState } },
          { path: `/threads/${encodeURIComponent(cleanThreadId)}/harness_package/install`, body: { package: pkg, apply_state: applyState } },
          { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/harness_package/install`, body: { package: pkg, apply_state: applyState } },
        ],
      });
      return normalizeHarnessPackage(data);
    } catch (error) {
      await this.updateHarnessSpec(cleanThreadId, pkg.harness_spec || {});
      await this.installTeamBlueprint({ threadId: cleanThreadId }, pkg.team_manifest || {}, applyState);
      return pkg;
    }
  }

  async listSkills({ threadId = '', includeDefaults = true } = {}) {
    const query = {};
    const cleanThreadId = String(threadId || '').trim();
    if (cleanThreadId) query.thread_id = cleanThreadId;
    query.include_defaults = includeDefaults ? 'true' : 'false';
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: '/api/skills', query },
        { path: '/skills', query },
      ],
    });
  }

  async getSkillPackage(skillId, { threadId = '', includeDefaults = true } = {}) {
    const cleanSkillId = String(skillId || '').trim();
    if (!cleanSkillId) throw new Error('getSkillPackage requires skillId');
    const query = {};
    const cleanThreadId = String(threadId || '').trim();
    if (cleanThreadId) query.thread_id = cleanThreadId;
    query.include_defaults = includeDefaults ? 'true' : 'false';
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: `/api/skills/${encodeURIComponent(cleanSkillId)}`, query },
        { path: `/skills/${encodeURIComponent(cleanSkillId)}`, query },
      ],
    });
  }

  async exportSkillPackage(skillId, { threadId = '', includeDefaults = true } = {}) {
    const cleanSkillId = String(skillId || '').trim();
    if (!cleanSkillId) throw new Error('exportSkillPackage requires skillId');
    const query = {};
    const cleanThreadId = String(threadId || '').trim();
    if (cleanThreadId) query.thread_id = cleanThreadId;
    query.include_defaults = includeDefaults ? 'true' : 'false';
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: `/api/skills/${encodeURIComponent(cleanSkillId)}/export`, query },
        { path: `/skills/${encodeURIComponent(cleanSkillId)}/export`, query },
      ],
    });
  }

  async installSkillPackage({ threadId = '', skillId = '', package: skillPackage = null, sourceThreadId = '', contextSetId = '' } = {}) {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('installSkillPackage requires threadId');
    if (!String(skillId || '').trim() && !asObject(skillPackage) && !skillPackage) throw new Error('installSkillPackage requires skillId or package');
    const body = {
      thread_id: cleanThreadId,
      skill_id: String(skillId || '').trim() || undefined,
      package: skillPackage || undefined,
      source_thread_id: String(sourceThreadId || '').trim() || undefined,
      context_set_id: String(contextSetId || '').trim() || undefined,
      auto_activate: true,
    };
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: '/api/skills/install', body },
        { path: '/skills/install', body },
      ],
    });
  }

  async publishSkillPackage({ skillId = '', package: skillPackage = null, threadId = '' } = {}) {
    if (!String(skillId || '').trim() && !asObject(skillPackage) && !skillPackage) throw new Error('publishSkillPackage requires skillId or package');
    const body = {
      skill_id: String(skillId || '').trim() || undefined,
      package: skillPackage || undefined,
      thread_id: String(threadId || '').trim() || undefined,
      visibility: 'public',
    };
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: '/api/skills/publish', body },
        { path: '/skills/publish', body },
      ],
    });
  }


  async getThreadBoard(threadId, { includeRawHistory = true, includeOtherResources = true, limitPerLane = 24 } = {}) {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('getThreadBoard requires threadId');
    const query = {
      include_raw_history: includeRawHistory ? 'true' : 'false',
      include_other_resources: includeOtherResources ? 'true' : 'false',
      limit_per_lane: String(limitPerLane),
    };
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/board`, query },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/board`, query },
      ],
    });
  }

  async approveBoardCandidate(threadId, candidateNodeId, { publishToLibrary = false } = {}) {
    const cleanThreadId = String(threadId || '').trim();
    const cleanCandidateNodeId = String(candidateNodeId || '').trim();
    if (!cleanThreadId) throw new Error('approveBoardCandidate requires threadId');
    if (!cleanCandidateNodeId) throw new Error('approveBoardCandidate requires candidateNodeId');
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/board/candidates/${encodeURIComponent(cleanCandidateNodeId)}/approve`, body: { publish_to_library: publishToLibrary === true } },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/board/candidates/${encodeURIComponent(cleanCandidateNodeId)}/approve`, body: { publish_to_library: publishToLibrary === true } },
      ],
    });
  }

  async listImprovementJobs(threadId) {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('listImprovementJobs requires threadId');
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs` },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs` },
      ],
    });
  }

  async createImprovementJob(threadId, body = {}) {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('createImprovementJob requires threadId');
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs`, body: asObject(body) },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs`, body: asObject(body) },
      ],
    });
  }

  async getImprovementJob(threadId, jobId) {
    const cleanThreadId = String(threadId || '').trim();
    const cleanJobId = String(jobId || '').trim();
    if (!cleanThreadId) throw new Error('getImprovementJob requires threadId');
    if (!cleanJobId) throw new Error('getImprovementJob requires jobId');
    return await this._requestAny({
      method: 'GET',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs/${encodeURIComponent(cleanJobId)}` },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs/${encodeURIComponent(cleanJobId)}` },
      ],
    });
  }

  async reportImprovementJob(threadId, jobId, body = {}) {
    const cleanThreadId = String(threadId || '').trim();
    const cleanJobId = String(jobId || '').trim();
    if (!cleanThreadId) throw new Error('reportImprovementJob requires threadId');
    if (!cleanJobId) throw new Error('reportImprovementJob requires jobId');
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs/${encodeURIComponent(cleanJobId)}/report`, body: asObject(body) },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/improvement_jobs/${encodeURIComponent(cleanJobId)}/report`, body: asObject(body) },
      ],
    });
  }

  async upsertRawHistory(threadId, body = {}) {
    const cleanThreadId = String(threadId || '').trim();
    if (!cleanThreadId) throw new Error('upsertRawHistory requires threadId');
    const payload = asObject(body);
    return await this._requestAny({
      method: 'POST',
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/raw_history`, body: payload },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/raw_history`, body: payload },
      ],
    });
  }
  async getRunStudioSummary(threadId, { contextSetId = "" } = {}) {
    const cleanThreadId = String(threadId || "").trim();
    if (!cleanThreadId) throw new Error("getRunStudioSummary requires threadId");
    const query = {};
    const cleanContextSetId = String(contextSetId || "").trim();
    if (cleanContextSetId) query.context_set_id = cleanContextSetId;
    return await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(cleanThreadId)}/run_studio/summary`, query },
        { path: `/threads/${encodeURIComponent(cleanThreadId)}/run_studio/summary`, query },
        { path: `/v1/threads/${encodeURIComponent(cleanThreadId)}/run_studio/summary`, query },
      ],
    });
  }

  async listThreads() {
    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: "/api/threads" },
        { path: "/threads" },
        { path: "/v1/threads" },
      ],
    });
    return normalizeArrayResponse(data).map((row) => this.normalizeThread(row)).filter((row) => row.id);
  }

  async findThreadByTitle(title) {
    const clean = String(title || "").trim();
    if (!clean) return null;
    const list = await this.listThreads();
    return list.find((row) => row.title === clean) || null;
  }

  async findThreadByExternalRef(externalRef) {
    const clean = String(externalRef || "").trim();
    if (!clean) return null;
    const list = await this.listThreads();
    return list.find((row) => String(row?.externalRef || "").trim() === clean) || null;
  }

  async ensureThread({ title = "", externalRef = "", metaJson = null } = {}) {
    const cleanTitle = String(title || "").trim();
    const cleanExternalRef = String(externalRef || "").trim();
    if (!cleanTitle && !cleanExternalRef) {
      throw new Error("ensureThread requires title or externalRef");
    }

    const payload = {
      title: cleanTitle || undefined,
      external_ref: cleanExternalRef || undefined,
      externalRef: cleanExternalRef || undefined,
      meta_json: metaJson && typeof metaJson === "object" ? metaJson : undefined,
      metaJson: metaJson && typeof metaJson === "object" ? metaJson : undefined,
    };

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/threads/ensure", body: payload },
        { path: "/threads/ensure", body: payload },
        { path: "/v1/threads/ensure", body: payload },
        { path: "/api/threads:ensure", body: payload },
      ],
    });
    const entity = normalizeEntity(data, ["thread", "data"]);
    let thread = this.normalizeThread(entity);
    if (!thread.id) {
      const list = normalizeArrayResponse(data);
      for (const row of list) {
        const normalized = this.normalizeThread(normalizeEntity(row, ["thread", "data"]));
        if (!normalized.id) continue;
        thread = normalized;
        break;
      }
    }
    if (!thread.id) {
      if (cleanExternalRef) {
        const foundByRef = await this.findThreadByExternalRef(cleanExternalRef).catch(() => null);
        if (foundByRef?.id) thread = foundByRef;
      }
      if (!thread.id && cleanTitle) {
        const foundByTitle = await this.findThreadByTitle(cleanTitle).catch(() => null);
        if (foundByTitle?.id) thread = foundByTitle;
      }
    }
    if (!thread.id) throw new Error("GoC ensureThread returned no id");
    return thread;
  }

  async listContextSets(threadId) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("listContextSets requires threadId");
    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: "/api/context_sets", query: { thread_id: tid } },
        { path: "/api/context-sets", query: { thread_id: tid } },
        { path: "/context_sets", query: { thread_id: tid } },
        { path: "/context-sets", query: { thread_id: tid } },
        { path: `/api/threads/${encodeURIComponent(tid)}/context_sets` },
        { path: `/threads/${encodeURIComponent(tid)}/context_sets` },
      ],
    });
    return normalizeArrayResponse(data).map((row) => this.normalizeContextSet(row)).filter((row) => row.id);
  }

  async createContextSet(threadId, name) {
    const tid = String(threadId || "").trim();
    const cname = String(name || "").trim();
    if (!tid) throw new Error("createContextSet requires threadId");
    if (!cname) throw new Error("createContextSet requires name");

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/context_sets", body: { thread_id: tid, name: cname } },
        { path: "/api/context-sets", body: { thread_id: tid, name: cname } },
        { path: "/context_sets", body: { thread_id: tid, name: cname } },
        { path: "/context-sets", body: { thread_id: tid, name: cname } },
        { path: `/api/threads/${encodeURIComponent(tid)}/context_sets`, body: { name: cname } },
        { path: `/threads/${encodeURIComponent(tid)}/context_sets`, body: { name: cname } },
      ],
    });
    const entity = normalizeEntity(data, ["context_set", "contextSet", "data"]);
    const ctx = this.normalizeContextSet(entity);
    if (!ctx.id) throw new Error("GoC createContextSet returned no id");
    return ctx;
  }

  async getContextSet(contextSetId) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("getContextSet requires contextSetId");
    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}` },
        { path: `/api/context-sets/${encodeURIComponent(ctxId)}` },
        { path: `/context_sets/${encodeURIComponent(ctxId)}` },
        { path: `/context-sets/${encodeURIComponent(ctxId)}` },
      ],
    });
    const entity = normalizeEntity(data, ["context_set", "contextSet", "data"]);
    const contextSet = this.normalizeContextSet(entity);
    if (!contextSet.id) {
      return {
        ...contextSet,
        id: ctxId,
      };
    }
    return contextSet;
  }

  async rebuildContextSetActive(contextSetId, policy = {}) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("rebuildContextSetActive requires contextSetId");
    const body = {
      ...asObject(policy),
      context_set_id: ctxId,
    };
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/rebuild_active`, body },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}:rebuild_active`, body },
        { path: `/context_sets/${encodeURIComponent(ctxId)}/rebuild_active`, body },
        { path: "/api/context_sets/rebuild_active", body },
        { path: "/context_sets/rebuild_active", body },
      ],
    });
    const entity = normalizeEntity(data, ["context_set", "contextSet", "result", "data"]);
    const ctx = this.normalizeContextSet(entity);
    const meta = normalizeCompiledMeta(data);
    return {
      ok: true,
      context_set_id: ctx.id || ctxId,
      active_node_ids: meta.active_node_ids.length > 0 ? meta.active_node_ids : ctx.activeNodeIds,
      context_version: meta.context_version || ctx.version || "",
      node_type_breakdown: meta.node_type_breakdown,
      raw: data,
    };
  }

  async cloneContextSet(baseContextSetId, name = "", meta = null) {
    const baseId = String(baseContextSetId || "").trim();
    if (!baseId) throw new Error("cloneContextSet requires baseContextSetId");
    const cleanName = String(name || "").trim();
    const metaJson = meta && typeof meta === "object" ? meta : undefined;
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        {
          path: `/api/context_sets/${encodeURIComponent(baseId)}/clone`,
          body: {
            name: cleanName || undefined,
            meta: metaJson,
            meta_json: metaJson,
          },
        },
        {
          path: `/api/context-sets/${encodeURIComponent(baseId)}/clone`,
          body: {
            name: cleanName || undefined,
            meta: metaJson,
            meta_json: metaJson,
          },
        },
        {
          path: "/api/context_sets/clone",
          body: {
            base_context_set_id: baseId,
            context_set_id: baseId,
            name: cleanName || undefined,
            meta: metaJson,
            meta_json: metaJson,
          },
        },
        {
          path: "/api/context_sets:clone",
          body: {
            base_context_set_id: baseId,
            context_set_id: baseId,
            name: cleanName || undefined,
            meta: metaJson,
            meta_json: metaJson,
          },
        },
        {
          path: `/context_sets/${encodeURIComponent(baseId)}/clone`,
          body: {
            name: cleanName || undefined,
            meta: metaJson,
            meta_json: metaJson,
          },
        },
      ],
    });
    const entity = normalizeEntity(data, ["context_set", "contextSet", "clone", "data"]);
    const cloned = this.normalizeContextSet(entity);
    if (!cloned.id) throw new Error("GoC cloneContextSet returned no id");
    return cloned;
  }

  async unfoldPlan(contextSetId, query, options = {}) {
    const ctxId = String(contextSetId || "").trim();
    const q = String(query || "").trim();
    if (!ctxId) throw new Error("unfoldPlan requires contextSetId");
    if (!q) return { context_set_id: ctxId, seed_node_ids: [], raw: null };

    const opts = asObject(options);
    const body = {
      query: q,
      budget_tokens: Number.isFinite(Number(opts.budget_tokens))
        ? Math.max(100, Math.min(12000, Math.floor(Number(opts.budget_tokens))))
        : undefined,
      closure_edge_types: Array.isArray(opts.closure_edge_types)
        ? opts.closure_edge_types.map((row) => String(row || "").trim()).filter(Boolean)
        : undefined,
      closure_direction: String(opts.closure_direction || "").trim() || undefined,
      max_closure_nodes: Number.isFinite(Number(opts.max_closure_nodes))
        ? Math.max(1, Math.min(2000, Math.floor(Number(opts.max_closure_nodes))))
        : undefined,
    };
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/unfold_plan`, body },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/unfold/plan`, body },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}:unfold_plan`, body },
        { path: "/api/context_sets/unfold_plan", body: { context_set_id: ctxId, ...body } },
        { path: `/context_sets/${encodeURIComponent(ctxId)}/unfold_plan`, body },
      ],
    });
    const row = normalizeEntity(data, ["plan", "unfold_plan", "data"]);
    const seedNodeIds = normalizeNodeIdList(
      pick(row, ["seed_node_ids", "seedNodeIds", "node_ids", "nodeIds", "add_node_ids", "addNodeIds"])
      || pick(data, ["seed_node_ids", "seedNodeIds", "node_ids", "nodeIds", "add_node_ids", "addNodeIds"])
    );
    return {
      context_set_id: ctxId,
      seed_node_ids: seedNodeIds,
      raw: data,
    };
  }

  async applyUnfoldPlan(contextSetId, seedNodeIdsOrPlan, options = {}) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("applyUnfoldPlan requires contextSetId");

    const source = asObject(seedNodeIdsOrPlan);
    const seedNodeIds = normalizeNodeIdList(
      Array.isArray(seedNodeIdsOrPlan) || typeof seedNodeIdsOrPlan === "string"
        ? seedNodeIdsOrPlan
        : (source.seed_node_ids || source.seedNodeIds || source.node_ids || source.nodeIds || [])
    );
    if (seedNodeIds.length === 0) {
      return {
        context_set_id: ctxId,
        seed_node_ids: [],
        added_node_ids: [],
      };
    }

    const opts = asObject(options);
    const body = {
      seed_node_ids: seedNodeIds,
      query: String(opts.query || source.query || "").trim() || undefined,
      budget_tokens: Number.isFinite(Number(opts.budget_tokens ?? source.budget_tokens))
        ? Math.max(100, Math.min(12000, Math.floor(Number(opts.budget_tokens ?? source.budget_tokens))))
        : undefined,
      closure_edge_types: Array.isArray(opts.closure_edge_types)
        ? opts.closure_edge_types.map((row) => String(row || "").trim()).filter(Boolean)
        : undefined,
      closure_direction: String(opts.closure_direction || source.closure_direction || "").trim() || undefined,
      max_closure_nodes: Number.isFinite(Number(opts.max_closure_nodes ?? source.max_closure_nodes))
        ? Math.max(1, Math.min(2000, Math.floor(Number(opts.max_closure_nodes ?? source.max_closure_nodes))))
        : undefined,
    };

    try {
      const data = await this._requestAny({
        method: "POST",
        attempts: [
          { path: `/api/context_sets/${encodeURIComponent(ctxId)}/apply_unfold_plan`, body },
          { path: `/api/context_sets/${encodeURIComponent(ctxId)}/unfold/apply`, body },
          { path: `/api/context_sets/${encodeURIComponent(ctxId)}:apply_unfold_plan`, body },
          { path: "/api/context_sets/apply_unfold_plan", body: { context_set_id: ctxId, ...body } },
          { path: `/context_sets/${encodeURIComponent(ctxId)}/apply_unfold_plan`, body },
        ],
      });
      const row = normalizeEntity(data, ["result", "data", "plan"]);
      const addedNodeIds = normalizeNodeIdList(
        pick(row, ["added_node_ids", "addedNodeIds", "node_ids", "nodeIds", "active_node_ids", "activeNodeIds"])
        || pick(data, ["added_node_ids", "addedNodeIds", "node_ids", "nodeIds", "active_node_ids", "activeNodeIds"])
      );
      return {
        context_set_id: ctxId,
        seed_node_ids: seedNodeIds,
        added_node_ids: addedNodeIds.length > 0 ? addedNodeIds : seedNodeIds,
        raw: data,
      };
    } catch {
      await this.activateNodes(ctxId, seedNodeIds);
      return {
        context_set_id: ctxId,
        seed_node_ids: seedNodeIds,
        added_node_ids: seedNodeIds,
      };
    }
  }

  async createResource(threadId, body = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("createResource requires threadId");
    const payload = asObject(body);

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(tid)}/resources`, body: payload },
        { path: "/api/resources", body: { thread_id: tid, ...payload } },
        { path: "/resources", body: { thread_id: tid, ...payload } },
        { path: "/v1/resources", body: { thread_id: tid, ...payload } },
        { path: `/threads/${encodeURIComponent(tid)}/resources`, body: payload },
      ],
    });
    const entity = normalizeEntity(data, ["resource", "node", "data"]);
    const resource = this.normalizeResource(entity);
    if (!resource.id) throw new Error("GoC createResource returned no id");
    return resource;
  }

  async createNode(threadId, body = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("createNode requires threadId");
    const payload = asObject(body);

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(tid)}/nodes`, body: payload },
        { path: "/api/nodes", body: { thread_id: tid, ...payload } },
        { path: "/nodes", body: { thread_id: tid, ...payload } },
        { path: "/v1/nodes", body: { thread_id: tid, ...payload } },
        { path: `/threads/${encodeURIComponent(tid)}/nodes`, body: payload },
      ],
    });
    const entity = normalizeEntity(data, ["node", "data", "resource"]);
    const node = this.normalizeNode(entity);
    if (!node.id) throw new Error("GoC createNode returned no id");
    return node;
  }

  async addMessage(threadId, body = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("addMessage requires threadId");
    const payload = asObject(body);
    const roleRaw = String(payload.role || "").trim().toLowerCase();
    const role = ["user", "assistant", "system", "tool"].includes(roleRaw) ? roleRaw : "user";
    const text = String(payload.text || payload.content || "").trim();
    if (!text) throw new Error("addMessage requires text");
    const replyTo = String(payload.reply_to || payload.replyTo || "").trim();
    const metaRaw = payload.meta_json && typeof payload.meta_json === "object"
      ? payload.meta_json
      : (payload.metaJson && typeof payload.metaJson === "object" ? payload.metaJson : null);
    const meta = metaRaw && typeof metaRaw === "object" ? metaRaw : undefined;

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        {
          path: `/api/threads/${encodeURIComponent(tid)}/messages`,
          body: {
            role,
            text,
            reply_to: replyTo || undefined,
            meta_json: meta,
          },
        },
        {
          path: `/threads/${encodeURIComponent(tid)}/messages`,
          body: {
            role,
            text,
            reply_to: replyTo || undefined,
            meta_json: meta,
          },
        },
        {
          path: "/api/messages",
          body: {
            thread_id: tid,
            role,
            text,
            reply_to: replyTo || undefined,
            meta_json: meta,
          },
        },
        {
          path: "/messages",
          body: {
            thread_id: tid,
            role,
            text,
            reply_to: replyTo || undefined,
            meta_json: meta,
          },
        },
      ],
    });
    const entity = normalizeEntity(data, ["message", "data", "node"]);
    const message = this.normalizeMessage(entity);
    if (!message.id) throw new Error("GoC addMessage returned no id");
    return message;
  }

  async listResources(threadId, options = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("listResources requires threadId");
    const resourceKind = String(options.resourceKind || "").trim().toLowerCase();
    const contextSetId = String(options.contextSetId || "").trim();

    let rawRows = [];
    let usedGraphFallback = false;
    try {
      const data = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/resources`, query: { resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: "/api/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: "/api/resources", query: { threadId: tid, resourceKind: resourceKind || undefined, contextSetId: contextSetId || undefined } },
          { path: "/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: "/v1/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: `/threads/${encodeURIComponent(tid)}/resources`, query: { resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
        ],
      });
      rawRows = normalizeArrayResponse(data);
    } catch (listErr) {
      const graphData = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/v1/threads/${encodeURIComponent(tid)}/graph` },
        ],
      }).catch(() => null);

      if (!graphData) throw listErr;
      usedGraphFallback = true;
      rawRows = normalizeGraphNodes(graphData).filter((row) => isGraphResourceNode(row));
    }

    let rows = rawRows
      .map((row) => this.normalizeResource(usedGraphFallback ? normalizeEntity(row, ["resource", "node", "data"]) : row))
      .filter((row) => row.id);
    if (resourceKind) {
      rows = rows.filter((row) => row.resourceKind === resourceKind);
    }
    if (contextSetId) {
      rows = rows.filter((row) => !row.contextSetId || row.contextSetId === contextSetId);
    }
    return rows;
  }

  async listNodes(threadId, options = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("listNodes requires threadId");
    const contextSetId = String(options.contextSetId || "").trim();

    let rawRows = [];
    let usedGraphFallback = false;
    try {
      const data = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/nodes`, query: { context_set_id: contextSetId || undefined } },
          { path: "/api/nodes", query: { thread_id: tid, context_set_id: contextSetId || undefined } },
          { path: "/api/nodes", query: { threadId: tid, contextSetId: contextSetId || undefined } },
          { path: "/nodes", query: { thread_id: tid, context_set_id: contextSetId || undefined } },
          { path: "/v1/nodes", query: { thread_id: tid, context_set_id: contextSetId || undefined } },
          { path: `/threads/${encodeURIComponent(tid)}/nodes`, query: { context_set_id: contextSetId || undefined } },
        ],
      });
      rawRows = normalizeArrayResponse(data);
    } catch (listErr) {
      const graphData = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/v1/threads/${encodeURIComponent(tid)}/graph` },
        ],
      }).catch(() => null);
      if (!graphData) throw listErr;
      usedGraphFallback = true;
      rawRows = normalizeGraphNodes(graphData);
    }

    let rows = rawRows
      .map((row) => this.normalizeNode(usedGraphFallback ? normalizeEntity(row, ["node", "resource", "data"]) : row))
      .filter((row) => row.id);
    if (contextSetId) {
      rows = rows.filter((row) => !row.contextSetId || row.contextSetId === contextSetId);
    }
    return rows;
  }

  async listMessages(threadId, options = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("listMessages requires threadId");
    const limitRaw = Number(options.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.max(1, Math.min(200, Math.floor(limitRaw)))
      : undefined;

    let rawRows = [];
    let usedGraphFallback = false;
    try {
      const data = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/messages`, query: { limit } },
          { path: `/threads/${encodeURIComponent(tid)}/messages`, query: { limit } },
          { path: "/api/messages", query: { thread_id: tid, limit } },
          { path: "/messages", query: { thread_id: tid, limit } },
          { path: "/v1/messages", query: { thread_id: tid, limit } },
        ],
      });
      rawRows = normalizeArrayResponse(data);
    } catch (listErr) {
      const graphData = await this._requestAny({
        method: "GET",
        attempts: [
          { path: `/api/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/threads/${encodeURIComponent(tid)}/graph` },
          { path: `/v1/threads/${encodeURIComponent(tid)}/graph` },
        ],
      }).catch(() => null);
      if (!graphData) throw listErr;
      usedGraphFallback = true;
      rawRows = normalizeGraphNodes(graphData).filter((row) => isGraphMessageNode(row));
    }

    let rows = rawRows
      .map((row) => this.normalizeMessage(usedGraphFallback ? normalizeEntity(row, ["message", "node", "data"]) : row))
      .filter((row) => row.id);
    if (typeof limit === "number" && limit > 0 && rows.length > limit) {
      rows = rows.slice(-limit);
    }
    return rows;
  }

  async createEdge(threadId, fromId, toId, type = "NEXT_PART") {
    const tid = String(threadId || "").trim();
    const from = String(fromId || "").trim();
    const to = String(toId || "").trim();
    const edgeType = String(type || "NEXT_PART").trim() || "NEXT_PART";
    if (!tid || !from || !to) throw new Error("createEdge requires threadId/fromId/toId");

    try {
      await this._requestAny({
        method: "POST",
        attempts: [
          // Primary backend contract
          {
            path: `/api/threads/${encodeURIComponent(tid)}/edges`,
            body: { from_id: from, to_id: to, type: edgeType },
          },
          // Compatibility fallbacks
          { path: "/api/edges", body: { thread_id: tid, from_id: from, to_id: to, type: edgeType } },
          { path: "/edges", body: { thread_id: tid, from_id: from, to_id: to, type: edgeType } },
          { path: "/v1/edges", body: { thread_id: tid, from_id: from, to_id: to, type: edgeType } },
          { path: "/api/nodes/edges", body: { thread_id: tid, from_node_id: from, to_node_id: to, edge_type: edgeType } },
        ],
      });
      if (String(process.env.GOC_DEBUG || "").trim().toLowerCase() === "true") {
        console.log(`[goc] createEdge ok thread=${tid} from=${from} to=${to} type=${edgeType}`);
      }
      return true;
    } catch (e) {
      console.warn(`[goc] createEdge failed thread=${tid} from=${from} to=${to} type=${edgeType}: ${String(e?.message ?? e)}`);
      throw e;
    }
  }

  async getCompiledContext(contextSetId, options = {}) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("getCompiledContext requires contextSetId");
    const payload = await this.getCompiledContextWithMeta(ctxId, options);
    return String(payload?.text || "");
  }

  async getCompiledContextWithMeta(contextSetId, options = {}) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("getCompiledContextWithMeta requires contextSetId");
    const includeExplain = parseBooleanLike(
      options?.includeExplain ?? options?.include_explain,
      false
    );
    const includeMeta = parseBooleanLike(
      options?.includeMeta ?? options?.include_meta,
      false
    );
    const maxChars = Number.isFinite(Number(options?.max_chars ?? options?.maxChars))
      ? Math.max(500, Math.min(120000, Math.floor(Number(options.max_chars ?? options.maxChars))))
      : undefined;
    const excludeTypes = normalizeStringList(options?.exclude_types ?? options?.excludeTypes);
    const excludeResourceKinds = normalizeStringList(options?.exclude_resource_kinds ?? options?.excludeResourceKinds);

    const query = {
      include_explain: includeExplain ? true : undefined,
      include_meta: includeMeta ? 1 : undefined,
      max_chars: maxChars || undefined,
      exclude_types: excludeTypes.length > 0 ? excludeTypes.join(",") : undefined,
      exclude_resource_kinds: excludeResourceKinds.length > 0 ? excludeResourceKinds.join(",") : undefined,
    };

    const attempts = [
      { path: `/api/context_sets/${encodeURIComponent(ctxId)}/compiled`, query },
      { path: "/api/compiled_context", query: { context_set_id: ctxId, ...query } },
      { path: "/api/compiled", query: { context_set_id: ctxId, ...query } },
      // Keep legacy non-/api routes as the last resort to avoid UI fallback HTML.
      { path: `/context_sets/${encodeURIComponent(ctxId)}/compiled`, query },
      { path: "/compiled_context", query: { context_set_id: ctxId, ...query } },
      { path: "/compiled", query: { context_set_id: ctxId, ...query } },
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        const data = await this._request({
          method: "GET",
          path: attempt.path,
          query: attempt.query,
        });
        const normalized = normalizeCompiledExplainPayload(data);
        const meta = normalizeCompiledMeta(data, normalized);
        return {
          text: normalized.compiled_text,
          explain: normalized.explain,
          active_node_ids: meta.active_node_ids.length > 0 ? meta.active_node_ids : normalized.active_node_ids,
          token_estimate: meta.token_estimate,
          context_version: meta.context_version,
          node_type_breakdown: meta.node_type_breakdown,
          raw: data,
        };
      } catch (e) {
        errors.push(e);
        if (!isRetryableStatus(e?.status)) break;
      }
    }

    if (errors.length) throw errors[errors.length - 1];
    throw new Error("GoC getCompiledContextWithMeta failed: no attempts");
  }

  async getCompiledContextExplain(contextSetId) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("getCompiledContextExplain requires contextSetId");

    const attempts = [
      { path: `/api/context_sets/${encodeURIComponent(ctxId)}/compiled`, query: { include_explain: true } },
      { path: "/api/compiled_context", query: { context_set_id: ctxId, include_explain: true } },
      { path: "/api/compiled", query: { context_set_id: ctxId, include_explain: true } },
      { path: `/context_sets/${encodeURIComponent(ctxId)}/compiled`, query: { include_explain: true } },
      { path: "/compiled_context", query: { context_set_id: ctxId, include_explain: true } },
      { path: "/compiled", query: { context_set_id: ctxId, include_explain: true } },
    ];

    const errors = [];
    for (const attempt of attempts) {
      try {
        const data = await this._request({
          method: "GET",
          path: attempt.path,
          query: attempt.query,
        });
        const normalized = normalizeCompiledExplainPayload(data);
        return {
          compiled_text: normalized.compiled_text,
          explain: normalized.explain,
          active_node_ids: normalized.active_node_ids,
        };
      } catch (e) {
        errors.push(e);
        if (!isRetryableStatus(e?.status)) break;
      }
    }

    if (errors.length) throw errors[errors.length - 1];
    throw new Error("GoC getCompiledContextExplain failed: no attempts");
  }


  async materializeRuntimeScopes(threadId, runtimeSnapshot = {}, options = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("materializeRuntimeScopes requires threadId");
    const payload = {
      runtime_snapshot: sanitizeScopeMaterializationSnapshot(runtimeSnapshot),
    };
    const scopeId = String(options.scopeId || options.scope_id || "").trim();
    if (scopeId) {
      payload.scope_id = scopeId;
      payload.scopeId = scopeId;
    }
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(tid)}/scope_materialize`, body: payload },
        { path: `/threads/${encodeURIComponent(tid)}/scope_materialize`, body: payload },
        { path: "/api/scope_materialize", body: { thread_id: tid, ...payload } },
      ],
    });
    const rows = Array.isArray(asObject(data).materialized_scopes)
      ? asObject(data).materialized_scopes
      : normalizeArrayResponse(data);
    return rows
      .filter((row) => row && typeof row === "object")
      .map((row) => ({ ...row }));
  }

  async getNode(nodeId) {
    const nid = String(nodeId || "").trim();
    if (!nid) throw new Error("getNode requires nodeId");

    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: `/api/nodes/${encodeURIComponent(nid)}`, query: { include_parts: true } },
        { path: `/api/nodes/${encodeURIComponent(nid)}`, query: { includeParts: true } },
        { path: `/nodes/${encodeURIComponent(nid)}`, query: { include_parts: true } },
        { path: `/v1/nodes/${encodeURIComponent(nid)}`, query: { include_parts: true } },
        { path: `/api/resources/${encodeURIComponent(nid)}`, query: { include_parts: true } },
      ],
    });

    const entity = normalizeEntity(data, ["node", "resource", "data"]);
    const node = asObject(entity);
    if (!node.id && !node.node_id && !node.nodeId) {
      return { ...node, id: nid };
    }
    return node;
  }

  async activateNodes(contextSetId, nodeIds = []) {
    return await this._setNodesActivation(contextSetId, nodeIds, true);
  }

  async deactivateNodes(contextSetId, nodeIds = []) {
    return await this._setNodesActivation(contextSetId, nodeIds, false);
  }

  async updateNode(nodeId, body = {}) {
    const nid = String(nodeId || "").trim();
    if (!nid) throw new Error("updateNode requires nodeId");
    const payload = asObject(body);
    const data = await this._requestAny({
      method: "PATCH",
      attempts: [
        { path: `/api/nodes/${encodeURIComponent(nid)}`, body: payload },
        { path: `/nodes/${encodeURIComponent(nid)}`, body: payload },
        { path: `/v1/nodes/${encodeURIComponent(nid)}`, body: payload },
        { path: `/api/resources/${encodeURIComponent(nid)}`, body: payload },
        { path: `/resources/${encodeURIComponent(nid)}`, body: payload },
      ],
    });
    const entity = normalizeEntity(data, ["node", "resource", "data"]);
    const normalized = this.normalizeNode(entity);
    return normalized?.id ? normalized : { id: nid, raw: data };
  }

  async _setNodesActivation(contextSetId, nodeIds = [], active = true) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("_setNodesActivation requires contextSetId");
    const ids = normalizeNodeIdList(nodeIds);
    if (ids.length === 0) return { ok: true, context_set_id: ctxId, node_ids: [] };

    const suffix = active ? "activate" : "deactivate";
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/${suffix}`, body: { node_ids: ids } },
        { path: `/context_sets/${encodeURIComponent(ctxId)}/${suffix}`, body: { node_ids: ids } },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/${suffix}_nodes`, body: { node_ids: ids } },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/nodes/${suffix}`, body: { node_ids: ids } },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/nodes:${suffix}`, body: { node_ids: ids } },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/nodes`, body: { node_ids: ids, active } },
        { path: `/context_sets/${encodeURIComponent(ctxId)}/${suffix}_nodes`, body: { node_ids: ids } },
      ],
    });
    return {
      ok: true,
      context_set_id: ctxId,
      node_ids: ids,
      raw: data,
    };
  }

  async upsertUserFromTelegram(input = {}) {
    const row = asObject(input);
    const telegramId = String(
      row.telegram_user_id
      || row.telegramUserId
      || row.user_id
      || row.userId
      || ""
    ).trim();
    const initData = String(row.init_data || row.initData || "").trim();
    if (!telegramId && !initData) {
      throw new Error("upsertUserFromTelegram requires telegram user id or initData");
    }
    const body = {
      telegram_user_id: telegramId || undefined,
      telegramUserId: telegramId || undefined,
      init_data: initData || undefined,
      initData: initData || undefined,
      username: String(row.username || "").trim() || undefined,
      first_name: String(row.first_name || row.firstName || "").trim() || undefined,
      last_name: String(row.last_name || row.lastName || "").trim() || undefined,
    };
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/users/telegram/upsert", body },
        { path: "/api/telegram/users/upsert", body },
        { path: "/api/users:upsert_telegram", body },
        { path: "/users/telegram/upsert", body },
      ],
    });
    const entity = normalizeEntity(data, ["user", "telegram_user", "data"]);
    return {
      id: String(pick(entity, ["id", "user_id", "userId"]) || "").trim(),
      telegram_user_id: String(
        pick(entity, ["telegram_user_id", "telegramUserId", "user_id", "userId"])
        || telegramId
      ).trim(),
      raw: data,
    };
  }

  async ensureConversation(threadTarget, {
    bootstrapDefaults = false,
  } = {}) {
    const target = normalizeConversationTarget(threadTarget);
    const tid = String(target.thread_id || "").trim();
    if (!tid) throw new Error("ensureConversation requires threadId");
    const body = buildConversationIdentityPatchBody({
      bootstrap_defaults: bootstrapDefaults === true,
      bootstrapDefaults: bootstrapDefaults === true,
    }, target);
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/threads/${encodeURIComponent(tid)}/conversation/ensure`, body },
        { path: `/threads/${encodeURIComponent(tid)}/conversation/ensure`, body },
        { path: `/api/threads/${encodeURIComponent(tid)}/conversation`, body },
        ...(target.conversation_id ? [
          { path: `/api/conversations/${encodeURIComponent(target.conversation_id)}/ensure`, body },
          { path: `/api/conversations/${encodeURIComponent(target.conversation_id)}`, body },
        ] : []),
        { path: "/api/conversations/ensure", body },
        { path: "/api/conversations", body },
        { path: "/conversations/ensure", body },
        { path: "/conversations", body },
      ],
    });
    return normalizeConversation(
      normalizeEntity(data, ["conversation", "data"]),
      tid
    );
  }

  async bootstrapDefaultAgents(threadId, { addToConversation = true } = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("bootstrapDefaultAgents requires threadId");
    const body = {
      thread_id: tid,
      threadId: tid,
      add_to_conversation: addToConversation !== false,
      addToConversation: addToConversation !== false,
    };
    return await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/agents/bootstrap_defaults", body },
        { path: "/agents/bootstrap_defaults", body },
        { path: "/api/agents/bootstrap-defaults", body },
      ],
    });
  }

  async listTeamMembers(threadTarget) {
    const target = normalizeConversationTarget(threadTarget);
    const tid = String(target.thread_id || "").trim();
    const cid = String(target.conversation_id || "").trim();
    if (!tid && !cid) throw new Error("listConversationAgents requires threadId or conversationId");
    const data = await this._requestAny({
      method: "GET",
      attempts: buildCanonicalTeamListAttempts(target),
    });
    return extractConversationAgentsArray(data)
      .map((row) => normalizeConversationAgent(row, tid))
      .filter((row) => row.agent_id);
  }

  async addTeamMember(threadTarget, agentId, enabled = true) {
    const target = normalizeConversationTarget(threadTarget);
    const tid = String(target.thread_id || "").trim();
    const cid = String(target.conversation_id || "").trim();
    const aid = String(agentId || "").trim().toLowerCase();
    if ((!tid && !cid) || !aid) throw new Error("addConversationAgent requires threadId|conversationId and agentId");
    const addBody = {
      agent_id: aid,
      agentId: aid,
      enabled: enabled !== false,
    };
    const body = buildConversationIdentityPatchBody(addBody, target);
    const data = await this._requestAny({
      method: "POST",
      attempts: buildCanonicalTeamAddAttempts(target, addBody, body),
    });
    const rows = extractConversationAgentsArray(data)
      .map((entry) => normalizeConversationAgent(entry, tid))
      .filter((entry) => entry.agent_id);
    if (rows.length > 0) {
      return rows.find((entry) => entry.agent_id === aid) || rows[rows.length - 1];
    }
    return normalizeConversationAgent(normalizeEntity(data, ["conversation_agent", "membership", "data"]), tid);
  }

  async patchTeamMember(threadTarget, agentId, patch = {}) {
    const target = normalizeConversationTarget(threadTarget);
    const tid = String(target.thread_id || "").trim();
    const cid = String(target.conversation_id || "").trim();
    const aid = String(agentId || "").trim().toLowerCase();
    if ((!tid && !cid) || !aid) throw new Error("patchConversationAgent requires threadId|conversationId and agentId");
    const row = asObject(patch);
    const orderIndexRaw = Number(row.order_index ?? row.orderIndex ?? row.order ?? row.position);
    const overridesRaw = row.overrides_json ?? row.overridesJson ?? row.overrides;
    const overridesJson = overridesRaw && typeof overridesRaw === "object"
      ? asObject(overridesRaw)
      : asObject(parseJsonMaybe(String(overridesRaw || "")));
    const patchBody = {
      enabled: typeof row.enabled === "boolean" ? row.enabled : undefined,
      order_index: Number.isFinite(orderIndexRaw) ? Math.floor(orderIndexRaw) : undefined,
      overrides_json: Object.keys(overridesJson).length > 0 ? overridesJson : undefined,
    };
    const patchBodyWithIdentity = buildConversationIdentityPatchBody({
      agent_id: aid,
      agentId: aid,
      ...patchBody,
    }, target);
    const data = await this._requestAny({
      method: "PATCH",
      attempts: buildCanonicalTeamPatchAttempts(target, aid, patchBody, patchBodyWithIdentity),
    });
    const rows = extractConversationAgentsArray(data)
      .map((entry) => normalizeConversationAgent(entry, tid))
      .filter((entry) => entry.agent_id);
    if (rows.length > 0) {
      return rows.find((entry) => entry.agent_id === aid) || rows[rows.length - 1];
    }
    const single = normalizeConversationAgent(normalizeEntity(data, ["conversation_agent", "membership", "data"]), tid);
    if (single.agent_id) return single;
    return {
      id: `${tid}:${aid}`,
      thread_id: tid,
      agent_id: aid,
      enabled: typeof row.enabled === "boolean" ? row.enabled : true,
      order_index: Number.isFinite(orderIndexRaw) ? Math.floor(orderIndexRaw) : null,
      overrides_json: Object.keys(overridesJson).length > 0 ? overridesJson : {},
      order: Number.isFinite(orderIndexRaw) ? Math.floor(orderIndexRaw) : null,
      overrides: Object.keys(overridesJson).length > 0 ? overridesJson : {},
      created_at: "",
      updated_at: "",
      raw: data,
    };
  }

  async removeTeamMember(threadTarget, agentId) {
    const target = normalizeConversationTarget(threadTarget);
    const tid = String(target.thread_id || "").trim();
    const cid = String(target.conversation_id || "").trim();
    const aid = String(agentId || "").trim().toLowerCase();
    if ((!tid && !cid) || !aid) throw new Error("removeConversationAgent requires threadId|conversationId and agentId");
    const body = buildConversationIdentityPatchBody({
      agent_id: aid,
      agentId: aid,
    }, target);
    await this._requestAny({
      method: "DELETE",
      attempts: buildCanonicalTeamDeleteAttempts(target, aid, body),
    });
    return {
      ok: true,
      thread_id: tid,
      conversation_id: cid,
      agent_id: aid,
    };
  }

  async listConversationAgents(threadTarget) {
    return await this.listTeamMembers(threadTarget);
  }

  async addConversationAgent(threadTarget, agentId, enabled = true, overridesJson = null) {
    return await this.addTeamMember(threadTarget, agentId, enabled, overridesJson);
  }

  async patchConversationAgent(threadTarget, agentId, patch = {}) {
    return await this.patchTeamMember(threadTarget, agentId, patch);
  }

  async removeConversationAgent(threadTarget, agentId) {
    return await this.removeTeamMember(threadTarget, agentId);
  }


  async getTeamConfig(threadTarget) {
    return await getTeamConfigApi(this, threadTarget);
  }

  async setTeamConfig(threadTarget, teamConfig = {}) {
    return await setTeamConfigApi(this, threadTarget, teamConfig);
  }



  async getTeamBlueprint(threadTarget) {
    return await getTeamBlueprintApi(this, threadTarget);
  }

  async validateTeamBlueprint(threadTarget, blueprint = {}, applyState = 'active') {
    return await validateTeamBlueprintApi(this, threadTarget, blueprint, applyState);
  }

  async buildTeamPublishCandidate(threadTarget, options = {}) {
    return await buildTeamPublishCandidateApi(this, threadTarget, options);
  }

  async installTeamBlueprint(threadTarget, blueprint = {}, applyState = 'active') {
    return await installTeamBlueprintApi(this, threadTarget, blueprint, applyState);
  }

  async getTeamManifest(threadTarget) {
    return await this.getTeamBlueprint(threadTarget);
  }

  async validateTeamManifest(threadTarget, manifest = {}, applyState = 'active') {
    return await this.validateTeamBlueprint(threadTarget, manifest, applyState);
  }

  async installTeamManifest(threadTarget, manifest = {}, applyState = 'active') {
    return await this.installTeamBlueprint(threadTarget, manifest, applyState);
  }

  async listAgents(scope = "") {
    const cleanScope = normalizeAgentsScope(scope);
    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: "/api/agents", query: { scope: cleanScope } },
        { path: "/agents", query: { scope: cleanScope } },
        { path: "/v1/agents", query: { scope: cleanScope } },
      ],
    });
    const rows = Array.isArray(data)
      ? data
      : (Array.isArray(asObject(data).agents) ? asObject(data).agents : normalizeArrayResponse(data));
    return rows
      .map((row) => normalizeCatalogAgent(row))
      .filter((row) => row.id);
  }

  async createAgent(def = {}) {
    const body = buildAgentCatalogPayload(def, { requireName: true });
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/agents", body },
        { path: "/agents", body },
        { path: "/v1/agents", body },
      ],
    });
    const parsed = normalizeCatalogAgent(normalizeEntity(data, ["agent", "data"]));
    if (!parsed.id) throw new Error("createAgent returned no id");
    return parsed;
  }

  async patchAgent(agentId, def = {}) {
    const aid = String(agentId || "").trim().toLowerCase();
    if (!aid) throw new Error("patchAgent requires agentId");
    const body = buildAgentCatalogPayload(def, { requireName: false, forPatch: true });
    const data = await this._requestAny({
      method: "PATCH",
      attempts: [
        { path: `/api/agents/${encodeURIComponent(aid)}`, body },
        { path: `/agents/${encodeURIComponent(aid)}`, body },
        { path: `/v1/agents/${encodeURIComponent(aid)}`, body },
      ],
    });
    const parsed = normalizeCatalogAgent(normalizeEntity(data, ["agent", "data"]));
    if (!parsed.id) return { ...parsed, id: aid, raw: data };
    return parsed;
  }

  async forkAgent(agentId, body = {}) {
    const aid = String(agentId || "").trim().toLowerCase();
    if (!aid) throw new Error("forkAgent requires agentId");
    const payload = body && typeof body === 'object' ? body : {};
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: `/api/agents/${encodeURIComponent(aid)}/fork`, body: payload },
        { path: `/agents/${encodeURIComponent(aid)}/fork`, body: payload },
        { path: `/v1/agents/${encodeURIComponent(aid)}/fork`, body: payload },
        { path: "/api/agents/fork", body: { agent_id: aid, ...payload } },
      ],
    });
    const parsed = normalizeCatalogAgent(normalizeEntity(data, ["agent", "data", "result"]));
    if (!parsed.id) throw new Error("forkAgent returned no id");
    const fork = normalizeEntity(data, ["fork", "fork_operation", "operation"]);
    return { ...parsed, fork, fork_operation_id: String(fork?.id || '').trim() || undefined };
  }

  async rejoinAgent(agentId, body = {}) {
    const aid = String(agentId || "").trim().toLowerCase();
    if (!aid) throw new Error("rejoinAgent requires agentId");
    const payload = body && typeof body === 'object' ? body : {};
    const data = await this._requestAny({
      method: 'POST',
      attempts: [
        { path: `/api/agents/${encodeURIComponent(aid)}/rejoin`, body: payload },
        { path: `/agents/${encodeURIComponent(aid)}/rejoin`, body: payload },
        { path: `/v1/agents/${encodeURIComponent(aid)}/rejoin`, body: payload },
      ],
    });
    const fork = normalizeEntity(data, ['fork', 'fork_operation', 'operation']);
    return {
      ok: parseBooleanLike(pick(asObject(data), ['ok']), true),
      source_agent_id: String(fork?.source_agent_id || '').trim().toLowerCase() || undefined,
      fork_operation_id: String(fork?.id || '').trim() || undefined,
      fork,
      message: String(pick(asObject(data), ['message']) || '').trim(),
      raw: data,
    };
  }

  async publishAgent(agentId, published = true) {
    const aid = String(agentId || "").trim().toLowerCase();
    if (!aid) throw new Error("publishAgent requires agentId");
    const isPublished = published !== false;
    let data = null;
    try {
      data = await this._requestAny({
        method: "POST",
        attempts: [
          { path: `/api/agents/${encodeURIComponent(aid)}/${isPublished ? "publish" : "unpublish"}`, body: {} },
          { path: `/agents/${encodeURIComponent(aid)}/${isPublished ? "publish" : "unpublish"}`, body: {} },
          { path: `/v1/agents/${encodeURIComponent(aid)}/${isPublished ? "publish" : "unpublish"}`, body: {} },
        ],
      });
    } catch {
      data = await this._requestAny({
        method: "PATCH",
        attempts: [
          { path: `/api/agents/${encodeURIComponent(aid)}`, body: { published: isPublished } },
          { path: `/agents/${encodeURIComponent(aid)}`, body: { published: isPublished } },
          { path: `/v1/agents/${encodeURIComponent(aid)}`, body: { published: isPublished } },
        ],
      });
    }
    const parsed = normalizeCatalogAgent(normalizeEntity(data, ["agent", "data", "result"]));
    return parsed.id
      ? parsed
      : { id: aid, published: isPublished, raw: data };
  }

  async unpublishAgent(agentId) {
    return await this.publishAgent(agentId, false);
  }

  async createPublishRequest(sourceNodeId) {
    const nodeId = String(sourceNodeId || "").trim();
    if (!nodeId) throw new Error("createPublishRequest requires sourceNodeId");
    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/publish_requests", body: { source_node_id: nodeId } },
        { path: "/publish_requests", body: { source_node_id: nodeId } },
        { path: "/v1/publish_requests", body: { source_node_id: nodeId } },
      ],
    });
    const row = normalizeEntity(data, ["publish_request", "data", "request"]);
    const requestId = String(
      pick(row, ["id", "request_id", "requestId"])
      || pick(data, ["id", "request_id", "requestId"])
      || ""
    ).trim();
    return {
      request_id: requestId,
      source_node_id: nodeId,
      raw: data,
    };
  }

  async mintUiToken(ttlSec) {
    const n = Number(ttlSec);
    const ttl = Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/service/mint_ui_token", body: typeof ttl === "number" ? { ttl_sec: ttl } : {} },
        { path: "/service/mint_ui_token", body: typeof ttl === "number" ? { ttl_sec: ttl } : {} },
      ],
    });

    const token = String(pick(data, ["token", "access_token"]) || "").trim();
    if (!token) throw new Error("GoC mintUiToken returned no token");
    const exp = pick(data, ["exp", "expires_at", "expiresAt"]);
    return { token, exp };
  }
}
