import path from "node:path";
import { runGeminiPrompt } from "../gemini.js";
import { clip } from "../textutil.js";
import { normalizeActionPlan } from "./actions.js";
import { parseJsonObjectFromText } from "../shared/json_extract.js";
import { buildInteractionSummaryLines, buildRouterInteractionContract, normalizeInteractionSpec } from "../domain/interaction_spec.js";
import { canParallelSpawnInRuntime, sanitizeExecutablePlan } from "./route_execution_contract.js";
import { appendPromptTelemetry } from "../application/prompt_telemetry.js";
import { runDir, runSharedDir } from "../application/telegram_runtime_state.js";
import { compactPromptJson } from "../application/prompt_surface_builder.js";
import { resolveRoutingContractSummary, resolveRouteContractHeuristic, alignPlanActionsToRouteContract, rankAgentsByRouteContract } from "../application/route_contract.js";
import { buildSupervisorOutputSchemaLines, buildSupervisorRuleLines } from "./supervisor_prompt_fragments.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
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

const ROUTER_RELEVANCE_STOPWORDS = new Set([
  "agent",
  "agents",
  "에이전트",
  "해주세요",
  "해줘",
  "요청",
  "작업",
  "and",
  "the",
  "with",
  "from",
  "this",
  "that",
  "then",
  "for",
  "into",
  "about",
]);

function tokenizeForRelevance(text) {
  const matches = String(text || "").toLowerCase().match(/[a-z0-9가-힣_]{2,}/g) || [];
  const out = [];
  const seen = new Set();
  for (const token of matches) {
    if (!token || ROUTER_RELEVANCE_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= 80) break;
  }
  return out;
}

function buildAgentCatalogText(agent) {
  const row = asObject(agent);
  return [
    row.id,
    row.system_key,
    row.systemKey,
    row.name,
    clip(String(row.description || "").trim(), 320),
    clip(String(row.prompt || "").trim(), 1400),
    clip(String(row.system_prompt || "").trim(), 1400),
    clip(String(row.systemPrompt || "").trim(), 1400),
    clip(String(row.instruction || "").trim(), 800),
  ]
    .map((entry) => String(entry || "").trim())
    .filter(Boolean)
    .join(" ");
}

function pickRelevantCatalogAgents(message, {
  agentsCatalog = [],
  enabledAgentIds = [],
  limit = 12,
} = {}) {
  const rows = Array.isArray(agentsCatalog) ? agentsCatalog : [];
  if (rows.length === 0) return [];
  const queryLower = String(message || "").trim().toLowerCase();
  const queryTokens = tokenizeForRelevance(message);
  const enabledSet = new Set(
    (Array.isArray(enabledAgentIds) ? enabledAgentIds : [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter(Boolean)
  );

  const scored = rows
    .map((agent) => {
      const id = String(agent?.id || "").trim().toLowerCase();
      if (!id) return null;
      const systemKey = String(agent?.system_key || agent?.systemKey || "").trim().toLowerCase();
      const name = String(agent?.name || "").trim().toLowerCase();
      const candidateTokens = new Set(tokenizeForRelevance(buildAgentCatalogText(agent)));
      let overlap = 0;
      for (const token of queryTokens) {
        if (candidateTokens.has(token)) overlap += 1;
      }
      let score = overlap;
      if (queryLower) {
        if (id && queryLower.includes(id)) score += 3;
        if (systemKey && queryLower.includes(systemKey)) score += 3;
        if (name && queryLower.includes(name)) score += 2;
      }
      if (enabledSet.has(id)) score += 2;
      if (["router", "planner", "researcher", "coder"].includes(systemKey || id)) score += 1;
      return {
        agent,
        id,
        overlap,
        score,
        enabled: enabledSet.has(id),
      };
    })
    .filter(Boolean);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.overlap !== a.overlap) return b.overlap - a.overlap;
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });

  const preferred = scored.filter((row) => row.score > 0);
  const source = preferred.length > 0 ? preferred : scored;
  return source.slice(0, Math.max(1, Math.min(15, limit))).map((row) => row.agent);
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

function fallbackPlan(message, { agents = [], tools = [], jobConfig = {}, parallelSpawnAllowed = true, activeTeam = null, runtimeTeamSnapshot = null } = {}) {
  const msg = String(message || "").trim();
  const config = asObject(jobConfig);
  const routeHeuristic = resolveRouteContractHeuristic({
    message: msg,
    agents,
    activeTeam,
    runtimeTeamSnapshot,
  });
  const rankedRouteAgents = rankAgentsByRouteContract({
    message: msg,
    agents,
    activeTeam,
    runtimeTeamSnapshot,
  });
  const defaultAgent = routeHeuristic.preferred_agent_id || rankedRouteAgents.preferred_agent_id || pickDefaultAgent(agents);
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
  const wantsConversationAdd = /(추가|add|invite|초대)/i.test(msg) && /(대화|conversation|participant|멤버|member|팀)/i.test(msg);
  const wantsConversationRemove = /(제거|remove|삭제|exclude|빼)/i.test(msg) && /(대화|conversation|participant|멤버|member|팀)/i.test(msg);

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

  if (routeHeuristic.should_explain_constraints) {
    const constraintHint = routeHeuristic.blocked_explanation || 'route contract is not ready';
    return {
      reason: `route contract fallback (${constraintHint})`,
      actions: [{
        type: routeHeuristic.intent?.wants_status ? 'get_status' : 'summarize',
        detail: routeHeuristic.intent?.wants_status ? 'summary' : undefined,
        hint: routeHeuristic.intent?.wants_status ? undefined : `현재 팀 제약 설명: ${constraintHint}`,
        risk: 'L0',
      }],
      final_response_style: 'concise',
      followup_hint: 'final owner 또는 artifact publisher 구성을 먼저 확인해 주세요.',
      route_contract: routeHeuristic.summary || undefined,
    };
  }

  if (isSpawnRequest(msg) && mentionedAgents.length >= 2) {
    if (!parallelSpawnAllowed) {
      return {
        reason: "parallel spawn unavailable fallback",
        actions: mentionedAgents.slice(0, 4).map((agentId) => ({
          type: "run_agent",
          agent_id: agentId,
          goal: msg,
          risk: "L1",
        })),
        final_response_style: "concise",
      };
    }
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

  if (requestedAgent && wantsConversationAdd) {
    return {
      reason: "add agent to conversation fallback",
      actions: [{ type: "add_agent_to_conversation", agent_id: requestedAgent, enabled: true, risk: "L2" }],
      final_response_style: "concise",
    };
  }

  if (requestedAgent && wantsConversationRemove) {
    return {
      reason: "remove agent from conversation fallback",
      actions: [{ type: "remove_agent_from_conversation", agent_id: requestedAgent, risk: "L2" }],
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
      reason: "agent definition create fallback",
      actions: [{
        type: "create_agent_definition",
        agent_spec: {
          id: requestedId,
          name: requestedId,
          description: "created from /chat fallback",
          provider: "gemini",
          model: "gemini",
          prompt: msg,
          tools: [],
          meta: {},
        },
        add_to_conversation: true,
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
      route_contract: routeHeuristic.summary || undefined,
    };
  }

  if (!defaultAgent) {
    return {
      reason: "no available agents",
      actions: [{ type: "summarize" }],
      final_response_style: "concise",
      route_contract: routeHeuristic.summary || undefined,
    };
  }
  return {
    reason: routeHeuristic.preferred_agent_id && routeHeuristic.preferred_agent_id === defaultAgent
      ? "default run_agent fallback; route_contract_preferred_agent"
      : "default run_agent fallback",
    actions: [{ type: "run_agent", agent_id: defaultAgent, goal: msg, risk: "L1" }],
    final_response_style: "concise",
    route_contract: routeHeuristic.summary || undefined,
  };
}

function envFlagEnabled(name, defaultValue = true) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return defaultValue;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  return defaultValue;
}

function positiveInt(value, fallback, { min = 1000, max = 240000 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function shouldUseLocalFastRoute(message, { agents = [], enabledAgentIds = [], allowChatGPTPlanner = false } = {}) {
  if (!envFlagEnabled('CHAT_SUPERVISOR_LOCAL_FAST_PATH', false)) return false;
  if (allowChatGPTPlanner) return false;
  const msg = String(message || '').trim();
  if (!msg) return true;
  const enabled = Array.isArray(enabledAgentIds) ? enabledAgentIds.filter(Boolean) : [];
  const rows = Array.isArray(agents) ? agents : [];
  const nonChatGptAgents = rows.filter((agent) => normalizeProvider(agent?.provider) !== 'chatgpt');
  const singleExecutableAgent = enabled.length <= 1 || nonChatGptAgents.length <= 1;
  if (singleExecutableAgent) return true;
  if (isStatusRequest(msg) || isOpenContextRequest(msg) || isInterruptRequest(msg) || isListAgentsRequest(msg) || isListToolsRequest(msg)) return true;
  return false;
}

function buildRouterPrompt(message, context = {}) {
  const row = asObject(context);
  const agents = Array.isArray(row.agents) ? row.agents : [];
  const agentsCatalog = Array.isArray(row.agentsCatalog) ? row.agentsCatalog : [];
  const teamRecommendation = row.teamRecommendation && typeof row.teamRecommendation === "object"
    ? row.teamRecommendation
    : {};
  const enabledAgentIds = Array.isArray(row.enabledAgentIds)
    ? row.enabledAgentIds.map((id) => String(id || "").trim().toLowerCase()).filter(Boolean)
    : agents.map((agent) => String(agent?.id || "").trim().toLowerCase()).filter(Boolean);
  const tools = Array.isArray(row.tools) ? row.tools : [];
  const jobConfig = asObject(row.jobConfig);
  const allowChatGPTPlanner = !!row.allowChatGPTPlanner;
  const teamLocked = row.teamLocked === true;
  const teamCompositionMode = String(row.teamCompositionMode || row.activeTeamConfig?.composition_mode || 'structured').trim().toLowerCase() || 'structured';
  const teamInteractionSpec = normalizeInteractionSpec(row.teamInteractionSpec || row.interaction_spec || {});
  const routerInteractionContract = buildRouterInteractionContract(teamInteractionSpec);
  const interactionSummaryText = buildInteractionSummaryLines(routerInteractionContract).join("\n") || "(none)";
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
  const jobConfigText = compactPromptJson(jobConfig, { maxDepth: 4, maxItems: 10, maxStringChars: 180 });
  const contextSummary = clip(String(row.contextSummary || ""), 4500) || "(none)";
  const progressSummary = clip(String(row.progressSummary || ""), 3200) || "(none)";
  const originalUserMessage = String(row.originalUserMessage || "").trim();
  const autopilotTurn = Number.isFinite(Number(row.autopilotTurn))
    ? Math.max(1, Math.floor(Number(row.autopilotTurn)))
    : 1;
  const suggestedActionsText = (() => {
    const rows = Array.isArray(row.suggestedActions) ? row.suggestedActions : [];
    if (rows.length === 0) return "(none)";
    try {
      return compactPromptJson(rows.slice(0, 8), { maxDepth: 4, maxItems: 8, maxStringChars: 160 });
    } catch {
      return "(none)";
    }
  })();
  const relevantCatalogText = (() => {
    const rows = pickRelevantCatalogAgents(message, {
      agentsCatalog,
      enabledAgentIds,
      limit: 12,
    });
    if (rows.length === 0) return "(none)";
    const enabledSet = new Set(enabledAgentIds);
    return rows.map((agent) => {
      const id = String(agent?.id || "").trim().toLowerCase();
      const systemKey = String(agent?.system_key || agent?.systemKey || "").trim().toLowerCase();
      const provider = String(agent?.provider || "").trim().toLowerCase() || "gemini";
      const model = String(agent?.model || provider).trim();
      const name = String(agent?.name || id || "unknown").trim();
      const desc = clip(String(agent?.description || "").trim(), 180);
      return `- id=${id || "unknown"}, name=${name}, system_key=${systemKey || "-"}, enabled=${enabledSet.has(id) ? "yes" : "no"}, provider=${provider}, model=${model}, desc=${desc || "(none)"}`;
    }).join("\n");
  })();
  const teamCandidatesText = (() => {
    const rows = Array.isArray(teamRecommendation?.candidates) ? teamRecommendation.candidates : [];
    if (rows.length === 0) return "(none)";
    return rows.slice(0, 12).map((agent) => {
      const id = String(agent?.agent_id || agent?.id || "").trim().toLowerCase();
      const name = String(agent?.name || id || "unknown").trim();
      const provider = String(agent?.provider || "gemini").trim().toLowerCase();
      const source = String(agent?.source || "catalog").trim().toLowerCase();
      const score = Number(agent?.score || 0);
      const why = clip(String(agent?.why || "").trim(), 140) || "(none)";
      return `- id=${id || "unknown"}, name=${name}, provider=${provider}, source=${source}, score=${score}, why=${why}`;
    }).join("\n");
  })();
  const recommendedTeamText = (() => {
    const rows = Array.isArray(teamRecommendation?.selected_existing_agents)
      ? teamRecommendation.selected_existing_agents
      : [];
    if (rows.length === 0) return "(none)";
    return rows.slice(0, 8).map((agent) => {
      const role = String(agent?.role || "").trim().toLowerCase() || "role";
      const id = String(agent?.agent_id || agent?.id || "").trim().toLowerCase();
      const name = String(agent?.name || id || "unknown").trim();
      const provider = String(agent?.provider || "gemini").trim().toLowerCase();
      const source = String(agent?.source || "catalog").trim().toLowerCase();
      const why = clip(String(agent?.why || "").trim(), 140) || "(none)";
      return `- role=${role}, id=${id || "unknown"}, name=${name}, provider=${provider}, source=${source}, why=${why}`;
    }).join("\n");
  })();
  const missingCapabilitiesText = (() => {
    const rows = Array.isArray(teamRecommendation?.missing_capabilities)
      ? teamRecommendation.missing_capabilities
      : [];
    if (rows.length === 0) return "(none)";
    return rows.slice(0, 8).map((item) => `- ${String(item || "").trim()}`).join("\n");
  })();
  const canSatisfyWithoutCreation = teamRecommendation?.can_satisfy_without_creation === true;
  const teamCompositionIntent = teamRecommendation?.team_composition_intent === true;
  const parallelSpawnAllowed = row.parallelSpawnAllowed !== false;
  const routeContract = resolveRoutingContractSummary({
    activeTeam: row.activeTeamConfig && typeof row.activeTeamConfig === 'object' ? row.activeTeamConfig : null,
    runtimeTeamSnapshot: row.runtimeTeamSnapshot && typeof row.runtimeTeamSnapshot === 'object' ? row.runtimeTeamSnapshot : null,
  });
  const routeContractText = routeContract?.available
    ? [
        `- final_owner=${routeContract.final_owner || '(unset)'}`,
        `- final_owner_role=${routeContract.final_owner_role || '(unset)'}`,
        `- final_answer_publish=${routeContract.final_answer_publish_ok === false ? 'blocked' : 'ready'}`,
        `- artifact_publish=${routeContract.artifact_publish_ok === false ? 'blocked' : 'ready'}`,
        `- artifact_publishers=${Array.isArray(routeContract.artifact_publishers) && routeContract.artifact_publishers.length > 0 ? routeContract.artifact_publishers.join(', ') : '(none)'}`,
        `- memory_contract=${routeContract.memory_contract_enforcement?.read_scope || 'hard_role_scoped_local_only'}`,
      ].join('\n')
    : '(none)';

  const outputSchemaLines = buildSupervisorOutputSchemaLines({ teamLocked, parallelSpawnAllowed });
  const coreRuleLines = buildSupervisorRuleLines({ teamLocked, parallelSpawnAllowed, allowChatGPTPlanner });

  return [
    "너는 Telegram /chat supervisor_router다.",
    "반드시 JSON 객체 1개만 출력한다. JSON 외 텍스트 금지.",
    ...outputSchemaLines,
    "",
    "핵심 규칙:",
    ...coreRuleLines,
    ...(process.env.CHAT_SUPERVISOR_FEWSHOT === "1" ? [
      "",
      "few-shot 예시:",
      "user: \"주제 3개 제안하고 ipynb 코드 뼈대와 과제 5개 만들어줘\"",
      "assistant(JSON): {\"reason\":\"복합 산출물\",\"done\":false,\"await_user\":false,\"deliverables\":[\"주제 제안\",\"ipynb 코드\",\"과제\"],\"completed_deliverables\":[],\"actions\":[{\"type\":\"run_agent\",\"agent_id\":\"researcher\",\"goal\":\"주제 3개 제안\"},{\"type\":\"run_agent\",\"agent_id\":\"coder\",\"goal\":\"ipynb 코드 뼈대 작성\"},{\"type\":\"run_agent\",\"agent_id\":\"reviewer\",\"goal\":\"과제 5개 생성 및 품질 점검\"}],\"final_response_style\":\"concise\"}",
    ] : []),
    "",
    `current_job_id=${String(row.currentJobId || "").trim() || "(none)"}`,
    `current_context_set_id=${String(row.currentContextSetId || "").trim() || "(none)"}`,
    `autopilot_turn=${autopilotTurn}`,
    `locale=${String(row.locale || "ko-KR")}`,
    row.routerPolicy ? `router_policy=${String(row.routerPolicy)}` : "",
    "",
    "job_config:",
    jobConfigText,
    "",
    "registered_agents:",
    agentText,
    "",
    "enabled_agents_for_this_conversation:",
    enabledAgentIds.length > 0 ? enabledAgentIds.map((id) => `- @${id}`).join("\n") : "(none)",
    "",
    "relevant_catalog_agents:",
    relevantCatalogText,
    "",
    "existing_team_candidates:",
    teamCandidatesText,
    "",
    "recommended_existing_team:",
    recommendedTeamText,
    "",
    "current_active_team_route_contract:",
    routeContractText,
    "",
    "missing_capabilities:",
    missingCapabilitiesText,
    "",
    `can_satisfy_without_creation=${canSatisfyWithoutCreation ? "yes" : "no"}`,
    `team_composition_intent=${teamCompositionIntent ? "yes" : "no"}`,
    "",
    "team_interaction_contract:",
    interactionSummaryText,
    "",
    `team_locked=${teamLocked ? "yes" : "no"}`,
    `team_composition_mode=${teamCompositionMode}`,
    "",
    "tool_specs:",
    toolText,
    "",
    "current_context_summary:",
    contextSummary,
    "",
    "original_user_message:",
    originalUserMessage || "(none)",
    "",
    "autopilot_progress_summary:",
    progressSummary,
    "",
    "agent_suggested_actions_candidates:",
    suggestedActionsText,
    "",
    "user_message:",
    String(message || ""),
  ].filter(Boolean).join("\n");
}

export async function routeWithSupervisor(message, {
  agents = [],
  agentsCatalog = [],
  teamRecommendation = null,
  teamLocked = false,
  teamInteractionSpec = null,
  enabledAgentIds = [],
  tools = [],
  jobConfig = {},
  currentJobId = "",
  currentContextSetId = "",
  progressSummary = "",
  suggestedActions = [],
  originalUserMessage = "",
  autopilotTurn = 1,
  workspaceRoot = process.cwd(),
  cwd = process.cwd(),
  signal = null,
  locale = "ko-KR",
  routerPolicy = "",
  contextSummary = "",
  onGeminiRetry = null,
  onGeminiModelSwitch = null,
  onGeminiGiveUp = null,
  geminiConcurrencyKey = "",
  geminiModel = "",
  runtimeTeamSnapshot = null,
  activeTeam = null,
} = {}) {
  const msg = String(message || "").trim();
  const allowChatGPTPlanner = isExplicitChatGptPlannerRequest(msg);
  const parallelSpawnAllowed = canParallelSpawnInRuntime({
    runtimeSnapshot: runtimeTeamSnapshot,
    childCount: 2,
  });
  const routeHeuristic = resolveRouteContractHeuristic({
    message: msg,
    agents,
    activeTeam,
    runtimeTeamSnapshot,
  });
  const fallback = {
    ...normalizeActionPlan(
      fallbackPlan(msg, { agents, tools, jobConfig, parallelSpawnAllowed, activeTeam, runtimeTeamSnapshot }),
      { maxActions: 4 }
    ),
    route_contract: routeHeuristic.summary || undefined,
  };

  if (shouldUseLocalFastRoute(msg, { agents, enabledAgentIds, allowChatGPTPlanner })) {
    return {
      ...fallback,
      reason: ['fast_local_route', fallback.reason].filter(Boolean).join('; '),
      route_contract: fallback.route_contract || routeHeuristic.summary || undefined,
    };
  }

  const prompt = buildRouterPrompt(msg, {
    agents,
    agentsCatalog,
    teamRecommendation,
    enabledAgentIds,
    tools,
    jobConfig,
    currentJobId,
    currentContextSetId,
    progressSummary,
    suggestedActions,
    originalUserMessage,
    autopilotTurn,
    locale,
    routerPolicy,
    allowChatGPTPlanner,
    contextSummary,
    teamLocked,
    teamInteractionSpec,
    parallelSpawnAllowed,
    activeTeam,
    runtimeTeamSnapshot,
  });

  const cleanJobId = String(currentJobId || '').trim();
  if (cleanJobId) {
    appendPromptTelemetry({
      jobDir: runDir(cleanJobId),
      sharedDir: runSharedDir(cleanJobId),
      row: {
        kind: 'supervisor_prompt',
        surface_id: 'supervisor_router',
        surface_label: 'supervisor_router',
        provider: 'gemini',
        model: geminiModel || '',
        agent_id: 'supervisor_router',
        role_id: 'supervisor',
        prompt_text: prompt,
        components: {
          router_policy: String(routerPolicy || '').trim(),
          job_config: compactPromptJson(jobConfig, { maxDepth: 4, maxItems: 10, maxStringChars: 180 }),
          agents: compactPromptJson((Array.isArray(agents) ? agents : []).slice(0, 8), { maxDepth: 3, maxItems: 8, maxStringChars: 120 }),
          tools: compactPromptJson((Array.isArray(tools) ? tools : []).slice(0, 8), { maxDepth: 3, maxItems: 8, maxStringChars: 120 }),
          team_recommendation: compactPromptJson(teamRecommendation, { maxDepth: 4, maxItems: 10, maxStringChars: 140 }),
          context_summary: String(contextSummary || ''),
          progress_summary: String(progressSummary || ''),
          suggested_actions: compactPromptJson((Array.isArray(suggestedActions) ? suggestedActions : []).slice(0, 8), { maxDepth: 4, maxItems: 8, maxStringChars: 160 }),
          user_message: String(message || ''),
        },
        metadata: {
          current_context_set_id: String(currentContextSetId || '').trim() || undefined,
          autopilot_turn: autopilotTurn,
          team_locked: teamLocked,
        },
      },
    });
  }

  try {
    const routerTimeoutMs = positiveInt(process.env.CHAT_SUPERVISOR_GEMINI_TIMEOUT_MS, 30000, { min: 2000, max: 60000 });
    const r = await runGeminiPrompt({
      workspaceRoot,
      cwd: path.resolve(cwd || workspaceRoot || process.cwd()),
      prompt,
      signal,
      concurrencyKey: geminiConcurrencyKey || "",
      jobId: String(currentJobId || "").trim(),
      model: geminiModel || "",
      onRetry: onGeminiRetry,
      onModelSwitch: onGeminiModelSwitch,
      onGiveUp: onGeminiGiveUp,
      timeoutMs: routerTimeoutMs,
      traceMetadata: { surface_role: 'supervisor_router', timeout_ms: routerTimeoutMs },
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
    if ((!Array.isArray(normalized.actions) || normalized.actions.length === 0)
      && !normalized.done
      && !normalized.await_user) {
      return fallback;
    }

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
    if (filtered.length === 0 && !normalized.done && !normalized.await_user) return fallback;
    const hardened = filtered.map((action) => {
      if (action.type !== "run_agent") return action;
      const provider = providerById.get(String(action.agent_id || "").trim().toLowerCase());
      if (provider === "codex") {
        return { ...action, risk: resolveProviderActionRisk({ action, provider: "codex", fallback: "L2" }) };
      }
      return action;
    });
    const routeAligned = alignPlanActionsToRouteContract({
      plan: {
        ...normalized,
        actions: hardened,
        route_contract: routeHeuristic.summary || normalized.route_contract || undefined,
      },
      message: msg,
      agents,
      activeTeam,
      runtimeTeamSnapshot,
      preserveExplicitAgent: Boolean(parseRequestedAgentId(msg)),
    });
    const contractSafe = sanitizeExecutablePlan({
      plan: routeAligned.plan,
      runtimeSnapshot: runtimeTeamSnapshot,
    });
    return {
      reason: routeAligned.adjusted
        ? `${normalized.reason || "supervisor route"}; route_contract_ranked_agent=${routeAligned.preferred_agent_id || ''}`
        : (normalized.reason || "supervisor route"),
      route_contract: routeAligned.heuristic?.summary || routeHeuristic.summary || undefined,
      route_contract_adjusted: routeAligned.adjusted === true,
      route_contract_preferred_agent: routeAligned.preferred_agent_id || undefined,
      route_contract_adjustment_type: routeAligned.plan?.route_contract_adjustment_type || undefined,
      actions: Array.isArray(contractSafe?.plan?.actions) ? contractSafe.plan.actions : (Array.isArray(routeAligned?.plan?.actions) ? routeAligned.plan.actions : hardened),
      final_response_style: normalized.final_response_style,
      done: normalized.done === true,
      await_user: normalized.await_user === true,
      deliverables: Array.isArray(normalized.deliverables) ? normalized.deliverables : [],
      completed_deliverables: Array.isArray(normalized.completed_deliverables) ? normalized.completed_deliverables : [],
      followup_hint: String(normalized.followup_hint || (routeAligned.adjusted ? `route contract preferred ${routeAligned.preferred_agent_id || 'publisher-capable agent'} for this request` : "")).trim() || undefined,
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return fallback;
  }
}
