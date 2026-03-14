import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Jobs } from "../jobs.js";
import { Tracking } from "../tracking.js";
import { Approvals } from "../approvals.js";
import { runCommand } from "../proc.js";
import { runCodexExec } from "../codex.js";
import { runGeminiPrompt } from "../gemini.js";
import { OrchestratorMemory } from "../settings.js";
import { orchestratorNotes, buildChatGPTNextStepPrompt } from "../prompts.js";
import { clip, extractCodexInstruction, extractJsonPlan } from "../textutil.js";
import { loadAgents, getAgent } from "../agents.js";
import {
  parseAutoSuggestDecision as parseAutoSuggestDecisionShared,
  parseJsonObjectFromText as parseJsonObjectFromTextShared,
} from "../shared/json_extract.js";
import {
  parseRouterPlan as parseRouterPlanDomain,
  sanitizeSupervisorRoutePlan as sanitizeSupervisorRoutePlanDomain,
  normalizeForceMode as normalizeForceModeDomain,
} from "../domain/route_plan.js";
import {
  normalizeLensSpec as normalizeLensSpecDomain,
  defaultLensSpecForAgent as defaultLensSpecForAgentDomain,
  resolveEffectiveLensSpec as resolveEffectiveLensSpecDomain,
  dedupeNodeIds as dedupeLensNodeIds,
} from "../domain/lens.js";
import { createDefaultRunRoute } from "./orchestrator.js";
import { sendLong as sendLongAdapter } from "../adapters/telegram/send.js";
import {
  buildPendingApprovalPrompt as buildPendingApprovalPromptAdapter,
  formatChatSummary as formatChatSummaryAdapter,
} from "../adapters/telegram/formatting.js";
import {
  buildContextLinks,
  buildContextLinkButtons,
  isTelegramWebAppHttpsError,
} from "../adapters/telegram/context_links.js";
import {
  getActionGoal as getActionGoalShared,
  formatActionAgentLabel as formatActionAgentLabelShared,
  formatChatActionLabel as chatActionLabelShared,
  buildPlanPreviewLines as buildPlanPreviewLinesShared,
  buildQueuedAgentStatusFromActions as buildQueuedAgentStatusFromActionsShared,
  buildRoutedDashboardText as buildRoutedDashboardTextShared,
  inferApprovalPreviewReason as inferApprovalPreviewReasonShared,
  buildApprovalActionSummaryLines as buildApprovalActionSummaryLinesShared,
  buildAutopilotProgressSummary as buildAutopilotProgressSummaryShared,
  buildAutopilotFollowupMessage as buildAutopilotFollowupMessageShared,
  updateCompletedDeliverablesFromOutputs as updateCompletedDeliverablesFromOutputsShared,
  summarizeSpecialChatOutputs as summarizeSpecialChatOutputsShared,
  buildChatSynthesisFallback as buildChatSynthesisFallbackShared,
} from "../adapters/telegram/preview_formatting.js";
import {
  buildGeminiRetryNoticeText as buildGeminiRetryNoticeTextShared,
  buildGeminiModelSwitchNoticeText as buildGeminiModelSwitchNoticeTextShared,
  buildGeminiGiveUpNoticeText as buildGeminiGiveUpNoticeTextShared,
} from "../adapters/telegram/status_messages.js";
import { formatByteSize } from "../adapters/telegram/uploads.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./job_runtime.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { createRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { markActionsSkipped, wasInterruptedByReplan } from "./run_status_cleanup.js";
import {
  applyRunAuthority,
  buildRunAuthority,
  buildRunAuthorityPatch,
  normalizeRunAuthority,
  summarizeRunAuthorityLines,
} from "./run_authority.js";
import {
  createRuntimeComposer,
  invokeRuntimePlanner,
} from "./runtime_composer.js";
import { createSupervisorRuntimeLoader } from "./supervisor_runtime_loader.js";
import {
  isExplicitTeamConfigurationIntentMessage,
} from "./team_intent.js";
import { buildExplicitTeamReconfigurationActions } from "./team_config_diff.js";
import { normalizeAgentLookupKey } from "./logical_agents.js";
import {
  verifyConversationMembershipMutation,
  createMembershipConfirmationError,
} from "./membership_confirmation.js";
import {
  resolveConversationMembershipTarget,
  summarizeMembershipTarget,
} from "./membership_target.js";
import {
  applyConversationAgentMutation,
  runConversationAgentTeamCommand,
  summarizeMembershipMutationResponse,
  syncRuntimeConversationTeamState,
} from "./agent_team_commands.js";
import {
  createAgentProfile,
  updateAgentProfile,
  listPublicBlueprints,
  installBlueprint,
} from "../agent_registry.js";
import { GocClient } from "../goc_client.js";
import {
  ensureJobThread,
  ensureAgentsThread,
  ensureToolsThread,
  ensureGlobalThread,
  normalizeJobConfig as normalizeSupervisorJobConfig,
  appendTrackingChunkToGoc,
} from "../goc_mapping.js";
import { ChatSessionStore } from "../chat/session.js";
import { routeWithSupervisor } from "../chat/supervisor_router.js";
import { executeSupervisorActions, isMutatingAction } from "../chat/executor.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  formatChatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { normalizeActionPlan } from "../chat/actions.js";
import { expandDetailContext } from "../chat/unfold.js";
import { ChatRunManager } from "../chat/run_manager.js";
import { GocExecutionGraphRecorder } from "../chat/goc_execution_graph.js";

import * as runtimeState from "./telegram_runtime_state.js";
import * as runtimeIo from "./telegram_runtime_io.js";
import * as gocRuntime from "./telegram_goc_runtime.js";

const {
  AUTO_SUGGEST_ENABLED,
  AUTOPILOT_MAX_TURNS,
  jobs,
  tracking,
  memory,
  chatSessionStore,
  agentRegistry,
  AGENT_STATUS_MESSAGE_THROTTLE_MS,
  runWorkspaceDir,
  resolveAgentId,
  findAgentConfig,
  findAgentConfigInRuntime,
  enqueue,
} = runtimeState;
const { loadContextDocs, convoToText, sendLong } = runtimeIo;
const { composeCapabilitiesForRun, getAgentRolesText, getRegisteredAgentsText } = gocRuntime;

function parseAutoSuggestDecision(raw) {
  return parseAutoSuggestDecisionShared(raw);
}

function parseJsonObjectFromText(raw) {
  return parseJsonObjectFromTextShared(raw);
}

function parseRouterPlan(raw) {
  return parseRouterPlanDomain(raw, { resolveAgentId });
}

function getGoalFromResearch(jobId) {
  try {
    const research = tracking.read(jobId, "research.md");
    const m = research.match(/## Goal\s*\n\s*([\s\S]*?)(\n\n|\n---|$)/);
    if (m && m[1]) return m[1].trim().slice(0, 2000);
  } catch {}
  return "(unknown)";
}

function defaultRouteFor(mode, goal, seedInstruction = "") {
  return createDefaultRunRoute(mode, goal, seedInstruction);
}

async function decideRunRoute(jobId, { mode, goal, seedInstruction = "", signal = null }) {
  const docs = await loadContextDocs(jobId, ["research.md", "plan.md", "progress.md", "decisions.md"], 2200);
  const convo = clip(convoToText(jobs.tailConversation(jobId, 50)), 4200);
  const routerPrompt = memory.getRouterPrompt();
  const roleText = getAgentRolesText();
  const registryText = await getRegisteredAgentsText();

  const prompt = [
    "너는 오케스트레이터의 Multi-Agent 라우터다.",
    "목표를 가장 빠르고 안전하게 달성하기 위해 필요한 에이전트만 선택하고 순서를 정해라.",
    "반드시 JSON 객체 하나만 출력해라. JSON 외 텍스트 금지.",
    "",
    "출력 JSON 스키마:",
    "{",
    "  \"reason\": \"한 줄 이유\",",
    "  \"actions\": [",
    "    {\"type\":\"agent_run\", \"agent\":\"researcher\", \"prompt\":\"...\", \"inputs\":{}},",
    "    {\"type\":\"agent_run\", \"agent\":\"coder\", \"prompt\":\"...\", \"inputs\":{}},",
    "    {\"type\":\"chatgpt_prompt\", \"question\":\"...\"},",
    "    {\"type\":\"git_summary\"}",
    "  ]",
    "}",
    "",
    "규칙:",
    "- 중복 작업 금지. 같은 분석/계획/구현을 반복 배정하지 말 것.",
    "- 필요한 최소 액션만 포함.",
    "- action은 최대 4개.",
    "",
    `mode=${mode}`,
    `goal=${goal}`,
    `seedInstruction=${seedInstruction || "(none)"}`,
    "",
    "라우팅 기준 메모리:",
    routerPrompt,
    "",
    "에이전트 역할 메모리:",
    roleText,
    "",
    "에이전트 레지스트리:",
    registryText,
    "",
    "shared docs:",
    docs,
    "",
    "recent conversation:",
    convo,
  ].join("\n");

  const runtimeAuthority = normalizeRunAuthority(
    composeCapabilitiesForRun({ jobId }).authority
  );

  try {
    const r = await enqueue(
      () => runGeminiPrompt({
        workspaceRoot: runWorkspaceDir(jobId),
        cwd: runWorkspaceDir(jobId),
        prompt,
        signal,
        concurrencyKey: `job:${String(jobId || "").trim()}`,
        jobId,
      }),
      { jobId, signal, label: "agent_router" }
    );
    const out = (r.stdout || r.stderr || "").trim();
    const planned = r.ok ? parseRouterPlan(out) : null;
    const fallbackRoute = defaultRouteFor(mode, goal, seedInstruction);
    const planningResult = await invokeRuntimePlanner({
      composeForRun: composeCapabilitiesForRun,
      jobId,
      mode,
      goal,
      seedInstruction,
      routePlan: planned || null,
      registry: agentRegistry,
      preferredRoles: [],
      maxAgents: 6,
      resolveAgentId,
      runsDir: jobs.runsDir,
      persistSkillEvents: true,
    });
    const planSource = String(planningResult?.plan_source || runtimeAuthority?.plan_source || "local").trim().toLowerCase() || "local";
    const routePlan = planningResult?.route_plan && typeof planningResult.route_plan === "object"
      ? planningResult.route_plan
      : {};
    return {
      actions: Array.isArray(routePlan?.actions) && routePlan.actions.length > 0
        ? routePlan.actions
        : fallbackRoute.actions,
      reason: String(routePlan?.reason || planned?.reason || fallbackRoute.reason || "router route").trim(),
      action_source: String(routePlan?.action_source || "default_fallback_route").trim(),
      ...buildRunAuthorityPatch(
        { runtime_authority: runtimeAuthority },
        { plan_source: planSource }
      ),
      team_plan: planningResult?.team_plan || null,
      runtime_agents: planningResult?.runtime_agents || [],
      runtime_team_snapshot: planningResult?.runtime_team_snapshot || null,
    };
  } catch {
    const fallbackRoute = defaultRouteFor(mode, goal, seedInstruction);
    const planningResult = await invokeRuntimePlanner({
      composeForRun: composeCapabilitiesForRun,
      jobId,
      mode,
      goal,
      seedInstruction,
      routePlan: null,
      registry: agentRegistry,
      preferredRoles: [],
      maxAgents: 6,
      resolveAgentId,
      runsDir: jobs.runsDir,
      persistSkillEvents: true,
    });
    const routePlan = planningResult?.route_plan && typeof planningResult.route_plan === "object"
      ? planningResult.route_plan
      : {};
    const planSourceBase = String(planningResult?.plan_source || runtimeAuthority?.plan_source || "local").trim().toLowerCase();
    const planSource = planSourceBase === "goc" ? "local_fallback" : (planSourceBase || "local");
    return {
      actions: Array.isArray(routePlan?.actions) && routePlan.actions.length > 0
        ? routePlan.actions
        : fallbackRoute.actions,
      reason: String(routePlan?.reason || fallbackRoute.reason || "router fallback").trim(),
      action_source: String(routePlan?.action_source || "default_fallback_route").trim(),
      ...buildRunAuthorityPatch(
        { runtime_authority: runtimeAuthority },
        { plan_source: planSource }
      ),
      team_plan: planningResult?.team_plan || null,
      runtime_agents: planningResult?.runtime_agents || [],
      runtime_team_snapshot: planningResult?.runtime_team_snapshot || null,
    };
  }
}

async function reflectAutoSuggest(jobId, trigger, question, signal = null) {
  if (!AUTO_SUGGEST_ENABLED) {
    return { shouldAsk: false, reason: "AUTO_SUGGEST_GPT_PROMPT=false" };
  }

  const goal = getGoalFromResearch(jobId);
  const docs = await loadContextDocs(jobId, ["research.md", "plan.md", "progress.md", "decisions.md"], 2200);
  const convo = clip(convoToText(jobs.tailConversation(jobId, 50)), 5000);
  const policyPrompt = memory.getPolicyPrompt();

  const prompt = [
    "너는 Telegram 오케스트레이터의 '자체 반성 판단기'다.",
    "지금 이 시점에 ChatGPT에게 다음 단계 질문 프롬프트를 자동 생성할지 판단해라.",
    "반드시 JSON 객체 하나만 출력해라. JSON 외 텍스트 금지.",
    "",
    "출력 JSON 스키마:",
    "{",
    "  \"shouldAskChatGPT\": true|false,",
    "  \"reason\": \"짧은 한 줄 이유\",",
    "  \"signals\": [\"looping\"|\"complexity\"|\"needs_review\"|\"blocked\"|\"none\"],",
    "  \"confidence\": 0-100",
    "}",
    "",
    "판단 기준(운영자 메모리 프롬프트):",
    policyPrompt,
    "",
    `trigger=${trigger}`,
    `question=${question}`,
    `goal=${goal}`,
    "",
    "shared docs:",
    docs,
    "",
    "recent conversation:",
    convo,
  ].join("\n");

  try {
    const r = await enqueue(
      () => runGeminiPrompt({
        workspaceRoot: runWorkspaceDir(jobId),
        cwd: runWorkspaceDir(jobId),
        prompt,
        signal,
        concurrencyKey: `job:${String(jobId || "").trim()}`,
        jobId,
      }),
      { jobId, signal, label: "auto_reflection" }
    );
    const out = (r.stdout || r.stderr || "").trim();
    if (!r.ok) return { shouldAsk: false, reason: clip(`reflection failed: ${out}`, 300) };

    const parsed = parseAutoSuggestDecision(out);
    const rawShouldAsk = parsed?.shouldAskChatGPT;
    const shouldAsk = typeof rawShouldAsk === "boolean"
      ? rawShouldAsk
      : (["true", "1", "yes"].includes(String(rawShouldAsk).trim().toLowerCase()) ? true
        : (["false", "0", "no"].includes(String(rawShouldAsk).trim().toLowerCase()) ? false : null));
    if (!parsed || shouldAsk === null) {
      return { shouldAsk: false, reason: "reflection output parse failed" };
    }

    const signals = Array.isArray(parsed.signals) ? parsed.signals.map(v => String(v)) : [];
    return {
      shouldAsk,
      reason: String(parsed.reason || "").trim() || "(no reason)",
      signals,
      confidence: Number.isFinite(Number(parsed.confidence)) ? Number(parsed.confidence) : null,
    };
  } catch (e) {
    return { shouldAsk: false, reason: `reflection exception: ${String(e?.message ?? e)}` };
  }
}

async function suggestNextPrompt(bot, chatId, jobId, question, trigger = "run", signal = null) {
  const decision = await reflectAutoSuggest(jobId, trigger, question, signal);
  try {
    const signals = Array.isArray(decision.signals) && decision.signals.length > 0 ? decision.signals.join(", ") : "none";
    const confidence = Number.isFinite(Number(decision.confidence)) ? Number(decision.confidence) : "n/a";
    tracking.append(jobId, "decisions.md", [
      "## Auto-suggest reflection",
      `- trigger: ${trigger}`,
      `- shouldAskChatGPT: ${decision.shouldAsk}`,
      `- confidence: ${confidence}`,
      `- signals: ${signals}`,
      `- reason: ${decision.reason || "(no reason)"}`,
    ].join("\n"));
  } catch {}
  if (!decision.shouldAsk) return;

  await sendChatGPTPrompt(bot, chatId, jobId, question);
}

async function sendChatGPTPrompt(bot, chatId, jobId, question) {
  const goal = getGoalFromResearch(jobId);
  const docs = await loadContextDocs(jobId, ["research.md", "plan.md", "progress.md"], 3000);
  const convo = jobs.tailConversation(jobId, 60);
  const prompt = buildChatGPTNextStepPrompt({
    jobId,
    goal,
    question,
    contextDocsText: docs,
    convoText: convoToText(convo),
    routerPrompt: memory.getRouterPrompt(),
    agentRolesText: getAgentRolesText(),
  });
  await bot.sendMessage(
    chatId,
    "🧩 다음 단계 결정을 위해 ChatGPT 프롬프트를 생성했어요.\n답변을 받은 뒤 아래 버튼으로 붙여넣기 모드를 시작하세요.",
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "🟣 답변 붙여넣기 시작", callback_data: `gptapply:${jobId}` },
        ]],
      },
    }
  );
  await sendLong(bot, chatId, prompt);
}

function normalizeActionShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  const type = String(raw.type || "").trim().toLowerCase();
  if (!type) return null;

  if (type === "agent_run") {
    const agent = resolveAgentId(raw.agent || raw.agentId || "");
    const prompt = String(raw.prompt || raw.task || raw.instruction || "").trim();
    if (!agent || !prompt) return null;
    return {
      type: "agent_run",
      agent,
      prompt,
      inputs: raw.inputs && typeof raw.inputs === "object" ? raw.inputs : {},
    };
  }
  if (type === "gemini" || type === "gemini_research") {
    const prompt = String(raw.prompt || raw.query || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "researcher", prompt, inputs: {} };
  }
  if (type === "codex" || type === "codex_implement") {
    const prompt = String(raw.instruction || raw.prompt || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "coder", prompt, inputs: {} };
  }
  if (type === "chatgpt_prompt") {
    const question = String(raw.question || raw.prompt || raw.task || "").trim();
    if (!question) return null;
    return { type: "chatgpt_prompt", question };
  }
  if (type === "chatgpt") {
    const prompt = String(raw.question || raw.prompt || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "planner", prompt, inputs: {} };
  }
  if (type === "track_append") {
    return { type: "track_append", doc: raw.doc || "plan.md", markdown: String(raw.markdown || "") };
  }
  if (type === "git_summary") return { type: "git_summary" };
  if (type === "commit_request") {
    const message = String(raw.message || "").trim();
    if (!message) return null;
    return { type: "commit_request", message };
  }
  return null;
}

function actionLabel(act) {
  if (!act || !act.type) return "(unknown)";
  const globalAgentIndex = buildAgentDisplayIndexShared(agentRegistry);
  if (act.type === "agent_run") {
    const agentDisplay = formatChatAgentDisplayName(act.agent, globalAgentIndex);
    return `agent_run:${agentDisplay}`;
  }
  if (act.type === "chatgpt_prompt") return "chatgpt_prompt";
  if (act.type === "track_append") return `track_append:${act.doc || "plan.md"}`;
  return String(act.type);
}

function formatRegistryLines(reg) {
  return [
    `registry=${reg.path}`,
    `source=${reg.source || "local"}`,
    ...(reg.threadId ? [`thread=${reg.threadId}`] : []),
    ...(reg.ctxId ? [`ctx=${reg.ctxId}`] : []),
    "",
    ...reg.agents.map((row) => `- ${row.id}: provider=${row.provider}, model=${row.model}${row.description ? `, ${row.description}` : ""}`),
  ].join("\n");
}

function formatActionAgentLabel(action = {}, { agentIndex = null } = {}) {
  const resolvedIndex = agentIndex instanceof Map
    ? agentIndex
    : buildAgentDisplayIndexShared(agentRegistry);
  return formatActionAgentLabelShared(action, {
    agentIndex: resolvedIndex,
    fallback: "unknown",
  });
}

function chatActionLabel(action, { agentIndex = null } = {}) {
  const resolvedIndex = agentIndex instanceof Map
    ? agentIndex
    : buildAgentDisplayIndexShared(agentRegistry);
  return chatActionLabelShared(action, {
    agentIndex: resolvedIndex,
    needMoreDetailFallback: "ctx",
    publishFallbackMode: "unknown",
    openContextFallback: "current",
  });
}

const READ_ONLY_CONTROL_ACTION_TYPES = new Set([
  "open_context",
  "list_agents",
  "list_tools",
  "get_status",
]);

function normalizeForceMode(raw) {
  return normalizeForceModeDomain(raw);
}

function isWorkLikeMessage(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return /만들어|작성|구현|조사|정리|설계|개발|수정|분석|리팩터|코드|work|task|implement|research|design|plan/i.test(text);
}

function isCodeNotebookRequest(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return false;
  return /코드|ipynb|notebook|노트북|실습|코딩|python|주피터|jupyter|스크립트/i.test(text);
}

function isReadOnlyControlAction(action) {
  const type = String(action?.type || "").trim().toLowerCase();
  return READ_ONLY_CONTROL_ACTION_TYPES.has(type);
}

function pickRuntimeDefaultAgentId(agents = []) {
  const rows = Array.isArray(agents) ? agents : [];
  const gemini = rows.find((row) => String(row?.provider || "").trim().toLowerCase() === "gemini");
  if (gemini?.id) return String(gemini.id).trim().toLowerCase();
  const nonChatgpt = rows.find((row) => String(row?.provider || "").trim().toLowerCase() !== "chatgpt");
  if (nonChatgpt?.id) return String(nonChatgpt.id).trim().toLowerCase();
  const first = rows.find((row) => String(row?.id || "").trim());
  return first?.id ? String(first.id).trim().toLowerCase() : "";
}

function getActionGoal(action) {
  return getActionGoalShared(action);
}

function pickCoderAgentId(agents = []) {
  const rows = Array.isArray(agents) ? agents : [];
  const byId = rows.find((row) => String(row?.id || "").trim().toLowerCase() === "coder");
  if (byId?.id) return String(byId.id).trim().toLowerCase();
  const codex = rows.find((row) => String(row?.provider || "").trim().toLowerCase() === "codex");
  if (codex?.id) return String(codex.id).trim().toLowerCase();
  const hinted = rows.find((row) => /code|coder|dev/i.test(String(row?.id || "").trim().toLowerCase()));
  if (hinted?.id) return String(hinted.id).trim().toLowerCase();
  return "";
}

function normalizeStringList(raw, { max = 24 } = {}) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = String(row || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Math.floor(max))) break;
  }
  return out;
}

function extractDeliverablesFromMessage(message = "") {
  const text = String(message || "");
  const lower = text.toLowerCase();
  const out = [];
  if (/주제|아이디어|토픽|topic|proposal|제안/i.test(lower)) out.push("주제 제안");
  if (/ipynb|notebook|노트북|jupyter|코드|실습|구현|coding|python/i.test(lower)) out.push("코드/노트북 산출물");
  if (/과제|assignment|문제|quiz|연습문제/i.test(lower)) out.push("과제/문항");
  if (out.length === 0 && text.trim()) out.push(clip(text.trim(), 120));
  return normalizeStringList(out, { max: 12 });
}

function hasCoderDelegation(actions = [], coderAgentId = "") {
  const rows = Array.isArray(actions) ? actions : [];
  const target = String(coderAgentId || "").trim().toLowerCase();
  for (const action of rows) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const agentId = String(action?.agent_id || action?.agent || "").trim().toLowerCase();
      if (agentId && (agentId === target || (!target && agentId === "coder"))) return true;
      continue;
    }
    if (type !== "spawn_agents") continue;
    const children = Array.isArray(action?.agents) ? action.agents : [];
    for (const child of children) {
      const agentId = String(child?.agent_id || child?.agent || "").trim().toLowerCase();
      if (agentId && (agentId === target || (!target && agentId === "coder"))) return true;
    }
  }
  return false;
}

function buildPlanPreviewLines(actions = []) {
  return buildPlanPreviewLinesShared(actions, {
    agentIndex: buildAgentDisplayIndexShared(agentRegistry),
    actionLabel: (action) => chatActionLabel(action),
  });
}

function buildQueuedAgentStatusFromActions(actions = []) {
  return buildQueuedAgentStatusFromActionsShared(actions);
}

function buildRoutedDashboardText({ actions = [], agentStatus = {} } = {}) {
  return buildRoutedDashboardTextShared({
    actions,
    agentStatus,
    actionLabel: (action) => chatActionLabel(action),
    agentIndex: buildAgentDisplayIndexShared(agentRegistry),
  });
}

function getCurrentTurnReplyMessageId(chatId) {
  const session = chatSessionStore.get(chatId);
  const planMessageId = Number(session?.current_turn_plan_message_id || 0);
  if (Number.isFinite(planMessageId) && planMessageId > 0) return planMessageId;
  const ackMessageId = Number(session?.current_turn_ack_message_id || 0);
  if (Number.isFinite(ackMessageId) && ackMessageId > 0) return ackMessageId;
  return null;
}

async function sendRouterAckMessage(bot, chatId, { replyToMessageId = null } = {}) {
  const sent = await bot.sendMessage(
    chatId,
    "👀 접수했어요. 라우팅/분담 중…",
    Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
      ? { reply_to_message_id: Number(replyToMessageId) }
      : undefined
  );
  const messageId = Number(sent?.message_id || 0);
  chatSessionStore.upsert(chatId, {
    current_turn_ack_message_id: messageId > 0 ? messageId : null,
    current_turn_plan_message_id: null,
  });
  return messageId > 0 ? messageId : null;
}

async function sendPlanPreviewMessage(bot, chatId, { actions = [], replyToMessageId = null } = {}) {
  const agentStatus = buildQueuedAgentStatusFromActions(actions);
  const text = buildRoutedDashboardText({
    actions,
    agentStatus,
  });
  const sent = await bot.sendMessage(
    chatId,
    text || "🧭 분담\n- (system) no actions",
    Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
      ? { reply_to_message_id: Number(replyToMessageId) }
      : undefined
  );
  const messageId = Number(sent?.message_id || 0);
  chatSessionStore.upsert(chatId, {
    current_turn_plan_message_id: messageId > 0 ? messageId : null,
  });
  return messageId > 0 ? messageId : null;
}

function shouldSendAgentStatusMessage(chatId, agentId, state) {
  const key = String(chatId || "");
  if (!agentStatusMessageStateByChat.has(key)) {
    agentStatusMessageStateByChat.set(key, new Map());
  }
  const perChat = agentStatusMessageStateByChat.get(key);
  const agentKey = String(agentId || "").trim().toLowerCase();
  const cleanState = String(state || "").trim().toLowerCase();
  const nowMs = Date.now();
  const prev = perChat.get(agentKey) || null;
  if (prev && prev.state === cleanState && (nowMs - Number(prev.atMs || 0)) < AGENT_STATUS_MESSAGE_THROTTLE_MS) {
    return false;
  }
  perChat.set(agentKey, { state: cleanState, atMs: nowMs });
  return true;
}

function buildAgentTransitionText({ agentId = "", state = "", goal = "", error = "" } = {}) {
  const cleanAgentId = String(agentId || "").trim().toLowerCase() || "unknown";
  const agentDisplay = formatChatAgentDisplayName(
    cleanAgentId,
    buildAgentDisplayIndexShared(agentRegistry)
  );
  const cleanState = String(state || "").trim().toLowerCase();
  if (cleanState === "running") {
    return `▶️ ${agentDisplay} 시작: ${clip(String(goal || "").trim() || "(goal 없음)", 240)}`;
  }
  if (cleanState === "done") {
    return `✅ ${agentDisplay} 완료`;
  }
  if (cleanState === "error") {
    return `❌ ${agentDisplay} 실패: ${clip(String(error || "unknown error"), 240)}`;
  }
  return `ℹ️ ${agentDisplay} 상태: ${cleanState || "queued"}`;
}

async function sendAgentStatusTransitionMessage(
  bot,
  chatId,
  {
    agentId = "",
    state = "",
    goal = "",
    error = "",
    replyToMessageId = null,
  } = {}
) {
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  const cleanState = String(state || "").trim().toLowerCase();
  if (!cleanAgentId || !cleanState) return;
  if (!["running", "done", "error"].includes(cleanState)) return;
  if (!shouldSendAgentStatusMessage(chatId, cleanAgentId, cleanState)) return;

  const fallbackReply = getCurrentTurnReplyMessageId(chatId);
  const replyId = Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
    ? Number(replyToMessageId)
    : (Number.isFinite(Number(fallbackReply)) && Number(fallbackReply) > 0 ? Number(fallbackReply) : null);
  await bot.sendMessage(
    chatId,
    buildAgentTransitionText({
      agentId: cleanAgentId,
      state: cleanState,
      goal,
      error,
    }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

async function sendGeminiRetryMessage(
  bot,
  chatId,
  {
    retryCount = 0,
    maxRetries = 0,
    agentId = "",
    replyToMessageId = null,
  } = {}
) {
  const fallbackReply = getCurrentTurnReplyMessageId(chatId);
  const replyId = Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
    ? Number(replyToMessageId)
    : (Number.isFinite(Number(fallbackReply)) && Number(fallbackReply) > 0 ? Number(fallbackReply) : null);
  const agentLabel = agentId
    ? formatChatAgentDisplayName(agentId, buildAgentDisplayIndexShared(agentRegistry))
    : "";
  await bot.sendMessage(
    chatId,
    buildGeminiRetryNoticeTextShared({ retryCount, maxRetries, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

async function sendGeminiModelSwitchMessage(
  bot,
  chatId,
  {
    toModel = "",
    agentId = "",
    replyToMessageId = null,
  } = {}
) {
  const fallbackReply = getCurrentTurnReplyMessageId(chatId);
  const replyId = Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
    ? Number(replyToMessageId)
    : (Number.isFinite(Number(fallbackReply)) && Number(fallbackReply) > 0 ? Number(fallbackReply) : null);
  const agentLabel = agentId
    ? formatChatAgentDisplayName(agentId, buildAgentDisplayIndexShared(agentRegistry))
    : "";
  await bot.sendMessage(
    chatId,
    buildGeminiModelSwitchNoticeTextShared({ toModel, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

async function sendGeminiGiveUpMessage(
  bot,
  chatId,
  {
    reason = "",
    agentId = "",
    replyToMessageId = null,
  } = {}
) {
  const fallbackReply = getCurrentTurnReplyMessageId(chatId);
  const replyId = Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
    ? Number(replyToMessageId)
    : (Number.isFinite(Number(fallbackReply)) && Number(fallbackReply) > 0 ? Number(fallbackReply) : null);
  const agentLabel = agentId
    ? formatChatAgentDisplayName(agentId, buildAgentDisplayIndexShared(agentRegistry))
    : "";
  await bot.sendMessage(
    chatId,
    buildGeminiGiveUpNoticeTextShared({ reason, agentId, agentLabel }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

function updateAgentStatus(chatId, agentId, patch = {}) {
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  if (!cleanAgentId) return { changed: false, previousState: "", nextState: "" };
  let previousState = "";
  let nextState = "";
  chatSessionStore.upsert(chatId, (session) => {
    const currentMap = session?.agent_status && typeof session.agent_status === "object"
      ? session.agent_status
      : {};
    const previous = currentMap[cleanAgentId] && typeof currentMap[cleanAgentId] === "object"
      ? currentMap[cleanAgentId]
      : {};
    previousState = String(previous.state || "").trim().toLowerCase();
    const nextRow = {
      ...previous,
      ...patch,
    };
    if (!nextRow.goal && previous.goal) nextRow.goal = previous.goal;
    nextState = String(nextRow.state || "").trim().toLowerCase();
    return {
      ...session,
      agent_status: {
        ...currentMap,
        [cleanAgentId]: nextRow,
      },
    };
  });
  return {
    changed: previousState !== nextState,
    previousState,
    nextState,
  };
}

function toolInputPreviewFromAction(action, detailContext = "") {
  const type = String(action?.type || "").trim().toLowerCase();
  const lines = [
    `type=${type || "unknown"}`,
  ];
  if (action?.agent_id) lines.push(`agent_id=${String(action.agent_id).trim().toLowerCase()}`);
  if (action?.goal) lines.push(`goal=${clip(String(action.goal), 400)}`);
  if (type === "spawn_agents") {
    const children = Array.isArray(action?.agents) ? action.agents : [];
    if (children.length > 0) {
      lines.push(`children=${children.map((row) => `@${String(row?.agent_id || "").trim().toLowerCase()}`).filter(Boolean).join(", ")}`);
    }
  }
  if (type === "need_more_detail") {
    lines.push(`context_set_id=${String(action?.context_set_id || "").trim() || "(shared)"}`);
  }
  const detail = String(detailContext || "").trim();
  if (detail) lines.push(`detail_context=${clip(detail, 220)}`);
  return lines.join("\n");
}

function outputPreviewFromResult(result) {
  if (typeof result === "string") return clip(result, 1800);
  if (result == null) return "";
  if (typeof result === "number" || typeof result === "boolean") return String(result);
  if (Array.isArray(result)) return clip(JSON.stringify(result), 1800);
  const row = result && typeof result === "object" ? result : {};
  const direct = String(
    row.output
    || row.text
    || row.summary
    || row.link
    || row.message
    || ""
  ).trim();
  if (direct) return clip(direct, 1800);
  try {
    return clip(JSON.stringify(row), 1800);
  } catch {
    return clip(String(row), 1800);
  }
}

function normalizeDeliverableList(raw, { max = 24 } = {}) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const text = String(row || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= Math.max(1, Math.floor(max))) break;
  }
  return out;
}

function extractJsonAfterLabelBlock(text = "", label = "NEXT_ACTIONS_JSON") {
  const src = String(text || "");
  if (!src) return null;
  const regexes = [
    new RegExp(`${label}\\s*[:：]?\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\\`\\\`\\\``, "i"),
    new RegExp(`${label}\\s*[:：]?\\s*\\\`\\\`\\\`\\s*([\\s\\S]*?)\\\`\\\`\\\``, "i"),
    new RegExp(`${label}\\s*[:：]?\\s*(\\{[\\s\\S]*\\}|\\[[\\s\\S]*\\])`, "i"),
  ];
  for (const re of regexes) {
    const match = src.match(re);
    if (!match?.[1]) continue;
    const candidate = String(match[1] || "").trim();
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  return null;
}

function parseSuggestedActionsFromAgentOutput(text = "", { maxActions = 4 } = {}) {
  const parsed = extractJsonAfterLabelBlock(text, "NEXT_ACTIONS_JSON");
  if (!parsed || typeof parsed !== "object") return [];
  const planLike = Array.isArray(parsed)
    ? { actions: parsed }
    : parsed;
  const normalized = normalizeActionPlan(planLike, { maxActions: Math.max(1, Math.floor(maxActions)) });
  return Array.isArray(normalized?.actions) ? normalized.actions : [];
}

function actionSignature(action = {}) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) return "";
  if (type === "run_agent") {
    return `${type}:${String(action?.agent_id || "").trim().toLowerCase()}:${clip(getActionGoal(action), 160)}`;
  }
  if (type === "spawn_agents") {
    const ids = (Array.isArray(action?.agents) ? action.agents : [])
      .map((row) => String(row?.agent_id || "").trim().toLowerCase())
      .filter(Boolean)
      .join(",");
    return `${type}:${ids}:${clip(String(action?.summary || ""), 120)}`;
  }
  return `${type}:${clip(JSON.stringify(action || {}), 180)}`;
}

function mergeSuggestedActions(base = [], incoming = [], { max = 16 } = {}) {
  const rows = [...(Array.isArray(base) ? base : []), ...(Array.isArray(incoming) ? incoming : [])];
  const out = [];
  const seen = new Set();
  for (const action of rows) {
    if (!action || typeof action !== "object") continue;
    const sig = actionSignature(action);
    if (!sig || seen.has(sig)) continue;
    seen.add(sig);
    out.push(action);
    if (out.length >= Math.max(1, Math.floor(max))) break;
  }
  return out;
}

function collectSuggestedActionsFromOutputs(outputs = []) {
  const rows = Array.isArray(outputs) ? outputs : [];
  const out = [];
  for (const row of rows) {
    const text = String(row?.output || "").trim();
    if (!text) continue;
    const suggested = parseSuggestedActionsFromAgentOutput(text, { maxActions: 4 });
    if (suggested.length === 0) continue;
    out.push(...suggested);
    if (out.length >= 12) break;
  }
  return out.slice(0, 12);
}

function buildAutopilotProgressSummary({
  turn = 1,
  maxTurns = AUTOPILOT_MAX_TURNS,
  deliverables = [],
  completedDeliverables = [],
  results = [],
  outputs = [],
  suggestedActions = [],
  followupHint = "",
} = {}) {
  return buildAutopilotProgressSummaryShared({
    turn,
    maxTurns,
    deliverables,
    completedDeliverables,
    results,
    outputs,
    suggestedActions,
    followupHint,
    actionLabel: (action) => chatActionLabel(action),
  });
}

function buildAutopilotFollowupMessage({
  originalUserText = "",
  deliverables = [],
  completedDeliverables = [],
  followupHint = "",
  suggestedActions = [],
} = {}) {
  return buildAutopilotFollowupMessageShared({
    originalUserText,
    deliverables,
    completedDeliverables,
    followupHint,
    suggestedActions,
    actionLabel: (action) => chatActionLabel(action),
  });
}

function updateCompletedDeliverablesFromOutputs(deliverables = [], completed = [], outputs = []) {
  return updateCompletedDeliverablesFromOutputsShared(deliverables, completed, outputs);
}

function sanitizeSupervisorRoutePlan(
  routePlan,
  {
    message = "",
    agents = [],
    allowReadOnlyControl = false,
    forceMode = "normal",
  } = {}
) {
  return sanitizeSupervisorRoutePlanDomain(routePlan, {
    message,
    agents,
    allowReadOnlyControl,
    forceMode,
    isReadOnlyControlAction,
    isMutatingAction,
    isWorkLikeMessage,
    isCodeNotebookRequest,
    pickRuntimeDefaultAgentId,
    findDefaultChatAgentId,
    pickCoderAgentId,
    hasCoderDelegation,
    extractDeliverablesFromMessage,
  });
}

const AGENT_DEDUPE_STOPWORDS = new Set([
  "agent",
  "agents",
  "에이전트",
  "please",
  "the",
  "and",
  "with",
  "from",
  "that",
  "this",
  "for",
  "into",
  "about",
  "요청",
  "작업",
  "해줘",
  "해주세요",
]);

function tokenizeAgentDedupeText(text, { maxTokens = 120 } = {}) {
  const tokens = String(text || "").toLowerCase().match(/[a-z0-9가-힣_]{2,}/g) || [];
  const out = [];
  const seen = new Set();
  for (const token of tokens) {
    if (!token || AGENT_DEDUPE_STOPWORDS.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= Math.max(16, Math.floor(maxTokens))) break;
  }
  return out;
}

function extractProposalActionProfile(action = {}) {
  const type = String(action?.type || "").trim().toLowerCase();
  const spec = type === "create_agent_definition" && action?.agent_spec && typeof action.agent_spec === "object"
    ? action.agent_spec
    : {};
  const id = String(
    action?.agent_id
    || action?.agentId
    || spec?.id
    || spec?.agent_id
    || ""
  ).trim().toLowerCase();
  const name = String(action?.name || spec?.name || "").trim();
  const description = String(action?.description || spec?.description || "").trim();
  const prompt = String(
    action?.prompt
    || spec?.prompt
    || spec?.system_prompt
    || spec?.systemPrompt
    || spec?.instruction
    || ""
  ).trim();
  const clippedPrompt = clip(prompt, 1400);
  const lookupKeys = [
    normalizeAgentLookupKey(id),
    normalizeAgentLookupKey(name),
  ].filter(Boolean);
  const text = [id, name, description, clippedPrompt].filter(Boolean).join("\n");
  const tokenSet = new Set(tokenizeAgentDedupeText(text));
  return {
    id,
    name,
    description,
    prompt,
    lookupKeys,
    tokenSet,
  };
}

function buildCatalogAgentSimilarityView(agent = {}) {
  const id = String(agent?.id || "").trim().toLowerCase();
  if (!id) return null;
  const systemKey = String(agent?.system_key || agent?.systemKey || "").trim().toLowerCase();
  const name = String(agent?.name || "").trim();
  const description = clip(String(agent?.description || "").trim(), 320);
  const prompt = String(
    agent?.prompt
    || agent?.system_prompt
    || agent?.systemPrompt
    || agent?.instruction
    || ""
  ).trim();
  const clippedPrompt = clip(prompt, 1400);
  const lookupKeys = [
    normalizeAgentLookupKey(id),
    normalizeAgentLookupKey(systemKey),
    normalizeAgentLookupKey(name),
  ].filter(Boolean);
  const text = [id, systemKey, name, description, clippedPrompt].filter(Boolean).join("\n");
  const tokenSet = new Set(tokenizeAgentDedupeText(text));
  return {
    agent,
    id,
    systemKey,
    lookupKeys,
    tokenSet,
  };
}

function overlapCount(setA, setB) {
  let count = 0;
  for (const token of setA) {
    if (setB.has(token)) count += 1;
  }
  return count;
}

function findBestCatalogAgentForProposal(action, agentsCatalog = []) {
  const rows = Array.isArray(agentsCatalog) ? agentsCatalog : [];
  if (rows.length === 0) return null;
  const actionView = extractProposalActionProfile(action);
  if (actionView.lookupKeys.length === 0 && actionView.tokenSet.size === 0) return null;
  const catalogViews = rows.map((row) => buildCatalogAgentSimilarityView(row)).filter(Boolean);

  if (actionView.lookupKeys.length > 0) {
    for (const view of catalogViews) {
      if (actionView.lookupKeys.some((key) => view.lookupKeys.includes(key))) {
        return {
          agent: view.agent,
          id: view.id,
          reason: "exact",
          overlap: 0,
          ratio: 1,
        };
      }
    }
  }

  if (actionView.tokenSet.size < 5) return null;

  let best = null;
  for (const view of catalogViews) {
    if (view.tokenSet.size === 0) continue;
    const overlap = overlapCount(actionView.tokenSet, view.tokenSet);
    if (overlap < 5) continue;
    const ratio = overlap / Math.max(1, Math.min(actionView.tokenSet.size, view.tokenSet.size));
    if (ratio < 0.6) continue;
    if (!best || ratio > best.ratio || (ratio === best.ratio && overlap > best.overlap)) {
      best = {
        agent: view.agent,
        id: view.id,
        reason: "overlap",
        overlap,
        ratio,
      };
    }
  }
  return best;
}

function buildConversationAgentEnabledMap(conversationAgents = []) {
  const map = new Map();
  const rows = Array.isArray(conversationAgents) ? conversationAgents : [];
  for (const row of rows) {
    const agentId = String(row?.agent_id || row?.agentId || "").trim().toLowerCase();
    if (!agentId) continue;
    const enabled = row?.enabled !== false;
    if (!map.has(agentId)) {
      map.set(agentId, enabled);
      continue;
    }
    map.set(agentId, map.get(agentId) || enabled);
  }
  return map;
}

function getConversationMembershipActionKey(action) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!["add_agent_to_conversation", "enable_agent"].includes(type)) return "";
  const agentId = String(action?.agent_id || action?.agentId || "").trim().toLowerCase();
  if (!agentId) return "";
  return `${type}:${agentId}`;
}

function isTeamCompositionIntentMessage(taskText = "") {
  return isExplicitTeamConfigurationIntentMessage(taskText);
}

function buildAgentSearchText(agent = {}) {
  const row = agent && typeof agent === "object" ? agent : {};
  return [
    row.id,
    row.system_key,
    row.systemKey,
    row.name,
    row.description,
    row.prompt,
    row.system_prompt,
    row.systemPrompt,
    row.instruction,
    ...(Array.isArray(row.tools) ? row.tools : []),
  ]
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean)
    .join("\n");
}

function inferTaskCapabilityHints(taskText = "") {
  const text = String(taskText || "").toLowerCase();
  const has = (patterns = []) => patterns.some((pattern) => text.includes(pattern));
  return {
    coding: has(["code", "coding", "coder", "개발", "코드", "구현", "python", "ipynb", "노트북", "patch", "버그"]),
    research: has(["research", "리서치", "조사", "분석", "시장", "search", "자료", "탐색", "invest"]),
    browser: has(["browser", "web", "웹", "사이트", "뉴스", "크롤", "crawl"]),
    review: has(["review", "critic", "qa", "audit", "검토", "리뷰", "품질", "리스크", "검증"]),
    planning: has(["plan", "planner", "전략", "기획", "계획", "router", "orchestr"]),
  };
}

function searchVisibleAgentsForTask(taskText, runtime, { limit = 12 } = {}) {
  const maxItems = Math.max(1, Math.min(30, Number(limit) || 12));
  const query = String(taskText || "").trim().toLowerCase();
  const queryTokens = tokenizeAgentDedupeText(query, { maxTokens: 80 });
  const queryTokenSet = new Set(queryTokens);
  const hints = inferTaskCapabilityHints(query);
  const catalogRows = Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : [];
  const enabledRows = Array.isArray(runtime?.agents) ? runtime.agents : [];
  const conversationEnabledMap = buildConversationAgentEnabledMap(runtime?.conversationAgents || []);
  const enabledSet = new Set(
    (Array.isArray(runtime?.enabledAgentIds) ? runtime.enabledAgentIds : [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const poolById = new Map();
  const addRows = (rows = []) => {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const id = String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase();
      if (!id) continue;
      if (!poolById.has(id)) {
        poolById.set(id, row);
        continue;
      }
      const prev = poolById.get(id);
      const prevScore = buildAgentSearchText(prev).length;
      const nextScore = buildAgentSearchText(row).length;
      if (nextScore > prevScore) poolById.set(id, row);
    }
  };
  addRows(catalogRows);
  addRows(enabledRows);

  const scored = [];
  for (const [agentId, row] of poolById.entries()) {
    const provider = String(row?.provider || "gemini").trim().toLowerCase() || "gemini";
    const name = String(row?.name || row?.system_key || row?.systemKey || agentId).trim() || agentId;
    const systemKey = String(row?.system_key || row?.systemKey || "").trim().toLowerCase();
    const searchText = buildAgentSearchText(row);
    const candidateTokenSet = new Set(tokenizeAgentDedupeText(searchText, { maxTokens: 140 }));
    let overlap = 0;
    for (const token of queryTokenSet) {
      if (candidateTokenSet.has(token)) overlap += 1;
    }

    const why = [];
    let score = overlap * 2;
    if (agentId && query && query.includes(agentId)) {
      score += 10;
      why.push("id_match");
    }
    if (systemKey && query && query.includes(systemKey)) {
      score += 9;
      why.push("system_key_match");
    }
    if (name && query && query.includes(name.toLowerCase())) {
      score += 8;
      why.push("name_match");
    }
    if (overlap > 0) why.push(`token_overlap:${overlap}`);

    if (hints.coding && (provider === "codex" || /code|coder|개발|구현|python|ipynb/.test(searchText))) {
      score += 5;
      why.push("coding_fit");
    }
    if ((hints.research || hints.browser) && (/research|analyst|search|browser|조사|분석|리서치/.test(searchText) || provider === "gemini")) {
      score += 4;
      why.push("research_fit");
    }
    if (hints.review && /review|critic|qa|audit|검토|리뷰|품질/.test(searchText)) {
      score += 4;
      why.push("review_fit");
    }
    if (hints.planning && /plan|planner|router|기획|전략|계획/.test(searchText)) {
      score += 3;
      why.push("planning_fit");
    }

    const inConversation = conversationEnabledMap.has(agentId);
    const enabled = enabledSet.has(agentId) || conversationEnabledMap.get(agentId) === true;
    if (inConversation) {
      score += 6;
      why.push("in_conversation");
    }
    if (enabled) {
      score += 5;
      why.push("enabled");
    }

    scored.push({
      agent_id: agentId,
      name,
      provider,
      score,
      why: why.join(","),
      source: inConversation ? "conversation" : "catalog",
      _system_key: systemKey,
      _search_text: searchText,
      _enabled: enabled,
      _in_conversation: inConversation,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a._in_conversation !== b._in_conversation) return a._in_conversation ? -1 : 1;
    if (a._enabled !== b._enabled) return a._enabled ? -1 : 1;
    return String(a.agent_id || "").localeCompare(String(b.agent_id || ""));
  });

  return scored.slice(0, maxItems).map((row) => ({
    agent_id: row.agent_id,
    name: row.name,
    provider: row.provider,
    score: row.score,
    why: row.why || "",
    source: row.source,
  }));
}

function scoreCandidateForTeamRole(roleId, candidate = {}, runtimeAgent = {}) {
  const text = buildAgentSearchText({
    ...runtimeAgent,
    id: candidate.agent_id,
    name: candidate.name,
    provider: candidate.provider,
  });
  const provider = String(candidate.provider || runtimeAgent?.provider || "").trim().toLowerCase();
  let score = Number(candidate.score || 0) * 0.15;
  const has = (keywords = []) => keywords.some((keyword) => text.includes(keyword));
  if (roleId === "planner") {
    if (has(["planner", "plan", "router", "orchestr", "기획", "전략", "계획"])) score += 6;
    if (provider === "chatgpt") score += 1;
  } else if (roleId === "researcher") {
    if (has(["research", "analyst", "search", "browser", "조사", "분석", "리서치"])) score += 6;
    if (provider === "gemini") score += 1;
  } else if (roleId === "coder") {
    if (has(["coder", "code", "개발", "구현", "python", "ipynb"])) score += 6;
    if (provider === "codex") score += 2;
  } else if (roleId === "critic_or_reviewer") {
    if (has(["critic", "review", "qa", "audit", "검토", "리뷰", "품질", "검증"])) score += 6;
    if (provider === "chatgpt") score += 1;
  }
  return score;
}

function recommendTeamForTask(taskText, runtime) {
  const text = String(taskText || "").trim();
  const hints = inferTaskCapabilityHints(text);
  const teamIntent = isTeamCompositionIntentMessage(text);
  const candidates = searchVisibleAgentsForTask(text, runtime, { limit: 12 });
  const byId = new Map();
  for (const row of [
    ...(Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : []),
    ...(Array.isArray(runtime?.agents) ? runtime.agents : []),
  ]) {
    const id = String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, row);
  }

  const roleDefs = [
    { id: "planner", required: () => true },
    { id: "researcher", required: () => teamIntent || hints.research || hints.browser || !hints.coding },
    { id: "coder", required: () => teamIntent || hints.coding },
    { id: "critic_or_reviewer", required: () => teamIntent || hints.review },
  ];
  const selected = [];
  const selectedIds = new Set();
  const missing = [];

  for (const roleDef of roleDefs) {
    let best = null;
    for (const candidate of candidates) {
      const agentId = String(candidate.agent_id || "").trim().toLowerCase();
      if (!agentId || selectedIds.has(agentId)) continue;
      const runtimeAgent = byId.get(agentId) || {};
      const roleScore = scoreCandidateForTeamRole(roleDef.id, candidate, runtimeAgent);
      if (roleScore <= 0) continue;
      const totalScore = roleScore + Number(candidate.score || 0) * 0.1;
      if (!best || totalScore > best.totalScore) {
        best = {
          role: roleDef.id,
          agent_id: agentId,
          name: candidate.name,
          provider: candidate.provider,
          source: candidate.source,
          why: candidate.why,
          totalScore,
        };
      }
    }
    if (best) {
      selectedIds.add(best.agent_id);
      selected.push({
        role: best.role,
        agent_id: best.agent_id,
        name: best.name,
        provider: best.provider,
        source: best.source,
        why: best.why,
      });
      continue;
    }
    if (roleDef.required()) missing.push(roleDef.id);
  }

  return {
    candidates,
    selected_existing_agents: selected,
    missing_capabilities: missing,
    can_satisfy_without_creation: missing.length === 0,
    team_composition_intent: teamIntent,
  };
}

function hasCloseExistingAgentForCapability(capability = "", agentsCatalog = []) {
  const capTokens = new Set(tokenizeAgentDedupeText(String(capability || ""), { maxTokens: 24 }));
  if (capTokens.size === 0) return false;
  for (const row of (Array.isArray(agentsCatalog) ? agentsCatalog : [])) {
    const view = buildCatalogAgentSimilarityView(row);
    if (!view?.tokenSet || view.tokenSet.size === 0) continue;
    const overlap = overlapCount(capTokens, view.tokenSet);
    if (overlap >= Math.min(2, capTokens.size)) return true;
    const ratio = overlap / Math.max(1, capTokens.size);
    if (overlap >= 2 && ratio >= 0.5) return true;
  }
  return false;
}

function rewritePlanToReuseAgents(
  routePlan,
  runtime = {},
  {
    message = "",
    teamRecommendation = null,
  } = {}
) {
  if (!routePlan || typeof routePlan !== "object") return routePlan;
  const sourceActions = Array.isArray(routePlan.actions) ? routePlan.actions : [];
  if (sourceActions.length === 0) return routePlan;
  const agentsCatalog = Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : [];
  if (agentsCatalog.length === 0) return routePlan;

  const membership = buildConversationAgentEnabledMap(runtime?.conversationAgents || []);
  const existingMembershipActionKeys = new Set(
    sourceActions
      .map((action) => getConversationMembershipActionKey(action))
      .filter(Boolean)
  );
  const emittedReplacementKeys = new Set();
  const rewrittenActions = [];
  let dedupedProposals = 0;
  let droppedCreates = 0;
  let survivedCreates = 0;
  const selectedExistingIds = Array.from(new Set(
    (Array.isArray(teamRecommendation?.selected_existing_agents) ? teamRecommendation.selected_existing_agents : [])
      .map((row) => String(row?.agent_id || row?.id || "").trim().toLowerCase())
      .filter(Boolean)
  ));
  const missingCapabilities = Array.from(new Set(
    (Array.isArray(teamRecommendation?.missing_capabilities) ? teamRecommendation.missing_capabilities : [])
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  ));
  const canSatisfyWithoutCreation = teamRecommendation?.can_satisfy_without_creation === true;
  const explicitTeamConfigIntent = teamRecommendation?.team_composition_intent === true
    || isExplicitTeamConfigurationIntentMessage(message);
  const allowCreateFromMissing = (
    !canSatisfyWithoutCreation
    && missingCapabilities.length > 0
    && missingCapabilities.some((capability) => !hasCloseExistingAgentForCapability(capability, agentsCatalog))
  );

  for (const action of sourceActions) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (!["propose_agent", "create_agent_definition"].includes(type)) {
      rewrittenActions.push(action);
      continue;
    }

    const match = findBestCatalogAgentForProposal(action, agentsCatalog);
    let matchedAgentId = String(match?.id || "").trim().toLowerCase();
    if (!matchedAgentId && canSatisfyWithoutCreation && selectedExistingIds.length > 0) {
      matchedAgentId = (
        selectedExistingIds.find((id) => !membership.has(id))
        || selectedExistingIds.find((id) => membership.get(id) !== true)
        || selectedExistingIds[0]
        || ""
      );
    }
    if (!matchedAgentId) {
      if (allowCreateFromMissing) {
        rewrittenActions.push(action);
        survivedCreates += 1;
        continue;
      }
      dedupedProposals += 1;
      droppedCreates += 1;
      continue;
    }

    dedupedProposals += 1;
    const isMember = membership.has(matchedAgentId);
    const isEnabled = membership.get(matchedAgentId) === true;
    if (isMember && isEnabled) {
      continue;
    }

    const replacement = isMember
      ? {
        type: "enable_agent",
        agent_id: matchedAgentId,
        risk: "L1",
      }
      : {
        type: "add_agent_to_conversation",
        agent_id: matchedAgentId,
        enabled: true,
        risk: "L2",
      };
    const replacementKey = getConversationMembershipActionKey(replacement);
    if (
      replacementKey
      && (existingMembershipActionKeys.has(replacementKey) || emittedReplacementKeys.has(replacementKey))
    ) {
      membership.set(matchedAgentId, true);
      continue;
    }
    rewrittenActions.push(replacement);
    if (replacementKey) {
      emittedReplacementKeys.add(replacementKey);
      existingMembershipActionKeys.add(replacementKey);
    }
    membership.set(matchedAgentId, true);
  }

  const teamDiffResult = explicitTeamConfigIntent && selectedExistingIds.length > 0
    ? buildExplicitTeamReconfigurationActions({
      currentMembership: membership,
      desiredAgentIds: selectedExistingIds,
      existingActions: [...sourceActions, ...rewrittenActions],
      allowRemoval: canSatisfyWithoutCreation,
      removalMode: "remove",
    })
    : { actions: [], stats: { added: 0, enabled: 0, removed: 0, disabled: 0 } };
  const teamDiffActions = Array.isArray(teamDiffResult.actions) ? teamDiffResult.actions : [];
  const teamDiffStats = teamDiffResult.stats && typeof teamDiffResult.stats === "object"
    ? teamDiffResult.stats
    : { added: 0, enabled: 0, removed: 0, disabled: 0 };
  if (teamDiffActions.length > 0) {
    rewrittenActions.push(...teamDiffActions);
  }

  const teamDiffTotal = Number(teamDiffStats.added || 0)
    + Number(teamDiffStats.enabled || 0)
    + Number(teamDiffStats.removed || 0)
    + Number(teamDiffStats.disabled || 0);
  if (dedupedProposals <= 0 && droppedCreates <= 0 && teamDiffTotal <= 0) return routePlan;

  let finalActions = rewrittenActions;
  let reason = String(routePlan.reason || "supervisor route").trim() || "supervisor route";

  if (
    finalActions.length === 0
    && routePlan.done !== true
    && routePlan.await_user !== true
    && !explicitTeamConfigIntent
  ) {
    const fallbackAgent = pickRuntimeDefaultAgentId(runtime?.agents || []) || findDefaultChatAgentId();
    if (fallbackAgent) {
      finalActions = [{
        type: "run_agent",
        agent_id: fallbackAgent,
        goal: `기존 agent를 재사용해 요청 처리: ${clip(String(message || "").trim(), 240)}`,
        risk: "L1",
      }];
      reason = `${reason}; dedupe_fallback_run_agent`;
    }
  }

  reason = `${reason}; deduped_proposals=${dedupedProposals}; dropped_creates=${droppedCreates}; survived_creates=${survivedCreates}; team_diff_add=${Number(teamDiffStats.added || 0)}; team_diff_enable=${Number(teamDiffStats.enabled || 0)}; team_diff_remove=${Number(teamDiffStats.removed || 0)}; team_diff_disable=${Number(teamDiffStats.disabled || 0)}`;
  return {
    ...routePlan,
    reason,
    actions: finalActions.slice(0, 4),
  };
}

function markMutatingActionsConfirmed(actions = []) {
  const rows = Array.isArray(actions) ? actions : [];
  return rows.map((action) => {
    if (!isMutatingAction(action)) return action;
    return {
      ...action,
      _mutating_confirmed: true,
    };
  });
}

function inferApprovalPreviewReason(pending = {}) {
  return inferApprovalPreviewReasonShared(pending);
}

function buildApprovalActionSummaryLines(pending = {}) {
  return buildApprovalActionSummaryLinesShared(pending, {
    actionLabel: (action) => chatActionLabel(action),
  });
}

function buildPendingApprovalPrompt(pending = {}) {
  return buildPendingApprovalPromptAdapter(pending, {
    inferReason: inferApprovalPreviewReason,
    buildActionLines: buildApprovalActionSummaryLines,
  });
}

function findDefaultChatAgentId() {
  if (agentRegistry?.byId?.has("researcher")) return "researcher";
  const agents = Array.isArray(agentRegistry?.agents) ? agentRegistry.agents : [];
  const gemini = agents.find((row) => String(row?.provider || "").trim().toLowerCase() === "gemini");
  if (gemini?.id) return String(gemini.id).trim().toLowerCase();
  const nonChatgpt = agents.find((row) => String(row?.provider || "").trim().toLowerCase() !== "chatgpt");
  if (nonChatgpt?.id) return String(nonChatgpt.id).trim().toLowerCase();
  return "";
}

function isExplicitChatGptDecisionRequest(message) {
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

function sanitizeChatRoutePlan(routePlan, message) {
  const allowChatGPTPlanner = isExplicitChatGptDecisionRequest(message);
  const actions = Array.isArray(routePlan?.actions) ? routePlan.actions : [];
  const filtered = [];
  let removedChatGpt = 0;

  for (const action of actions) {
    if (action?.type !== "run_agent") {
      filtered.push(action);
      continue;
    }

    const agentId = resolveAgentId(action.agent || "");
    const provider = String(findAgentConfig(agentId)?.provider || "").trim().toLowerCase();
    if (!allowChatGPTPlanner && provider === "chatgpt") {
      removedChatGpt += 1;
      continue;
    } else {
      filtered.push({ ...action, agent: agentId || action.agent });
    }
  }

  if (filtered.length > 0) {
    const reasonTail = removedChatGpt > 0 ? `; filtered_chatgpt=${removedChatGpt}` : "";
    return {
      reason: `${String(routePlan?.reason || "(none)")}${reasonTail}`,
      actions: filtered,
      allowChatGPTPlanner,
    };
  }

  const fallbackAgent = findDefaultChatAgentId();
  if (!fallbackAgent) {
    return {
      reason: `${String(routePlan?.reason || "(none)")} ; no routable actions`,
      actions: [{ type: "show_agents" }],
      allowChatGPTPlanner,
    };
  }
  return {
    reason: `${String(routePlan?.reason || "(none)")} ; fallback_to=${fallbackAgent}`,
    actions: [{ type: "run_agent", agent: fallbackAgent, prompt: String(message || "").trim() }],
    allowChatGPTPlanner,
  };
}


function parseChatMessageWithFlags(rawArgs) {
  const tokens = String(rawArgs || "").split(/\s+/).filter(Boolean);
  const out = [];
  let debug = false;
  for (const token of tokens) {
    if (token === "--debug") {
      debug = true;
      continue;
    }
    out.push(token);
  }
  return {
    debug,
    message: out.join(" ").trim(),
  };
}

export {
  parseAutoSuggestDecision,
  parseJsonObjectFromText,
  parseRouterPlan,
  getGoalFromResearch,
  decideRunRoute,
  suggestNextPrompt,
  sendChatGPTPrompt,
  normalizeActionShape,
  actionLabel,
  formatRegistryLines,
  formatActionAgentLabel,
  chatActionLabel,
  normalizeForceMode,
  getActionGoal,
  buildPlanPreviewLines,
  buildQueuedAgentStatusFromActions,
  buildRoutedDashboardText,
  getCurrentTurnReplyMessageId,
  sendRouterAckMessage,
  sendPlanPreviewMessage,
  sendAgentStatusTransitionMessage,
  buildAutopilotProgressSummary,
  buildAutopilotFollowupMessage,
  sanitizeSupervisorRoutePlan,
  recommendTeamForTask,
  rewritePlanToReuseAgents,
  normalizeDeliverableList,
  mergeSuggestedActions,
  collectSuggestedActionsFromOutputs,
  updateCompletedDeliverablesFromOutputs,
  markMutatingActionsConfirmed,
  inferApprovalPreviewReason,
  buildApprovalActionSummaryLines,
  buildPendingApprovalPrompt,
  findDefaultChatAgentId,
  sanitizeChatRoutePlan,
  parseChatMessageWithFlags,
};
