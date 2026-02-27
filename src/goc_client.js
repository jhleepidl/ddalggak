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
  const id = pick(entity, ["id", "thread_id", "context_set_id", "resource_id", "node_id", "uuid"]);
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
        if (![400, 404, 405, 415, 422, 501].includes(status)) break;
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
    const payload = asObject(pick(row, ["payload_json", "payloadJson", "payload"]));
    return {
      id: pickId(row),
      name: String(pick(row, ["name", "title"]) || ""),
      text: String(pick(row, ["text", "content", "summary", "compiled_text"]) || ""),
      summary: String(pick(row, ["summary", "text", "content"]) || ""),
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
    const thread = this.normalizeThread(entity);
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

    let rows = normalizeArrayResponse(data).map((row) => this.normalizeResource(row)).filter((row) => row.id);
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

  async getCompiledContext(contextSetId) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId) throw new Error("getCompiledContext requires contextSetId");

    const data = await this._requestAny({
      method: "GET",
      attempts: [
        { path: "/api/compiled_context", query: { context_set_id: ctxId } },
        { path: "/api/compiled", query: { context_set_id: ctxId } },
        { path: "/compiled_context", query: { context_set_id: ctxId } },
        { path: "/compiled", query: { context_set_id: ctxId } },
        { path: `/api/context_sets/${encodeURIComponent(ctxId)}/compiled` },
        { path: `/context_sets/${encodeURIComponent(ctxId)}/compiled` },
      ],
    });

    if (typeof data === "string") return data;
    const compiled = pick(data, ["compiled_text", "compiledText", "text", "content"]);
    if (typeof compiled === "string") return compiled;
    if (data && typeof data === "object") return JSON.stringify(data, null, 2);
    return "";
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
