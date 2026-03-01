import fs from "node:fs";
import path from "node:path";

const DEFAULT_JOB_THREAD_TITLE_PREFIX = "job:";
const DEFAULT_GLOBAL_THREAD_TITLE = "global:shared";
const DEFAULT_AGENTS_THREAD_TITLE = "agents";
const DEFAULT_TOOLS_THREAD_TITLE = "tools";
const inflightServiceThreadEnsures = new Map();
const inflightJobThreadEnsures = new Map();

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

function parseJsonMaybe(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function defaultJobThreadTitle(jobId) {
  const prefix = String(process.env.GOC_JOB_THREAD_TITLE_PREFIX || DEFAULT_JOB_THREAD_TITLE_PREFIX).trim() || DEFAULT_JOB_THREAD_TITLE_PREFIX;
  return `${prefix}${jobId}`;
}

function normalizeStringList(raw, { lower = false } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? raw.split(",") : []);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const value = String(entry || "").trim();
    if (!value) continue;
    const normalized = lower ? value.toLowerCase() : value;
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

function normalizeSelectionSet(raw, { lower = true } = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const modeRaw = String(row.mode || "").trim().toLowerCase();
  return {
    mode: modeRaw === "selected" ? "selected" : "all_enabled",
    selected: normalizeStringList(row.selected, { lower }),
    disabled: normalizeStringList(row.disabled, { lower }),
  };
}

function normalizeFinalResponseStyle(raw, fallback = "concise") {
  return String(raw || fallback).trim().toLowerCase() === "detailed"
    ? "detailed"
    : "concise";
}

function normalizeCatalogIds(list = []) {
  const ids = (Array.isArray(list) ? list : []).map((row) => String(
    row?.id
    || row?.tool_id
    || row?.toolId
    || row?.agent_id
    || row?.agentId
    || row?.name
    || ""
  ).trim().toLowerCase());
  return normalizeStringList(ids, { lower: true });
}

function computeEnabledIds(selectionSet, allIds = []) {
  const config = normalizeSelectionSet(selectionSet, { lower: true });
  const catalog = normalizeStringList(allIds, { lower: true });
  const disabled = new Set(config.disabled);
  if (config.mode === "selected") {
    const catalogSet = new Set(catalog);
    return config.selected.filter((id) => !disabled.has(id) && catalogSet.has(id));
  }
  return catalog.filter((id) => !disabled.has(id));
}

function pickDefaultEnabledAgentId(allIds = []) {
  const catalog = normalizeStringList(allIds, { lower: true });
  if (catalog.length === 0) return "";
  if (catalog.includes("router")) return "router";
  if (catalog.includes("coder")) return "coder";
  return catalog[0] || "";
}

function defaultJobConfig(jobId) {
  return {
    version: 2,
    schema_version: 2,
    job_id: String(jobId || "").trim(),
    mode: "supervisor",
    final_response_style: "concise",
    participants: [],
    agent_set: {
      mode: "all_enabled",
      selected: [],
      disabled: [],
    },
    tool_set: {
      mode: "all_enabled",
      selected: [],
      disabled: [],
    },
    allow_actions: [
      "run_agent",
      "propose_agent",
      "need_more_detail",
      "open_context",
      "summarize",
      "search_public_agents",
      "install_agent_blueprint",
      "publish_agent",
      "disable_agent",
      "enable_agent",
      "disable_tool",
      "enable_tool",
      "list_agents",
      "list_tools",
    ],
    budget: {
      max_actions: 4,
      max_chars: 16000,
      max_risk: "L2",
    },
    approval: {
      require_for_risk: ["L3"],
      require_file_write: false,
    },
    policies: {
      forbid_chatgpt_planner_by_default: true,
    },
    updated_at: new Date().toISOString(),
  };
}

export function normalizeJobConfig(jobConfig, { agentsCatalog = [], toolsCatalog = [] } = {}) {
  const row = jobConfig && typeof jobConfig === "object" ? jobConfig : {};
  const jobId = String(row.job_id || row.jobId || "").trim();
  const base = defaultJobConfig(jobId);
  const participants = normalizeStringList(
    Array.isArray(row.participants) ? row.participants : base.participants,
    { lower: true }
  );
  const allowActions = normalizeStringList(
    row.allow_actions || row.allowed_actions || row.actions_allowlist || row.action_allowlist || base.allow_actions,
    { lower: true }
  );
  const budgetRaw = row.budget && typeof row.budget === "object" ? row.budget : {};
  const approvalRaw = row.approval && typeof row.approval === "object" ? row.approval : {};
  const requiresForRisk = normalizeStringList(
    Array.isArray(approvalRaw.require_for_risk)
      ? approvalRaw.require_for_risk
      : base.approval.require_for_risk,
    { lower: false }
  ).map((entry) => entry.toUpperCase());

  const fromParticipantAgentSet = participants.length > 0
    ? { mode: "selected", selected: participants, disabled: [] }
    : base.agent_set;
  const rawAgentSet = row.agent_set && typeof row.agent_set === "object"
    ? row.agent_set
    : (row.agentSet && typeof row.agentSet === "object" ? row.agentSet : null);
  const rawToolSet = row.tool_set && typeof row.tool_set === "object"
    ? row.tool_set
    : (row.toolSet && typeof row.toolSet === "object" ? row.toolSet : null);

  const agentSet = normalizeSelectionSet(rawAgentSet || fromParticipantAgentSet, { lower: true });
  const toolSet = normalizeSelectionSet(rawToolSet || base.tool_set, { lower: true });
  const allAgentIds = normalizeCatalogIds(agentsCatalog);
  const allToolIds = normalizeCatalogIds(toolsCatalog);
  let enabledAgentIds = computeEnabledIds(agentSet, allAgentIds);
  if (enabledAgentIds.length === 0) {
    const fallbackAgentId = pickDefaultEnabledAgentId(allAgentIds);
    if (fallbackAgentId) enabledAgentIds = [fallbackAgentId];
  }
  const enabledToolIds = computeEnabledIds(toolSet, allToolIds);

  const configNormalized = {
    ...base,
    ...row,
    version: Number.isFinite(Number(row.version))
      ? Math.max(2, Math.floor(Number(row.version)))
      : base.version,
    schema_version: Number.isFinite(Number(row.schema_version || row.schemaVersion))
      ? Math.max(2, Math.floor(Number(row.schema_version || row.schemaVersion)))
      : 2,
    job_id: jobId || base.job_id,
    mode: "supervisor",
    final_response_style: normalizeFinalResponseStyle(
      row.final_response_style || row.finalResponseStyle || base.final_response_style,
      base.final_response_style
    ),
    participants,
    allow_actions: allowActions.length > 0 ? allowActions : [...base.allow_actions],
    budget: {
      ...base.budget,
      ...budgetRaw,
      max_actions: Number.isFinite(Number(budgetRaw.max_actions))
        ? Math.max(1, Math.floor(Number(budgetRaw.max_actions)))
        : base.budget.max_actions,
    },
    approval: {
      ...base.approval,
      ...approvalRaw,
      require_for_risk: requiresForRisk.length > 0 ? requiresForRisk : [...base.approval.require_for_risk],
      require_file_write: typeof approvalRaw.require_file_write === "boolean"
        ? approvalRaw.require_file_write
        : base.approval.require_file_write,
    },
    agent_set: agentSet,
    tool_set: toolSet,
  };

  return {
    configNormalized,
    enabledAgentIds,
    enabledToolIds,
  };
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

function runWithInflight(map, key, task) {
  const k = String(key || "").trim();
  if (!k) return Promise.resolve().then(task);
  const existing = map.get(k);
  if (existing) return existing;
  const p = Promise.resolve()
    .then(task)
    .finally(() => {
      if (map.get(k) === p) map.delete(k);
    });
  map.set(k, p);
  return p;
}

async function ensureServiceThread(client, { baseDir, key, title, lookupTitles = [], preferLookupTitles = false }) {
  const serviceKey = String(key || "").trim();
  if (!serviceKey) throw new Error("ensureServiceThread requires key");
  const lockKey = `${path.resolve(baseDir || process.cwd())}::${serviceKey}`;
  return await runWithInflight(inflightServiceThreadEnsures, lockKey, async () => {
    const current = loadGocServiceMap(baseDir);
    const slot = current[serviceKey] && typeof current[serviceKey] === "object" ? current[serviceKey] : {};

    let threadId = String(slot.threadId || "").trim();
    let ctxId = String(slot.ctxId || "").trim();
    const desiredTitle = String(title || "").trim();
    const candidates = [...lookupTitles, desiredTitle]
      .map((row) => String(row || "").trim())
      .filter(Boolean)
      .filter((row, idx, arr) => arr.indexOf(row) === idx);

    if (preferLookupTitles && candidates.length > 0) {
      for (const candidate of candidates) {
        try {
          const found = await client.findThreadByTitle(candidate);
          if (found?.id) {
            if (threadId !== found.id) {
              threadId = found.id;
              ctxId = "";
            }
            break;
          }
        } catch {}
      }
    }

    if (!threadId) {
      for (const candidate of candidates) {
        try {
          const found = await client.findThreadByTitle(candidate);
          if (found?.id) {
            threadId = found.id;
            break;
          }
        } catch {}
      }
    }

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
  });
}

export async function ensureAgentsThread(client, { baseDir, title = "" }) {
  const hintedTitle = String(title || "").trim();
  const lookupTitles = [
    "agents:profiles",
    "agents",
  ];
  if (hintedTitle && !lookupTitles.includes(hintedTitle)) lookupTitles.unshift(hintedTitle);

  return await ensureServiceThread(client, {
    baseDir,
    key: "agents",
    title: DEFAULT_AGENTS_THREAD_TITLE,
    lookupTitles,
  });
}

export async function ensureToolsThread(client, { baseDir, title = "" }) {
  const hintedTitle = String(title || "").trim();
  const lookupTitles = [
    "tools:specs",
    "tools",
    "tool_specs",
  ];
  if (hintedTitle && !lookupTitles.includes(hintedTitle)) lookupTitles.splice(1, 0, hintedTitle);

  return await ensureServiceThread(client, {
    baseDir,
    key: "tools",
    title: DEFAULT_TOOLS_THREAD_TITLE,
    lookupTitles,
    preferLookupTitles: true,
  });
}

export async function ensurePublicLibraryThreadId(client) {
  if (!client || typeof client.listThreads !== "function") return null;
  try {
    const threads = await client.listThreads();
    const found = (Array.isArray(threads) ? threads : [])
      .find((row) => String(row?.title || "").trim() === "agents:library");
    return found?.id ? String(found.id).trim() : null;
  } catch {
    return null;
  }
}

async function ensureDefaultJobConfigResource(client, { threadId, ctxId, jobId }) {
  const tid = String(threadId || "").trim();
  const cid = String(ctxId || "").trim();
  const jid = String(jobId || "").trim();
  if (!tid || !cid || !jid) return null;

  let resources = [];
  try {
    resources = await client.listResources(tid, {
      resourceKind: "job_config",
      contextSetId: cid,
    });
  } catch {
    return null;
  }

  const hasValidConfig = resources.some((resource) => {
    const payload = resource?.payload && typeof resource.payload === "object" ? resource.payload : {};
    if (payload.job_config && typeof payload.job_config === "object") return true;
    const fromText = parseJsonMaybe(
      resource?.text
      || resource?.raw?.raw_text
      || resource?.raw?.rawText
      || resource?.summary
      || ""
    );
    return !!(fromText && typeof fromText === "object");
  });
  if (hasValidConfig) return resources[resources.length - 1] || null;

  const nowIso = new Date().toISOString();
  const config = defaultJobConfig(jid);
  const rawText = `${JSON.stringify(config, null, 2)}\n`;
  return await client.createResource(tid, {
    name: `job_config@${nowIso}`,
    summary: "default supervisor job_config",
    text_mode: "plain",
    raw_text: rawText,
    resource_kind: "job_config",
    uri: `ddalggak://jobs/${jid}/job_config`,
    context_set_id: cid,
    auto_activate: true,
    payload_json: {
      op: "init_default",
      ts: nowIso,
      job_id: jid,
      job_config: config,
    },
  });
}

export async function ensureJobThread(client, { jobId, jobDir, title = "" }) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) throw new Error("ensureJobThread requires jobId");
  const desiredTitle = String(title || "").trim() || defaultJobThreadTitle(cleanJobId);
  const lockKey = `${path.resolve(jobDir || process.cwd())}::${cleanJobId}`;
  return await runWithInflight(inflightJobThreadEnsures, lockKey, async () => {
    const current = loadGocMap(jobDir, cleanJobId);
    let threadId = current.threadId;
    if (!threadId) {
      try {
        const found = await client.findThreadByTitle(desiredTitle);
        if (found?.id) threadId = found.id;
      } catch {}
    }
    if (!threadId) {
      const created = await client.createThread(desiredTitle);
      threadId = created.id;
    }

    let sharedId = current.ctxSharedId;
    if (!sharedId) {
      const shared = await ensureSharedContextSet(client, threadId);
      sharedId = shared.id;
    }

    try {
      await ensureDefaultJobConfigResource(client, {
        threadId,
        ctxId: sharedId,
        jobId: cleanJobId,
      });
    } catch {}

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
  });
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
