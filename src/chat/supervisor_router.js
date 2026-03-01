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

function pickDefaultAgent(agents = []) {
  const rows = Array.isArray(agents) ? agents : [];
  const gemini = rows.find((row) => normalizeProvider(row?.provider) === "gemini");
  if (gemini?.id) return String(gemini.id).trim().toLowerCase();
  const nonChatgpt = rows.find((row) => normalizeProvider(row?.provider) !== "chatgpt");
  if (nonChatgpt?.id) return String(nonChatgpt.id).trim().toLowerCase();
  const first = rows[0];
  return first?.id ? String(first.id).trim().toLowerCase() : "";
}

function normalizeStringList(raw) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? raw.split(",") : []);
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    const value = String(entry || "").trim().toLowerCase();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function escapeRegExp(text) {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function isPublicSearchRequest(message) {
  const text = String(message || "").toLowerCase();
  const asksPublic = text.includes("public")
    || text.includes("공개")
    || text.includes("library")
    || text.includes("라이브러리")
    || text.includes("blueprint")
    || text.includes("블루프린트");
  if (!asksPublic) return false;
  return text.includes("찾")
    || text.includes("search")
    || text.includes("추천")
    || text.includes("목록")
    || text.includes("보여");
}

function isInstallPublicRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("설치")
    || text.includes("install")
    || text.includes("가져와")
    || text.includes("복제");
}

function isPublishAgentRequest(message) {
  const text = String(message || "").toLowerCase();
  const hasPublishKeyword = text.includes("게시")
    || text.includes("공개 요청")
    || text.includes("공개해")
    || text.includes("publish");
  const hasAgentKeyword = text.includes("agent")
    || text.includes("에이전트");
  return hasPublishKeyword && hasAgentKeyword;
}

function isDisableSelectionRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("빼줘")
    || text.includes("제외")
    || text.includes("비활성")
    || text.includes("막아")
    || text.includes("차단")
    || text.includes("disable");
}

function isEnableSelectionRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("다시 넣")
    || text.includes("다시 포함")
    || text.includes("다시 활성")
    || text.includes("다시 허용")
    || text.includes("복구")
    || text.includes("활성화")
    || text.includes("허용")
    || text.includes("enable");
}

function isListAgentsRequest(message) {
  const text = String(message || "").toLowerCase();
  const asksAgent = text.includes("agent") || text.includes("에이전트");
  if (!asksAgent) return false;
  return text.includes("목록")
    || text.includes("list")
    || text.includes("상태")
    || text.includes("보여")
    || text.includes("어떤");
}

function isListToolsRequest(message) {
  const text = String(message || "").toLowerCase();
  const asksTool = text.includes("tool") || text.includes("툴");
  if (!asksTool) return false;
  return text.includes("목록")
    || text.includes("list")
    || text.includes("상태")
    || text.includes("보여")
    || text.includes("어떤");
}

function isStatusRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("상태")
    || text.includes("진행")
    || text.includes("running")
    || text.includes("뭐 하고")
    || text.includes("뭐하고")
    || text.includes("status");
}

function isInterruptRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("stop")
    || text.includes("중단")
    || text.includes("취소")
    || text.includes("멈춰")
    || text === "/stop"
    || text.includes("cancel");
}

function parseInterruptMode(message) {
  const text = String(message || "").toLowerCase();
  if (text.includes("hard") || text.includes("강제") || text.includes("취소") || text.includes("cancel")) {
    return "cancel";
  }
  return "replan";
}

function isOpenContextRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("context")
    || text.includes("컨텍스트")
    || text.includes("goc 링크")
    || text.includes("goc 열")
    || text.includes("open goc");
}

function parseMentionedAgentIds(message) {
  const text = String(message || "");
  const out = [];
  const seen = new Set();
  const matches = text.matchAll(/@([a-zA-Z0-9_-]+)/g);
  for (const match of matches) {
    const id = String(match?.[1] || "").trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isSpawnRequest(message) {
  const text = String(message || "").toLowerCase();
  return text.includes("병렬")
    || text.includes("동시에")
    || text.includes("parallel")
    || text.includes("spawn")
    || text.includes("각자");
}

function parseRequestedToolId(message, { tools = [], jobConfig = {} } = {}) {
  const src = String(message || "").trim();
  const lower = src.toLowerCase();
  const explicit = src.match(/\btool\s*[:=]\s*([a-zA-Z0-9_-]+)/i);
  if (explicit?.[1]) return explicit[1].toLowerCase();
  const hinted = src.match(/\b([a-zA-Z0-9_-]+)\s*(?:tool|툴)\b/i);
  if (hinted?.[1]) return hinted[1].toLowerCase();

  const toolSet = asObject(jobConfig?.tool_set || jobConfig?.toolSet);
  const disabled = normalizeStringList(toolSet.disabled);
  const candidates = normalizeStringList([
    ...(Array.isArray(tools) ? tools.map((row) => row?.id || row?.tool_id || row?.name || "") : []),
    ...disabled,
  ]);
  for (const id of candidates) {
    if (!id) continue;
    const pattern = new RegExp(`(^|[^a-z0-9_])${escapeRegExp(id)}([^a-z0-9_]|$)`, "i");
    if (pattern.test(lower)) return id;
  }
  return "";
}

function normalizePublicSearchQuery(message) {
  return String(message || "")
    .replace(/public|공개|library|라이브러리|blueprint|블루프린트|agent|에이전트/gi, " ")
    .replace(/찾아줘|찾아 봐|찾아봐|search|install|설치해줘|설치/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackPlan(message, { agents = [], tools = [], jobConfig = {} } = {}) {
  const msg = String(message || "").trim();
  const config = asObject(jobConfig);
  const defaultAgent = pickDefaultAgent(agents);
  const requestedAgent = parseRequestedAgentId(msg);
  const requestedTool = parseRequestedToolId(msg, { tools, jobConfig: config });
  const requestedExists = (Array.isArray(agents) ? agents : [])
    .some((row) => String(row?.id || "").trim().toLowerCase() === requestedAgent);
  const availableAgentSet = new Set(
    (Array.isArray(agents) ? agents : [])
      .map((row) => String(row?.id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const agentSet = asObject(config.agent_set || config.agentSet);
  const disabledAgents = new Set(normalizeStringList(agentSet.disabled));
  const mentionedAgents = parseMentionedAgentIds(msg)
    .filter((id) => availableAgentSet.has(id) && !disabledAgents.has(id));
  const wantsDisable = isDisableSelectionRequest(msg);
  const wantsEnable = isEnableSelectionRequest(msg);

  if (!msg) {
    return {
      reason: "empty message fallback",
      actions: defaultAgent
        ? [{ type: "run_agent", agent_id: defaultAgent, goal: "현재 상태를 요약하고 다음 단계를 제안해줘.", risk: "L1" }]
        : [{ type: "summarize" }],
      final_response_style: "concise",
    };
  }

  if (isListAgentsRequest(msg)) {
    return {
      reason: "list agents fallback",
      actions: [{ type: "list_agents", include_disabled: true, risk: "L0" }],
      final_response_style: "concise",
    };
  }

  if (isListToolsRequest(msg)) {
    return {
      reason: "list tools fallback",
      actions: [{ type: "list_tools", include_disabled: true, risk: "L0" }],
      final_response_style: "concise",
    };
  }

  if (isStatusRequest(msg)) {
    return {
      reason: "status request fallback",
      actions: [{ type: "get_status", detail: "summary", risk: "L0" }],
      final_response_style: "concise",
    };
  }

  if (isInterruptRequest(msg)) {
    return {
      reason: "interrupt fallback",
      actions: [{
        type: "interrupt",
        mode: parseInterruptMode(msg),
        note: msg,
        risk: "L0",
      }],
      final_response_style: "concise",
    };
  }

  if (isOpenContextRequest(msg)) {
    return {
      reason: "open context fallback",
      actions: [{
        type: "open_context",
        scope: msg.toLowerCase().includes("global") ? "global" : "current",
        risk: "L0",
      }],
      final_response_style: "concise",
    };
  }

  if (isSpawnRequest(msg) && mentionedAgents.length >= 2) {
    return {
      reason: "parallel spawn fallback",
      actions: [{
        type: "spawn_agents",
        summary: "병렬 위임 실행",
        agents: mentionedAgents.slice(0, 4).map((agentId) => ({
          agent_id: agentId,
          goal: msg,
          risk: "L1",
        })),
        risk: "L1",
      }],
      final_response_style: "concise",
    };
  }

  if (requestedAgent && wantsDisable) {
    return {
      reason: "disable agent fallback",
      actions: [{ type: "disable_agent", agent_id: requestedAgent, risk: "L1" }],
      final_response_style: "concise",
    };
  }

  if (requestedAgent && wantsEnable) {
    return {
      reason: "enable agent fallback",
      actions: [{ type: "enable_agent", agent_id: requestedAgent, risk: "L1" }],
      final_response_style: "concise",
    };
  }

  if (requestedTool && wantsDisable) {
    return {
      reason: "disable tool fallback",
      actions: [{ type: "disable_tool", tool_id: requestedTool, risk: "L1" }],
      final_response_style: "concise",
    };
  }

  if (requestedTool && wantsEnable) {
    return {
      reason: "enable tool fallback",
      actions: [{ type: "enable_tool", tool_id: requestedTool, risk: "L1" }],
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

  if (isPublishAgentRequest(msg)) {
    return {
      reason: "publish request fallback (admin approval required)",
      actions: [{
        type: "publish_agent",
        agent_id: parseRequestedAgentId(msg) || "",
        risk: "L1",
      }],
      final_response_style: "concise",
    };
  }

  if (isInstallPublicRequest(msg)) {
    const query = normalizePublicSearchQuery(msg);
    return {
      reason: "install public fallback",
      actions: [
        {
          type: "search_public_agents",
          query,
          risk: "L0",
        },
        {
          type: "install_agent_blueprint",
          agent_id_override: parseRequestedAgentId(msg) || "",
          risk: "L1",
        },
      ],
      final_response_style: "concise",
    };
  }

  if (isPublicSearchRequest(msg)) {
    return {
      reason: "public search fallback",
      actions: [{
        type: "search_public_agents",
        query: normalizePublicSearchQuery(msg),
        risk: "L0",
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

  if (requestedAgent && disabledAgents.has(requestedAgent)) {
    return {
      reason: "requested agent is disabled in this job; suggest enable_agent",
      actions: [{ type: "enable_agent", agent_id: requestedAgent, risk: "L1" }],
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
    "    {\"type\":\"search_public_agents\",\"query\":\"...\",\"limit\":5},",
    "    {\"type\":\"install_agent_blueprint\",\"blueprint_id\":\"optional\",\"public_node_id\":\"optional\",\"agent_id_override\":\"optional\"},",
    "    {\"type\":\"publish_agent\",\"agent_node_id\":\"optional\",\"agent_id\":\"optional\"},",
    "    {\"type\":\"disable_agent\",\"agent_id\":\"...\"},",
    "    {\"type\":\"enable_agent\",\"agent_id\":\"...\"},",
    "    {\"type\":\"disable_tool\",\"tool_id\":\"...\"},",
    "    {\"type\":\"enable_tool\",\"tool_id\":\"...\"},",
    "    {\"type\":\"list_agents\",\"include_disabled\":true},",
    "    {\"type\":\"list_tools\",\"include_disabled\":true},",
    "    {\"type\":\"create_agent\",\"agent\":{\"id\":\"...\",\"name\":\"...\",\"provider\":\"gemini|codex|chatgpt\",\"model\":\"...\",\"prompt\":\"...\",\"description\":\"...\",\"meta\":{}},\"format\":\"json\"},",
    "    {\"type\":\"update_agent\",\"agent_id\":\"...\",\"patch\":{\"prompt\":\"...\",\"description\":\"...\"},\"format\":\"json\"},",
    "    {\"type\":\"get_status\",\"detail\":\"summary|full\"},",
    "    {\"type\":\"interrupt\",\"mode\":\"cancel|replan\",\"note\":\"...\"},",
    "    {\"type\":\"spawn_agents\",\"summary\":\"...\",\"agents\":[{\"agent_id\":\"...\",\"goal\":\"...\",\"risk\":\"L1\"}],\"max_parallel\":2},",
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
    "- public agent 검색 요청은 search_public_agents를 사용한다.",
    "- 설치 요청은 먼저 search_public_agents로 후보를 좁히고, 1개로 좁혀지면 install_agent_blueprint를 사용한다.",
    "- publish_agent는 admin 승인/검토가 필요함을 reason 또는 summarize 힌트에 명시한다.",
    "- agent/tool 제외 요청은 disable_agent/disable_tool을 사용한다.",
    "- agent/tool 재포함 요청은 enable_agent/enable_tool을 사용한다.",
    "- 상태/진행 상황 요청은 get_status를 우선 사용한다.",
    "- 중단/취소/멈춤 요청은 interrupt를 사용한다.",
    "- 컨텍스트/GoC 링크 요청은 open_context를 사용한다.",
    "- agent를 생성/수정해달라는 요청은 create_agent/update_agent를 사용한다.",
    "- 병렬/동시 실행 요청이고 @agent가 2개 이상이면 spawn_agents를 고려한다.",
    "- 현재 job에서 비활성화된 agent가 명시되면 run_agent 대신 enable_agent를 우선 제안한다.",
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
    fallbackPlan(msg, { agents, tools, jobConfig }),
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
    if (!r?.ok) {
      if (signal?.aborted) {
        const aborted = new Error("supervisor router aborted");
        aborted.code = "ECANCELLED";
        throw aborted;
      }
      return fallback;
    }
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
  } catch (e) {
    if (signal?.aborted) throw e;
    return fallback;
  }
}
