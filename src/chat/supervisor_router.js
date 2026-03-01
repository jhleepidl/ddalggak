import path from "node:path";
import { runGeminiPrompt } from "../gemini.js";
import { clip } from "../textutil.js";
import { normalizeActionPlan } from "./actions.js";

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

  for (const candidate of candidates) {
    if (!candidate) continue;
    const direct = parseJsonMaybe(candidate);
    if (direct && typeof direct === "object") return direct;
    const objectText = findFirstJsonObject(candidate);
    if (!objectText) continue;
    const parsed = parseJsonMaybe(objectText);
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

function pickDefaultAgent(agents = [], preferredIds = []) {
  const rows = Array.isArray(agents) ? agents : [];
  const byId = new Map(rows.map((row) => [String(row?.id || "").trim().toLowerCase(), row]));
  for (const raw of preferredIds) {
    const key = String(raw || "").trim().toLowerCase();
    if (key && byId.has(key)) return key;
  }
  const gemini = rows.find((row) => normalizeProvider(row?.provider) === "gemini");
  if (gemini?.id) return String(gemini.id).trim().toLowerCase();
  const nonChatgpt = rows.find((row) => normalizeProvider(row?.provider) !== "chatgpt");
  if (nonChatgpt?.id) return String(nonChatgpt.id).trim().toLowerCase();
  const first = rows[0];
  return first?.id ? String(first.id).trim().toLowerCase() : "";
}

function parseRequestedAgentId(message) {
  const src = String(message || "");
  const explicit = src.match(/\bid\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const tagged = src.match(/@([a-zA-Z0-9_-]+)/);
  if (tagged?.[1]) return tagged[1].toLowerCase();
  const named = src.match(/([a-zA-Z0-9_-]+)\s*(?:agent|에이전트)/i);
  if (named?.[1]) return named[1].toLowerCase();
  return "";
}

function isExplicitChatGptPlannerRequest(message) {
  const text = String(message || "").toLowerCase();
  const asksChatGPT = text.includes("chatgpt")
    || text.includes("gpt")
    || text.includes("챗지피티")
    || text.includes("지피티");
  if (!asksChatGPT) return false;
  return text.includes("결정")
    || text.includes("정해")
    || text.includes("판단")
    || text.includes("action plan")
    || text.includes("plan")
    || text.includes("플랜")
    || text.includes("계획")
    || text.includes("decide");
}

function isAgentProposalRequest(message) {
  const text = String(message || "").toLowerCase();
  if (!(text.includes("agent") || text.includes("에이전트"))) return false;
  return text.includes("추가")
    || text.includes("생성")
    || text.includes("invite")
    || text.includes("create")
    || text.includes("draft")
    || text.includes("초대");
}

function fallbackPlan(message, { agents = [], jobConfig = {} } = {}) {
  const msg = String(message || "").trim();
  const participants = Array.isArray(jobConfig?.participants) ? jobConfig.participants : [];
  const defaultAgent = pickDefaultAgent(agents, participants);
  const requestedAgent = parseRequestedAgentId(msg);
  const requestedExists = (Array.isArray(agents) ? agents : [])
    .some((row) => String(row?.id || "").trim().toLowerCase() === requestedAgent);
  if (!msg) {
    return {
      reason: "empty message fallback",
      actions: defaultAgent
        ? [{ type: "run_agent", agent_id: defaultAgent, goal: "현재 상태를 요약하고 다음 단계를 제안해줘.", risk: "L1" }]
        : [{ type: "summarize" }],
      final_response_style: "concise",
    };
  }

  if (isAgentProposalRequest(msg)) {
    const requestedId = parseRequestedAgentId(msg) || `agent_${Date.now().toString(36)}`;
    return {
      reason: "agent proposal fallback",
      actions: [{
        type: "propose_agent",
        agent_id: requestedId,
        name: requestedId,
        description: "proposed from /chat",
        provider: "gemini",
        model: "gemini",
        prompt: msg,
        risk: "L2",
      }],
      final_response_style: "concise",
    };
  }

  if (requestedAgent && requestedExists) {
    return {
      reason: "explicit agent mention fallback",
      actions: [{ type: "run_agent", agent_id: requestedAgent, goal: msg, risk: "L1" }],
      final_response_style: "concise",
    };
  }

  if (!defaultAgent) {
    return {
      reason: "no available agents",
      actions: [{ type: "summarize" }],
      final_response_style: "concise",
    };
  }
  return {
    reason: "default run_agent fallback",
    actions: [{ type: "run_agent", agent_id: defaultAgent, goal: msg, risk: "L1" }],
    final_response_style: "concise",
  };
}

function buildRouterPrompt(message, context = {}) {
  const row = asObject(context);
  const agents = Array.isArray(row.agents) ? row.agents : [];
  const tools = Array.isArray(row.tools) ? row.tools : [];
  const jobConfig = asObject(row.jobConfig);
  const participants = Array.isArray(jobConfig.participants) ? jobConfig.participants : [];
  const allowChatGPTPlanner = !!row.allowChatGPTPlanner;
  const agentText = agents.length
    ? agents
      .map((agent) => `- id=${agent.id}, provider=${agent.provider}, model=${agent.model}, desc=${agent.description || ""}`)
      .join("\n")
    : "(none)";
  const toolText = tools.length
    ? tools
      .map((tool) => `- name=${tool.name || tool.id || "tool"}, action_types=${Array.isArray(tool.action_types) ? tool.action_types.join(",") : ""}, risk=${tool.risk || "L1"}`)
      .join("\n")
    : "(none)";
  const jobConfigText = clip(JSON.stringify(jobConfig, null, 2), 3200);
  const contextSummary = clip(String(row.contextSummary || ""), 4500) || "(none)";

  return [
    "너는 Telegram /chat supervisor_router다.",
    "반드시 JSON 객체 1개만 출력한다. JSON 외 텍스트 금지.",
    "출력 스키마(JSON only):",
    "{",
    "  \"reason\": \"...\",",
    "  \"actions\": [",
    "    {\"type\":\"run_agent\",\"agent_id\":\"...\",\"goal\":\"...\",\"inputs\":{},\"risk\":\"L0|L1|L2|L3\"},",
    "    {\"type\":\"propose_agent\",\"agent_id\":\"...\",\"name\":\"...\",\"description\":\"...\",\"provider\":\"gemini|codex|chatgpt\",\"model\":\"...\",\"prompt\":\"...\",\"meta\":{},\"risk\":\"L2|L3\"},",
    "    {\"type\":\"need_more_detail\",\"context_set_id\":\"...\",\"node_ids\":[\"...\"],\"depth\":1,\"max_chars\":7000},",
    "    {\"type\":\"open_context\",\"scope\":\"current|global\"},",
    "    {\"type\":\"summarize\",\"hint\":\"...\"}",
    "  ],",
    "  \"final_response_style\": \"concise|detailed\"",
    "}",
    "",
    "핵심 규칙:",
    "- action은 필요한 최소만 선택한다 (최대 4개).",
    "- 일반 요청은 run_agent 1개로 우선 처리한다.",
    "- 컨텍스트가 부족하면 need_more_detail 후 run_agent를 배치한다.",
    "- provider=chatgpt(planner) run_agent는 기본 금지다.",
    allowChatGPTPlanner
      ? "- 이번 요청은 사용자가 ChatGPT 의사결정을 명시적으로 요청했다. chatgpt 사용 가능."
      : "- 사용자가 명시적으로 요청하지 않은 한 chatgpt agent를 선택하지 마라.",
    "- 에이전트 추가/초대/생성 요청은 propose_agent를 사용한다.",
    "- 파일 변경이 필요한 실행은 risk를 L3로 올린다.",
    "",
    `current_job_id=${String(row.currentJobId || "").trim() || "(none)"}`,
    `current_context_set_id=${String(row.currentContextSetId || "").trim() || "(none)"}`,
    `locale=${String(row.locale || "ko-KR")}`,
    row.routerPolicy ? `router_policy=${String(row.routerPolicy)}` : "",
    "",
    "job_config:",
    jobConfigText,
    "",
    "registered_agents:",
    agentText,
    "",
    "tool_specs:",
    toolText,
    "",
    "current_context_summary:",
    contextSummary,
    "",
    "user_message:",
    String(message || ""),
  ].filter(Boolean).join("\n");
}

export async function routeWithSupervisor(message, {
  agents = [],
  tools = [],
  jobConfig = {},
  currentJobId = "",
  currentContextSetId = "",
  workspaceRoot = process.cwd(),
  cwd = process.cwd(),
  signal = null,
  locale = "ko-KR",
  routerPolicy = "",
  contextSummary = "",
} = {}) {
  const msg = String(message || "").trim();
  const allowChatGPTPlanner = isExplicitChatGptPlannerRequest(msg);
  const fallback = normalizeActionPlan(
    fallbackPlan(msg, { agents, jobConfig }),
    { maxActions: 4 }
  );

  const prompt = buildRouterPrompt(msg, {
    agents,
    tools,
    jobConfig,
    currentJobId,
    currentContextSetId,
    locale,
    routerPolicy,
    allowChatGPTPlanner,
    contextSummary,
  });

  try {
    const r = await runGeminiPrompt({
      workspaceRoot,
      cwd: path.resolve(cwd || workspaceRoot || process.cwd()),
      prompt,
      signal,
    });
    if (!r?.ok) return fallback;
    const parsed = parseJsonObjectFromText(r.stdout || r.stderr || "");
    if (!parsed) return fallback;

    const normalized = normalizeActionPlan(parsed, {
      maxActions: Number(jobConfig?.budget?.max_actions) > 0
        ? Math.floor(Number(jobConfig.budget.max_actions))
        : 4,
    });
    if (!Array.isArray(normalized.actions) || normalized.actions.length === 0) return fallback;

    const providerById = new Map(
      (Array.isArray(agents) ? agents : []).map((agent) => [
        String(agent?.id || "").trim().toLowerCase(),
        normalizeProvider(agent?.provider),
      ])
    );

    const filtered = normalized.actions.filter((action) => {
      if (action.type !== "run_agent") return true;
      if (allowChatGPTPlanner) return true;
      const provider = providerById.get(String(action.agent_id || "").trim().toLowerCase());
      return provider !== "chatgpt";
    });
    if (filtered.length === 0) return fallback;
    const hardened = filtered.map((action) => {
      if (action.type !== "run_agent") return action;
      const provider = providerById.get(String(action.agent_id || "").trim().toLowerCase());
      if (provider === "codex" && String(action.risk || "").toUpperCase() !== "L3") {
        return { ...action, risk: "L3" };
      }
      return action;
    });
    return {
      reason: normalized.reason || "supervisor route",
      actions: hardened,
      final_response_style: normalized.final_response_style,
    };
  } catch {
    return fallback;
  }
}
