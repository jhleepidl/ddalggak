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

function parseBooleanLike(value, fallback = false) {
  if (typeof value === "boolean") return value;
  const key = String(value ?? "").trim().toLowerCase();
  if (!key) return fallback;
  if (["1", "true", "yes", "on"].includes(key)) return true;
  if (["0", "false", "no", "off"].includes(key)) return false;
  return fallback;
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

export class GocClient {
  constructor({ apiBase, serviceKey } = {}) {
    const base = String(apiBase || process.env.GOC_API_BASE || "").trim();
    const key = String(serviceKey || process.env.GOC_SERVICE_KEY || "").trim();
    if (!base) throw new Error("Missing GOC_API_BASE");
    if (!key) throw new Error("Missing GOC_SERVICE_KEY");
    this.apiBase = base.replace(/\/+$/, "");
    this.serviceKey = key;
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
    const init = { method, headers };
    if (typeof body !== "undefined") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

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
  }

  async _requestAny({ method, attempts = [] }) {
    const errors = [];
    for (const attempt of attempts) {
      try {
        return await this._request({
          method,
          path: attempt.path,
          query: attempt.query,
          body: attempt.body,
        });
      } catch (e) {
        errors.push(e);
        const status = Number(e?.status);
        if (!isRetryableStatus(status)) break;
      }
    }
    if (errors.length) throw errors[errors.length - 1];
    throw new Error("GoC API call failed: no attempts");
  }

  normalizeThread(entity) {
    const row = asObject(entity);
    return {
      id: pickId(row),
      title: String(pick(row, ["title", "name"]) || ""),
      raw: row,
    };
  }

  normalizeContextSet(entity) {
    const row = asObject(entity);
    return {
      id: pickId(row),
      name: String(pick(row, ["name", "title"]) || ""),
      raw: row,
    };
  }

  normalizeResource(entity) {
    const row = asObject(entity);
    const payloadRaw = pick(row, ["payload_json", "payloadJson", "payload"]);
    let payload = {};
    if (payloadRaw && typeof payloadRaw === "object") {
      payload = asObject(payloadRaw);
    } else if (typeof payloadRaw === "string") {
      payload = asObject(parseJsonMaybe(payloadRaw));
    }
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

  async createResource(threadId, body = {}) {
    const tid = String(threadId || "").trim();
    if (!tid) throw new Error("createResource requires threadId");
    const payload = asObject(body);

    const data = await this._requestAny({
      method: "POST",
      attempts: [
        { path: "/api/resources", body: { thread_id: tid, ...payload } },
        { path: "/resources", body: { thread_id: tid, ...payload } },
        { path: "/v1/resources", body: { thread_id: tid, ...payload } },
        { path: `/api/threads/${encodeURIComponent(tid)}/resources`, body: payload },
        { path: `/threads/${encodeURIComponent(tid)}/resources`, body: payload },
      ],
    });
    const entity = normalizeEntity(data, ["resource", "node", "data"]);
    const resource = this.normalizeResource(entity);
    if (!resource.id) throw new Error("GoC createResource returned no id");
    return resource;
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
          { path: "/api/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: "/api/resources", query: { threadId: tid, resourceKind: resourceKind || undefined, contextSetId: contextSetId || undefined } },
          { path: "/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: "/v1/resources", query: { thread_id: tid, resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
          { path: `/api/threads/${encodeURIComponent(tid)}/resources`, query: { resource_kind: resourceKind || undefined, context_set_id: contextSetId || undefined } },
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
    const includeExplain = parseBooleanLike(
      options?.includeExplain ?? options?.include_explain,
      false
    );

    const attempts = [
      {
        path: `/api/context_sets/${encodeURIComponent(ctxId)}/compiled`,
        query: includeExplain ? { include_explain: true } : undefined,
      },
      { path: "/api/compiled_context", query: { context_set_id: ctxId, include_explain: includeExplain ? true : undefined } },
      { path: "/api/compiled", query: { context_set_id: ctxId, include_explain: includeExplain ? true : undefined } },
      // Keep legacy non-/api routes as the last resort to avoid UI fallback HTML.
      { path: `/context_sets/${encodeURIComponent(ctxId)}/compiled`, query: includeExplain ? { include_explain: true } : undefined },
      { path: "/compiled_context", query: { context_set_id: ctxId, include_explain: includeExplain ? true : undefined } },
      { path: "/compiled", query: { context_set_id: ctxId, include_explain: includeExplain ? true : undefined } },
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
        return normalized.compiled_text;
      } catch (e) {
        errors.push(e);
        if (!isRetryableStatus(e?.status)) break;
      }
    }

    if (errors.length) throw errors[errors.length - 1];
    throw new Error("GoC getCompiledContext failed: no attempts");
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

  async _setNodesActivation(contextSetId, nodeIds = [], active = true) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("_setNodesActivation requires contextSetId");
    const ids = normalizeNodeIdList(nodeIds);
    if (ids.length === 0) return { ok: true, context_set_id: ctxId, node_ids: [] };

    const suffix = active ? "activate" : "deactivate";
    const data = await this._requestAny({
      method: "POST",
      attempts: [
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
