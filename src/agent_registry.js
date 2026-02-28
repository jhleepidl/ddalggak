import { loadAgents } from "./agents.js";
import { ensureAgentsThread } from "./goc_mapping.js";

const PROVIDER_ALIASES = {
  gpt: "chatgpt",
  openai: "chatgpt",
  codex: "codex",
  gemini: "gemini",
  chatgpt: "chatgpt",
};

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

function normalizeProvider(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return PROVIDER_ALIASES[key] || "gemini";
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = asObject(raw);
  const id = String(row.id || row.agent_id || row.agentId || "").trim().toLowerCase();
  if (!id) return null;
  const provider = normalizeProvider(row.provider || row.model);
  const model = String(row.model || row.provider || "").trim() || provider;
  return {
    id,
    name: String(row.name || row.title || id).trim(),
    description: String(row.description || "").trim(),
    provider,
    model,
    prompt: String(
      row.prompt
      || row.base_prompt
      || row.basePrompt
      || row.system_prompt
      || row.systemPrompt
      || ""
    ).trim(),
    meta: row.meta && typeof row.meta === "object" ? row.meta : {},
  };
}

function dedupeByIdKeepLast(list) {
  const map = new Map();
  for (const row of list) {
    if (!row?.id) continue;
    map.set(row.id, row);
  }
  return Array.from(map.values());
}

function parseYamlScalar(raw) {
  const value = String(raw || "").trim();
  if (!value) return "";
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  const n = Number(value);
  if (Number.isFinite(n) && String(n) === value) return n;
  return value;
}

function countIndent(line) {
  let i = 0;
  while (i < line.length && line[i] === " ") i += 1;
  return i;
}

function parseSimpleYamlObject(text) {
  const src = String(text || "").replace(/\t/g, "  ");
  const lines = src.split(/\r?\n/);
  let i = 0;

  function parseMap(baseIndent) {
    const out = {};
    while (i < lines.length) {
      const line = lines[i];
      if (!line || !line.trim() || line.trim().startsWith("#")) {
        i += 1;
        continue;
      }

      const indent = countIndent(line);
      if (indent < baseIndent) break;
      if (indent > baseIndent) {
        i += 1;
        continue;
      }

      const body = line.slice(indent);
      const kv = body.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/);
      if (!kv) {
        i += 1;
        continue;
      }

      const key = kv[1];
      const valueRaw = kv[2];

      if (valueRaw === "|" || valueRaw === ">") {
        const isFolded = valueRaw === ">";
        i += 1;
        const block = [];
        while (i < lines.length) {
          const next = lines[i];
          if (!next.trim()) {
            block.push("");
            i += 1;
            continue;
          }
          const nextIndent = countIndent(next);
          if (nextIndent <= indent) break;
          block.push(next.slice(Math.min(nextIndent, indent + 2)));
          i += 1;
        }
        out[key] = isFolded ? block.join(" ").replace(/\s+/g, " ").trim() : block.join("\n").trimEnd();
        continue;
      }

      if (!valueRaw) {
        i += 1;
        const nestedStart = i;
        while (i < lines.length && (!lines[i].trim() || countIndent(lines[i]) > indent)) i += 1;
        const nestedLines = lines
          .slice(nestedStart, i)
          .map((row) => {
            if (!row.trim()) return "";
            return row.slice(Math.min(countIndent(row), indent + 2));
          })
          .join("\n");
        const nested = parseSimpleYamlObject(nestedLines);
        out[key] = nested && typeof nested === "object" ? nested : {};
        continue;
      }

      out[key] = parseYamlScalar(valueRaw);
      i += 1;
    }
    return out;
  }

  return parseMap(0);
}

function unwrapAgentContainer(parsed) {
  const row = asObject(parsed);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(row.agents)) return row.agents;
  if (row.agent && typeof row.agent === "object") return [row.agent];
  if (row.agent_profile && typeof row.agent_profile === "object") return [row.agent_profile];
  return [row];
}

function parseCandidateDocument(text) {
  const raw = String(text || "").trim();
  if (!raw) return [];

  const out = [];
  const directJson = parseJsonMaybe(raw);
  if (directJson) out.push(directJson);

  if (!directJson) {
    const yaml = parseSimpleYamlObject(raw);
    if (yaml && typeof yaml === "object" && Object.keys(yaml).length > 0) out.push(yaml);
  }

  return out;
}

function parseAgentProfilesFromText(text) {
  const src = String(text || "");
  const blocks = [];

  const fencedRe = /```(?:json|yaml|yml)?\s*([\s\S]*?)```/gi;
  let match;
  while ((match = fencedRe.exec(src)) !== null) {
    if (match[1] && match[1].trim()) blocks.push(match[1].trim());
  }
  blocks.push(src);

  const rows = [];
  for (const block of blocks) {
    for (const parsed of parseCandidateDocument(block)) {
      for (const candidate of unwrapAgentContainer(parsed)) {
        const agent = normalizeAgent(candidate);
        if (agent) rows.push(agent);
      }
    }
  }
  return dedupeByIdKeepLast(rows);
}

function getResourceText(resource) {
  const row = asObject(resource);
  const raw = asObject(row.raw);
  return String(
    row.text
    || row.summary
    || raw.summary
    || raw.text
    || raw.content
    || raw.compiled_text
    || ""
  );
}

function getResourcePayload(resource) {
  const row = asObject(resource);
  if (row.payload && typeof row.payload === "object") return row.payload;
  const raw = asObject(row.raw);
  const payload = raw.payload_json ?? raw.payloadJson ?? raw.payload;
  return payload && typeof payload === "object" ? payload : {};
}

function parseProfilesFromResource(resource) {
  const out = [];
  const payload = getResourcePayload(resource);
  const payloadCandidates = [
    payload.agent_profile,
    payload.agentProfile,
    payload.agent,
    payload.profile,
    payload,
  ];
  for (const c of payloadCandidates) {
    const normalized = normalizeAgent(c);
    if (!normalized) continue;
    out.push(normalized);
    break;
  }

  const textRows = parseAgentProfilesFromText(getResourceText(resource));
  for (const row of textRows) out.push(row);
  return dedupeByIdKeepLast(out);
}

function sortByCreatedAt(list) {
  return [...list].sort((a, b) => {
    const ta = Date.parse(String(a?.createdAt || ""));
    const tb = Date.parse(String(b?.createdAt || ""));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return 0;
  });
}

function quoteYamlString(v) {
  const s = String(v ?? "");
  if (!s || /[\s:#{}\[\],&*?]|^[-]|["']/.test(s)) return JSON.stringify(s);
  return s;
}

function serializeAgentProfileYaml(agent) {
  const lines = [
    `id: ${quoteYamlString(agent.id)}`,
    `name: ${quoteYamlString(agent.name || agent.id)}`,
    `description: ${quoteYamlString(agent.description || "")}`,
    `provider: ${quoteYamlString(agent.provider || "gemini")}`,
    `model: ${quoteYamlString(agent.model || agent.provider || "gemini")}`,
  ];
  const prompt = String(agent.prompt || "");
  if (!prompt.includes("\n")) {
    lines.push(`prompt: ${quoteYamlString(prompt)}`);
  } else {
    lines.push("prompt: |");
    for (const line of prompt.split("\n")) lines.push(`  ${line}`);
  }
  return lines.join("\n") + "\n";
}

function buildRegistry(agents, meta = {}) {
  const deduped = dedupeByIdKeepLast(agents);
  return {
    path: "goc://agents",
    source: String(meta.source || "goc"),
    threadId: String(meta.threadId || ""),
    ctxId: String(meta.ctxId || ""),
    compiledText: String(meta.compiledText || ""),
    agents: deduped,
    byId: new Map(deduped.map((row) => [row.id, row])),
    resources: Array.isArray(meta.resources) ? meta.resources : [],
  };
}

export async function loadAgentsFromGoc({ client, baseDir, includeCompiled = true } = {}) {
  if (!client) throw new Error("loadAgentsFromGoc requires client");
  const fallback = loadAgents();
  const slot = await ensureAgentsThread(client, { baseDir });

  const resources = await client.listResources(slot.threadId, { resourceKind: "agent_profile" });
  const parsedFromNodes = [];
  for (const resource of sortByCreatedAt(resources)) {
    for (const row of parseProfilesFromResource(resource)) parsedFromNodes.push(row);
  }

  let compiledText = "";
  let parsedFromCompiled = [];
  if (includeCompiled && slot.ctxId) {
    try {
      compiledText = await client.getCompiledContext(slot.ctxId);
      parsedFromCompiled = parseAgentProfilesFromText(compiledText);
    } catch {
      compiledText = "";
      parsedFromCompiled = [];
    }
  }

  const selected = parsedFromCompiled.length > 0
    ? parsedFromCompiled
    : (parsedFromNodes.length > 0 ? parsedFromNodes : fallback.agents);

  return buildRegistry(selected, {
    source: parsedFromCompiled.length > 0 ? "goc_compiled" : (parsedFromNodes.length > 0 ? "goc_nodes" : "fallback_local"),
    threadId: slot.threadId,
    ctxId: slot.ctxId,
    compiledText,
    resources,
  });
}

async function findLatestAgentNode(client, threadId, agentId) {
  const id = String(agentId || "").trim().toLowerCase();
  if (!id) return null;
  const resources = await client.listResources(threadId, { resourceKind: "agent_profile" });
  const ordered = sortByCreatedAt(resources);
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const resource = ordered[i];
    const rows = parseProfilesFromResource(resource);
    if (rows.some((row) => row.id === id)) return resource;
  }
  return null;
}

async function upsertAgentProfile(client, { baseDir, profile, format = "json", op = "create", actor = "" }) {
  const agent = normalizeAgent(profile);
  if (!agent) throw new Error("invalid agent profile (id is required)");

  const slot = await ensureAgentsThread(client, { baseDir });
  const nowIso = new Date().toISOString();
  const fmt = String(format || "json").trim().toLowerCase() === "yaml" ? "yaml" : "json";
  const text = fmt === "yaml" ? serializeAgentProfileYaml(agent) : `${JSON.stringify(agent, null, 2)}\n`;
  const prev = await findLatestAgentNode(client, slot.threadId, agent.id);

  const created = await client.createResource(slot.threadId, {
    name: `agent:${agent.id}@${nowIso}`,
    summary: text,
    resource_kind: "agent_profile",
    uri: `ddalggak://agents/${agent.id}`,
    context_set_id: slot.ctxId,
    auto_activate: true,
    attach_to: prev?.id || undefined,
    payload_json: {
      op,
      format: fmt,
      agent_id: agent.id,
      updated_by: String(actor || "").trim() || undefined,
      ts: nowIso,
      agent_profile: agent,
    },
  });

  if (prev?.id && created?.id && prev.id !== created.id) {
    try {
      await client.createEdge(slot.threadId, prev.id, created.id, "NEXT_PART");
    } catch {}
  }

  return { created, threadId: slot.threadId, ctxId: slot.ctxId, agent };
}

export async function createAgentProfile(client, { baseDir, profile, format = "json", actor = "" } = {}) {
  return await upsertAgentProfile(client, { baseDir, profile, format, op: "create", actor });
}

export async function updateAgentProfile(client, { baseDir, agentId, patch, format = "json", actor = "" } = {}) {
  const id = String(agentId || patch?.id || "").trim().toLowerCase();
  if (!id) throw new Error("updateAgentProfile requires agentId");
  const reg = await loadAgentsFromGoc({ client, baseDir, includeCompiled: false });
  const current = reg.byId.get(id);
  if (!current) throw new Error(`agent not found: ${id}`);

  const rawPatch = patch && typeof patch === "object" ? patch : {};
  const merged = {
    ...current,
    ...rawPatch,
    id,
    meta: {
      ...(current.meta && typeof current.meta === "object" ? current.meta : {}),
      ...(rawPatch.meta && typeof rawPatch.meta === "object" ? rawPatch.meta : {}),
    },
  };
  return await upsertAgentProfile(client, { baseDir, profile: merged, format, op: "update", actor });
}
