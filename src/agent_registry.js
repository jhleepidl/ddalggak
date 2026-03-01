import { loadAgents } from "./agents.js";
import { ensureAgentsThread, ensurePublicLibraryThreadId } from "./goc_mapping.js";

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

function normalizeStringArray(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((row) => String(row || "").trim()).filter(Boolean);
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
    || raw.raw_text
    || raw.rawText
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

function getResourceRawText(resource) {
  const row = asObject(resource);
  const raw = asObject(row.raw);
  const text = String(
    raw.raw_text
    || raw.rawText
    || row.text
    || raw.text
    || raw.summary
    || row.summary
    || ""
  );
  return text;
}

function parsePublicBlueprintFromResource(resource) {
  const row = asObject(resource);
  const payload = getResourcePayload(row);
  const payloadBlueprint = asObject(
    payload.agent_blueprint
    || payload.blueprint
    || payload
  );
  const rawText = getResourceRawText(row);
  const textRows = parseAgentProfilesFromText(rawText);
  const payloadAgent = normalizeAgent(
    payloadBlueprint.agent
    || payloadBlueprint.profile
    || payloadBlueprint.agent_profile
    || payloadBlueprint
  );
  const agent = textRows[0] || payloadAgent;
  const blueprintId = String(
    payloadBlueprint.blueprint_id
    || payloadBlueprint.id
    || payload.blueprint_id
    || row.id
    || ""
  ).trim();
  const publicNodeId = String(row.id || "").trim();
  if (!publicNodeId) return null;

  const tags = normalizeStringArray(
    payloadBlueprint.tags
    || payload.tags
  );
  const title = String(
    payloadBlueprint.title
    || row.name
    || `blueprint:${blueprintId || publicNodeId}`
  ).trim();
  const description = String(
    payloadBlueprint.description
    || agent?.description
    || ""
  ).trim();
  const fallbackAgentId = String(
    payloadBlueprint.agent_id
    || payload.agent_id
    || agent?.id
    || ""
  ).trim().toLowerCase();
  const preparedRawText = rawText.trim()
    ? rawText
    : `${JSON.stringify({
      id: fallbackAgentId || `agent_${publicNodeId}`,
      name: payloadBlueprint.name || fallbackAgentId || `agent_${publicNodeId}`,
      description,
      provider: payloadBlueprint.provider || agent?.provider || "gemini",
      model: payloadBlueprint.model || agent?.model || payloadBlueprint.provider || agent?.provider || "gemini",
      prompt: payloadBlueprint.prompt || agent?.prompt || "",
      meta: payloadBlueprint.meta && typeof payloadBlueprint.meta === "object" ? payloadBlueprint.meta : {},
    }, null, 2)}\n`;

  return {
    blueprint_id: blueprintId || publicNodeId,
    public_node_id: publicNodeId,
    title,
    description,
    tags,
    agent_id: fallbackAgentId || "",
    provider: String(payloadBlueprint.provider || agent?.provider || "").trim().toLowerCase(),
    model: String(payloadBlueprint.model || agent?.model || "").trim(),
    prompt: String(payloadBlueprint.prompt || agent?.prompt || "").trim(),
    raw_text: preparedRawText.endsWith("\n") ? preparedRawText : `${preparedRawText}\n`,
    payload_json: payload,
    resource: row,
  };
}

export async function listPublicBlueprints(client) {
  if (!client) throw new Error("listPublicBlueprints requires client");
  const libraryThreadId = await ensurePublicLibraryThreadId(client);
  if (!libraryThreadId) return [];

  const resources = await client.listResources(libraryThreadId, {
    resourceKind: "agent_blueprint",
  });
  const out = [];
  for (const resource of sortByCreatedAt(resources)) {
    const parsed = parsePublicBlueprintFromResource(resource);
    if (!parsed) continue;
    out.push({
      ...parsed,
      library_thread_id: libraryThreadId,
    });
  }
  return out;
}

export async function installBlueprint(client, blueprintNode, { agentsThreadId, ctxId, agentIdOverride = "" } = {}) {
  if (!client) throw new Error("installBlueprint requires client");
  const threadId = String(agentsThreadId || "").trim();
  const contextId = String(ctxId || "").trim();
  if (!threadId) throw new Error("installBlueprint requires agentsThreadId");
  if (!contextId) throw new Error("installBlueprint requires ctxId");

  const parsed = parsePublicBlueprintFromResource(blueprintNode);
  if (!parsed) throw new Error("installBlueprint requires valid blueprint node");

  const overrideId = String(agentIdOverride || "").trim().toLowerCase();
  let profileRaw = parsed.raw_text;
  let parsedProfile = null;
  const parsedDirect = parseJsonMaybe(profileRaw);
  if (parsedDirect && typeof parsedDirect === "object") {
    parsedProfile = parsedDirect;
  } else {
    const fromText = parseAgentProfilesFromText(profileRaw);
    if (fromText.length > 0) parsedProfile = fromText[0];
  }

  if (!parsedProfile || typeof parsedProfile !== "object") {
    parsedProfile = {
      id: parsed.agent_id || `agent_${parsed.blueprint_id}`,
      name: parsed.title || parsed.agent_id || parsed.blueprint_id,
      description: parsed.description || "",
      provider: parsed.provider || "gemini",
      model: parsed.model || parsed.provider || "gemini",
      prompt: parsed.prompt || "",
      meta: {},
    };
  }

  if (overrideId) parsedProfile.id = overrideId;
  const finalAgentId = String(parsedProfile.id || parsed.agent_id || "").trim().toLowerCase();
  if (!finalAgentId) throw new Error("installBlueprint resolved empty agent id");
  parsedProfile.id = finalAgentId;
  profileRaw = `${JSON.stringify(parsedProfile, null, 2)}\n`;

  const nowIso = new Date().toISOString();
  const payloadJson = {
    ...(parsed.payload_json && typeof parsed.payload_json === "object" ? parsed.payload_json : {}),
    installed_from_public: true,
    origin: {
      type: "public",
      blueprint_id: parsed.blueprint_id,
      public_node_id: parsed.public_node_id,
      installed_at: nowIso,
    },
    agent_profile: parsedProfile,
  };

  const created = await client.createResource(threadId, {
    name: `agent:${finalAgentId}@${nowIso}`,
    summary: `installed from public blueprint ${parsed.blueprint_id}`,
    text_mode: "plain",
    raw_text: profileRaw,
    resource_kind: "agent_profile",
    uri: `ddalggak://agents/${finalAgentId}`,
    context_set_id: contextId,
    auto_activate: true,
    payload_json: payloadJson,
  });

  return {
    created,
    agent_id: finalAgentId,
    blueprint_id: parsed.blueprint_id,
    public_node_id: parsed.public_node_id,
  };
}

export async function loadAgentsFromGoc({ client, baseDir, includeCompiled = true } = {}) {
  if (!client) throw new Error("loadAgentsFromGoc requires client");
  const fallback = loadAgents();
  const slot = await ensureAgentsThread(client, { baseDir });

  const resources = await client.listResources(slot.threadId, { resourceKind: "agent_profile" });
  const parsedFromNodes = [];
  const publicOriginByAgentId = new Map();
  for (const resource of sortByCreatedAt(resources)) {
    const payload = getResourcePayload(resource);
    const origin = payload?.origin && typeof payload.origin === "object" ? payload.origin : null;
    const isPublicOrigin = String(origin?.type || "").trim().toLowerCase() === "public";
    for (const row of parseProfilesFromResource(resource)) {
      parsedFromNodes.push(row);
      if (isPublicOrigin && row?.id) {
        publicOriginByAgentId.set(String(row.id).toLowerCase(), {
          ...origin,
          installed_from_public: true,
        });
      }
    }
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
  const selectedWithOrigin = selected.map((agent) => {
    const key = String(agent?.id || "").trim().toLowerCase();
    const origin = key ? publicOriginByAgentId.get(key) : null;
    if (!origin) return agent;
    return {
      ...agent,
      installed_from_public: true,
      origin,
    };
  });

  return buildRegistry(selectedWithOrigin, {
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
  const rawText = `${JSON.stringify(agent, null, 2)}\n`;
  const prev = await findLatestAgentNode(client, slot.threadId, agent.id);

  const created = await client.createResource(slot.threadId, {
    name: `agent:${agent.id}@${nowIso}`,
    summary: `agent_profile ${agent.id} (${op})`,
    text_mode: "plain",
    raw_text: rawText,
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
