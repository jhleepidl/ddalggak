import path from "node:path";
import { runGeminiPrompt } from "./gemini.js";

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

function findFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

function parseJsonObjectFromText(text) {
  const src = String(text || "");
  const candidates = [];
  const fenced = src.match(/```json\s*([\s\S]*?)```/i) || src.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(src.trim());

  for (const c of candidates) {
    if (!c) continue;
    const direct = parseJsonMaybe(c);
    if (direct && typeof direct === "object") return direct;
    const objText = findFirstJsonObject(c);
    if (!objText) continue;
    const parsed = parseJsonMaybe(objText);
    if (parsed && typeof parsed === "object") return parsed;
  }
  return null;
}

function normalizeProvider(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (["chatgpt", "gpt", "openai"].includes(key)) return "chatgpt";
  if (["codex"].includes(key)) return "codex";
  if (["gemini"].includes(key)) return "gemini";
  return "gemini";
}

function normalizeAgentProfile(raw) {
  const row = asObject(raw);
  const id = String(row.id || row.agent_id || row.agentId || "").trim().toLowerCase();
  if (!id) return null;
  const provider = normalizeProvider(row.provider || row.model);
  return {
    id,
    name: String(row.name || row.title || id).trim(),
    description: String(row.description || "").trim(),
    provider,
    model: String(row.model || row.provider || "").trim() || provider,
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

function normalizeRouteAction(raw) {
  const type = String(raw?.type || "").trim().toLowerCase();
  if (!type) return null;

  if (type === "show_agents" || type === "list_agents") return { type: "show_agents" };

  if (type === "open_context" || type === "context") {
    const scope = String(raw.scope || raw.target || "current").trim().toLowerCase();
    const jobId = String(raw.jobId || raw.job_id || "").trim();
    return { type: "open_context", scope: scope === "global" ? "global" : "current", jobId };
  }

  if (type === "run_agent" || type === "agent_run") {
    const agent = String(raw.agent || raw.agentId || raw.id || "").trim().toLowerCase();
    const prompt = String(raw.prompt || raw.task || raw.instruction || raw.message || "").trim();
    const jobId = String(raw.jobId || raw.job_id || "").trim();
    if (!agent || !prompt) return null;
    return { type: "run_agent", agent, prompt, jobId };
  }

  if (type === "create_agent") {
    const agent = normalizeAgentProfile(raw.agent || raw.profile || raw);
    const format = String(raw.format || "json").trim().toLowerCase() === "yaml" ? "yaml" : "json";
    if (!agent) return null;
    return { type: "create_agent", agent, format };
  }

  if (type === "update_agent") {
    const patch = asObject(raw.patch || raw.agent || raw.profile);
    const agentId = String(raw.agentId || raw.agent_id || patch.id || "").trim().toLowerCase();
    const format = String(raw.format || "json").trim().toLowerCase() === "yaml" ? "yaml" : "json";
    if (!agentId) return null;
    return { type: "update_agent", agentId, patch, format };
  }

  return null;
}

function detectAgentId(message, agents) {
  const text = String(message || "").toLowerCase();
  for (const row of Array.isArray(agents) ? agents : []) {
    const id = String(row?.id || "").trim().toLowerCase();
    const name = String(row?.name || "").trim().toLowerCase();
    if (!id) continue;
    if (text.includes(id)) return id;
    if (name && text.includes(name)) return id;
  }
  return "";
}

function pickProviderFromMessage(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("codex")) return "codex";
  if (text.includes("chatgpt") || text.includes("gpt")) return "chatgpt";
  if (text.includes("gemini")) return "gemini";
  return "gemini";
}

function parseRequestedAgentId(message) {
  const src = String(message || "");
  const explicit = src.match(/\bid\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const named = src.match(/([a-zA-Z0-9_-]+)\s*(?:agent|에이전트)/i);
  if (named?.[1]) return named[1].toLowerCase();
  return "";
}

function fallbackRoute(message, context = {}) {
  const msg = String(message || "").trim();
  const low = msg.toLowerCase();
  const agents = Array.isArray(context.agents) ? context.agents : [];

  if (!msg) {
    return { reason: "empty message fallback", actions: [{ type: "show_agents" }] };
  }
  if (low.includes("목록") || low.includes("list agents") || low.includes("agents")) {
    return { reason: "list intent fallback", actions: [{ type: "show_agents" }] };
  }
  if (low.includes("/context") || low.includes("컨텍스트") || low.includes("context 링크")) {
    const scope = low.includes("global") ? "global" : "current";
    return { reason: "context intent fallback", actions: [{ type: "open_context", scope }] };
  }
  if ((low.includes("생성") || low.includes("create")) && (low.includes("agent") || low.includes("에이전트"))) {
    const id = parseRequestedAgentId(msg) || `agent_${Date.now().toString(36)}`;
    return {
      reason: "create intent fallback",
      actions: [{
        type: "create_agent",
        format: "json",
        agent: {
          id,
          name: id,
          description: "Created from /chat fallback",
          provider: pickProviderFromMessage(msg),
          model: pickProviderFromMessage(msg),
          prompt: msg,
          meta: {},
        },
      }],
    };
  }
  if ((low.includes("수정") || low.includes("업데이트") || low.includes("update")) && (low.includes("agent") || low.includes("에이전트"))) {
    const id = parseRequestedAgentId(msg);
    if (id) return { reason: "update intent fallback", actions: [{ type: "update_agent", agentId: id, patch: { prompt: msg }, format: "json" }] };
  }

  const mentionedAgent = detectAgentId(msg, agents);
  if (mentionedAgent) {
    return { reason: "run intent fallback", actions: [{ type: "run_agent", agent: mentionedAgent, prompt: msg }] };
  }

  return { reason: "default fallback", actions: [{ type: "show_agents" }] };
}

function buildRouterPrompt(message, context = {}) {
  const agents = Array.isArray(context.agents) ? context.agents : [];
  const agentText = agents.length
    ? agents.map((row) => `- id=${row.id}, provider=${row.provider}, model=${row.model}, description=${row.description || ""}`).join("\n")
    : "(none)";

  const currentJobId = String(context.currentJobId || "").trim();
  const locale = String(context.locale || "ko-KR");
  const routerPolicy = String(context.routerPolicy || "").trim();

  return [
    "너는 Telegram /chat 오케스트레이터 라우터다.",
    "사용자 메시지의 의도를 분석해서 다음 JSON 액션 계획을 만들어라.",
    "반드시 JSON 객체 하나만 출력한다.",
    "",
    "허용 액션:",
    "- show_agents",
    "- run_agent: {\"type\":\"run_agent\",\"agent\":\"id\",\"prompt\":\"작업지시\",\"jobId\":\"optional\"}",
    "- create_agent: {\"type\":\"create_agent\",\"agent\":{id,name,description,provider,model,prompt,meta},\"format\":\"json|yaml\"}",
    "- update_agent: {\"type\":\"update_agent\",\"agentId\":\"id\",\"patch\":{...},\"format\":\"json|yaml\"}",
    "- open_context: {\"type\":\"open_context\",\"scope\":\"current|global\",\"jobId\":\"optional\"}",
    "",
    "규칙:",
    "- action은 필요한 최소 개수만 선택한다.",
    "- run_agent는 반드시 명시된 에이전트 id 중 하나를 사용한다.",
    "- 에이전트 목록 요청이면 show_agents만 사용한다.",
    "- 컨텍스트 링크 요청이면 open_context를 사용한다.",
    "",
    `locale=${locale}`,
    `current_job_id=${currentJobId || "(none)"}`,
    routerPolicy ? `router_policy=${routerPolicy}` : "",
    "",
    "등록된 에이전트:",
    agentText,
    "",
    "사용자 메시지:",
    message,
    "",
    "반환 형식:",
    "{",
    "  \"reason\": \"한 줄 이유\",",
    "  \"actions\": [ ... ]",
    "}",
  ].filter(Boolean).join("\n");
}

export async function route(message, context = {}) {
  const msg = String(message || "").trim();
  const fallback = fallbackRoute(msg, context);
  const workspaceRoot = String(context.workspaceRoot || process.cwd()).trim() || process.cwd();
  const cwd = String(context.cwd || context.runDir || workspaceRoot).trim() || workspaceRoot;
  const prompt = buildRouterPrompt(msg, context);

  try {
    const r = await runGeminiPrompt({
      workspaceRoot,
      cwd: path.resolve(cwd),
      prompt,
      signal: context.signal || null,
    });
    if (!r?.ok) return fallback;

    const parsed = parseJsonObjectFromText(r.stdout || r.stderr || "");
    if (!parsed || !Array.isArray(parsed.actions)) return fallback;
    const normalized = parsed.actions.map(normalizeRouteAction).filter(Boolean).slice(0, 4);
    if (normalized.length === 0) return fallback;
    return {
      reason: String(parsed.reason || "").trim() || "router decision",
      actions: normalized,
    };
  } catch {
    return fallback;
  }
}
