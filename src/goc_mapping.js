import fs from "node:fs";
import path from "node:path";

const DEFAULT_JOB_THREAD_TITLE_PREFIX = "job:";
const DEFAULT_GLOBAL_THREAD_TITLE = "global:shared";
const DEFAULT_AGENTS_THREAD_TITLE = "agents:profiles";

function parseBool(raw, fallback = false) {
  const v = String(raw ?? "").trim().toLowerCase();
  if (!v) return fallback;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function parseOptionalPositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

function maybeLimitChunkText(text) {
  const src = String(text || "");
  const limit = parseOptionalPositiveInt(process.env.GOC_TRACKING_CHUNK_MAX_LEN);
  if (!limit || src.length <= limit) {
    return { text: src, truncated: false, originalLength: src.length };
  }
  return {
    text: src.slice(0, limit),
    truncated: true,
    originalLength: src.length,
  };
}

function defaultJobThreadTitle(jobId) {
  const prefix = String(process.env.GOC_JOB_THREAD_TITLE_PREFIX || DEFAULT_JOB_THREAD_TITLE_PREFIX).trim() || DEFAULT_JOB_THREAD_TITLE_PREFIX;
  return `${prefix}${jobId}`;
}

function normalizedMap(jobId, input = {}) {
  const m = input && typeof input === "object" ? input : {};
  const shared = String(
    m.ctxSharedId
    || m.ctxId
    || m?.ctxByAgentId?.shared
    || m?.ctxByAgent?.shared
    || ""
  ).trim();
  return {
    version: 1,
    jobId: String(jobId),
    threadId: String(m.threadId || "").trim(),
    ctxId: shared,
    ctxSharedId: shared,
    ctxByAgentId: {
      ...(m.ctxByAgentId && typeof m.ctxByAgentId === "object" ? m.ctxByAgentId : {}),
      ...(shared ? { shared } : {}),
    },
    lastNodeByDoc: m.lastNodeByDoc && typeof m.lastNodeByDoc === "object" ? { ...m.lastNodeByDoc } : {},
    updatedAt: String(m.updatedAt || "") || null,
  };
}

export function gocMapPath(jobDir) {
  return path.join(jobDir, "goc.json");
}

export function loadGocMap(jobDir, jobId = "") {
  const p = gocMapPath(jobDir);
  if (!fs.existsSync(p)) return normalizedMap(jobId || "", {});
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizedMap(jobId || parsed?.jobId || "", parsed);
  } catch {
    return normalizedMap(jobId || "", {});
  }
}

export function saveGocMap(jobDir, mapData) {
  const p = gocMapPath(jobDir);
  const final = normalizedMap(mapData?.jobId || "", mapData);
  final.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(final, null, 2), "utf8");
  return final;
}

async function ensureSharedContextSet(client, threadId) {
  const list = await client.listContextSets(threadId);
  const existing = list.find((row) => row.name === "shared");
  if (existing?.id) return existing;
  return await client.createContextSet(threadId, "shared");
}

function gocServiceMapPath(baseDir) {
  const dir = path.resolve(baseDir || process.cwd());
  return path.join(dir, "goc.service.json");
}

function loadGocServiceMap(baseDir) {
  const p = gocServiceMapPath(baseDir);
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveGocServiceMap(baseDir, map) {
  const p = gocServiceMapPath(baseDir);
  const final = map && typeof map === "object" ? map : {};
  fs.writeFileSync(p, JSON.stringify(final, null, 2), "utf8");
  return final;
}

async function ensureServiceThread(client, { baseDir, key, title }) {
  const serviceKey = String(key || "").trim();
  if (!serviceKey) throw new Error("ensureServiceThread requires key");

  const current = loadGocServiceMap(baseDir);
  const slot = current[serviceKey] && typeof current[serviceKey] === "object" ? current[serviceKey] : {};

  let threadId = String(slot.threadId || "").trim();
  let ctxId = String(slot.ctxId || "").trim();

  if (!threadId) {
    const created = await client.createThread(String(title || "").trim());
    threadId = created.id;
  }
  if (!ctxId) {
    const shared = await ensureSharedContextSet(client, threadId);
    ctxId = shared.id;
  }

  const next = saveGocServiceMap(baseDir, {
    ...current,
    version: 1,
    [serviceKey]: {
      threadId,
      ctxId,
      updatedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });

  return {
    threadId,
    ctxId,
    raw: next[serviceKey],
  };
}

export async function ensureAgentsThread(client, { baseDir, title = "" }) {
  return await ensureServiceThread(client, {
    baseDir,
    key: "agents",
    title: String(title || "").trim() || DEFAULT_AGENTS_THREAD_TITLE,
  });
}

export async function ensureJobThread(client, { jobId, jobDir, title = "" }) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) throw new Error("ensureJobThread requires jobId");

  const current = loadGocMap(jobDir, cleanJobId);
  let threadId = current.threadId;
  if (!threadId) {
    const created = await client.createThread(String(title || "").trim() || defaultJobThreadTitle(cleanJobId));
    threadId = created.id;
  }

  let sharedId = current.ctxSharedId;
  if (!sharedId) {
    const shared = await ensureSharedContextSet(client, threadId);
    sharedId = shared.id;
  }

  const merged = saveGocMap(jobDir, {
    ...current,
    jobId: cleanJobId,
    threadId,
    ctxId: sharedId,
    ctxSharedId: sharedId,
    ctxByAgentId: {
      ...(current.ctxByAgentId || {}),
      shared: sharedId,
    },
  });
  return merged;
}

export function setLastNodeByDoc(jobDir, jobId, docName, nodeId) {
  const map = loadGocMap(jobDir, jobId);
  const key = String(docName || "").trim();
  if (!key) return map;
  const next = {
    ...map,
    lastNodeByDoc: {
      ...(map.lastNodeByDoc || {}),
      [key]: String(nodeId || "").trim(),
    },
  };
  return saveGocMap(jobDir, next);
}

export function getLastNodeByDoc(jobDir, jobId, docName) {
  const map = loadGocMap(jobDir, jobId);
  const key = String(docName || "").trim();
  return String(map?.lastNodeByDoc?.[key] || "").trim() || null;
}

export async function appendTrackingChunkToGoc(client, {
  jobId,
  jobDir,
  docName,
  chunkText,
  autoActivate,
}) {
  const map = await ensureJobThread(client, { jobId, jobDir });
  const name = String(docName || "").trim();
  const prevId = getLastNodeByDoc(jobDir, jobId, name);
  const progressActivate = parseBool(process.env.GOC_AUTO_ACTIVATE_PROGRESS, false);
  const shouldActivate = typeof autoActivate === "boolean"
    ? autoActivate
    : (name === "progress.md" ? progressActivate : true);
  const nowIso = new Date().toISOString();
  const limited = maybeLimitChunkText(chunkText);
  const preview = limited.text.slice(0, 180);

  const created = await client.createResource(map.threadId, {
    name: `${name.replace(/\.md$/i, "")}@${nowIso}`,
    // NOTE: backend stores summary as node text, so summary must carry the full chunk by default.
    summary: limited.text,
    resource_kind: "tracking_append",
    uri: `ddalggak://runs/${jobId}/shared/${name}`,
    context_set_id: map.ctxSharedId,
    auto_activate: shouldActivate,
    attach_to: prevId || undefined,
    payload_json: {
      doc_name: name,
      preview,
      ts: nowIso,
      original_length: limited.originalLength,
      truncated: limited.truncated,
      max_len: parseOptionalPositiveInt(process.env.GOC_TRACKING_CHUNK_MAX_LEN),
    },
  });

  if (prevId && created?.id && prevId !== created.id) {
    try {
      await client.createEdge(map.threadId, prevId, created.id, "NEXT_PART");
    } catch (e) {
      console.warn(`[goc] createEdge NEXT_PART failed doc=${name} prev=${prevId} next=${created?.id}: ${String(e?.message ?? e)}`);
    }
  }
  setLastNodeByDoc(jobDir, jobId, name, created.id);
  return created;
}

export async function ensureGlobalThread(client, { baseDir, title = "" }) {
  const dir = path.resolve(baseDir || process.cwd());
  const mapPath = path.join(dir, "goc.global.json");
  const parsed = (() => {
    try {
      return JSON.parse(fs.readFileSync(mapPath, "utf8"));
    } catch {
      return {};
    }
  })();

  let threadId = String(parsed.threadId || "").trim();
  let ctxId = String(parsed.ctxId || "").trim();
  if (!threadId) {
    const created = await client.createThread(String(title || "").trim() || DEFAULT_GLOBAL_THREAD_TITLE);
    threadId = created.id;
  }
  if (!ctxId) {
    const shared = await ensureSharedContextSet(client, threadId);
    ctxId = shared.id;
  }

  const next = {
    threadId,
    ctxId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(mapPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}
