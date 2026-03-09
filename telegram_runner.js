import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import TelegramBot from "node-telegram-bot-api";

import { Jobs } from "./src/jobs.js";
import { Tracking } from "./src/tracking.js";
import { Approvals } from "./src/approvals.js";
import { runCommand } from "./src/proc.js";
import { runCodexExec } from "./src/codex.js";
import { runGeminiPrompt } from "./src/gemini.js";
import { OrchestratorMemory } from "./src/settings.js";
import { orchestratorNotes, buildChatGPTNextStepPrompt } from "./src/prompts.js";
import { clip, extractCodexInstruction, extractJsonPlan } from "./src/textutil.js";
import { loadAgents, getAgent } from "./src/agents.js";
import {
  parseAutoSuggestDecision as parseAutoSuggestDecisionShared,
  parseJsonObjectFromText as parseJsonObjectFromTextShared,
} from "./src/shared/json_extract.js";
import {
  parseRouterPlan as parseRouterPlanDomain,
  sanitizeSupervisorRoutePlan as sanitizeSupervisorRoutePlanDomain,
  normalizeForceMode as normalizeForceModeDomain,
} from "./src/domain/route_plan.js";
import {
  normalizeLensSpec as normalizeLensSpecDomain,
  defaultLensSpecForAgent as defaultLensSpecForAgentDomain,
  resolveEffectiveLensSpec as resolveEffectiveLensSpecDomain,
  dedupeNodeIds as dedupeLensNodeIds,
} from "./src/domain/lens.js";
import { buildRuntimeOrchestration, createDefaultRunRoute } from "./src/application/orchestrator.js";
import {
  sendLong as sendLongAdapter,
  sendTextWithOptionalGocButton as sendTextWithOptionalGocButtonAdapter,
} from "./src/adapters/telegram/send.js";
import {
  buildPendingApprovalPrompt as buildPendingApprovalPromptAdapter,
  formatChatSummary as formatChatSummaryAdapter,
} from "./src/adapters/telegram/formatting.js";
import { createTelegramCommandHandler } from "./src/adapters/telegram/commands.js";
import { createTelegramCallbackQueryHandler } from "./src/adapters/telegram/callbacks.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./src/application/job_runtime.js";
import { createRuntimeTeamSnapshot } from "./src/application/runtime_metadata.js";
import {
  loadAgentsFromGoc,
  createAgentProfile,
  updateAgentProfile,
  listPublicBlueprints,
  installBlueprint,
} from "./src/agent_registry.js";
import { GocClient } from "./src/goc_client.js";
import {
  ensureJobThread,
  ensureAgentsThread,
  ensureToolsThread,
  ensureGlobalThread,
  normalizeJobConfig as normalizeSupervisorJobConfig,
  appendTrackingChunkToGoc,
} from "./src/goc_mapping.js";
import { ChatSessionStore } from "./src/chat/session.js";
import { routeWithSupervisor } from "./src/chat/supervisor_router.js";
import { executeSupervisorActions, isMutatingAction } from "./src/chat/executor.js";
import { normalizeActionPlan } from "./src/chat/actions.js";
import { expandDetailContext } from "./src/chat/unfold.js";
import { ChatRunManager } from "./src/chat/run_manager.js";
import { GocExecutionGraphRecorder } from "./src/chat/goc_execution_graph.js";
import { makeContextEngine } from "./src/context_engine/index.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

const FENCE = "```";

const jobs = new Jobs();
const tracking = new Tracking(jobs);
const approvals = new Approvals(jobs);

const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 1);
const AUTO_SUGGEST_ENABLED = String(process.env.AUTO_SUGGEST_GPT_PROMPT ?? "true").toLowerCase() !== "false";
const CHAT_VERBOSE = String(process.env.CHAT_VERBOSE ?? "false").toLowerCase() === "true";
const TELEGRAM_REQUIRE_MENTION_IN_GROUP = String(process.env.TELEGRAM_REQUIRE_MENTION_IN_GROUP ?? "false").toLowerCase() === "true";
const TELEGRAM_FORCE_IPV4 = String(process.env.TELEGRAM_FORCE_IPV4 ?? "true").toLowerCase() !== "false";
const TELEGRAM_POLLING_INTERVAL_MS = Number(process.env.TELEGRAM_POLLING_INTERVAL_MS ?? 1000);
const TELEGRAM_POLLING_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLLING_TIMEOUT_SEC ?? 15);
const BYTES_PER_MB = 1024 * 1024;
const TELEGRAM_UPLOAD_MAX_MB = Number.isFinite(Number(process.env.TELEGRAM_UPLOAD_MAX_MB))
  ? Math.max(1, Math.floor(Number(process.env.TELEGRAM_UPLOAD_MAX_MB)))
  : 20;
const TELEGRAM_UPLOAD_MAX_BYTES = TELEGRAM_UPLOAD_MAX_MB * BYTES_PER_MB;
const TELEGRAM_DOWNLOAD_MAX_BYTES = Number.isFinite(Number(process.env.TELEGRAM_DOWNLOAD_MAX_BYTES))
  ? Math.max(1, Math.floor(Number(process.env.TELEGRAM_DOWNLOAD_MAX_BYTES)))
  : (20 * BYTES_PER_MB);
const TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES = Math.min(TELEGRAM_UPLOAD_MAX_BYTES, TELEGRAM_DOWNLOAD_MAX_BYTES);
const TELEGRAM_SEND_MAX_BYTES = 50 * BYTES_PER_MB;
const TELEGRAM_UPLOAD_ALLOWED_EXTS = String(
  process.env.TELEGRAM_UPLOAD_ALLOWED_EXTS
  ?? ".txt,.md,.pdf,.csv,.json,.py,.ipynb,.jpg,.jpeg,.png,.mp4,.mp3,.ogg,.wav,.m4a"
)
  .split(",")
  .map((entry) => String(entry || "").trim().toLowerCase())
  .filter(Boolean)
  .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
const TELEGRAM_UPLOAD_ALLOWED_EXT_SET = new Set(TELEGRAM_UPLOAD_ALLOWED_EXTS);
const TELEGRAM_SINGLE_INSTANCE_LOCK = String(process.env.TELEGRAM_SINGLE_INSTANCE_LOCK ?? "true").toLowerCase() !== "false";
const LOCK_FILE = process.env.TELEGRAM_LOCK_FILE || path.join(jobs.baseDir, ".locks", "telegram_runner.lock");
const OUTPUT_AUTO_SEND = String(process.env.OUTPUT_AUTO_SEND ?? "true").trim().toLowerCase() !== "false";
const OUTPUT_AUTO_SEND_MAX_FILES = Number.isFinite(Number(process.env.OUTPUT_AUTO_SEND_MAX_FILES))
  ? Math.max(1, Math.min(20, Math.floor(Number(process.env.OUTPUT_AUTO_SEND_MAX_FILES))))
  : 4;
const OUTPUT_AUTO_SEND_ON = String(process.env.OUTPUT_AUTO_SEND_ON || "step").trim().toLowerCase() === "run_end"
  ? "run_end"
  : "step";
const MEMORY_MODE = String(process.env.MEMORY_MODE || "local").trim().toLowerCase() === "goc" ? "goc" : "local";
const GOC_UI_TOKEN_TTL_SEC = Number(process.env.GOC_UI_TOKEN_TTL_SEC ?? 21600);
const GOC_UI_BROWSER_TOKEN_TTL_SEC = Number.isFinite(Number(process.env.GOC_UI_BROWSER_TOKEN_TTL_SEC))
  ? Math.max(60, Math.floor(Number(process.env.GOC_UI_BROWSER_TOKEN_TTL_SEC)))
  : 3600;
const GOC_UI_LINK_MODE = String(process.env.GOC_UI_LINK_MODE || "telegram_auth").trim().toLowerCase() === "bearer_token"
  ? "bearer_token"
  : "telegram_auth";
const MAX_PARALLEL_PER_RUN = Number.isFinite(Number(process.env.MAX_PARALLEL_PER_RUN))
  ? Math.max(1, Math.min(8, Math.floor(Number(process.env.MAX_PARALLEL_PER_RUN))))
  : 3;
const INTERRUPT_DEBOUNCE_MS = Number.isFinite(Number(process.env.INTERRUPT_DEBOUNCE_MS))
  ? Math.max(0, Math.floor(Number(process.env.INTERRUPT_DEBOUNCE_MS)))
  : 500;
const AGENT_STATUS_MESSAGE_THROTTLE_MS = Number.isFinite(Number(
  process.env.AGENT_STATUS_MESSAGE_THROTTLE_MS
  ?? process.env.DASHBOARD_EDIT_THROTTLE_MS
))
  ? Math.max(200, Math.floor(Number(
    process.env.AGENT_STATUS_MESSAGE_THROTTLE_MS
    ?? process.env.DASHBOARD_EDIT_THROTTLE_MS
  )))
  : 1000;
const AUTOPILOT_ENABLED = String(process.env.AUTOPILOT_ENABLED ?? "true").toLowerCase() !== "false";
const AUTOPILOT_MAX_TURNS = Number.isFinite(Number(process.env.AUTOPILOT_MAX_TURNS))
  ? Math.max(1, Math.min(8, Math.floor(Number(process.env.AUTOPILOT_MAX_TURNS))))
  : 3;
const AUTOPILOT_MAX_TOTAL_ACTIONS = Number.isFinite(Number(process.env.AUTOPILOT_MAX_TOTAL_ACTIONS))
  ? Math.max(1, Math.min(120, Math.floor(Number(process.env.AUTOPILOT_MAX_TOTAL_ACTIONS))))
  : 20;
const SHARED_CONTEXT_RECENT_USER_MESSAGES = Number.isFinite(Number(process.env.SHARED_CONTEXT_RECENT_USER_MESSAGES))
  ? Math.max(1, Math.min(40, Math.floor(Number(process.env.SHARED_CONTEXT_RECENT_USER_MESSAGES))))
  : 6;
const SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES = Number.isFinite(Number(process.env.SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES))
  ? Math.max(1, Math.min(40, Math.floor(Number(process.env.SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES))))
  : 6;
const SHARED_CONTEXT_RECENT_RUN_STEP = Number.isFinite(Number(process.env.SHARED_CONTEXT_RECENT_RUN_STEP))
  ? Math.max(1, Math.min(60, Math.floor(Number(process.env.SHARED_CONTEXT_RECENT_RUN_STEP))))
  : 10;
const SHARED_CONTEXT_RECENT_TOOL_ARTIFACT = Number.isFinite(Number(process.env.SHARED_CONTEXT_RECENT_TOOL_ARTIFACT))
  ? Math.max(1, Math.min(40, Math.floor(Number(process.env.SHARED_CONTEXT_RECENT_TOOL_ARTIFACT))))
  : 5;
const SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS = String(
  process.env.SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS || "job_config,tracking_append"
)
  .split(",")
  .map((entry) => String(entry || "").trim().toLowerCase())
  .filter(Boolean);
const LEGACY_AGENT_MAP = {
  gemini: "researcher",
  codex: "coder",
  chatgpt: "planner",
};

const memory = new OrchestratorMemory({ baseDir: jobs.baseDir });
const chatSessionStore = new ChatSessionStore({ baseDir: jobs.baseDir });
let agentRegistry = loadAgents();
let gocClient = null;
let gocReady = false;
let gocInitError = "";
if (MEMORY_MODE === "goc") {
  try {
    gocClient = new GocClient({
      apiBase: process.env.GOC_API_BASE,
      serviceKey: process.env.GOC_SERVICE_KEY,
    });
    gocReady = true;
  } catch (e) {
    gocReady = false;
    gocInitError = String(e?.message ?? e);
    console.error(`[memory] GoC init failed, fallback to local: ${gocInitError}`);
  }
}

let hasLock = false;

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}

function parseLockPid(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    const m = String(raw).match(/\b\d+\b/);
    if (!m) return null;
    const pid = Number(m[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

function acquireSingleInstanceLock() {
  if (!TELEGRAM_SINGLE_INSTANCE_LOCK) return;
  fs.mkdirSync(path.dirname(LOCK_FILE), { recursive: true });

  if (fs.existsSync(LOCK_FILE)) {
    const existingPid = parseLockPid(fs.readFileSync(LOCK_FILE, "utf8"));
    if (existingPid && existingPid !== process.pid && isPidRunning(existingPid)) {
      console.error(`Another telegram_runner.js process is already running (pid=${existingPid}).`);
      console.error("Stop the existing process first, or set TELEGRAM_SINGLE_INSTANCE_LOCK=false.");
      process.exit(1);
    }
  }

  fs.writeFileSync(LOCK_FILE, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf8");
  hasLock = true;
}

function releaseSingleInstanceLock() {
  if (!hasLock) return;
  try {
    if (fs.existsSync(LOCK_FILE)) {
      const existingPid = parseLockPid(fs.readFileSync(LOCK_FILE, "utf8"));
      if (!existingPid || existingPid === process.pid) fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
  hasLock = false;
}

acquireSingleInstanceLock();
process.on("exit", () => { releaseSingleInstanceLock(); });

function isAllowedChat(chatId) { void chatId; return true; }
function isAllowedUser(userId) { return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(String(userId)); }
const TRACK_DOC_NAMES = ["plan.md", "research.md", "progress.md", "decisions.md"];
const gocFallbackByJob = new Map();

function runDir(jobId) {
  return jobs.jobDir(jobId);
}

function runWorkspaceDir(jobId) {
  return jobs.workspaceDir(jobId);
}

function resolveWorkspacePath(jobId, userPath = ".", { asDirectory = false } = {}) {
  return jobs.ensureWorkspacePath(jobId, userPath, { asDirectory });
}

function sanitizeWorkspaceFileName(rawName = "", { fallback = "file" } = {}) {
  const src = String(rawName || "").trim();
  const base = src ? path.basename(src) : fallback;
  const safe = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 120);
  return safe || fallback;
}

function formatByteSize(bytes = 0) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0B";
  if (n < 1024) return `${Math.floor(n)}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

function formatFileMtime(ms = 0) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "n/a";
  try {
    return new Date(n).toISOString().replace("T", " ").slice(0, 19);
  } catch {
    return "n/a";
  }
}

function isUploadExtAllowed(fileName = "") {
  if (TELEGRAM_UPLOAD_ALLOWED_EXT_SET.size === 0) return true;
  const ext = String(path.extname(String(fileName || "")).trim().toLowerCase() || "");
  if (!ext) return false;
  return TELEGRAM_UPLOAD_ALLOWED_EXT_SET.has(ext);
}

function uploadAllowedExtsText() {
  if (TELEGRAM_UPLOAD_ALLOWED_EXT_SET.size === 0) return "(all)";
  return [...TELEGRAM_UPLOAD_ALLOWED_EXT_SET].join(", ");
}

function computeFileSha256(filePath = "") {
  const cleanPath = String(filePath || "").trim();
  if (!cleanPath) return "";
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(cleanPath));
  return hash.digest("hex");
}

function resolveLiveJobIdForChat(chatId) {
  const jobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  if (!jobId) return "";
  try {
    runDir(jobId);
    return jobId;
  } catch {
    return "";
  }
}

function parseClampedInt(raw, fallback, { min = 1, max = 100 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function runSharedDir(jobId) {
  return path.join(runDir(jobId), "shared");
}

function loadLocalContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
  let out = "";
  for (const name of docNames) {
    try {
      const t = tracking.read(jobId, name);
      const clipped = t.length > maxCharsPerDoc ? t.slice(-maxCharsPerDoc) : t;
      out += `\n\n---\n\n### ${path.join(runSharedDir(jobId), name)}\n\n${clipped}\n`;
    } catch (e) {
      out += `\n\n---\n\n### ${path.join(runSharedDir(jobId), name)}\n\n[read failed: ${String(e?.message ?? e)}]\n`;
    }
  }
  return out.trim() || "(none)";
}

function resolveGocUiBase() {
  const publicBase = String(process.env.GOC_UI_PUBLIC_BASE || "").trim().replace(/\/+$/, "");
  const internalBase = String(process.env.GOC_UI_BASE || "").trim().replace(/\/+$/, "");
  return publicBase || internalBase;
}

function isHttps(url) {
  return /^https:\/\//i.test(String(url || "").trim());
}

function isTelegramWebAppHttpsError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  const desc = String(error?.response?.body?.description || "");
  const msg = String(error?.message || error || "");
  const merged = `${desc}\n${msg}`;
  return code === "ETELEGRAM" && /Only HTTPS links are allowed/i.test(merged);
}

function buildGocUiLink({
  threadId,
  ctxId,
  token = "",
  base = "",
  withToken = null,
  page = "",
}) {
  const resolvedBase = String(base || resolveGocUiBase() || "").trim().replace(/\/+$/, "");
  if (!resolvedBase) throw new Error("Missing GOC_UI_BASE (or GOC_UI_PUBLIC_BASE)");
  const cleanPage = String(page || "").trim().toLowerCase();
  const cleanThreadId = String(threadId || "").trim();
  const cleanCtxId = String(ctxId || "").trim();
  let query = "";
  if (cleanPage === "agents") {
    const agentsBase = `${resolvedBase}/agents`;
    const qs = new URLSearchParams();
    if (cleanThreadId) qs.set("thread", cleanThreadId);
    if (cleanCtxId) qs.set("ctx", cleanCtxId);
    query = qs.toString() ? `${agentsBase}?${qs.toString()}` : agentsBase;
  } else {
    const baseForQuery = resolvedBase.endsWith("/") ? resolvedBase : `${resolvedBase}/`;
    const qs = new URLSearchParams();
    qs.set("thread", cleanThreadId);
    qs.set("ctx", cleanCtxId);
    query = `${baseForQuery}?${qs.toString()}`;
  }
  const useToken = typeof withToken === "boolean"
    ? withToken
    : (GOC_UI_LINK_MODE === "bearer_token");
  if (useToken && token) {
    return `${query}#token=${encodeURIComponent(String(token || ""))}`;
  }
  return query;
}

async function buildContextLinks(client, { threadId, ctxId, page = "" } = {}) {
  const base = resolveGocUiBase();
  if (!base) throw new Error("Missing GOC_UI_BASE (or GOC_UI_PUBLIC_BASE)");

  let miniAppToken = null;
  if (GOC_UI_LINK_MODE === "bearer_token") {
    miniAppToken = await client.mintUiToken(GOC_UI_TOKEN_TTL_SEC);
  }
  const browserToken = await client.mintUiToken(GOC_UI_BROWSER_TOKEN_TTL_SEC);

  const miniAppLink = buildGocUiLink({
    threadId,
    ctxId,
    token: miniAppToken?.token || "",
    base,
    page,
    withToken: GOC_UI_LINK_MODE === "bearer_token",
  });
  const browserLink = buildGocUiLink({
    threadId,
    ctxId,
    token: browserToken?.token || "",
    base,
    page,
    withToken: true,
  });
  return {
    miniAppLink,
    browserLink,
    miniAppTokenExp: miniAppToken?.exp || null,
    browserTokenExp: browserToken?.exp || null,
    miniAppSupported: isHttps(miniAppLink),
  };
}

function resolveCurrentJobIdForChat(chatId) {
  const chatKey = String(chatId);
  const fromSession = chatSessionStore.get(chatId)?.jobId || "";
  return activeJobByChat.get(chatKey) || getAwait(chatId)?.jobId || fromSession || lastChatJobByChat.get(chatKey) || "";
}

function rememberLastChatJob(chatId, jobId) {
  const chatKey = String(chatId);
  const key = String(jobId || "").trim();
  if (!key) return;
  lastChatJobByChat.set(chatKey, key);
}

function resetChatSession(chatId) {
  const chatKey = String(chatId);
  requestChatInterrupt(chatId, { mode: "cancel", reason: "chat_reset" });
  activeJobByChat.delete(chatKey);
  lastChatJobByChat.delete(chatKey);
  clearAwait(chatId);
  chatSessionStore.clear(chatId);
}

async function buildContextInfo(
  target,
  {
    chatId = null,
    userId = null,
    createIfMissing = false,
  } = {}
) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error(`GoC disabled (mode=${MEMORY_MODE}, effective=${memoryModeWithFallback()})`);
  }

  const restoreActor = bindGocActor(userId);
  try {
    const client = requireGocClient();
    const targetRaw = String(target || "").trim();
    let resolved = targetRaw || (chatId == null ? "" : resolveCurrentJobIdForChat(chatId));

    if (!resolved) {
      if (!createIfMissing || chatId == null) {
        throw new Error("Usage: /context <jobId|global>  (jobId omitted uses current running job)");
      }
      const seeded = await createJob("Open GoC context link", {
        ownerUserId: userId,
        ownerChatId: chatId,
      });
      resolved = String(seeded?.jobId || "").trim();
      if (!resolved) throw new Error("Failed to create context job");
      rememberLastChatJob(chatId, resolved);
      chatSessionStore.upsert(chatId, {
        jobId: resolved,
        state: "idle",
      });
    }

    if (resolved.toLowerCase() === "global") {
      const g = await ensureGlobalThread(client, {
        baseDir: jobs.baseDir,
        title: "global:shared",
      });
      const links = await buildContextLinks(client, {
        threadId: g.threadId,
        ctxId: g.ctxId,
      });
      const miniAppNotice = links.miniAppSupported
        ? ""
        : "Mini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.";
      return {
        scope: "global",
        threadId: g.threadId,
        ctxId: g.ctxId,
        link: links.miniAppLink,
        miniAppLink: links.miniAppLink,
        browserLink: links.browserLink,
        miniAppSupported: links.miniAppSupported,
        miniAppTokenExp: links.miniAppTokenExp,
        browserTokenExp: links.browserTokenExp,
        lines: [
          "global context",
          `thread=${g.threadId}`,
          `ctx=${g.ctxId}`,
          links.miniAppTokenExp ? `miniapp_token_exp=${links.miniAppTokenExp}` : "",
          links.browserTokenExp ? `browser_token_exp=${links.browserTokenExp}` : "",
          `miniapp_link=${links.miniAppLink}`,
          `browser_link=${links.browserLink}`,
          miniAppNotice,
          "",
          "UI에서 편집/활성 토글/삭제하면 다음 스텝 호출부터 반영됩니다.",
        ].filter(Boolean),
      };
    }

    const jobId = String(resolved).trim();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
      telegram: chatId == null ? null : { chat_id: String(chatId || "") },
    });
    const links = await buildContextLinks(client, {
      threadId: map.threadId,
      ctxId: map.ctxSharedId,
    });
    const miniAppNotice = links.miniAppSupported
      ? ""
      : "Mini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.";
    return {
      scope: "job",
      jobId,
      threadId: map.threadId,
      ctxId: map.ctxSharedId,
      link: links.miniAppLink,
      miniAppLink: links.miniAppLink,
      browserLink: links.browserLink,
      miniAppSupported: links.miniAppSupported,
      miniAppTokenExp: links.miniAppTokenExp,
      browserTokenExp: links.browserTokenExp,
      lines: [
        `jobId=${jobId}`,
        `thread=${map.threadId}`,
        `ctx=${map.ctxSharedId}`,
        links.miniAppTokenExp ? `miniapp_token_exp=${links.miniAppTokenExp}` : "",
        links.browserTokenExp ? `browser_token_exp=${links.browserTokenExp}` : "",
        `miniapp_link=${links.miniAppLink}`,
        `browser_link=${links.browserLink}`,
        miniAppNotice,
        "",
        "UI에서 편집/활성 토글/삭제하면 다음 스텝 호출부터 반영됩니다.",
      ].filter(Boolean),
    };
  } finally {
    restoreActor();
  }
}

async function sendContextInfo(bot, chatId, target, { userId = null, createIfMissing = true } = {}) {
  const info = await buildContextInfo(target, { chatId, userId, createIfMissing });
  const text = info.lines.join("\n");
  const hasMiniApp = isHttps(info.miniAppLink || "");
  const buttons = [];
  if (hasMiniApp) {
    buttons.push({ text: "Open GoC (Mini App)", web_app: { url: info.miniAppLink } });
  }
  if (info.browserLink) {
    buttons.push({ text: "Open GoC (Browser)", url: info.browserLink });
  } else if (info.miniAppLink) {
    buttons.push({ text: "Open GoC (Browser)", url: info.miniAppLink });
  }

  if (buttons.length === 0) {
    await sendLong(bot, chatId, text);
    return info;
  }
  try {
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [buttons] } });
  } catch (e) {
    if (hasMiniApp && isTelegramWebAppHttpsError(e)) {
      const fallbackText = `${text}\n\nMini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.`;
      const browserOnly = info.browserLink
        ? [{ text: "Open GoC (Browser)", url: info.browserLink }]
        : [];
      if (browserOnly.length > 0) {
        await bot.sendMessage(chatId, fallbackText, { reply_markup: { inline_keyboard: [browserOnly] } });
      } else {
        await sendLong(bot, chatId, fallbackText);
      }
      return info;
    }
    throw e;
  }
  return info;
}

async function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
  const local = loadLocalContextDocs(jobId, docNames, maxCharsPerDoc);
  if (memoryModeWithFallback() !== "goc") return local;

  try {
    const map = await ensureJobThread(requireGocClient(), {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
    });
    const compiled = await requireGocClient().getCompiledContext(map.ctxSharedId);
    const latest = String(compiled || "").trim();
    if (!latest) {
      gocFallbackByJob.set(String(jobId), "empty compiled_text");
      return local;
    }
    gocFallbackByJob.delete(String(jobId));
    return [
      "### GOC ACTIVE CONTEXT",
      clip(latest, 12000),
      "",
      "### LOCAL TRACKING SNAPSHOT",
      local,
    ].join("\n\n");
  } catch (e) {
    const reason = String(e?.message ?? e);
    gocFallbackByJob.set(String(jobId), reason);
    jobs.log(jobId, `GoC compiled context failed; fallback to local: ${reason}`);
    return local;
  }
}

async function appendChatMessageToGoc(jobId, {
  role = "user",
  text = "",
  kind = "chat_message",
  chatId = "",
  userId = "",
  replyTo = "",
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanJobId || !cleanText) return null;
  if (memoryModeWithFallback() !== "goc") return null;
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId: cleanJobId,
      jobDir: runDir(cleanJobId),
      title: `job:${cleanJobId}`,
    });
    return await client.addMessage(map.threadId, {
      role: String(role || "").trim().toLowerCase() || "user",
      text: cleanText,
      reply_to: String(replyTo || "").trim() || undefined,
      meta_json: {
        kind: String(kind || "chat_message").trim().toLowerCase(),
        job_id: cleanJobId,
        chat_id: String(chatId || "").trim() || undefined,
        user_id: String(userId || "").trim() || undefined,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    jobs.log(cleanJobId, `GoC message append skipped: ${String(e?.message ?? e)}`);
    return null;
  }
}

async function appendWorkspaceUploadArtifactToGoc(jobId, {
  fileName = "",
  fileSize = 0,
  localPath = "",
  uploadKind = "document",
  sha256 = "",
  telegramFileId = "",
  telegramMessageId = null,
  chatId = "",
  userId = "",
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanPath = String(localPath || "").trim();
  if (!cleanJobId || !cleanPath) return null;
  if (memoryModeWithFallback() !== "goc") return null;
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId: cleanJobId,
      jobDir: runDir(cleanJobId),
      title: `job:${cleanJobId}`,
    });
    const relPath = path.relative(runWorkspaceDir(cleanJobId), cleanPath);
    const safeRelPath = relPath && !relPath.startsWith("..") ? relPath : path.basename(cleanPath);
    return await client.createResource(map.threadId, {
      name: `upload:${String(fileName || "file").slice(0, 80)}@${new Date().toISOString()}`,
      summary: `telegram upload ${fileName || path.basename(cleanPath)}`,
      text_mode: "plain",
      raw_text: [
        "telegram upload",
        `job_id: ${cleanJobId}`,
        `kind: ${String(uploadKind || "document")}`,
        `filename: ${fileName || path.basename(cleanPath)}`,
        `size: ${Number(fileSize || 0)}`,
        `sha256: ${String(sha256 || "")}`,
        `local_path: ${cleanPath}`,
      ].join("\n") + "\n",
      resource_kind: "artifact",
      uri: `ddalggak://jobs/${cleanJobId}/workspace/${safeRelPath}`,
      context_set_id: map.ctxSharedId,
      auto_activate: false,
      payload_json: {
        kind: "telegram_upload",
        job_id: cleanJobId,
        upload_kind: String(uploadKind || "document"),
        file_name: fileName || path.basename(cleanPath),
        file_size: Number(fileSize || 0),
        sha256: String(sha256 || "").trim() || undefined,
        local_path: cleanPath,
        local_workspace_path: safeRelPath,
        telegram_file_id: String(telegramFileId || "").trim() || undefined,
        telegram_message_id: Number.isFinite(Number(telegramMessageId)) ? Number(telegramMessageId) : undefined,
        chat_id: String(chatId || "").trim() || undefined,
        user_id: String(userId || "").trim() || undefined,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    jobs.log(cleanJobId, `GoC upload artifact append skipped: ${String(e?.message ?? e)}`);
    return null;
  }
}

function extensionFromMimeType(rawMime = "", fallbackExt = ".bin") {
  const mime = String(rawMime || "").trim().toLowerCase();
  if (!mime) return fallbackExt;
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("pdf")) return ".pdf";
  if (mime.includes("json")) return ".json";
  if (mime.includes("csv")) return ".csv";
  if (mime.includes("markdown")) return ".md";
  if (mime.includes("plain")) return ".txt";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("quicktime")) return ".mov";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("wav")) return ".wav";
  return fallbackExt;
}

function resolveTelegramUploadCandidate(msg = {}) {
  const messageId = Number.isFinite(Number(msg?.message_id)) ? Number(msg.message_id) : 0;
  const stamp = Date.now().toString(36);

  const document = msg?.document && typeof msg.document === "object" ? msg.document : null;
  if (document?.file_id) {
    const fallbackExt = extensionFromMimeType(document.mime_type, ".bin");
    const fallback = `document_${stamp}_${messageId}${fallbackExt}`;
    return {
      kind: "document",
      fileId: String(document.file_id || "").trim(),
      fileUniqueId: String(document.file_unique_id || "").trim(),
      fileSize: Number(document.file_size || 0),
      fileName: String(document.file_name || fallback).trim(),
    };
  }

  const photos = Array.isArray(msg?.photo) ? msg.photo.filter((row) => row?.file_id) : [];
  if (photos.length > 0) {
    const best = photos.reduce((acc, row) => {
      if (!acc) return row;
      const aSize = Number(acc?.file_size || 0);
      const bSize = Number(row?.file_size || 0);
      if (bSize !== aSize) return bSize > aSize ? row : acc;
      const aPixels = Number(acc?.width || 0) * Number(acc?.height || 0);
      const bPixels = Number(row?.width || 0) * Number(row?.height || 0);
      return bPixels > aPixels ? row : acc;
    }, photos[0] || null);
    if (best?.file_id) {
      return {
        kind: "photo",
        fileId: String(best.file_id || "").trim(),
        fileUniqueId: String(best.file_unique_id || "").trim(),
        fileSize: Number(best.file_size || 0),
        fileName: `photo_${stamp}_${messageId}.jpg`,
      };
    }
  }

  const video = msg?.video && typeof msg.video === "object" ? msg.video : null;
  if (video?.file_id) {
    const ext = path.extname(String(video.file_name || "").trim()) || extensionFromMimeType(video.mime_type, ".mp4");
    return {
      kind: "video",
      fileId: String(video.file_id || "").trim(),
      fileUniqueId: String(video.file_unique_id || "").trim(),
      fileSize: Number(video.file_size || 0),
      fileName: String(video.file_name || `video_${stamp}_${messageId}${ext}`).trim(),
    };
  }

  const audio = msg?.audio && typeof msg.audio === "object" ? msg.audio : null;
  if (audio?.file_id) {
    const ext = path.extname(String(audio.file_name || "").trim()) || extensionFromMimeType(audio.mime_type, ".mp3");
    return {
      kind: "audio",
      fileId: String(audio.file_id || "").trim(),
      fileUniqueId: String(audio.file_unique_id || "").trim(),
      fileSize: Number(audio.file_size || 0),
      fileName: String(audio.file_name || `audio_${stamp}_${messageId}${ext}`).trim(),
    };
  }

  const voice = msg?.voice && typeof msg.voice === "object" ? msg.voice : null;
  if (voice?.file_id) {
    return {
      kind: "voice",
      fileId: String(voice.file_id || "").trim(),
      fileUniqueId: String(voice.file_unique_id || "").trim(),
      fileSize: Number(voice.file_size || 0),
      fileName: `voice_${stamp}_${messageId}.ogg`,
    };
  }

  return null;
}

function hasTelegramUploadAttachment(msg = {}) {
  return !!resolveTelegramUploadCandidate(msg);
}

async function saveTelegramFileToWorkspace(bot, msg, {
  chatId = "",
  userId = "",
  fileId = "",
  filename = "",
  size = 0,
  kind = "document",
  fileUniqueId = "",
} = {}) {
  const cleanFileId = String(fileId || "").trim();
  if (!cleanFileId) return null;
  const cleanKind = String(kind || "document").trim().toLowerCase() || "document";
  const maxBytes = TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES;
  const cleanSize = Number(size || 0);
  if (cleanSize > maxBytes) {
    await bot.sendMessage(
      chatId,
      [
        `❌ 파일이 20MB를 초과해 표준 Bot API로 다운로드할 수 없어요. (설정 한도: ${formatByteSize(maxBytes)})`,
        "대안: (1) 링크로 공유 (2) 외부 스토리지 업로드 (3) 로컬 Telegram Bot API 서버 사용",
      ].join("\n"),
      Number.isFinite(Number(msg?.message_id))
        ? { reply_to_message_id: Number(msg.message_id) }
        : undefined
    );
    return {
      skipped: true,
      reason: "download_limit_exceeded",
    };
  }

  const cleanName = sanitizeWorkspaceFileName(filename || `${cleanKind}.bin`, {
    fallback: `${cleanKind}.bin`,
  });
  if (!isUploadExtAllowed(cleanName)) {
    await bot.sendMessage(
      chatId,
      [
        "❌ 업로드 확장자가 허용 목록에 없습니다.",
        `- file: ${cleanName}`,
        `- allowed: ${uploadAllowedExtsText()}`,
      ].join("\n"),
      Number.isFinite(Number(msg?.message_id))
        ? { reply_to_message_id: Number(msg.message_id) }
        : undefined
    );
    return {
      skipped: true,
      reason: "extension_not_allowed",
    };
  }

  let jobId = resolveLiveJobIdForChat(chatId);
  let createdJob = false;
  if (!jobId) {
    const seed = await createJob(`uploaded file: ${cleanName}`, {
      ownerUserId: userId,
      ownerChatId: chatId,
    });
    jobId = String(seed.jobId || "").trim();
    createdJob = true;
    rememberLastChatJob(chatId, jobId);
    chatSessionStore.upsert(chatId, {
      jobId,
      state: "idle",
    });
  }
  if (!jobId) throw new Error("Failed to resolve jobId for file upload");

  const uploadsDir = resolveWorkspacePath(jobId, "uploads", { asDirectory: true });
  const downloadedPath = await bot.downloadFile(cleanFileId, uploadsDir);
  const stamp = Date.now().toString(36);
  const messageId = Number.isFinite(Number(msg?.message_id)) ? Number(msg.message_id) : 0;
  const finalName = sanitizeWorkspaceFileName(`${stamp}_${messageId}_${cleanName}`, {
    fallback: `${cleanKind}_${stamp}.bin`,
  });
  const finalPath = resolveWorkspacePath(jobId, path.join("uploads", finalName));
  if (path.resolve(downloadedPath) !== path.resolve(finalPath)) {
    fs.renameSync(downloadedPath, finalPath);
  }

  const fileStat = fs.statSync(finalPath);
  const actualSize = Number(fileStat?.size || cleanSize || 0);
  const sha256 = computeFileSha256(finalPath);
  const manifestPath = resolveWorkspacePath(jobId, "uploads/manifest.jsonl");
  const workspaceRelPath = path.relative(runWorkspaceDir(jobId), finalPath).replace(/\\/g, "/");
  const record = {
    ts: new Date().toISOString(),
    kind: `telegram_${cleanKind}_upload`,
    upload_kind: cleanKind,
    job_id: jobId,
    chat_id: String(chatId || ""),
    user_id: String(userId || ""),
    message_id: messageId,
    file_id: cleanFileId,
    file_unique_id: String(fileUniqueId || "").trim(),
    filename: cleanName,
    size: actualSize,
    sha256,
    local_path: finalPath,
    workspace_path: workspaceRelPath,
  };
  fs.appendFileSync(manifestPath, `${JSON.stringify(record)}\n`, "utf8");

  jobs.appendConversation(jobId, "user", `uploaded file: ${cleanName}`, {
    kind: `upload_${cleanKind}`,
    telegram_message_id: messageId || undefined,
    local_path: finalPath,
    sha256,
  });
  tracking.append(jobId, "progress.md", [
    "## upload",
    `- kind: ${cleanKind}`,
    `- filename: ${cleanName}`,
    `- size: ${actualSize}`,
    `- sha256: ${sha256}`,
    `- workspace_path: ${workspaceRelPath}`,
    `- file_id: ${cleanFileId}`,
  ].join("\n"));
  await appendWorkspaceUploadArtifactToGoc(jobId, {
    fileName: cleanName,
    fileSize: actualSize,
    localPath: finalPath,
    uploadKind: cleanKind,
    sha256,
    telegramFileId: cleanFileId,
    telegramMessageId: messageId,
    chatId,
    userId,
  }).catch(() => null);

  await bot.sendMessage(
    chatId,
    [
      "📎 파일 업로드 저장 완료",
      `- kind: ${cleanKind}`,
      `- job_id: ${jobId}`,
      `- workspace: ${runWorkspaceDir(jobId)}`,
      `- path: ${workspaceRelPath}`,
      `- size: ${formatByteSize(actualSize)}`,
      createdJob ? "- note: 새 job 생성됨" : "",
    ].filter(Boolean).join("\n"),
    Number.isFinite(Number(msg?.message_id))
      ? { reply_to_message_id: Number(msg.message_id) }
      : undefined
  );
  return {
    skipped: false,
    kind: cleanKind,
    jobId,
    finalPath,
    relPath: workspaceRelPath,
    sha256,
    createdJob,
  };
}

async function handleTelegramFileUpload(bot, msg, { chatId, userId } = {}) {
  const candidate = resolveTelegramUploadCandidate(msg);
  if (!candidate) return null;
  return await saveTelegramFileToWorkspace(bot, msg, {
    chatId,
    userId,
    fileId: candidate.fileId,
    filename: candidate.fileName,
    size: candidate.fileSize,
    kind: candidate.kind,
    fileUniqueId: candidate.fileUniqueId,
  });
}

function listWorkspaceFilesRecursive(rootDir) {
  const out = [];
  const stack = [String(rootDir || "")];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry?.name || "").trim();
      if (!name || name === "." || name === "..") continue;
      if (name.startsWith(".telegram_")) continue;
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

function normalizeWorkspaceScope(raw = "") {
  const scope = String(raw || "").trim().toLowerCase();
  if (scope === "uploads" || scope === "outputs" || scope === "all") return scope;
  return "all";
}

function collectWorkspaceFileEntries(jobId, { scope = "all" } = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const normalizedScope = normalizeWorkspaceScope(scope);
  const targets = [];
  if (normalizedScope === "all" || normalizedScope === "uploads") {
    targets.push({ bucket: "uploads", dir: resolveWorkspacePath(cleanJobId, "uploads", { asDirectory: true }) });
  }
  if (normalizedScope === "all" || normalizedScope === "outputs") {
    targets.push({ bucket: "outputs", dir: resolveWorkspacePath(cleanJobId, "outputs", { asDirectory: true }) });
  }

  const out = [];
  for (const target of targets) {
    const files = listWorkspaceFilesRecursive(target.dir);
    for (const abs of files) {
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) continue;
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
      out.push({
        bucket: target.bucket,
        abs,
        rel,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    }
  }
  out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  return out;
}

function formatWorkspaceFileListText(jobId, entries = [], { scope = "all", limit = 20 } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const normalizedScope = normalizeWorkspaceScope(scope);
  const lines = [
    `job_id=${cleanJobId}`,
    `scope=${normalizedScope}`,
    `limit=${limit}`,
  ];
  if (!Array.isArray(entries) || entries.length === 0) {
    lines.push("- (no files)");
    return lines.join("\n");
  }
  for (const row of entries) {
    lines.push(`- ${row.rel} (${formatByteSize(row.size)}, mtime=${formatFileMtime(row.mtimeMs)})`);
  }
  return lines.join("\n");
}

function buildWorkspaceFilesPromptSection(jobId, { limitPerBucket = 5 } = {}) {
  const limit = Number.isFinite(Number(limitPerBucket))
    ? Math.max(1, Math.min(20, Math.floor(Number(limitPerBucket))))
    : 5;
  const uploads = collectWorkspaceFileEntries(jobId, { scope: "uploads" }).slice(0, limit);
  const outputs = collectWorkspaceFileEntries(jobId, { scope: "outputs" }).slice(0, limit);
  const render = (rows) => (
    rows.length > 0
      ? rows.map((row) => `- ${row.rel} (${formatByteSize(row.size)})`).join("\n")
      : "- (none)"
  );
  return [
    "workspace 파일 목록(최근):",
    "uploads:",
    render(uploads),
    "outputs:",
    render(outputs),
    "지시:",
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "- 매우 큰 파일은 목록만 참고하고 필요한 부분만 선택해 사용해라.",
  ].join("\n");
}

async function maybeAutoSendOutputs(bot, chatId, jobId, {
  when = "step",
  replyToMessageId = null,
} = {}) {
  if (!OUTPUT_AUTO_SEND) return;
  if (String(when || "").trim().toLowerCase() !== OUTPUT_AUTO_SEND_ON) return;
  await deliverWorkspaceOutputs(bot, chatId, jobId, {
    replyToMessageId,
    maxFiles: OUTPUT_AUTO_SEND_MAX_FILES,
  }).catch(() => null);
}

async function sendWorkspaceFileByRelativePath(bot, chatId, jobId, relativePath, { replyToMessageId = null } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const requested = String(relativePath || "").trim();
  if (!cleanJobId || !requested) {
    throw new Error("jobId and relative path are required");
  }
  const abs = jobs.resolveWorkspacePath(cleanJobId, requested);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw new Error(`file not found: ${requested}`);
  }
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    throw new Error("Path outside workspace");
  }
  if (!(rel.startsWith("uploads/") || rel.startsWith("outputs/"))) {
    throw new Error("only uploads/ or outputs/ paths are allowed");
  }
  if (Number(stat.size || 0) > TELEGRAM_SEND_MAX_BYTES) {
    throw new Error(
      `file is too large for sendDocument (limit=${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}, size=${formatByteSize(stat.size)})`
    );
  }
  await bot.sendDocument(
    chatId,
    abs,
    {
      caption: `📄 file\njob_id=${cleanJobId}\npath=${rel}`,
      reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
        ? Number(replyToMessageId)
        : undefined,
    }
  );
  return {
    abs,
    rel,
    size: Number(stat.size || 0),
  };
}

async function deliverWorkspaceOutputs(bot, chatId, jobId, { replyToMessageId = null, maxFiles = 4 } = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return;
  const sentIndexPath = resolveWorkspacePath(cleanJobId, "outputs/.telegram_sent.json");
  let sent = {};
  try {
    sent = JSON.parse(fs.readFileSync(sentIndexPath, "utf8"));
  } catch {
    sent = {};
  }

  const candidates = collectWorkspaceFileEntries(cleanJobId, { scope: "outputs" })
    .map((row) => ({
      ...row,
      key: `${row.rel}:${row.size}:${row.mtimeMs}`,
    }));

  const limit = Number.isFinite(Number(maxFiles))
    ? Math.max(1, Math.min(10, Math.floor(Number(maxFiles))))
    : 4;
  let sentCount = 0;
  for (const file of candidates) {
    if (sentCount >= limit) break;
    if (sent[file.key]) continue;
    if (Number(file.size || 0) <= 0) continue;
    if (Number(file.size || 0) > TELEGRAM_SEND_MAX_BYTES) {
      await bot.sendMessage(
        chatId,
        `📦 output 생성됨(sendDocument 한도 초과로 전송 생략)\njob_id=${cleanJobId}\npath=${file.rel}\nsize=${file.size}`,
        Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
          ? { reply_to_message_id: Number(replyToMessageId) }
          : undefined
      );
      sent[file.key] = { ts: new Date().toISOString(), path: file.rel, skipped: "too_large" };
      sentCount += 1;
      continue;
    }
    await bot.sendDocument(
      chatId,
      file.abs,
      {
        caption: `📦 output file\njob_id=${cleanJobId}\npath=${file.rel}`,
        reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
          ? Number(replyToMessageId)
          : undefined,
      }
    );
    sent[file.key] = { ts: new Date().toISOString(), path: file.rel, sent: true };
    sentCount += 1;
  }
  try {
    fs.writeFileSync(sentIndexPath, `${JSON.stringify(sent, null, 2)}\n`, "utf8");
  } catch {}
}

function convoToText(convo) {
  if (!convo || convo.length === 0) return "(none)";
  return convo.map(r => `- ${r.role}: ${r.text}`).join("\n");
}

async function sendLong(bot, chatId, text) {
  return sendLongAdapter(bot, chatId, text);
}

function ensureCommandOk(name, result) {
  if (result?.ok) return;
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : -1;
  const details = clip(String(result?.stderr || result?.stdout || "(no output)"), 1500);
  throw new Error(`${name} failed (exit=${exitCode})\n${details}`);
}

function refreshAgentRegistryLocal() {
  agentRegistry = loadAgents();
  return agentRegistry;
}

async function refreshAgentRegistry({ preferGoc = true, includeCompiled = true } = {}) {
  if (preferGoc && memoryModeWithFallback() === "goc") {
    try {
      agentRegistry = await loadAgentsFromGoc({
        client: requireGocClient(),
        baseDir: jobs.baseDir,
        includeCompiled,
      });
      return agentRegistry;
    } catch (e) {
      const reason = String(e?.message ?? e);
      gocInitError = gocInitError || reason;
    }
  }
  return refreshAgentRegistryLocal();
}

function resolveAgentId(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (!key) return "";
  return LEGACY_AGENT_MAP[key] || key;
}

function findAgentConfig(agentId) {
  const id = resolveAgentId(agentId);
  return getAgent(id, agentRegistry) || null;
}

function findAgentConfigInRuntime(agentId, runtime = null) {
  const key = String(agentId || "").trim().toLowerCase();
  const resolved = resolveAgentId(key);
  const targets = new Set([key, resolved].filter(Boolean));
  if (!targets.size) return null;
  const rows = [
    ...(Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : []),
    ...(Array.isArray(runtime?.agents) ? runtime.agents : []),
  ];
  for (const row of rows) {
    const rowId = String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase();
    const rowSystemKey = String(row?.system_key || row?.systemKey || "").trim().toLowerCase();
    if (rowId && targets.has(rowId)) return row;
    if (rowSystemKey && targets.has(rowSystemKey)) return row;
  }
  return null;
}

function memoryModeWithFallback() {
  if (MEMORY_MODE !== "goc") return "local";
  return gocReady && gocClient ? "goc" : "local";
}

function requireGocClient() {
  if (!gocReady || !gocClient) {
    const reason = gocInitError || "GoC is not ready";
    throw new Error(reason);
  }
  return gocClient;
}

function setGocActingTelegramUser(telegramUserId) {
  if (memoryModeWithFallback() !== "goc") return;
  try {
    const client = requireGocClient();
    if (typeof client.setActorTelegramUserId === "function") {
      client.setActorTelegramUserId(telegramUserId);
    }
  } catch {}
}

function bindGocActor(telegramUserId = "") {
  if (memoryModeWithFallback() !== "goc") return () => {};
  try {
    const client = requireGocClient();
    const prev = String(client.actorTelegramUserId || "").trim();
    const next = String(telegramUserId || "").trim();
    if (next && typeof client.setActorTelegramUserId === "function") {
      client.setActorTelegramUserId(next);
    }
    return () => {
      try {
        if (typeof client.setActorTelegramUserId === "function") {
          client.setActorTelegramUserId(prev);
        }
      } catch {}
    };
  } catch {
    return () => {};
  }
}

function installTrackingGocHook() {
  tracking.setAppendHook(async ({ jobId, docName, chunk }) => {
    if (memoryModeWithFallback() !== "goc") return;
    if (!TRACK_DOC_NAMES.includes(docName)) return;
    try {
      await appendTrackingChunkToGoc(requireGocClient(), {
        jobId,
        jobDir: runDir(jobId),
        docName,
        chunkText: String(chunk || ""),
      });
    } catch (e) {
      jobs.log(jobId, `GoC append hook failed (${docName}): ${String(e?.message ?? e)}`);
    }
  });
}

installTrackingGocHook();

function formatMemorySummary() {
  const s = memory.getSummary();
  const role = memory.getAgentRoleSummary();
  return [
    "🧠 현재 메모리 기반 설정",
    `memory.mode=${MEMORY_MODE}`,
    `memory.effective=${memoryModeWithFallback()}`,
    ...(gocInitError ? [`memory.goc_error=${gocInitError}`] : []),
    `memory.file=${s.filePath}`,
    "",
    "Auto-Suggest Reflection Prompt (preview):",
    s.policyPreview || "(empty)",
    "",
    "Multi-Agent Router Prompt (preview):",
    s.routerPreview || "(empty)",
    "",
    "Agent Roles (preview):",
    `[Gemini]\n${role.geminiPreview}`,
    "",
    `[Codex]\n${role.codexPreview}`,
    "",
    `[ChatGPT]\n${role.chatgptPreview}`,
    "",
    `operator_notes=${s.noteCount}`,
    `recent_lessons=${s.lessonCount}`,
    "",
    "명령:",
    "/memory show",
    "/memory md",
    "/memory policy <자연어 프롬프트>",
    "/memory routing <자연어 프롬프트>",
    "/memory role <gemini|codex|chatgpt> <자연어 역할>",
    "/memory agents",
    "/memory note <메모>",
    "/memory lesson <교훈>",
    "/memory reset",
    "",
    "호환 alias:",
    "/settings ...  (=/memory ...)",
  ].join("\n");
}

function formatRunningJobs(chatId) {
  const chatKey = String(chatId);
  const active = activeJobByChat.get(chatKey) || "";
  const awaitingJob = getAwait(chatId)?.jobId || "";
  const lastChatJob = lastChatJobByChat.get(chatKey) || "";
  const running = Array.from(jobAbortControllers.keys());
  const queued = queue
    .map((item) => String(item?.jobId || "").trim())
    .filter(Boolean);
  const dedup = (list) => Array.from(new Set(list.filter(Boolean)));

  const lines = [
    "🏃 Running jobs",
    `chat_active=${active || "(none)"}`,
    `chat_gptawait=${awaitingJob || "(none)"}`,
    `chat_last=${lastChatJob || "(none)"}`,
    `running_count=${running.length}`,
    ...dedup(running).map((id) => `- running: ${id}`),
    `queue_count=${queued.length}`,
    ...dedup(queued).map((id) => `- queued: ${id}`),
    "",
    "중단: /stop <jobId>",
  ];
  return lines.join("\n");
}

function listPendingManualApprovals(jobId) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  let approvalsDir = "";
  try {
    approvalsDir = path.join(jobs.jobDir(cleanJobId), "approvals");
  } catch {
    return [];
  }
  if (!approvalsDir || !fs.existsSync(approvalsDir)) return [];
  const files = fs.readdirSync(approvalsDir, { withFileTypes: true })
    .filter((row) => row.isFile() && row.name.endsWith(".json"))
    .map((row) => row.name)
    .slice(0, 40);
  const pending = [];
  for (const name of files) {
    try {
      const filePath = path.join(approvalsDir, name);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (String(parsed?.status || "").trim().toLowerCase() !== "pending") continue;
      pending.push({
        token: String(parsed?.token || "").trim(),
        purpose: String(parsed?.purpose || "").trim(),
        summary: String(parsed?.summary || "").trim(),
      });
    } catch {}
  }
  return pending.slice(0, 5);
}

function buildChatStatusCard(chatId, runtime = null) {
  const chatKey = String(chatId || "");
  const session = chatSessionStore.get(chatId);
  const activeJobId = activeJobByChat.get(chatKey) || "";
  const currentJobId = String(
    session.jobId
    || activeJobId
    || resolveCurrentJobIdForChat(chatId)
    || ""
  ).trim();
  const queueItems = queue.filter((item) => String(item?.jobId || "").trim() === currentJobId);
  const activeController = currentJobId ? jobAbortControllers.get(currentJobId) : null;
  const interrupt = session.interrupt && typeof session.interrupt === "object" ? session.interrupt : null;
  const pendingApproval = session.pending_approval && typeof session.pending_approval === "object"
    ? session.pending_approval
    : null;
  const pendingApprovalActionLabel = pendingApproval?.action
    ? chatActionLabel(pendingApproval.action)
    : "";
  const lastRoute = session.last_route && typeof session.last_route === "object"
    ? session.last_route
    : null;
  const manualApprovals = listPendingManualApprovals(currentJobId);
  const enabledAgents = runtime?.agentSelection?.enabled_ids || runtime?.enabledAgentIds || [];
  const enabledTools = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];

  const lines = [
    "📋 현재 상태",
    `- state: ${session.state || "idle"}`,
    `- job_id: ${currentJobId || "(none)"}`,
    `- active_run_id: ${session.active_run_id || "(none)"}`,
    `- running: ${activeJobId ? "yes" : "no"}`,
    `- queue_for_job: ${queueItems.length}`,
    `- abort_signal: ${activeController ? (activeController.signal.aborted ? "aborted" : "active") : "none"}`,
    `- pending_interrupt: ${interrupt?.requested ? `${interrupt.mode}${interrupt.reason ? ` (${clip(interrupt.reason, 90)})` : ""}` : "none"}`,
    `- pending_approval: ${pendingApproval ? (pendingApproval.reason || "yes") : "none"}`,
    pendingApprovalActionLabel ? `- pending_approval_action: ${pendingApprovalActionLabel}` : "",
    lastRoute
      ? `- last_route: ${String(lastRoute.reason || "(none)")}, actions=${Array.isArray(lastRoute.actions) ? lastRoute.actions.length : 0}`
      : "",
    `- pending_user_messages: ${Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0}`,
    manualApprovals.length > 0 ? `- pending_manual_approvals: ${manualApprovals.length}` : "",
  ];
  if (manualApprovals.length > 0) {
    for (const row of manualApprovals) {
      lines.push(`  - ${row.purpose || "approval"}: ${clip(row.summary || row.token || "", 120)}`);
    }
  }
  if (Array.isArray(enabledAgents) && enabledAgents.length > 0) {
    lines.push(`- enabled_agents: ${enabledAgents.map((id) => `@${id}`).join(", ")}`);
  }
  if (Array.isArray(enabledTools) && enabledTools.length > 0) {
    lines.push(`- enabled_tools: ${enabledTools.join(", ")}`);
  }
  if (runtime?.jobConfigDebugSummary) {
    lines.push(`- job_config(debug): ${clip(String(runtime.jobConfigDebugSummary || ""), 240)}`);
  }
  return {
    text: lines.join("\n"),
    status: {
      chat_id: chatKey,
      state: session.state || "idle",
      job_id: currentJobId || null,
      active_run_id: session.active_run_id || null,
      running: !!activeJobId,
      queue_for_job: queueItems.length,
      pending_interrupt: interrupt,
      pending_approval: pendingApproval,
      pending_user_messages: Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0,
      enabled_agents: Array.isArray(enabledAgents) ? enabledAgents : [],
      enabled_tools: Array.isArray(enabledTools) ? enabledTools : [],
    },
  };
}

function getAgentRolesText() {
  const roles = memory.getAgentRoles();
  return [
    "### Gemini",
    roles.gemini,
    "",
    "### Codex",
    roles.codex,
    "",
    "### ChatGPT",
    roles.chatgpt,
  ].join("\n");
}

async function getRegisteredAgentsText() {
  await refreshAgentRegistry();
  if (!agentRegistry.agents.length) return "(none)";
  return agentRegistry.agents
    .map((row) => `- id=${row.id}, provider=${row.provider}, model=${row.model}, prompt=${clip(row.prompt || "", 220)}`)
    .join("\n");
}

function formatAgentMemorySummary() {
  const roles = memory.getAgentRoles();
  return [
    "🤖 Multi-Agent 역할 메모리",
    "",
    "Gemini",
    roles.gemini,
    "",
    "Codex",
    roles.codex,
    "",
    "ChatGPT",
    roles.chatgpt,
    "",
    "Router Prompt",
    memory.getRouterPrompt(),
  ].join("\n");
}

function parseAutoSuggestDecision(raw) {
  return parseAutoSuggestDecisionShared(raw);
}

function parseJsonObjectFromText(raw) {
  return parseJsonObjectFromTextShared(raw);
}

function parseRouterPlan(raw) {
  return parseRouterPlanDomain(raw, { resolveAgentId });
}

// concurrency gate
let running = 0;
const queue = [];
const jobRuntimeState = createJobRuntimeState();
const { jobAbortControllers, activeJobByChat, lastChatJobByChat } = jobRuntimeState;
const agentStatusMessageStateByChat = new Map(); // chatId -> Map(agentId, { state, atMs })

function makeCancelledError(jobId) {
  return makeCancelledErrorDomain(jobId);
}

function isCancelledError(e) {
  return isCancelledErrorDomain(e);
}

function resetJobAbortController(jobId) {
  return jobRuntimeState.resetJobAbortController(jobId);
}

function cancelJobExecution(jobId) {
  return jobRuntimeState.cancelJobExecution(jobId, queue);
}

function requestChatInterrupt(chatId, { mode = "replan", reason = "" } = {}) {
  const chatKey = String(chatId || "");
  const interruptMode = String(mode || "").trim().toLowerCase() === "cancel" ? "cancel" : "replan";
  const targetJobId = resolveCurrentJobIdForChat(chatId);
  const result = targetJobId
    ? cancelJobExecution(targetJobId)
    : { aborted: false, dropped: 0 };

  chatSessionStore.upsert(chatId, (session) => ({
    ...session,
    jobId: String(targetJobId || session.jobId || "").trim(),
    interrupt: {
      requested: true,
      mode: interruptMode,
      reason: String(reason || "").trim(),
      ts: new Date().toISOString(),
    },
    pending_approval: interruptMode === "cancel" ? null : session.pending_approval,
    pending_user_messages: interruptMode === "cancel" ? [] : session.pending_user_messages,
    state: interruptMode === "cancel"
      ? "idle"
      : (session.pending_approval ? "awaiting_approval" : session.state),
  }));

  if (interruptMode === "cancel") {
    if (activeJobByChat.get(chatKey) === String(targetJobId || "")) {
      activeJobByChat.delete(chatKey);
    }
    clearAwait(chatId);
  }

  return {
    jobId: String(targetJobId || "").trim(),
    mode: interruptMode,
    ...result,
  };
}

async function enqueue(fn, { jobId = "", signal = null, label = "" } = {}) {
  return await new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject, jobId: String(jobId || ""), signal, label });
    pump();
  });
}
async function pump() {
  if (running >= MAX_CONCURRENCY) return;
  const item = queue.shift();
  if (!item) return;
  if (item.signal?.aborted) {
    item.reject(makeCancelledError(item.jobId || "unknown"));
    pump();
    return;
  }
  running += 1;
  try { item.resolve(await item.fn()); } catch (e) { item.reject(e); } finally { running -= 1; pump(); }
}

async function createJob(goal, { ownerUserId = null, ownerChatId = null } = {}) {
  await refreshAgentRegistry();
  const job = jobs.createJob({
    title: goal.slice(0, 80),
    ownerUserId,
    ownerChatId,
  });
  tracking.init(job.jobId);
  tracking.append(job.jobId, "plan.md", orchestratorNotes({ goal }), { timestamp: false });
  tracking.append(job.jobId, "research.md", `## Goal\n\n${goal}\n`, { timestamp: false });
  tracking.append(job.jobId, "progress.md", `## Started\n- goal: ${goal}\n`, { timestamp: false });
  jobs.appendConversation(job.jobId, "user", goal, { kind: "goal" });
  return job;
}

async function geminiResearch(jobId, goal, signal = null, opts = {}) {
  const sectionTitle = String(opts.sectionTitle || "Gemini notes");
  const outputGuide = String(opts.outputGuide || "").trim();
  const concurrencyKey = String(opts.concurrencyKey || "").trim() || `job:${String(jobId || "").trim()}`;
  const preferredModel = String(opts.model || "").trim();
  const roleMemo = memory.getAgentRole("gemini");
  const ctx = await loadContextDocs(jobId, ["research.md"]);
  const workspacePath = runWorkspaceDir(jobId);
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, { limitPerBucket: 5 });
  const prompt = [
    ctx,
    "",
    "역할 메모리:",
    roleMemo,
    "",
    `run workspace: ${workspacePath}`,
    `tracking docs dir: ${runSharedDir(jobId)}`,
    "",
    workspaceFilesText,
    "",
    "제약:",
    "- 코드 작성/수정/패치 제안 금지",
    "- 터미널 명령 제안 최소화",
    "- 설계/리스크/검증 관점으로만 답변",
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "",
    "다음 목표를 달성하기 위한 구현 단계와 리스크를 한국어로 간결하게 작성해줘.",
    "",
    `목표: ${goal}`,
    "",
    outputGuide || [
      "출력:",
      "- 요약",
      "- 구현 단계(번호)",
      "- 리스크/주의",
      "- 검증(테스트/체크)",
    ].join("\n"),
  ].join("\n");
  const r = await runGeminiPrompt({
    workspaceRoot: workspacePath,
    cwd: workspacePath,
    prompt,
    signal,
    model: preferredModel || "",
    concurrencyKey,
    jobId,
    onRetry: opts.onGeminiRetry,
    onModelSwitch: opts.onGeminiModelSwitch,
    onGiveUp: opts.onGeminiGiveUp,
  });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "research.md", `## ${sectionTitle}\n\n${out}\n`);
  jobs.appendConversation(jobId, "gemini", out, { kind: "research" });
  ensureCommandOk("Gemini", r);
  return out;
}

async function codexImplement(jobId, instruction, signal = null) {
  const roleMemo = memory.getAgentRole("codex");
  const ctx = await loadContextDocs(jobId, ["plan.md", "research.md"], 6000);
  const trackDocs = TRACK_DOC_NAMES.map(n => `- ${path.join(runSharedDir(jobId), n)}`).join("\n");
  const workspacePath = runWorkspaceDir(jobId);
  const workspaceFilesText = buildWorkspaceFilesPromptSection(jobId, { limitPerBucket: 5 });
  const prompt = [
    ctx,
    "",
    "역할 메모리:",
    roleMemo,
    "",
    "너는 코드 수정 에이전트다.",
    "규칙:",
    "- 네트워크 접근 금지.",
    `- CODEX_WORKSPACE_ROOT(코드 작업 영역) 내부 파일만 수정: ${workspacePath}`,
    `- 현재 run workspace: ${workspacePath}`,
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "- 아래 트래킹 문서는 run/shared에서만 관리하고, CODEX_WORKSPACE_ROOT 루트에 동명 파일을 만들지 말 것:",
    trackDocs,
    "",
    workspaceFilesText,
    "- 테스트 실행은 하지 말고, 필요한 테스트를 제안만.",
    "- 변경 요약(파일별 이유) 포함.",
    "",
    "작업:",
    instruction,
    "",
  ].join("\n");
  const r = await runCodexExec({
    workspaceRoot: workspacePath,
    cwd: workspacePath,
    prompt,
    signal,
    jobId,
  });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "progress.md", `## Codex output\n\n${out}\n`);
  jobs.appendConversation(jobId, "codex", out, { kind: "implementation" });
  ensureCommandOk("Codex", r);
  return out;
}

async function gitSummary(jobId, signal = null) {
  const commandCwd = runWorkspaceDir(jobId);
  const status = await runCommand("git", ["status", "--porcelain=v1"], { cwd: commandCwd, abortSignal: signal });
  if (!status.ok && /not a git repository/i.test(String(status.stderr || ""))) {
    const note = `workspace is not a git repository: ${commandCwd}`;
    tracking.append(jobId, "progress.md", `## git status\n\n${note}\n`);
    return { status: "", diff: "", note };
  }
  const diff = await runCommand("git", ["diff"], { cwd: commandCwd, timeoutMs: 120000, abortSignal: signal });
  ensureCommandOk("git status", status);
  ensureCommandOk("git diff", diff);

  tracking.append(jobId, "progress.md", `## git status\n\n${FENCE}\n${status.stdout}\n${FENCE}\n`);
  tracking.append(jobId, "progress.md", `## git diff\n\n${FENCE}diff\n${diff.stdout}\n${FENCE}\n`);

  return { status: status.stdout || "", diff: diff.stdout || "" };
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
    const orchestration = buildRuntimeOrchestration({
      mode,
      goal,
      seedInstruction,
      routePlan: planned || fallbackRoute,
      registry: agentRegistry,
      preferredRoles: [],
      maxAgents: 6,
      resolveAgentId,
    });
    return {
      actions: Array.isArray(orchestration?.route_plan?.actions) && orchestration.route_plan.actions.length > 0
        ? orchestration.route_plan.actions
        : fallbackRoute.actions,
      reason: String(orchestration?.route_plan?.reason || planned?.reason || fallbackRoute.reason || "router route").trim(),
      team_plan: orchestration?.team_plan || null,
      runtime_agents: orchestration?.runtime_agents || [],
      runtime_team_snapshot: orchestration?.runtime_team_snapshot || null,
    };
  } catch {
    const fallbackRoute = defaultRouteFor(mode, goal, seedInstruction);
    const orchestration = buildRuntimeOrchestration({
      mode,
      goal,
      seedInstruction,
      routePlan: fallbackRoute,
      registry: agentRegistry,
      preferredRoles: [],
      maxAgents: 6,
      resolveAgentId,
    });
    return {
      actions: Array.isArray(orchestration?.route_plan?.actions) && orchestration.route_plan.actions.length > 0
        ? orchestration.route_plan.actions
        : fallbackRoute.actions,
      reason: String(orchestration?.route_plan?.reason || fallbackRoute.reason || "router fallback").trim(),
      team_plan: orchestration?.team_plan || null,
      runtime_agents: orchestration?.runtime_agents || [],
      runtime_team_snapshot: orchestration?.runtime_team_snapshot || null,
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
  if (act.type === "agent_run") return `agent_run:${act.agent}`;
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

function chatActionLabel(action) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) return "(unknown)";
  if (type === "run_agent") return `run_agent:${action.agent_id || action.agent || "unknown"}`;
  if (type === "propose_agent") return `propose_agent:${action.agent_id || action.agent || "unknown"}`;
  if (type === "need_more_detail") return `need_more_detail:${action.context_set_id || "ctx"}`;
  if (type === "search_public_agents") return `search_public_agents:${action.query || ""}`;
  if (type === "install_agent_blueprint") return `install_agent_blueprint:${action.blueprint_id || action.public_node_id || ""}`;
  if (type === "publish_agent") return `publish_agent:${action.agent_id || action.agent_node_id || ""}`;
  if (type === "add_agent_to_conversation") return `add_agent_to_conversation:${action.agent_id || "unknown"}`;
  if (type === "remove_agent_from_conversation") return `remove_agent_from_conversation:${action.agent_id || "unknown"}`;
  if (type === "create_agent_definition") return `create_agent_definition:${action.agent_spec?.id || action.agent_spec?.name || action.agent_id || "unknown"}`;
  if (type === "fork_agent") return `fork_agent:${action.agent_id || "unknown"}`;
  if (type === "disable_agent") return `disable_agent:${action.agent_id || "unknown"}`;
  if (type === "enable_agent") return `enable_agent:${action.agent_id || "unknown"}`;
  if (type === "disable_tool") return `disable_tool:${action.tool_id || "unknown"}`;
  if (type === "enable_tool") return `enable_tool:${action.tool_id || "unknown"}`;
  if (type === "list_agents") return "list_agents";
  if (type === "list_tools") return "list_tools";
  if (type === "create_agent") return `create_agent:${action.agent?.id || action.agent_id || "unknown"}`;
  if (type === "update_agent") return `update_agent:${action.agentId || action.agent_id || "unknown"}`;
  if (type === "get_status") return "get_status";
  if (type === "interrupt") return `interrupt:${action.mode || "replan"}`;
  if (type === "spawn_agents") return `spawn_agents:${Array.isArray(action.agents) ? action.agents.length : 0}`;
  if (type === "open_context") return `open_context:${action.scope || "current"}`;
  return type;
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
  if (!action || typeof action !== "object") return "";
  return String(action.goal || action.prompt || action.task || "").trim();
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
  const rows = Array.isArray(actions) ? actions : [];
  const lines = [];
  for (const action of rows) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const agentId = String(action.agent_id || action.agent || "").trim().toLowerCase() || "unknown";
      const goal = clip(getActionGoal(action) || "(goal 없음)", 220);
      lines.push(`- @${agentId}: ${goal}`);
      continue;
    }
    if (type === "spawn_agents") {
      const children = Array.isArray(action.agents) ? action.agents : [];
      if (children.length === 0) {
        lines.push(`- (system) ${chatActionLabel(action)}`);
        continue;
      }
      for (const child of children) {
        const childId = String(child?.agent_id || child?.agent || "").trim().toLowerCase() || "unknown";
        const goal = clip(String(child?.goal || child?.prompt || child?.task || "(goal 없음)"), 220);
        lines.push(`- @${childId}: ${goal}`);
      }
      continue;
    }
    lines.push(`- (system) ${chatActionLabel(action)}`);
  }
  if (lines.length === 0) lines.push("- (system) no actions");
  return lines;
}

function buildQueuedAgentStatusFromActions(actions = []) {
  const rows = Array.isArray(actions) ? actions : [];
  const out = {};
  for (const action of rows) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const agentId = String(action.agent_id || action.agent || "").trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: "queued",
        goal: getActionGoal(action),
      };
      continue;
    }
    if (type !== "spawn_agents") continue;
    const children = Array.isArray(action.agents) ? action.agents : [];
    for (const child of children) {
      const agentId = String(child?.agent_id || child?.agent || "").trim().toLowerCase();
      if (!agentId || out[agentId]) continue;
      out[agentId] = {
        state: "queued",
        goal: String(child?.goal || child?.prompt || child?.task || "").trim(),
      };
    }
  }
  return out;
}

function buildAgentStatusLines(agentStatusMap = {}) {
  const map = agentStatusMap && typeof agentStatusMap === "object" ? agentStatusMap : {};
  const entries = Object.entries(map);
  if (entries.length === 0) return ["- (agent 없음)"];
  const stateEmoji = {
    queued: "⏳",
    running: "🏃",
    done: "✅",
    error: "❌",
  };
  return entries
    .map(([agentIdRaw, rowRaw]) => {
      const agentId = String(agentIdRaw || "").trim().toLowerCase();
      if (!agentId) return "";
      const row = rowRaw && typeof rowRaw === "object" ? rowRaw : {};
      const state = String(row.state || "").trim().toLowerCase();
      const normalizedState = ["queued", "running", "done", "error"].includes(state)
        ? state
        : "queued";
      const emoji = stateEmoji[normalizedState] || "⏳";
      return `- @${agentId} ${emoji} ${normalizedState}`;
    })
    .filter(Boolean);
}

function buildRoutedDashboardText({ actions = [], agentStatus = {} } = {}) {
  const planLines = buildPlanPreviewLines(actions);
  const statusLines = buildAgentStatusLines(agentStatus);
  return [
    "🧭 분담(아래) + 상태판(아래)",
    "🧭 분담",
    ...planLines,
    "",
    "📡 상태",
    ...statusLines,
  ].join("\n");
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
  const cleanState = String(state || "").trim().toLowerCase();
  if (cleanState === "running") {
    return `▶️ @${cleanAgentId} 시작: ${clip(String(goal || "").trim() || "(goal 없음)", 240)}`;
  }
  if (cleanState === "done") {
    return `✅ @${cleanAgentId} 완료`;
  }
  if (cleanState === "error") {
    return `❌ @${cleanAgentId} 실패: ${clip(String(error || "unknown error"), 240)}`;
  }
  return `ℹ️ @${cleanAgentId} 상태: ${cleanState || "queued"}`;
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

function buildGeminiRetryNoticeText({ retryCount = 0, maxRetries = 0, agentId = "" } = {}) {
  const cleanRetry = Math.max(1, Math.floor(Number(retryCount) || 1));
  const cleanMax = Math.max(cleanRetry, Math.floor(Number(maxRetries) || cleanRetry));
  const suffix = String(agentId || "").trim().toLowerCase();
  return suffix
    ? `⏳ Gemini 혼잡으로 재시도 중 (${cleanRetry}/${cleanMax})… (@${suffix})`
    : `⏳ Gemini 혼잡으로 재시도 중 (${cleanRetry}/${cleanMax})…`;
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
  await bot.sendMessage(
    chatId,
    buildGeminiRetryNoticeText({ retryCount, maxRetries, agentId }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

function buildGeminiModelSwitchNoticeText({ toModel = "", agentId = "" } = {}) {
  const modelText = clip(String(toModel || "auto"), 120);
  const suffix = String(agentId || "").trim().toLowerCase();
  return suffix
    ? `🔁 혼잡 회피를 위해 모델을 ${modelText}로 전환했어요. (@${suffix})`
    : `🔁 혼잡 회피를 위해 모델을 ${modelText}로 전환했어요.`;
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
  await bot.sendMessage(
    chatId,
    buildGeminiModelSwitchNoticeText({ toModel, agentId }),
    replyId ? { reply_to_message_id: replyId } : undefined
  );
}

function buildGeminiGiveUpNoticeText({ reason = "", agentId = "" } = {}) {
  const suffix = String(agentId || "").trim().toLowerCase();
  const cleanReason = String(reason || "").trim().toLowerCase();
  const base = cleanReason === "model_not_found"
    ? "❌ Gemini 모델을 찾을 수 없어요(모델명/권한 문제).\nworkspace 설정(.gemini/settings.json)의 model.name을 제거하거나,\nGEMINI_WORKSPACE_MODEL/GEMINI_MODEL_PRIMARY를 사용 가능한 모델로 설정하세요.\n(gemini CLI에서 /model로 확인 가능)"
    : "❌ Gemini 혼잡이 지속돼요. 잠시 후 재시도하거나 모델/도구를 바꿀게요.";
  return suffix ? `${base} (@${suffix})` : base;
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
  await bot.sendMessage(
    chatId,
    buildGeminiGiveUpNoticeText({ reason, agentId }),
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
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase())
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const okCount = (Array.isArray(results) ? results : []).filter((row) => String(row?.status || "") === "ok").length;
  const errorCount = (Array.isArray(results) ? results : []).filter((row) => String(row?.status || "") === "error").length;
  const outputPreview = (Array.isArray(outputs) ? outputs : [])
    .slice(-3)
    .map((row) => `- ${String(row?.agentId || "system")}: ${clip(String(row?.output || ""), 120)}`)
    .filter(Boolean)
    .join("\n");
  const suggestedPreview = (Array.isArray(suggestedActions) ? suggestedActions : [])
    .slice(0, 6)
    .map((action) => `- ${chatActionLabel(action)}`)
    .join("\n");
  return [
    `autopilot_turn=${turn}/${maxTurns}`,
    allDeliverables.length > 0 ? `deliverables=${allDeliverables.join(" | ")}` : "deliverables=(none)",
    doneSet.size > 0 ? `completed=${Array.from(doneSet).join(" | ")}` : "completed=(none)",
    remaining.length > 0 ? `remaining=${remaining.join(" | ")}` : "remaining=(none)",
    `last_results: ok=${okCount}, error=${errorCount}`,
    followupHint ? `last_followup_hint=${followupHint}` : "",
    outputPreview ? "last_outputs:\n" + outputPreview : "",
    suggestedPreview ? "agent_suggested_actions:\n" + suggestedPreview : "",
  ].filter(Boolean).join("\n");
}

function buildAutopilotFollowupMessage({
  originalUserText = "",
  deliverables = [],
  completedDeliverables = [],
  followupHint = "",
  suggestedActions = [],
} = {}) {
  const allDeliverables = normalizeDeliverableList(deliverables, { max: 24 });
  const doneSet = new Set(
    normalizeDeliverableList(completedDeliverables, { max: 24 }).map((row) => row.toLowerCase())
  );
  const remaining = allDeliverables.filter((row) => !doneSet.has(row.toLowerCase()));
  const suggestedLines = (Array.isArray(suggestedActions) ? suggestedActions : [])
    .slice(0, 5)
    .map((action) => `- ${chatActionLabel(action)}`)
    .join("\n");
  return [
    "자동 연속 실행 지시: 이전 턴 결과를 이어서 남은 산출물을 진행하라.",
    `원 요청: ${String(originalUserText || "").trim()}`,
    remaining.length > 0 ? `남은 deliverables: ${remaining.join(" | ")}` : "남은 deliverables 없음(완료 검증 필요)",
    followupHint ? `followup_hint: ${followupHint}` : "",
    suggestedLines ? `agent_suggested_actions:\n${suggestedLines}` : "",
    "필요 시 연구->코드->검토 순으로 다음 step을 배치하라.",
  ].filter(Boolean).join("\n");
}

function updateCompletedDeliverablesFromOutputs(deliverables = [], completed = [], outputs = []) {
  const all = normalizeDeliverableList(deliverables, { max: 24 });
  const done = new Set(
    normalizeDeliverableList(completed, { max: 24 }).map((row) => row.toLowerCase())
  );
  const rows = Array.isArray(outputs) ? outputs : [];
  const hasCoderOutput = rows.some((row) => String(row?.agentId || "").trim().toLowerCase() === "coder");
  const hasResearchOutput = rows.some((row) => {
    const agentId = String(row?.agentId || "").trim().toLowerCase();
    return agentId === "researcher" || agentId === "planner";
  });
  const joinedText = rows.map((row) => String(row?.output || "")).join("\n").toLowerCase();

  for (const item of all) {
    const key = String(item || "").trim().toLowerCase();
    if (!key || done.has(key)) continue;
    if (/코드|ipynb|notebook|노트북|jupyter|실습|coding|python/.test(key)) {
      if (hasCoderOutput || /```python|\.ipynb|jupyter|notebook|코드/.test(joinedText)) done.add(key);
      continue;
    }
    if (/주제|아이디어|토픽|proposal|research|리서치/.test(key)) {
      if (hasResearchOutput || /주제|아이디어|토픽|research/.test(joinedText)) done.add(key);
      continue;
    }
    if (/과제|assignment|문항|quiz|연습문제/.test(key)) {
      if (/과제|assignment|문항|quiz|문제/.test(joinedText)) done.add(key);
      continue;
    }
  }

  const out = [];
  for (const item of all) {
    const key = String(item || "").trim().toLowerCase();
    if (done.has(key)) out.push(item);
  }
  return normalizeDeliverableList(out, { max: 24 });
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

function normalizeAgentLookupKey(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "");
}

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
  const text = String(taskText || "").toLowerCase();
  if (!text) return false;
  return text.includes("team 구성")
    || text.includes("agent team")
    || text.includes("팀 짜")
    || text.includes("구성해줘")
    || text.includes("세팅해줘")
    || text.includes("적합한 agent들")
    || text.includes("적합한 에이전트");
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

  if (dedupedProposals <= 0 && droppedCreates <= 0) return routePlan;

  let finalActions = rewrittenActions;
  let reason = String(routePlan.reason || "supervisor route").trim() || "supervisor route";

  if (finalActions.length === 0 && routePlan.done !== true && routePlan.await_user !== true) {
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

  reason = `${reason}; deduped_proposals=${dedupedProposals}; dropped_creates=${droppedCreates}; survived_creates=${survivedCreates}`;
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
  const explicit = String(pending?.preview_reason || pending?.reason || "").trim();
  if (explicit) return explicit;
  const type = String(pending?.action?.type || "").trim().toLowerCase();
  if ([
    "create_agent",
    "update_agent",
    "propose_agent",
    "enable_agent",
    "disable_agent",
    "enable_tool",
    "disable_tool",
  ].includes(type)) return "agent/tool 설정 변경";
  if (["publish_agent", "install_agent_blueprint"].includes(type)) return "publish/install";
  return "외부 상태 변경 가능성";
}

function buildApprovalActionSummaryLines(pending = {}) {
  if (Array.isArray(pending?.actions_summary) && pending.actions_summary.length > 0) {
    return pending.actions_summary
      .map((row) => String(row || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => row.startsWith("- ") ? row : `- ${row}`);
  }
  if (Array.isArray(pending?.preview_lines) && pending.preview_lines.length > 0) {
    return pending.preview_lines
      .map((row) => String(row || "").trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((row) => row.startsWith("- ") ? row : `- ${row}`);
  }
  const remaining = Array.isArray(pending?.remaining_actions) ? pending.remaining_actions : [];
  if (remaining.length > 0) {
    return remaining
      .slice(0, 8)
      .map((action) => `- ${chatActionLabel(action)}`);
  }
  return [`- ${chatActionLabel(pending?.action)}`];
}

function buildPendingApprovalPrompt(pending = {}) {
  return buildPendingApprovalPromptAdapter(pending, {
    inferReason: inferApprovalPreviewReason,
    buildActionLines: buildApprovalActionSummaryLines,
  });
}

function formatChatSummary(routePlan, results) {
  return formatChatSummaryAdapter(routePlan, results);
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

function pickPrimaryChatOutput(outputs) {
  const rows = Array.isArray(outputs) ? outputs : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.agentId === "researcher") return String(rows[i]?.output || "").trim();
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (String(rows[i]?.provider || "").trim().toLowerCase() === "gemini") return String(rows[i]?.output || "").trim();
  }
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const out = String(rows[i]?.output || "").trim();
    if (out) return out;
  }
  return "";
}

function summarizeSpecialChatOutputs(outputs) {
  const rows = Array.isArray(outputs) ? outputs : [];
  const searchRows = rows.filter((row) => String(row?.mode || "") === "public_search");
  const installRows = rows.filter((row) => String(row?.mode || "") === "install_agent_blueprint");
  const publishRows = rows.filter((row) => String(row?.mode || "") === "publish_agent_request");
  const selectionRows = rows.filter((row) => String(row?.mode || "") === "job_config_selection");
  const statusRows = rows.filter((row) => String(row?.mode || "") === "get_status");
  const interruptRows = rows.filter((row) => String(row?.mode || "") === "interrupt");
  const agentWriteRows = rows.filter((row) => {
    const mode = String(row?.mode || "");
    return mode === "create_agent" || mode === "update_agent";
  });
  const spawnRows = rows.filter((row) => String(row?.mode || "") === "spawn_agents");
  const listRows = rows.filter((row) => {
    const mode = String(row?.mode || "");
    return mode === "list_agents" || mode === "list_tools";
  });
  const lines = [];

  for (const row of searchRows) {
    const items = Array.isArray(row?.items) ? row.items : [];
    lines.push("Public agent 검색 결과");
    if (items.length === 0) {
      lines.push("- 검색 결과가 없습니다.");
      continue;
    }
    for (const item of items.slice(0, 6)) {
      const agentId = String(item?.agent_id || "").trim();
      const title = String(item?.title || "").trim() || String(item?.blueprint_id || "").trim();
      const blueprintId = String(item?.blueprint_id || "").trim();
      const tags = Array.isArray(item?.tags) && item.tags.length > 0 ? ` tags=${item.tags.join(",")}` : "";
      lines.push(`- ${title} (${agentId ? `@${agentId}` : "agent:n/a"}, blueprint=${blueprintId || "n/a"})${tags}`);
    }
  }

  for (const row of installRows) {
    const agentId = String(row?.installed_agent_id || "").trim().toLowerCase();
    if (agentId) {
      lines.push(`설치 완료: @${agentId}`);
      lines.push(`이제 @${agentId} 로 사용 가능`);
    } else {
      lines.push("설치 완료");
    }
  }

  for (const row of publishRows) {
    const requestId = String(row?.request_id || "").trim();
    if (requestId) {
      lines.push(`공개 요청 접수됨: request_id=${requestId}`);
    } else {
      lines.push("공개 요청이 생성되었습니다.");
    }
    lines.push("관리자 승인 후 public library에 반영됩니다.");
  }

  for (const row of selectionRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  for (const row of statusRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  for (const row of interruptRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  for (const row of agentWriteRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  for (const row of spawnRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  for (const row of listRows) {
    const text = String(row?.output || "").trim();
    if (text) lines.push(text);
  }

  return lines.join("\n").trim();
}

function buildChatSynthesisFallback(message, execution = {}) {
  const special = summarizeSpecialChatOutputs(execution.outputs);
  if (special) return special;
  const primary = pickPrimaryChatOutput(execution.outputs);
  if (primary) return clip(primary, 3600);

  const errors = (Array.isArray(execution.results) ? execution.results : [])
    .filter((row) => row?.status === "error")
    .map((row) => String(row?.note || "").trim())
    .filter(Boolean);
  if (errors.length > 0) {
    return `요청을 처리하는 중 오류가 발생했습니다.\n${errors.map((row) => `- ${row}`).join("\n")}`;
  }
  const oks = (Array.isArray(execution.results) ? execution.results : [])
    .filter((row) => row?.status === "ok")
    .map((row) => `${row?.label || "action"}${row?.note ? ` (${row.note})` : ""}`);
  if (oks.length > 0) {
    return `요청을 처리했습니다.\n${oks.map((row) => `- ${row}`).join("\n")}`;
  }
  return `요청: ${clip(String(message || ""), 300)}\n응답을 생성하지 못했습니다. 같은 요청을 다시 보내주세요.`;
}

async function synthesizeChatReply(message, routePlan, execution = {}) {
  const outputs = Array.isArray(execution.outputs) ? execution.outputs : [];
  if (outputs.length === 0) return buildChatSynthesisFallback(message, execution);
  const special = summarizeSpecialChatOutputs(outputs);
  const hasAgentOutput = outputs.some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
  if (special && !hasAgentOutput) return special;

  const outputText = outputs
    .map((row, idx) => [
      `## output_${idx + 1}`,
      `agent=${row.agentId || "unknown"}`,
      `provider=${row.provider || "unknown"}`,
      clip(String(row.output || ""), 3200),
    ].join("\n"))
    .join("\n\n");

  const jobId = String(execution.currentJobId || "").trim();
  const cwd = (() => {
    if (!jobId) return process.cwd();
    try {
      return runWorkspaceDir(jobId);
    } catch {
      return process.cwd();
    }
  })();

  const prompt = [
    "너는 Telegram /chat의 최종 응답 작성기다.",
    "아래 내부 실행 결과를 바탕으로 사용자에게 보여줄 최종 답변 1개만 작성하라.",
    "규칙:",
    "- 한국어로 답하라.",
    "- 내부 라우팅/잡ID/run_dir/provider/agent 이름/로그는 숨겨라.",
    "- 핵심 답변을 먼저 주고, 필요하면 간단한 다음 단계 1~3개를 번호로 제시하라.",
    "",
    "사용자 요청:",
    String(message || ""),
    "",
    "내부 라우팅 요약:",
    `reason=${String(routePlan?.reason || "(none)")}`,
    `actions=${(Array.isArray(routePlan?.actions) ? routePlan.actions : []).map((a) => chatActionLabel(a)).join(", ") || "(none)"}`,
    "",
    "실행 결과:",
    outputText,
    special ? "특수 실행 요약:" : "",
    special ? special : "",
    "",
    "최종 답변:",
  ].join("\n");

  try {
    const r = await enqueue(
      () => runGeminiPrompt({
        workspaceRoot: cwd,
        cwd,
        prompt,
        concurrencyKey: `job:${String(jobId || "").trim()}`,
        jobId,
      }),
      { jobId, label: "chat_synthesize" }
    );
    const out = String(r?.stdout || r?.stderr || "").trim();
    if (r?.ok && out) return clip(out, 3800);
  } catch {}

  return buildChatSynthesisFallback(message, execution);
}

function parseJsonMaybeLoose(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeProviderName(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (["chatgpt", "gpt", "openai"].includes(key)) return "chatgpt";
  if (["codex"].includes(key)) return "codex";
  if (["gemini"].includes(key)) return "gemini";
  return "gemini";
}

function parseStructuredFromResource(resource, preferredPayloadKey = "") {
  const row = resource && typeof resource === "object" ? resource : {};
  const payload = row.payload && typeof row.payload === "object"
    ? row.payload
    : (row.raw?.payload_json && typeof row.raw.payload_json === "object" ? row.raw.payload_json : {});

  if (preferredPayloadKey && payload[preferredPayloadKey] && typeof payload[preferredPayloadKey] === "object") {
    return payload[preferredPayloadKey];
  }
  if (payload && typeof payload === "object" && Object.keys(payload).length > 0) {
    const directPayload = payload[preferredPayloadKey] ?? payload.job_config ?? payload.tool_spec ?? payload.agent_profile_draft ?? payload.agent_profile;
    if (directPayload && typeof directPayload === "object") return directPayload;
  }

  const text = String(
    row.text
    || row.raw?.raw_text
    || row.raw?.rawText
    || row.summary
    || row.raw?.summary
    || row.raw?.text
    || row.raw?.content
    || ""
  ).trim();
  if (!text) return null;

  const direct = parseJsonMaybeLoose(text);
  if (direct && typeof direct === "object") {
    if (preferredPayloadKey && direct[preferredPayloadKey] && typeof direct[preferredPayloadKey] === "object") {
      return direct[preferredPayloadKey];
    }
    return direct;
  }
  const parsedFromText = parseJsonObjectFromText(text);
  if (parsedFromText && typeof parsedFromText === "object") {
    if (preferredPayloadKey && parsedFromText[preferredPayloadKey] && typeof parsedFromText[preferredPayloadKey] === "object") {
      return parsedFromText[preferredPayloadKey];
    }
    return parsedFromText;
  }
  return null;
}

function sortResourcesByCreatedAt(list = []) {
  return [...(Array.isArray(list) ? list : [])].sort((a, b) => {
    const ta = Date.parse(String(a?.createdAt || ""));
    const tb = Date.parse(String(b?.createdAt || ""));
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    return 0;
  });
}

async function listActiveResourcesByKind(client, { threadId, ctxId, resourceKind }) {
  const resources = await client.listResources(threadId, {
    resourceKind,
    contextSetId: ctxId,
  });
  const ordered = sortResourcesByCreatedAt(resources);
  try {
    const explain = await client.getCompiledContextExplain(ctxId);
    const activeSet = new Set(
      (Array.isArray(explain?.active_node_ids) ? explain.active_node_ids : [])
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    );
    if (activeSet.size === 0) return ordered;
    const activeRows = ordered.filter((row) => activeSet.has(String(row?.id || "").trim()));
    return activeRows.length > 0 ? activeRows : ordered;
  } catch {
    return ordered;
  }
}

async function listLatestResourceByKind(client, threadId, resourceKind) {
  const rows = await client.listResources(threadId, { resourceKind });
  return sortResourcesByCreatedAt(rows).at(-1) || null;
}

function parseTimeMs(raw) {
  const t = Date.parse(String(raw || "").trim());
  return Number.isFinite(t) ? t : 0;
}

function parseNodeCreatedAtMs(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return Math.max(
    parseTimeMs(row?.createdAt),
    parseTimeMs(raw.created_at),
    parseTimeMs(raw.createdAt),
    parseTimeMs(payload.ended_at),
    parseTimeMs(payload.started_at),
    parseTimeMs(payload.created_at),
    parseTimeMs(payload.createdAt),
    parseTimeMs(payload.ts),
    parseTimeMs(payload.timestamp)
  );
}

function nodeTypeLabel(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  const direct = String(
    row?.type
    || raw.node_type
    || raw.nodeType
    || raw.type
    || payload.type
    || payload.node_type
    || payload.nodeType
    || ""
  ).trim();
  if (direct) return direct;
  const resourceKind = String(
    row?.resourceKind
    || raw.resource_kind
    || raw.resourceKind
    || payload.resource_kind
    || payload.resourceKind
    || ""
  ).trim().toLowerCase();
  if (resourceKind === "artifact") return "Artifact";
  if (resourceKind) return "Resource";
  if (String(payload.role || "").trim()) return "Message";
  return "";
}

function nodeTypeKey(row = {}) {
  return String(nodeTypeLabel(row) || "").trim().toLowerCase();
}

function nodeResourceKind(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return String(
    row?.resourceKind
    || raw.resource_kind
    || raw.resourceKind
    || payload.resource_kind
    || payload.resourceKind
    || ""
  ).trim().toLowerCase();
}

function messageRoleOf(row = {}) {
  const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
  const raw = row?.raw && typeof row.raw === "object" ? row.raw : {};
  return String(
    row?.role
    || raw.role
    || raw.author_role
    || raw.authorRole
    || payload.role
    || ""
  ).trim().toLowerCase();
}

function sortRowsByRecent(rows = []) {
  return [...(Array.isArray(rows) ? rows : [])]
    .sort((a, b) => parseNodeCreatedAtMs(b) - parseNodeCreatedAtMs(a));
}

function uniqNodeIds(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = String(row?.id || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function chunkNodeIds(ids = [], size = 100) {
  const rows = Array.isArray(ids) ? ids : [];
  const out = [];
  const n = Math.max(1, Math.floor(Number(size) || 100));
  for (let i = 0; i < rows.length; i += n) {
    out.push(rows.slice(i, i + n));
  }
  return out;
}

function summarizeJobConfigDebug(rawConfig = {}) {
  const row = rawConfig && typeof rawConfig === "object" ? rawConfig : {};
  const mode = String(row.mode || "supervisor").trim().toLowerCase() || "supervisor";
  const style = String(row.final_response_style || row.finalResponseStyle || "concise").trim().toLowerCase() || "concise";
  const participants = Array.isArray(row.participants)
    ? row.participants.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    : [];
  const budget = row.budget && typeof row.budget === "object" ? row.budget : {};
  const maxActions = Number.isFinite(Number(budget.max_actions)) ? Math.max(1, Math.floor(Number(budget.max_actions))) : 4;
  const maxRisk = String(budget.max_risk || "L2").trim().toUpperCase() || "L2";
  return [
    `mode=${mode}`,
    `style=${style}`,
    `participants=${participants.length > 0 ? participants.map((id) => `@${id}`).join(", ") : "(none)"}`,
    `budget.max_actions=${maxActions}`,
    `budget.max_risk=${maxRisk}`,
  ].join(", ");
}

function buildSharedContextSelectionPolicy(runtime = {}) {
  const row = runtime && typeof runtime === "object" ? runtime : {};
  const cfg = row?.jobConfig && typeof row.jobConfig === "object" ? row.jobConfig : {};
  const policy = cfg?.context_policy && typeof cfg.context_policy === "object"
    ? cfg.context_policy
    : {};
  const pinnedNodeIds = Array.isArray(policy.pinned_node_ids)
    ? policy.pinned_node_ids.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const parseLimit = (value, fallback, maxCap) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.max(1, Math.min(maxCap, Math.floor(n)));
  };
  const excludeKinds = Array.isArray(policy.exclude_resource_kinds)
    ? policy.exclude_resource_kinds.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    : SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS;
  return {
    pinned_node_ids: pinnedNodeIds,
    recent_user_messages: parseLimit(policy.recent_user_messages, SHARED_CONTEXT_RECENT_USER_MESSAGES, 40),
    recent_assistant_messages: parseLimit(policy.recent_assistant_messages, SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES, 40),
    recent_run_step: parseLimit(policy.recent_run_step, SHARED_CONTEXT_RECENT_RUN_STEP, 80),
    recent_tool_artifact: parseLimit(policy.recent_tool_artifact, SHARED_CONTEXT_RECENT_TOOL_ARTIFACT, 40),
    exclude_resource_kinds: excludeKinds.length > 0 ? excludeKinds : ["job_config", "tracking_append"],
  };
}

function summarizeActiveTypeBreakdown(nodeIds = [], nodeMap = new Map()) {
  const breakdown = {};
  for (const idRaw of Array.isArray(nodeIds) ? nodeIds : []) {
    const id = String(idRaw || "").trim();
    if (!id) continue;
    const node = nodeMap.get(id);
    const type = nodeTypeKey(node);
    const resourceKind = nodeResourceKind(node);
    const role = messageRoleOf(node);
    let key = type || "unknown";
    if (type === "message" && role) key = `message:${role}`;
    else if ((type === "resource" || type === "artifact") && resourceKind) key = `resource:${resourceKind}`;
    breakdown[key] = Number(breakdown[key] || 0) + 1;
  }
  return breakdown;
}

async function refreshSharedContext(client, {
  threadId = "",
  sharedCtxId = "",
  policy = {},
  logger = null,
} = {}) {
  const tid = String(threadId || "").trim();
  const ctxId = String(sharedCtxId || "").trim();
  if (!tid || !ctxId || !client) {
    return { ok: false, reason: "missing_thread_or_context" };
  }
  const log = typeof logger === "function" ? logger : () => {};

  const normalizedPolicy = {
    pinned_node_ids: Array.isArray(policy?.pinned_node_ids)
      ? policy.pinned_node_ids.map((entry) => String(entry || "").trim()).filter(Boolean)
      : [],
    recent_user_messages: Number.isFinite(Number(policy?.recent_user_messages))
      ? Math.max(1, Math.floor(Number(policy.recent_user_messages)))
      : SHARED_CONTEXT_RECENT_USER_MESSAGES,
    recent_assistant_messages: Number.isFinite(Number(policy?.recent_assistant_messages))
      ? Math.max(1, Math.floor(Number(policy.recent_assistant_messages)))
      : SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES,
    recent_run_step: Number.isFinite(Number(policy?.recent_run_step))
      ? Math.max(1, Math.floor(Number(policy.recent_run_step)))
      : SHARED_CONTEXT_RECENT_RUN_STEP,
    recent_tool_artifact: Number.isFinite(Number(policy?.recent_tool_artifact))
      ? Math.max(1, Math.floor(Number(policy.recent_tool_artifact)))
      : SHARED_CONTEXT_RECENT_TOOL_ARTIFACT,
    exclude_resource_kinds: Array.isArray(policy?.exclude_resource_kinds)
      ? policy.exclude_resource_kinds.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
      : SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS,
  };
  const excludedKinds = new Set(normalizedPolicy.exclude_resource_kinds);

  const [messages, nodes, explain] = await Promise.all([
    client.listMessages(tid, { limit: 120 }).catch(() => []),
    client.listNodes(tid, { contextSetId: ctxId }).catch(() => []),
    client.getCompiledContextExplain(ctxId).catch(() => ({ active_node_ids: [] })),
  ]);

  const nodeMap = new Map();
  for (const row of Array.isArray(nodes) ? nodes : []) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    nodeMap.set(id, row);
  }
  for (const row of Array.isArray(messages) ? messages : []) {
    const id = String(row?.id || "").trim();
    if (!id || nodeMap.has(id)) continue;
    nodeMap.set(id, row);
  }

  const currentActiveIds = uniqNodeIds(
    (Array.isArray(explain?.active_node_ids) ? explain.active_node_ids : [])
      .map((id) => ({ id }))
  );
  const currentActiveSet = new Set(currentActiveIds);

  const messageRows = sortRowsByRecent(messages);
  const userMessageIds = uniqNodeIds(
    messageRows
      .filter((row) => messageRoleOf(row) === "user")
      .slice(0, normalizedPolicy.recent_user_messages)
  );
  const assistantMessageIds = uniqNodeIds(
    messageRows
      .filter((row) => messageRoleOf(row) === "assistant")
      .slice(0, normalizedPolicy.recent_assistant_messages)
  );

  const nodeRows = sortRowsByRecent(nodes);
  const runStepIds = uniqNodeIds(
    nodeRows
      .filter((row) => {
        const type = nodeTypeKey(row);
        return type === "run" || type === "step";
      })
      .slice(0, normalizedPolicy.recent_run_step)
  );
  const toolArtifactIds = uniqNodeIds(
    nodeRows
      .filter((row) => {
        const type = nodeTypeKey(row);
        const resourceKind = nodeResourceKind(row);
        if (type === "toolresult") return true;
        if (type === "artifact") return true;
        if (type === "resource" && resourceKind === "artifact") return true;
        return false;
      })
      .slice(0, normalizedPolicy.recent_tool_artifact)
  );

  const selectedSet = new Set([
    ...normalizedPolicy.pinned_node_ids,
    ...userMessageIds,
    ...assistantMessageIds,
    ...runStepIds,
    ...toolArtifactIds,
  ].map((id) => String(id || "").trim()).filter(Boolean));

  const excludedResourceIds = [];
  for (const row of nodeRows) {
    const id = String(row?.id || "").trim();
    if (!id) continue;
    const resourceKind = nodeResourceKind(row);
    if (!resourceKind || !excludedKinds.has(resourceKind)) continue;
    excludedResourceIds.push(id);
    selectedSet.delete(id);
  }

  const toActivate = [...selectedSet].filter((id) => !currentActiveSet.has(id));
  const toDeactivate = currentActiveIds.filter((id) => !selectedSet.has(id) || excludedResourceIds.includes(id));

  for (const ids of chunkNodeIds(toDeactivate, 120)) {
    if (ids.length === 0) continue;
    await client.deactivateNodes(ctxId, ids).catch((e) => {
      log(`[shared-context] deactivate failed: ${String(e?.message ?? e)}`);
    });
  }
  for (const ids of chunkNodeIds(toActivate, 120)) {
    if (ids.length === 0) continue;
    await client.activateNodes(ctxId, ids).catch((e) => {
      log(`[shared-context] activate failed: ${String(e?.message ?? e)}`);
    });
  }

  let refreshedActiveIds = [...selectedSet];
  let refreshedNodeMap = nodeMap;
  try {
    const refreshedExplain = await client.getCompiledContextExplain(ctxId);
    refreshedActiveIds = uniqNodeIds(
      (Array.isArray(refreshedExplain?.active_node_ids) ? refreshedExplain.active_node_ids : [])
        .map((id) => ({ id }))
    );
    const refreshedNodes = await client.listNodes(tid, { contextSetId: ctxId }).catch(() => []);
    if (Array.isArray(refreshedNodes) && refreshedNodes.length > 0) {
      refreshedNodeMap = new Map();
      for (const row of refreshedNodes) {
        const id = String(row?.id || "").trim();
        if (!id) continue;
        refreshedNodeMap.set(id, row);
      }
    }
  } catch {}

  return {
    ok: true,
    selected_count: selectedSet.size,
    activated_count: toActivate.length,
    deactivated_count: toDeactivate.length,
    excluded_resource_count: excludedResourceIds.length,
    active_node_ids: refreshedActiveIds,
    active_type_breakdown: summarizeActiveTypeBreakdown(refreshedActiveIds, refreshedNodeMap),
    policy: normalizedPolicy,
  };
}

async function refreshSharedContextForRuntime(runtime, {
  jobId = "",
  reason = "",
} = {}) {
  const row = runtime && typeof runtime === "object" ? runtime : null;
  if (!row || memoryModeWithFallback() !== "goc") return null;
  const threadId = String(row?.map?.threadId || "").trim();
  const ctxId = String(row?.map?.ctxSharedId || "").trim();
  if (!threadId || !ctxId) return null;
  const client = requireGocClient();
  const policy = buildSharedContextSelectionPolicy(row);
  const refreshed = await refreshSharedContext(client, {
    threadId,
    sharedCtxId: ctxId,
    policy,
    logger: (line) => {
      if (!jobId) return;
      jobs.log(jobId, line);
    },
  }).catch(() => null);
  if (!refreshed?.ok) return refreshed;

  try {
    const compiled = await client.getCompiledContext(ctxId);
    row.contextSummary = String(compiled || "").trim();
  } catch {}
  try {
    const meta = await client.getContextSet(ctxId);
    row.contextMeta = {
      context_set_id: ctxId,
      version: String(meta?.version || "").trim(),
      active_node_ids: Array.isArray(meta?.activeNodeIds)
        ? meta.activeNodeIds.map((entry) => String(entry || "").trim()).filter(Boolean)
        : [],
    };
  } catch {
    row.contextMeta = row.contextMeta && typeof row.contextMeta === "object"
      ? row.contextMeta
      : {
        context_set_id: ctxId,
        version: "",
        active_node_ids: [],
      };
  }
  row.sharedActiveTypeBreakdown = refreshed.active_type_breakdown && typeof refreshed.active_type_breakdown === "object"
    ? refreshed.active_type_breakdown
    : {};
  if (jobId) {
    tracking.append(jobId, "decisions.md", [
      "## shared_context_refresh",
      `- reason: ${reason || "manual"}`,
      `- selected_count: ${refreshed.selected_count}`,
      `- activated_count: ${refreshed.activated_count}`,
      `- deactivated_count: ${refreshed.deactivated_count}`,
      `- excluded_resource_count: ${refreshed.excluded_resource_count}`,
    ].join("\n"));
  }
  return refreshed;
}

function normalizeToolSpec(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.tool_id || row.name || "").trim();
  if (!id) return null;
  const actionTypes = Array.isArray(row.action_types || row.actions)
    ? (row.action_types || row.actions)
      .map((v) => String(v || "").trim().toLowerCase())
      .filter(Boolean)
    : [];
  return {
    id,
    name: String(row.name || id).trim(),
    description: String(row.description || "").trim(),
    action_types: actionTypes,
    risk: String(row.risk || "L1").trim().toUpperCase(),
    raw: row,
  };
}

function normalizeCatalogIds(list = [], { lower = true } = {}) {
  const rows = Array.isArray(list) ? list : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const raw = typeof row === "string"
      ? row
      : String(
        row?.id
        || row?.tool_id
        || row?.toolId
        || row?.agent_id
        || row?.agentId
        || row?.name
        || ""
      ).trim();
    if (!raw) continue;
    const cleanRaw = String(raw || "").trim();
    const id = lower ? cleanRaw.toLowerCase() : cleanRaw;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function summarizeSelectionState({ catalog = [], enabled = [] } = {}) {
  const catalogIds = normalizeCatalogIds(catalog);
  const enabledIds = normalizeCatalogIds(enabled);
  const enabledSet = new Set(enabledIds);
  const disabledIds = catalogIds.filter((id) => !enabledSet.has(id));
  return {
    catalog_ids: catalogIds,
    enabled_ids: enabledIds,
    disabled_ids: disabledIds,
  };
}

function pickBaselineConversationCatalogAgents(agentsCatalog = []) {
  const rows = Array.isArray(agentsCatalog) ? agentsCatalog : [];
  const requiredRoles = ["router", "planner", "researcher", "coder"];
  const byRole = [];
  const seen = new Set();
  for (const role of requiredRoles) {
    const match = rows.find((row) => {
      const systemKey = normalizeAgentLookupKey(row?.system_key || row?.systemKey || "");
      const id = normalizeAgentLookupKey(row?.id || "");
      const name = normalizeAgentLookupKey(row?.name || "");
      if (systemKey === role) return true;
      if (id === role) return true;
      return name.includes(role);
    });
    const cleanId = String(match?.id || "").trim().toLowerCase();
    if (!cleanId || seen.has(cleanId)) continue;
    seen.add(cleanId);
    byRole.push(cleanId);
  }
  return byRole;
}

function buildAgentProfileFromProposal(action) {
  const id = String(action?.agent_id || action?.id || "").trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    name: String(action?.name || id).trim() || id,
    description: String(action?.description || "").trim(),
    provider: normalizeProviderName(action?.provider || action?.model || "gemini"),
    model: String(action?.model || action?.provider || "gemini").trim() || "gemini",
    prompt: String(action?.prompt || action?.goal || "").trim(),
    meta: action?.meta && typeof action.meta === "object" ? action.meta : {},
  };
}

function buildGocAgentCreateSpec(spec = {}) {
  const row = spec && typeof spec === "object" ? spec : {};
  const name = String(row.name || row.title || row.id || row.agent_id || "").trim();
  const description = String(row.description || "").trim();
  const systemPrompt = String(
    row.system_prompt
    || row.systemPrompt
    || row.prompt
    || ""
  ).trim();
  const instruction = String(row.instruction || "").trim();
  const tools = Array.isArray(row.tools)
    ? row.tools.map((entry) => String(entry || "").trim()).filter(Boolean)
    : [];
  const provider = String(row.provider || "").trim().toLowerCase();
  const model = String(row.model || "").trim();
  let modelRef = "";
  if (provider && model && !model.includes(":")) modelRef = `${provider}:${model}`;
  else if (model) modelRef = model;
  else if (provider) modelRef = provider;
  const visibilityRaw = String(row.visibility || row.scope || "").trim().toLowerCase();
  const visibility = ["private", "public", "installed"].includes(visibilityRaw)
    ? visibilityRaw
    : "private";
  return {
    name,
    description,
    system_prompt: systemPrompt,
    instruction,
    tools,
    model: modelRef,
    visibility,
  };
}

function normalizeBlueprintSearchItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((row) => ({
      blueprint_id: String(row?.blueprint_id || "").trim(),
      public_node_id: String(row?.public_node_id || "").trim(),
      agent_id: String(row?.agent_id || "").trim().toLowerCase(),
      title: String(row?.title || "").trim(),
      tags: Array.isArray(row?.tags) ? row.tags.map((v) => String(v || "").trim()).filter(Boolean) : [],
      description: String(row?.description || "").trim(),
    }))
    .filter((row) => row.blueprint_id || row.public_node_id || row.agent_id);
}

function filterPublicBlueprintCandidates(items = [], query = "", limit = 5) {
  const rows = normalizeBlueprintSearchItems(items);
  const q = String(query || "").trim().toLowerCase();
  const max = Number.isFinite(Number(limit)) ? Math.max(1, Math.min(10, Math.floor(Number(limit)))) : 5;
  if (!q) return rows.slice(0, max);
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored = rows.map((row) => {
    const hay = [
      row.title,
      row.agent_id,
      row.blueprint_id,
      row.description,
      ...(Array.isArray(row.tags) ? row.tags : []),
    ].join(" ").toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (hay.includes(token)) score += 1;
      if (row.agent_id === token) score += 3;
      if (row.blueprint_id === token) score += 3;
    }
    return { row, score };
  });
  return scored
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.row)
    .slice(0, max);
}

function resolveInstallCandidateFromSession(session, action = {}) {
  const cache = normalizeBlueprintSearchItems(session?.public_search_cache || []);
  if (cache.length === 0) return null;
  const publicNodeId = String(action.public_node_id || "").trim();
  const blueprintId = String(action.blueprint_id || "").trim();
  const overrideAgentId = String(action.agent_id_override || "").trim().toLowerCase();

  if (publicNodeId) {
    const found = cache.find((row) => row.public_node_id === publicNodeId);
    if (found) return found;
  }
  if (blueprintId) {
    const found = cache.find((row) => row.blueprint_id === blueprintId);
    if (found) return found;
  }
  if (overrideAgentId) {
    const found = cache.find((row) => row.agent_id === overrideAgentId);
    if (found) return found;
  }
  return cache[0] || null;
}

function parseAgentIdFromProfileResource(resource) {
  const payload = resource?.payload && typeof resource.payload === "object" ? resource.payload : {};
  const candidate = payload.agent_profile && typeof payload.agent_profile === "object"
    ? payload.agent_profile
    : parseStructuredFromResource(resource, "agent_profile");
  const id = String(
    candidate?.id
    || candidate?.agent_id
    || payload.agent_id
    || ""
  ).trim().toLowerCase();
  return id;
}

async function findLatestAgentProfileNodeForPublish(client, agentsSlot, { agentNodeId = "", agentId = "" } = {}) {
  const directNodeId = String(agentNodeId || "").trim();
  if (directNodeId) {
    const node = await client.getNode(directNodeId);
    if (!node) return null;
    return { id: directNodeId, node };
  }

  const targetAgentId = String(agentId || "").trim().toLowerCase();
  const resources = await listActiveResourcesByKind(client, {
    threadId: agentsSlot.threadId,
    ctxId: agentsSlot.ctxId,
    resourceKind: "agent_profile",
  });
  for (let i = resources.length - 1; i >= 0; i -= 1) {
    const row = resources[i];
    const parsedAgentId = parseAgentIdFromProfileResource(row);
    if (targetAgentId && parsedAgentId !== targetAgentId) continue;
    if (row?.id) return row;
  }
  return null;
}

async function loadSupervisorRuntime(
  jobId,
  {
    chatMeta = null,
    includeContext = true,
    includeGlobal = true,
    telegramUserId = "",
  } = {}
) {
  const effectiveTelegramUserId = String(
    telegramUserId
    || chatMeta?.telegram_user_id
    || ""
  ).trim();
  const restoreActor = bindGocActor(effectiveTelegramUserId);
  try {
    const reg = await refreshAgentRegistry({ includeCompiled: true });
    const fallbackNormalized = normalizeSupervisorJobConfig(
      { job_id: String(jobId || "").trim() },
      { agentsCatalog: reg.agents, toolsCatalog: [] }
    );
    const fallbackAgentSet = new Set(
      (Array.isArray(fallbackNormalized.enabledAgentIds) ? fallbackNormalized.enabledAgentIds : [])
        .map((id) => String(id || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const fallbackAgents = (Array.isArray(reg.agents) ? reg.agents : [])
      .filter((row) => fallbackAgentSet.has(String(row?.id || "").trim().toLowerCase()));
    if (memoryModeWithFallback() !== "goc") {
      return {
        mode: "local",
        map: null,
        agentsSlot: null,
        toolsSlot: null,
        conversation: null,
        conversationAgents: [],
        conversationMembershipWarning: "",
        jobConfig: fallbackNormalized.configNormalized,
        jobConfigDebugSummary: summarizeJobConfigDebug(fallbackNormalized.configNormalized),
        jobConfigNodeId: "",
        agentsCatalog: reg.agents,
        toolsCatalog: [],
        enabledAgentIds: fallbackNormalized.enabledAgentIds,
        enabledToolIds: fallbackNormalized.enabledToolIds,
        agentSelection: summarizeSelectionState({ catalog: reg.agents, enabled: fallbackAgents }),
        toolSelection: summarizeSelectionState({ catalog: [], enabled: [] }),
        agents: fallbackAgents,
        tools: [],
        recentArtifactNodeIds: [],
        sharedActiveTypeBreakdown: {},
        contextSummary: includeContext ? loadLocalContextDocs(jobId, TRACK_DOC_NAMES, 2200) : "",
        globalSummary: "",
      };
    }

    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
      telegram: chatMeta,
    });
    const agentsSlot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
    const toolsSlot = await ensureToolsThread(client, { baseDir: jobs.baseDir });

    const warningLines = [];
    const pushConversationWarning = (stage, error = null) => {
      const base = `conversation membership bootstrap failed for thread=${String(map.threadId || "").trim() || "(none)"} user=${effectiveTelegramUserId || "(none)"}`;
      const detail = stage ? `${base}; stage=${stage}` : base;
      const line = error
        ? `${detail}; error=${String(error?.message ?? error)}`
        : detail;
      warningLines.push(line);
      if (jobId) jobs.log(jobId, line);
    };

    let conversation = {
      id: "",
      thread_id: String(map.threadId || "").trim(),
    };
    if (typeof client.ensureConversation === "function") {
      try {
        const ensured = await client.ensureConversation(map.threadId);
        if (ensured && typeof ensured === "object") {
          conversation = {
            id: String(ensured.id || "").trim(),
            thread_id: String(ensured.thread_id || ensured.threadId || map.threadId || "").trim(),
          };
        }
      } catch (e) {
        pushConversationWarning("ensure_conversation", e);
      }
    } else {
      pushConversationWarning("ensure_conversation_api_unavailable");
    }

    const listConversationAgentsStrict = async () => {
      if (typeof client.listConversationAgents !== "function") {
        throw new Error("listConversationAgents API unavailable");
      }
      const rows = await client.listConversationAgents(map.threadId);
      return Array.isArray(rows) ? rows : [];
    };

    let conversationAgents = [];
    try {
      conversationAgents = await listConversationAgentsStrict();
    } catch (e) {
      pushConversationWarning("list_conversation_agents_initial", e);
      conversationAgents = [];
    }

    if (conversationAgents.length === 0) {
      if (typeof client.bootstrapDefaultAgents === "function") {
        try {
          await client.bootstrapDefaultAgents(map.threadId, { addToConversation: true });
          conversationAgents = await listConversationAgentsStrict();
        } catch (e) {
          pushConversationWarning("bootstrap_default_agents", e);
        }
      } else {
        pushConversationWarning("bootstrap_default_agents_api_unavailable");
      }
    }

    if (conversationAgents.length === 0) {
      const baselineAgentIds = pickBaselineConversationCatalogAgents(reg.agents || []);
      if (baselineAgentIds.length === 0) {
        pushConversationWarning("no_baseline_agent_ids_from_catalog");
      } else if (typeof client.addConversationAgent !== "function") {
        pushConversationWarning("add_conversation_agent_api_unavailable");
      } else {
        for (const baselineAgentId of baselineAgentIds) {
          try {
            await client.addConversationAgent(map.threadId, baselineAgentId, true);
          } catch (e) {
            pushConversationWarning(`add_baseline_agent:${baselineAgentId}`, e);
          }
        }
        try {
          conversationAgents = await listConversationAgentsStrict();
        } catch (e) {
          pushConversationWarning("list_conversation_agents_after_baseline_add", e);
        }
      }
    }

    if (conversationAgents.length === 0) {
      pushConversationWarning("membership_still_empty_after_bootstrap");
    }
    const conversationMembershipWarning = warningLines.join(" | ");

    const latestJobNode = await listLatestResourceByKind(client, map.threadId, "job_config");
    const rawJobConfig = latestJobNode ? parseStructuredFromResource(latestJobNode, "job_config") : null;

    const toolRows = await client.listResources(toolsSlot.threadId, { resourceKind: "tool_spec" });
    const latestToolSpecById = new Map();
    for (const resource of sortResourcesByCreatedAt(toolRows)) {
      const normalized = normalizeToolSpec(parseStructuredFromResource(resource, "tool_spec"));
      if (!normalized) continue;
      latestToolSpecById.set(String(normalized.id || "").trim().toLowerCase(), normalized);
    }
    const toolsCatalog = [...latestToolSpecById.values()];

    const normalized = normalizeSupervisorJobConfig(
      rawJobConfig || { job_id: String(jobId || "").trim() },
      { agentsCatalog: reg.agents, toolsCatalog }
    );

    const enabledConversationAgentIds = Array.from(new Set(
      (Array.isArray(conversationAgents) ? conversationAgents : [])
        .filter((row) => row?.enabled !== false)
        .map((row) => String(row?.agent_id || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    const enabledAgentSet = new Set(enabledConversationAgentIds);
    const enabledToolSet = new Set(
      (Array.isArray(normalized.enabledToolIds) ? normalized.enabledToolIds : [])
        .map((id) => String(id || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const enabledAgents = (Array.isArray(reg.agents) ? reg.agents : [])
      .filter((agent) => enabledAgentSet.has(String(agent?.id || "").trim().toLowerCase()));
    const enabledTools = toolsCatalog
      .filter((tool) => enabledToolSet.has(String(tool?.id || "").trim().toLowerCase()));

    let recentArtifactNodeIds = [];
    try {
      const artifacts = await client.listResources(map.threadId, {
        resourceKind: "artifact",
      });
      recentArtifactNodeIds = sortResourcesByCreatedAt(artifacts)
        .slice(-5)
        .reverse()
        .map((row) => String(row?.id || "").trim())
        .filter(Boolean);
    } catch {
      recentArtifactNodeIds = [];
    }

    let contextSummary = "";
    if (includeContext) {
      try {
        contextSummary = await client.getCompiledContext(map.ctxSharedId);
      } catch {
        contextSummary = loadLocalContextDocs(jobId, TRACK_DOC_NAMES, 2200);
      }
    }

    let globalSummary = "";
    if (includeGlobal) {
      try {
        const globalSlot = await ensureGlobalThread(client, { baseDir: jobs.baseDir, title: "global:shared" });
        globalSummary = await client.getCompiledContext(globalSlot.ctxId);
      } catch {
        globalSummary = "";
      }
    }

    return {
      mode: "goc",
      map,
      agentsSlot,
      toolsSlot,
      jobConfig: normalized.configNormalized,
      jobConfigDebugSummary: summarizeJobConfigDebug(rawJobConfig || normalized.configNormalized),
      jobConfigNodeId: String(latestJobNode?.id || "").trim(),
      agentsCatalog: reg.agents,
      toolsCatalog,
      conversation,
      conversationAgents: Array.isArray(conversationAgents) ? conversationAgents : [],
      conversationMembershipWarning,
      enabledAgentIds: enabledConversationAgentIds,
      enabledToolIds: normalized.enabledToolIds,
      agentSelection: summarizeSelectionState({ catalog: reg.agents, enabled: enabledAgents }),
      toolSelection: summarizeSelectionState({ catalog: toolsCatalog, enabled: enabledTools }),
      agents: enabledAgents,
      tools: enabledTools,
      recentArtifactNodeIds,
      sharedActiveTypeBreakdown: {},
      contextSummary: contextSummary || "",
      globalSummary: globalSummary || "",
    };
  } finally {
    restoreActor();
  }
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

async function openAgentsUiInfo({ chatId = null, jobId = "", userId = "" } = {}) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error("open_agents_ui requires MEMORY_MODE=goc");
  }
  const client = requireGocClient();
  const restoreActor = bindGocActor(userId);
  try {
    const requestedJobId = String(jobId || "").trim();
    const resolvedJobId = requestedJobId || (chatId == null ? "" : String(resolveCurrentJobIdForChat(chatId) || "").trim());
    if (resolvedJobId) {
      const map = await ensureJobThread(client, {
        jobId: resolvedJobId,
        jobDir: runDir(resolvedJobId),
        title: `job:${resolvedJobId}`,
        telegram: chatId == null ? null : { chat_id: String(chatId || "") },
      });
      const links = await buildContextLinks(client, {
        threadId: map.threadId,
        ctxId: map.ctxSharedId,
        page: "agents",
      });
      return {
        scope: "job",
        jobId: resolvedJobId,
        threadId: map.threadId,
        ctxId: map.ctxSharedId,
        browserLink: links.browserLink,
        miniAppLink: links.miniAppLink,
        link: links.browserLink || links.miniAppLink,
        tokenExp: links.browserTokenExp || null,
        lines: [
          "thread team",
          `jobId=${resolvedJobId}`,
          `thread=${map.threadId}`,
          `ctx=${map.ctxSharedId}`,
          links.browserTokenExp ? `token_exp=${links.browserTokenExp}` : "",
          `browser_link=${links.browserLink}`,
          links.miniAppSupported ? `miniapp_link=${links.miniAppLink}` : "",
        ].filter(Boolean),
      };
    }

    const links = await buildContextLinks(client, { page: "agents" });
    return {
      scope: "catalog",
      jobId: "",
      threadId: "",
      ctxId: "",
      browserLink: links.browserLink,
      miniAppLink: links.miniAppLink,
      link: links.browserLink || links.miniAppLink,
      tokenExp: links.browserTokenExp || null,
      lines: [
        "agents catalog",
        links.browserTokenExp ? `token_exp=${links.browserTokenExp}` : "",
        `browser_link=${links.browserLink}`,
        links.miniAppSupported ? `miniapp_link=${links.miniAppLink}` : "",
      ].filter(Boolean),
    };
  } finally {
    restoreActor();
  }
}

async function createAgentDraftProposal(bot, chatId, userId, jobId, action) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error("propose_agent requires MEMORY_MODE=goc");
  }
  const profile = buildAgentProfileFromProposal(action);
  if (!profile?.id) throw new Error("propose_agent requires agent_id");

  const client = requireGocClient();
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const nowIso = new Date().toISOString();
  const rawText = `${JSON.stringify(profile, null, 2)}\n`;
  const created = await client.createResource(slot.threadId, {
    name: `agent_draft:${profile.id}@${nowIso}`,
    summary: `agent_profile_draft ${profile.id}`,
    text_mode: "plain",
    raw_text: rawText,
    resource_kind: "agent_profile_draft",
    uri: `ddalggak://agents/draft/${profile.id}`,
    context_set_id: slot.ctxId,
    auto_activate: true,
    payload_json: {
      op: "draft",
      ts: nowIso,
      agent_id: profile.id,
      job_id: String(jobId || "").trim() || undefined,
      proposed_by: `telegram:${userId}`,
      agent_profile_draft: profile,
    },
  });
  const draftNodeId = String(created?.id || "").trim();
  const cleanDescription = clip(
    String(profile.description || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .slice(0, 2)
      .join(" / "),
    220
  ) || "(none)";
  const promptPreview = clip(
    String(profile.prompt || "")
      .split(/\r?\n/)
      .map((line) => String(line || "").trim())
      .filter(Boolean)
      .join(" "),
    360
  ) || "(none)";
  const providerModel = `${String(profile.provider || "gemini").trim() || "gemini"}/${String(profile.model || profile.provider || "gemini").trim() || "gemini"}`;
  const approveCallback = draftNodeId
    ? `approve_draft:${draftNodeId}`
    : `approve_agent:${profile.id}`;
  const rejectCallback = draftNodeId
    ? `reject_draft:${draftNodeId}`
    : `reject_agent:${profile.id}`;

  const cleanJobId = String(jobId || "").trim();
  if (cleanJobId) {
    tracking.append(cleanJobId, "decisions.md", [
      "## /chat propose_agent",
      `- agent_id: ${profile.id}`,
      `- draft_node: ${created?.id || "unknown"}`,
      `- proposed_by: telegram:${userId}`,
    ].join("\n"));
  }
  const openAgentsUiCallback = cleanJobId ? `open_agents_ui:${cleanJobId}` : "open_agents_ui";

  await bot.sendMessage(
    chatId,
    [
      "🧪 agent draft 생성됨",
      `agent_id=${profile.id}`,
      `name=${clip(String(profile.name || profile.id), 120)}`,
      `description=${cleanDescription}`,
      `provider/model=${providerModel}`,
      `prompt_preview=${promptPreview}`,
      `draft_node=${draftNodeId || "unknown"}`,
      cleanJobId
        ? `승인하면 agent_profile이 registry에 추가되고, job_id=${cleanJobId} participants에 반영됩니다.`
        : "승인하면 agent_profile이 registry에 추가됩니다. (job_id 미확인 시 participants 반영 생략)",
    ].join("\n"),
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: approveCallback },
          { text: "❌ Reject", callback_data: rejectCallback },
          { text: "🧭 Agents UI", callback_data: openAgentsUiCallback },
        ]],
      },
    }
  );

  return { draft_id: created?.id || "", profile, slot };
}

async function findLatestDraftByAgentId(client, agentId) {
  const key = String(agentId || "").trim().toLowerCase();
  if (!key) return null;
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const resources = await client.listResources(slot.threadId, {
    resourceKind: "agent_profile_draft",
  });
  const ordered = sortResourcesByCreatedAt(resources);

  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const row = ordered[i];
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    const draft = parseStructuredFromResource(row, "agent_profile_draft") || parseStructuredFromResource(row, "agent_profile");
    const id = String(
      payload.agent_id
      || draft?.agent_id
      || draft?.id
      || ""
    ).trim().toLowerCase();
    if (id !== key) continue;
    return { slot, resource: row, payload, draft };
  }
  return null;
}

async function findDraftByNodeId(client, draftNodeId) {
  const key = String(draftNodeId || "").trim();
  if (!key) return null;
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  let node = null;
  try {
    node = await client.getNode(key);
  } catch (e) {
    return {
      slot,
      resource: null,
      payload: {},
      draft: null,
      lookupError: `getNode failed: ${String(e?.message ?? e)}`,
    };
  }
  const row = typeof client.normalizeResource === "function"
    ? client.normalizeResource(node)
    : (node && typeof node === "object" ? node : {});
  const resource = row && typeof row === "object"
    ? {
      ...row,
      id: String(row.id || key).trim(),
    }
    : { id: key };
  const payload = resource?.payload && typeof resource.payload === "object" ? resource.payload : {};
  const fallbackKind = payload?.agent_profile_draft && typeof payload.agent_profile_draft === "object"
    ? "agent_profile_draft"
    : "";
  const kind = String(
    resource.resourceKind
    || node?.resource_kind
    || node?.resourceKind
    || node?.payload?.resource_kind
    || node?.payload?.resourceKind
    || fallbackKind
  ).trim().toLowerCase();
  if (kind !== "agent_profile_draft") {
    return {
      slot,
      resource: null,
      payload: {},
      draft: null,
      lookupError: `node kind mismatch: ${kind || "unknown"}`,
    };
  }
  const draft = parseStructuredFromResource(resource, "agent_profile_draft") || parseStructuredFromResource(resource, "agent_profile");
  return { slot, resource, payload, draft };
}

async function appendParticipantToJobConfig(client, { jobId, agentId, actor = "" }) {
  const map = await ensureJobThread(client, {
    jobId,
    jobDir: runDir(jobId),
    title: `job:${jobId}`,
  });
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  if (!cleanAgentId) throw new Error("appendParticipantToJobConfig requires agentId");

  if (
    typeof client.ensureConversation === "function"
    && typeof client.addConversationAgent === "function"
    && typeof client.listConversationAgents === "function"
  ) {
    await client.ensureConversation(map.threadId);
    await client.addConversationAgent(map.threadId, cleanAgentId, true);
    const conversationAgents = await client.listConversationAgents(map.threadId);
    const enabledAgentIds = Array.from(new Set(
      (Array.isArray(conversationAgents) ? conversationAgents : [])
        .filter((row) => row?.enabled !== false)
        .map((row) => String(row?.agent_id || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    return {
      map,
      created: {
        id: `${String(map.threadId || "").trim()}:${cleanAgentId}`,
      },
      config: null,
      source: "conversation_agents",
      actor,
      enabledAgentIds,
      conversationAgents,
    };
  }

  return { map, created: null, config: null, source: "none" };
}

async function updateJobConfigSelection(client, {
  jobId,
  op,
  kind,
  id,
  actor = "",
  agentsCatalog = [],
  toolsCatalog = [],
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanOp = String(op || "").trim().toLowerCase();
  const cleanKind = String(kind || "").trim().toLowerCase();
  const cleanId = String(id || "").trim().toLowerCase();
  if (!cleanJobId) throw new Error("updateJobConfigSelection requires jobId");
  if (!["enable", "disable"].includes(cleanOp)) throw new Error("updateJobConfigSelection op must be enable|disable");
  if (!["agent", "tool"].includes(cleanKind)) throw new Error("updateJobConfigSelection kind must be agent|tool");
  if (!cleanId) throw new Error("updateJobConfigSelection requires id");

  const map = await ensureJobThread(client, {
    jobId: cleanJobId,
    jobDir: runDir(cleanJobId),
    title: `job:${cleanJobId}`,
  });

  if (cleanKind === "agent") {
    if (typeof client.ensureConversation !== "function" || typeof client.listConversationAgents !== "function") {
      throw new Error("conversation agent APIs unavailable");
    }
    await client.ensureConversation(map.threadId);
    if (cleanOp === "disable") {
      if (typeof client.patchConversationAgent === "function") {
        await client.patchConversationAgent(map.threadId, cleanId, { enabled: false }).catch(async () => {
          if (typeof client.addConversationAgent === "function") {
            await client.addConversationAgent(map.threadId, cleanId, false);
          } else {
            throw new Error("conversation agent disable is not supported by API");
          }
        });
      } else if (typeof client.addConversationAgent === "function") {
        await client.addConversationAgent(map.threadId, cleanId, false);
      } else {
        throw new Error("conversation agent disable is not supported by API");
      }
    } else if (typeof client.patchConversationAgent === "function") {
      await client.patchConversationAgent(map.threadId, cleanId, { enabled: true }).catch(async () => {
        if (typeof client.addConversationAgent === "function") {
          await client.addConversationAgent(map.threadId, cleanId, true);
        } else {
          throw new Error("conversation agent enable is not supported by API");
        }
      });
    } else if (typeof client.addConversationAgent === "function") {
      await client.addConversationAgent(map.threadId, cleanId, true);
    } else {
      throw new Error("conversation agent enable is not supported by API");
    }
    const conversationAgents = await client.listConversationAgents(map.threadId);
    const enabledAgentIds = Array.from(new Set(
      (Array.isArray(conversationAgents) ? conversationAgents : [])
        .filter((row) => row?.enabled !== false)
        .map((row) => String(row?.agent_id || "").trim().toLowerCase())
        .filter(Boolean)
    ));
    return {
      map,
      config: null,
      source: "conversation_agents",
      conversationAgents,
      enabledAgentIds,
      op: cleanOp,
      kind: cleanKind,
      id: cleanId,
    };
  }

  const latest = await listLatestResourceByKind(client, map.threadId, "job_config");
  const currentRaw = latest ? parseStructuredFromResource(latest, "job_config") : null;
  const normalized = normalizeSupervisorJobConfig(
    currentRaw || { job_id: cleanJobId },
    { agentsCatalog, toolsCatalog }
  );
  const current = normalized.configNormalized;

  const uniq = (list = []) => {
    const out = [];
    const seen = new Set();
    for (const entry of Array.isArray(list) ? list : []) {
      const value = String(entry || "").trim().toLowerCase();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };

  const currentAgentSet = current.agent_set && typeof current.agent_set === "object"
    ? current.agent_set
    : { mode: "all_enabled", selected: [], disabled: [] };
  const currentToolSet = current.tool_set && typeof current.tool_set === "object"
    ? current.tool_set
    : { mode: "all_enabled", selected: [], disabled: [] };
  const nextAgentSet = {
    mode: String(currentAgentSet.mode || "").trim().toLowerCase() === "selected" ? "selected" : "all_enabled",
    selected: uniq(currentAgentSet.selected),
    disabled: uniq(currentAgentSet.disabled),
  };
  const nextToolSet = {
    mode: String(currentToolSet.mode || "").trim().toLowerCase() === "selected" ? "selected" : "all_enabled",
    selected: uniq(currentToolSet.selected),
    disabled: uniq(currentToolSet.disabled),
  };
  let participants = uniq(current.participants);

  if (cleanKind === "agent") {
    if (cleanOp === "disable") {
      nextAgentSet.disabled = uniq([...nextAgentSet.disabled, cleanId]);
      if (nextAgentSet.mode === "selected") {
        nextAgentSet.selected = nextAgentSet.selected.filter((entry) => entry !== cleanId);
      }
      participants = participants.filter((entry) => entry !== cleanId);
    } else {
      nextAgentSet.disabled = nextAgentSet.disabled.filter((entry) => entry !== cleanId);
      if (nextAgentSet.mode === "selected") {
        nextAgentSet.selected = uniq([...nextAgentSet.selected, cleanId]);
      }
      participants = uniq([...participants, cleanId]);
    }
  } else if (cleanOp === "disable") {
    nextToolSet.disabled = uniq([...nextToolSet.disabled, cleanId]);
    if (nextToolSet.mode === "selected") {
      nextToolSet.selected = nextToolSet.selected.filter((entry) => entry !== cleanId);
    }
  } else {
    nextToolSet.disabled = nextToolSet.disabled.filter((entry) => entry !== cleanId);
    if (nextToolSet.mode === "selected") {
      nextToolSet.selected = uniq([...nextToolSet.selected, cleanId]);
    }
  }

  const nextConfig = {
    ...current,
    version: Math.max(2, Number(current.version || 2) || 2),
    schema_version: Math.max(2, Number(current.schema_version || current.schemaVersion || 2) || 2),
    participants,
    agent_set: nextAgentSet,
    tool_set: nextToolSet,
    updated_at: new Date().toISOString(),
  };
  const rawText = `${JSON.stringify(nextConfig, null, 2)}\n`;

  if (latest?.id) {
    await client.updateNode(String(latest.id), {
      text_mode: "plain",
      text: rawText,
      raw_text: rawText,
      summary: `job_config ${cleanOp}_${cleanKind}:${cleanId}`,
    });
  } else {
    await client.createResource(map.threadId, {
      name: `job_config@${new Date().toISOString()}`,
      summary: `job_config ${cleanOp}_${cleanKind}:${cleanId}`,
      text_mode: "plain",
      raw_text: rawText,
      resource_kind: "job_config",
      uri: `ddalggak://jobs/${cleanJobId}/job_config`,
      context_set_id: map.ctxSharedId,
      auto_activate: false,
      payload_json: {
        op: `${cleanOp}_${cleanKind}`,
        ts: new Date().toISOString(),
        job_id: cleanJobId,
        actor: actor || undefined,
        job_config: nextConfig,
      },
    });
  }

  tracking.append(cleanJobId, "decisions.md", [
    "## /chat update_job_config_selection",
    `- op: ${cleanOp}`,
    `- kind: ${cleanKind}`,
    `- id: ${cleanId}`,
    actor ? `- actor: ${actor}` : "",
  ].filter(Boolean).join("\n"));

  return {
    job_id: cleanJobId,
    op: cleanOp,
    kind: cleanKind,
    id: cleanId,
    config: nextConfig,
    node_id: String(latest?.id || "").trim(),
  };
}

function buildSupervisorExecutionCallbacks({
  bot,
  chatId,
  userId,
  jobId,
  runtime,
  controller,
  verbose,
  onAgentStatusChanged = null,
  executionGraph = null,
  contextEngine = null,
}) {
  const sharedContextSetId = String(runtime?.map?.ctxSharedId || "").trim();
  const threadId = String(runtime?.map?.threadId || "").trim();
  const currentTelegramUserId = String(userId || "").trim();
  const lensCacheByKey = new Map();
  const sharedContextMeta = runtime?.contextMeta && typeof runtime.contextMeta === "object"
    ? runtime.contextMeta
    : null;
  const hasContextEngine = !!(contextEngine && typeof contextEngine.prepareStepContext === "function");
  let threadNodeMapCache = null;

  const withBoundGocActor = async (work) => {
    const restoreActor = bindGocActor(currentTelegramUserId);
    try {
      return await work();
    } finally {
      restoreActor();
    }
  };

  function estimateTokens(text) {
    const src = String(text || "");
    if (!src) return 0;
    return Math.max(1, Math.ceil(src.length / 4));
  }

  function normalizeLensSpec(rawLens, { fallbackBudget = 1200 } = {}) {
    return normalizeLensSpecDomain(rawLens, { fallbackBudget });
  }

  function dedupeNodeIds(nodeIds = []) {
    return dedupeLensNodeIds(nodeIds);
  }

  function defaultLensSpecForAgent({ agentId = "", goal = "" } = {}) {
    return defaultLensSpecForAgentDomain({
      agentId,
      goal: clip(String(goal || "").trim(), 280),
      recentArtifactNodeIds: runtime?.recentArtifactNodeIds || [],
    });
  }

  function resolveEffectiveLensSpec(rawLens, { agentId = "", goal = "" } = {}) {
    return resolveEffectiveLensSpecDomain(rawLens, {
      agentId,
      goal: clip(String(goal || "").trim(), 280),
      recentArtifactNodeIds: runtime?.recentArtifactNodeIds || [],
    });
  }

  async function getThreadNodeMap(client, { refresh = false } = {}) {
    if (!client || !threadId) return new Map();
    if (!refresh && threadNodeMapCache instanceof Map) return threadNodeMapCache;
    const nodes = await client.listNodes(threadId, {
      contextSetId: sharedContextSetId || undefined,
    }).catch(() => []);
    const map = new Map();
    for (const row of Array.isArray(nodes) ? nodes : []) {
      const id = String(row?.id || "").trim();
      if (!id) continue;
      map.set(id, row);
    }
    threadNodeMapCache = map;
    return map;
  }

  function rankNodeForBudgetRemoval(node = {}) {
    const type = nodeTypeKey(node);
    const resourceKind = nodeResourceKind(node);
    const role = messageRoleOf(node);
    const createdMs = parseNodeCreatedAtMs(node);
    if (resourceKind === "job_config" || resourceKind === "tracking_append") {
      return { rank: 0, createdMs };
    }
    if (type === "toolresult" || type === "toolcall") {
      return { rank: 1, createdMs };
    }
    if (type === "run" || type === "step") {
      return { rank: 2, createdMs };
    }
    if (type === "resource" && resourceKind !== "artifact") {
      return { rank: 3, createdMs };
    }
    if (type === "message" && role === "assistant") {
      return { rank: 4, createdMs };
    }
    if (type === "artifact" || resourceKind === "artifact") {
      return { rank: 6, createdMs };
    }
    if (type === "message" && role === "user") {
      return { rank: 10, createdMs };
    }
    return { rank: 5, createdMs };
  }

  async function enforceLensBudget(client, {
    contextSetId = "",
    lensSpec = null,
    compiledText = "",
  } = {}) {
    const ctxId = String(contextSetId || "").trim();
    const normalizedLens = normalizeLensSpec(lensSpec, { fallbackBudget: 1200 });
    const budgetTokens = Number(normalizedLens?.budget_tokens) > 0
      ? Math.floor(Number(normalizedLens.budget_tokens))
      : 1200;

    let text = String(compiledText || "");
    let tokenEstimate = estimateTokens(text);
    let activeNodeIds = [];
    let breakdown = {};

    if (!ctxId || !client) {
      const maxChars = Math.max(1200, Math.floor(budgetTokens * 4));
      if (tokenEstimate > budgetTokens && text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n\n[context truncated: budget=${budgetTokens}]`;
        tokenEstimate = estimateTokens(text);
      }
      return {
        compiledText: text,
        compiledTokensEstimate: tokenEstimate,
        compiledChars: text.length,
        activeNodeIds: [],
        activeTypeBreakdown: {},
      };
    }

    for (let attempt = 0; attempt < 3 && tokenEstimate > budgetTokens; attempt += 1) {
      let activeIds = [];
      try {
        const ctx = await client.getContextSet(ctxId);
        activeIds = dedupeNodeIds(ctx?.activeNodeIds || []);
      } catch {
        activeIds = [];
      }
      if (activeIds.length <= 8) break;

      const nodeMap = await getThreadNodeMap(client, { refresh: attempt > 0 });
      const removable = activeIds
        .map((id) => ({ id, node: nodeMap.get(id) }))
        .filter((row) => row.id)
        .map((row) => ({
          ...row,
          ...rankNodeForBudgetRemoval(row.node || {}),
        }))
        .filter((row) => Number(row.rank) < 10)
        .sort((a, b) => {
          if (a.rank !== b.rank) return a.rank - b.rank;
          return a.createdMs - b.createdMs;
        });
      if (removable.length === 0) break;
      const removeCount = Math.max(1, Math.ceil(removable.length * 0.25));
      const removeIds = removable.slice(0, removeCount).map((row) => row.id).filter(Boolean);
      if (removeIds.length === 0) break;
      await client.deactivateNodes(ctxId, removeIds).catch(() => {});
      text = await client.getCompiledContext(ctxId).catch(() => text);
      tokenEstimate = estimateTokens(text);
    }

    if (tokenEstimate > budgetTokens) {
      const maxChars = Math.max(1200, Math.floor(budgetTokens * 4));
      if (text.length > maxChars) {
        text = `${text.slice(0, maxChars)}\n\n[context truncated: budget=${budgetTokens}]`;
        tokenEstimate = estimateTokens(text);
      }
    }

    try {
      const ctx = await client.getContextSet(ctxId);
      activeNodeIds = dedupeNodeIds(ctx?.activeNodeIds || []);
      const nodeMap = await getThreadNodeMap(client, { refresh: false });
      breakdown = summarizeActiveTypeBreakdown(activeNodeIds, nodeMap);
    } catch {
      activeNodeIds = [];
      breakdown = {};
    }

    return {
      compiledText: text,
      compiledTokensEstimate: tokenEstimate,
      compiledChars: text.length,
      activeNodeIds,
      activeTypeBreakdown: breakdown,
    };
  }

  function buildSharedContextInfo({
    lensSpec = null,
    compiledText = "",
    lensContextSetId = "",
    lensAddedCount = 0,
    contextActiveNodeIds = null,
    activeTypeBreakdown = null,
  } = {}) {
    const normalizedLens = normalizeLensSpec(lensSpec, { fallbackBudget: 1200 });
    const activeNodeIds = Array.isArray(contextActiveNodeIds)
      ? contextActiveNodeIds
      : (Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : []);
    const breakdown = activeTypeBreakdown && typeof activeTypeBreakdown === "object"
      ? activeTypeBreakdown
      : (runtime?.sharedActiveTypeBreakdown && typeof runtime.sharedActiveTypeBreakdown === "object"
        ? runtime.sharedActiveTypeBreakdown
        : {});
    return {
      context_set_id: sharedContextSetId || undefined,
      context_version: String(sharedContextMeta?.version || "").trim() || undefined,
      context_active_node_ids: activeNodeIds.length > 0 ? activeNodeIds : undefined,
      shared_context_set_id: sharedContextSetId || undefined,
      shared_context_version: String(sharedContextMeta?.version || "").trim() || undefined,
      shared_context_active_node_ids: Array.isArray(sharedContextMeta?.active_node_ids) && sharedContextMeta.active_node_ids.length > 0
        ? sharedContextMeta.active_node_ids
        : undefined,
      lens_context_set_id: String(lensContextSetId || sharedContextSetId || "").trim() || undefined,
      lens_spec: normalizedLens,
      lens_budget_tokens: normalizedLens.budget_tokens,
      lens_added_ids_count: Number.isFinite(Number(lensAddedCount)) ? Math.max(0, Math.floor(Number(lensAddedCount))) : 0,
      compiled_tokens_estimate: estimateTokens(compiledText),
      compiled_chars: String(compiledText || "").length,
      active_type_breakdown: breakdown,
    };
  }

  async function prepareStepLensContext({
    agentId = "",
    goal = "",
    lens = null,
    detailContext = "",
    stepNodeId = "",
  } = {}) {
    const cleanAgentId = String(agentId || "").trim().toLowerCase();
    const cleanGoal = String(goal || "").trim();
    const cleanDetail = String(detailContext || "").trim();
    const cleanStepNodeId = String(stepNodeId || "").trim();
    if (hasContextEngine) {
      const prepared = await contextEngine.prepareStepContext({
        jobId,
        chatId: String(chatId || ""),
        threadId,
        agentId: cleanAgentId,
        goal: cleanGoal,
        userMessageText: cleanGoal,
        stepKind: "agent",
        budgetTokens: Number.isFinite(Number(lens?.budget_tokens))
          ? Number(lens.budget_tokens)
          : undefined,
        lensSpec: lens && typeof lens === "object" ? lens : null,
        detailContext: cleanDetail,
        runMeta: {
          runId: String(executionGraph?.runId || "").trim(),
          stepId: cleanStepNodeId || undefined,
          stepNodeId: cleanStepNodeId || undefined,
          threadId,
          sharedContextSetId,
          runtimeTeamSnapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
          jobConfig: runtime?.jobConfig && typeof runtime.jobConfig === "object"
            ? runtime.jobConfig
            : undefined,
        },
      });
      const contextText = String(prepared?.contextText || "").trim();
      const meta = prepared?.meta && typeof prepared.meta === "object"
        ? prepared.meta
        : {};
      const contextInfo = {
        mode: String(meta.mode || "").trim() || undefined,
        budgetTokens: Number.isFinite(Number(meta.budgetTokens))
          ? Math.floor(Number(meta.budgetTokens))
          : undefined,
        token_estimate: Number.isFinite(Number(meta.estimatedTokens))
          ? Math.floor(Number(meta.estimatedTokens))
          : undefined,
        compiled_tokens_estimate: Number.isFinite(Number(meta.estimatedTokens))
          ? Math.floor(Number(meta.estimatedTokens))
          : undefined,
        compiled_chars: Number.isFinite(Number(meta.compiledChars))
          ? Math.floor(Number(meta.compiledChars))
          : String(contextText).length,
        context_set_id: String(meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        context_version: String(meta.contextVersion || sharedContextMeta?.version || "").trim() || undefined,
        context_active_node_ids: Array.isArray(meta.contextActiveNodeIds) && meta.contextActiveNodeIds.length > 0
          ? meta.contextActiveNodeIds
          : undefined,
        shared_context_set_id: String(meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        lens_context_set_id: String(meta.lensContextSetId || meta.sharedContextSetId || sharedContextSetId || "").trim() || undefined,
        lens_spec: meta.lensSpec && typeof meta.lensSpec === "object"
          ? meta.lensSpec
          : (lens && typeof lens === "object" ? lens : undefined),
        lens_added_ids_count: Number.isFinite(Number(meta.lensAddedCount))
          ? Math.max(0, Math.floor(Number(meta.lensAddedCount)))
          : 0,
        lens_removed_ids_count: Number.isFinite(Number(meta.lensRemovedCount))
          ? Math.max(0, Math.floor(Number(meta.lensRemovedCount)))
          : 0,
        activeNodeIdsCount: Number.isFinite(Number(meta.activeNodeIdsCount))
          ? Math.max(0, Math.floor(Number(meta.activeNodeIdsCount)))
          : undefined,
        node_type_breakdown: meta.typeBreakdown && typeof meta.typeBreakdown === "object"
          ? meta.typeBreakdown
          : undefined,
        active_type_breakdown: meta.typeBreakdown && typeof meta.typeBreakdown === "object"
          ? meta.typeBreakdown
          : undefined,
        local_recent_turns_count: Number.isFinite(Number(meta.localRecentTurnsCount))
          ? Math.max(0, Math.floor(Number(meta.localRecentTurnsCount)))
          : undefined,
        local_summary_chars: Number.isFinite(Number(meta.localSummaryChars))
          ? Math.max(0, Math.floor(Number(meta.localSummaryChars)))
          : undefined,
        local_pinned_count: Number.isFinite(Number(meta.localPinnedCount))
          ? Math.max(0, Math.floor(Number(meta.localPinnedCount)))
          : undefined,
      };
      await contextEngine.recordMeta({
        jobId,
        chatId: String(chatId || ""),
        agentId: cleanAgentId,
        goal: cleanGoal,
        userMessageText: cleanGoal,
        stepKind: "agent",
        runMeta: {
          runId: String(executionGraph?.runId || "").trim(),
          stepId: cleanStepNodeId || undefined,
          stepNodeId: cleanStepNodeId || undefined,
          threadId,
          sharedContextSetId,
          runtimeTeamSnapshot: runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
            ? runtime.runtimeTeamSnapshot
            : undefined,
        },
        meta,
      }).catch(() => {});
      const finalPrompt = [
        cleanGoal,
        contextText ? `[CONTEXT]\n${clip(contextText, 12000)}` : "",
        cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
        runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
      ].filter(Boolean).join("\n\n");
      return {
        final_prompt: finalPrompt,
        context_info: contextInfo,
      };
    }
    const lensSpec = resolveEffectiveLensSpec(lens, {
      agentId: cleanAgentId,
      goal: cleanGoal,
    });
    const sharedCompiled = String(runtime?.contextSummary || "").trim();

    const fallbackText = [
      cleanGoal,
      sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : "",
      cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
      runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
    ].filter(Boolean).join("\n\n");

    if (memoryModeWithFallback() !== "goc" || !sharedContextSetId) {
      return {
        final_prompt: fallbackText,
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: fallbackText,
          lensContextSetId: sharedContextSetId || undefined,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: {},
        }),
      };
    }

    // shared_only + no extra detail + within budget: reuse shared context directly (skip clone/apply)
    if (
      lensSpec.mode === "shared_only"
      && !cleanDetail
      && estimateTokens(sharedCompiled) <= Number(lensSpec?.budget_tokens || 1200)
    ) {
      return {
        final_prompt: [
          cleanGoal,
          sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : "",
          runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
        ].filter(Boolean).join("\n\n"),
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: sharedCompiled,
          lensContextSetId: sharedContextSetId,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
        }),
      };
    }

    const lensKey = JSON.stringify({
      agent_id: cleanAgentId || "",
      shared_context_set_id: sharedContextSetId,
      shared_context_version: String(sharedContextMeta?.version || "").trim(),
      lens: lensSpec,
      detail: cleanDetail ? clip(cleanDetail, 600) : "",
    });
    if (lensCacheByKey.has(lensKey)) {
      const cached = lensCacheByKey.get(lensKey);
      const prompt = [
        cleanGoal,
        cached?.compiled_prompt || "",
        cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
        runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
      ].filter(Boolean).join("\n\n");
      return {
        final_prompt: prompt,
        context_info: buildSharedContextInfo({
          lensSpec,
          compiledText: String(cached?.compiled_text || ""),
          lensContextSetId: cached?.lens_context_set_id || sharedContextSetId,
          lensAddedCount: Number.isFinite(Number(cached?.lens_added_ids_count))
            ? Number(cached.lens_added_ids_count)
            : 0,
          contextActiveNodeIds: Array.isArray(cached?.active_node_ids) ? cached.active_node_ids : [],
          activeTypeBreakdown: cached?.active_type_breakdown || {},
        }),
      };
    }

    const client = requireGocClient();
    let lensContextSetId = sharedContextSetId;
    let lensAddedCount = 0;
    let lensCompiledText = sharedCompiled;
    let enforced = {
      compiledText: sharedCompiled,
      compiledTokensEstimate: estimateTokens(sharedCompiled),
      compiledChars: sharedCompiled.length,
      activeNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
      activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
    };
    try {
      const cloned = await client.cloneContextSet(
        sharedContextSetId,
        `lens:${cleanAgentId || "agent"}@${Date.now().toString(36)}`,
        {
          kind: "agent_lens",
          agent_id: cleanAgentId || undefined,
          goal: cleanGoal || undefined,
          job_id: String(jobId || "").trim() || undefined,
          chat_id: String(chatId || "").trim() || undefined,
          lens_spec: lensSpec,
        }
      );
      lensContextSetId = String(cloned?.id || sharedContextSetId).trim() || sharedContextSetId;
      if (lensSpec.mode === "unfold_query" && lensSpec.query) {
        const plan = await client.unfoldPlan(lensContextSetId, lensSpec.query, lensSpec);
        const applied = await client.applyUnfoldPlan(lensContextSetId, plan, lensSpec);
        lensAddedCount = Array.isArray(applied?.added_node_ids) ? applied.added_node_ids.length : 0;
      }
      if (Array.isArray(lensSpec.add_node_ids) && lensSpec.add_node_ids.length > 0) {
        await client.activateNodes(lensContextSetId, lensSpec.add_node_ids);
        lensAddedCount += lensSpec.add_node_ids.length;
      }
      if (Array.isArray(lensSpec.remove_node_ids) && lensSpec.remove_node_ids.length > 0) {
        await client.deactivateNodes(lensContextSetId, lensSpec.remove_node_ids);
      }
      lensCompiledText = await client.getCompiledContext(lensContextSetId);
      enforced = await enforceLensBudget(client, {
        contextSetId: lensContextSetId,
        lensSpec,
        compiledText: lensCompiledText,
      });
      lensCompiledText = String(enforced?.compiledText || lensCompiledText || "").trim();
    } catch {
      lensContextSetId = sharedContextSetId;
      lensCompiledText = sharedCompiled;
      lensAddedCount = 0;
      enforced = {
        compiledText: sharedCompiled,
        compiledTokensEstimate: estimateTokens(sharedCompiled),
        compiledChars: sharedCompiled.length,
        activeNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
        activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
      };
    }

    const compiledPrompt = [
      sharedCompiled ? `[SHARED SUMMARY]\n${clip(sharedCompiled, 3500)}` : "",
      lensCompiledText ? `[LENS CONTEXT]\n${clip(lensCompiledText, 9000)}` : "",
    ].filter(Boolean).join("\n\n");
    const finalPrompt = [
      cleanGoal,
      compiledPrompt || (sharedCompiled ? `[JOB COMPILED CONTEXT]\n${clip(sharedCompiled, 9000)}` : ""),
      cleanDetail ? `[DETAIL CONTEXT]\n${cleanDetail}` : "",
      runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
    ].filter(Boolean).join("\n\n");
    const cachePayload = {
      lens_context_set_id: lensContextSetId,
      compiled_prompt: compiledPrompt,
      compiled_text: lensCompiledText,
      lens_added_ids_count: lensAddedCount,
      active_node_ids: Array.isArray(enforced?.activeNodeIds) ? enforced.activeNodeIds : [],
      active_type_breakdown: enforced?.activeTypeBreakdown && typeof enforced.activeTypeBreakdown === "object"
        ? enforced.activeTypeBreakdown
        : {},
    };
    lensCacheByKey.set(lensKey, cachePayload);
    return {
      final_prompt: finalPrompt,
      context_info: buildSharedContextInfo({
        lensSpec,
        compiledText: lensCompiledText,
        lensContextSetId,
        lensAddedCount,
        contextActiveNodeIds: Array.isArray(enforced?.activeNodeIds) ? enforced.activeNodeIds : [],
        activeTypeBreakdown: enforced?.activeTypeBreakdown || {},
      }),
    };
  }

  const runSingleAgent = async ({
    agentId,
    goal,
    detailContext = "",
    stepNodeId = "",
    preparedContext = null,
  }) => {
    const cleanAgentId = String(agentId || "").trim().toLowerCase();
    const cleanGoal = String(goal || "").trim();
    if (cleanAgentId) {
      updateAgentStatus(chatId, cleanAgentId, {
        state: "running",
        goal: cleanGoal,
        started_at: new Date().toISOString(),
        ended_at: undefined,
      });
      if (typeof onAgentStatusChanged === "function") {
        await onAgentStatusChanged({
          chatId,
          agentId: cleanAgentId,
          state: "running",
          goal: cleanGoal,
        });
      }
    }

    const prepared = preparedContext && typeof preparedContext === "object"
      ? preparedContext
      : await prepareStepLensContext({
        agentId: cleanAgentId,
        goal: cleanGoal,
        lens: null,
        detailContext,
        stepNodeId,
      });
    const nextActionsInstruction = [
      "[OUTPUT CONTRACT]",
      "- 필요하면 마지막에 NEXT_ACTIONS_JSON 블록으로 후속 작업을 제안하라.",
      "- 형식:",
      "NEXT_ACTIONS_JSON",
      "```json",
      "{\"actions\":[{\"type\":\"run_agent\",\"agent_id\":\"coder\",\"goal\":\"...\"}]}",
      "```",
      "- 후속 제안이 없으면 NEXT_ACTIONS_JSON 블록은 생략한다.",
    ].join("\n");
    const finalPrompt = [
      String(prepared?.final_prompt || "").trim() || cleanGoal,
      nextActionsInstruction,
    ].filter(Boolean).join("\n\n");
    try {
      const result = await enqueue(
        () => executeAgentRun(
          bot,
          chatId,
          jobId,
          { type: "agent_run", agent: cleanAgentId, prompt: finalPrompt },
          {
            runtime,
            telegramUserId: currentTelegramUserId,
            signal: controller.signal,
            notify: verbose,
            geminiConcurrencyKey: `job:${String(jobId || "").trim()}`,
            onGeminiRetry: async ({ retryCount = 0, maxRetries = 0 } = {}) => {
              await sendGeminiRetryMessage(bot, chatId, {
                retryCount,
                maxRetries,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
              });
            },
            onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
              await sendGeminiModelSwitchMessage(bot, chatId, {
                toModel,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
              });
            },
            onGeminiGiveUp: async ({ reason = "" } = {}) => {
              await sendGeminiGiveUpMessage(bot, chatId, {
                reason,
                agentId: cleanAgentId,
                replyToMessageId: getCurrentTurnReplyMessageId(chatId),
              });
            },
          }
        ),
        { jobId, signal: controller.signal, label: `chat_v2_run_${String(cleanAgentId || "agent")}` }
      );
      if (cleanAgentId) {
        updateAgentStatus(chatId, cleanAgentId, {
          state: "done",
          goal: cleanGoal,
          ended_at: new Date().toISOString(),
        });
        if (typeof onAgentStatusChanged === "function") {
          await onAgentStatusChanged({
            chatId,
            agentId: cleanAgentId,
            state: "done",
            goal: cleanGoal,
          });
        }
      }
      if (executionGraph && cleanAgentId && stepNodeId && String(result?.output || "").trim()) {
        await executionGraph.attachArtifact(String(stepNodeId || "").trim(), {
          name: `artifact:${cleanAgentId}@${new Date().toISOString()}`,
          summary: clip(`@${cleanAgentId} output`, 220),
          text: String(result.output || ""),
          uri: `ddalggak://jobs/${jobId}/agents/${cleanAgentId}/output`,
          payload: {
            kind: "agent_output",
            agent_id: cleanAgentId,
            provider: String(result?.provider || "").trim().toLowerCase() || undefined,
          },
        });
      }
      return result;
    } catch (e) {
      if (cleanAgentId) {
        updateAgentStatus(chatId, cleanAgentId, {
          state: "error",
          goal: cleanGoal,
          ended_at: new Date().toISOString(),
        });
        if (typeof onAgentStatusChanged === "function") {
          await onAgentStatusChanged({
            chatId,
            agentId: cleanAgentId,
            state: "error",
            goal: cleanGoal,
            error: String(e?.message ?? e),
          });
        }
      }
      throw e;
    }
  };

  const runActionWithGraph = async ({
    action,
    detailContext = "",
    toolName = "",
    work,
    onSuccess = null,
    onError = null,
  }) => {
    const stepNodeId = executionGraph ? executionGraph.getStepNodeId(action) : "";
    const cleanToolName = String(toolName || action?.type || "action").trim().toLowerCase() || "action";
    const inputPreview = toolInputPreviewFromAction(action, detailContext);
    const defaultAgentId = String(action?.agent_id || action?.agent || "").trim().toLowerCase();
    const actionType = String(action?.type || "").trim().toLowerCase();
    const preparedContext = (actionType === "run_agent" || actionType === "spawn_agents")
      ? await prepareStepLensContext({
        agentId: defaultAgentId,
        goal: getActionGoal(action),
        lens: action?.lens && typeof action.lens === "object" ? action.lens : null,
        detailContext,
        stepNodeId,
      })
      : {
        final_prompt: "",
        context_info: buildSharedContextInfo({
          lensSpec: action?.lens || null,
          compiledText: String(runtime?.contextSummary || ""),
          lensContextSetId: sharedContextSetId || undefined,
          lensAddedCount: 0,
          contextActiveNodeIds: Array.isArray(sharedContextMeta?.active_node_ids) ? sharedContextMeta.active_node_ids : [],
          activeTypeBreakdown: runtime?.sharedActiveTypeBreakdown || {},
        }),
      };
    if (executionGraph && stepNodeId) {
      await executionGraph.markStepRunning(action, {
        extra: preparedContext?.context_info || {},
      });
    }
    const toolCall = executionGraph
      ? await executionGraph.startToolCall(stepNodeId, {
        toolName: cleanToolName,
        inputPreview,
        status: "running",
      })
      : null;
    const toolCallNodeId = String(toolCall?.id || "").trim();

    try {
      const result = await work({ stepNodeId, preparedContext });
      const outputPreview = outputPreviewFromResult(result);
      if (executionGraph && stepNodeId) {
        await executionGraph.finishToolCall(toolCallNodeId, {
          status: "done",
          outputPreview,
        });
        await executionGraph.recordToolResult({
          stepNodeId,
          toolCallNodeId,
          toolName: cleanToolName,
          outputPreview,
          status: "done",
        });
        await executionGraph.markStepDone(action, {
          output: outputPreview,
          extra: preparedContext?.context_info || {},
        });
      }
      if (typeof onSuccess === "function") {
        await onSuccess({ result, stepNodeId, outputPreview });
      }
      return result;
    } catch (e) {
      const errText = String(e?.message ?? e);
      if (executionGraph && stepNodeId) {
        await executionGraph.finishToolCall(toolCallNodeId, {
          status: "error",
          error: errText,
        });
        await executionGraph.recordToolResult({
          stepNodeId,
          toolCallNodeId,
          toolName: cleanToolName,
          outputPreview: errText,
          status: "error",
          error: errText,
        });
        await executionGraph.markStepError(action, e, {
          output: errText,
          extra: preparedContext?.context_info || {},
        });
      }
      if (typeof onError === "function") {
        await onError({ error: e, stepNodeId });
      }
      throw e;
    }
  };

  const runSpawnAgents = async ({ action, detailContext, parentStepNodeId = "" }) => {
    const children = Array.isArray(action?.agents) ? action.agents : [];
    if (children.length === 0) {
      return {
        summary: "spawn할 agent가 없습니다.",
        children: [],
      };
    }

    const limitRaw = Number(action?.max_parallel);
    const maxParallel = Number.isFinite(limitRaw)
      ? Math.max(1, Math.min(MAX_PARALLEL_PER_RUN, Math.floor(limitRaw)))
      : MAX_PARALLEL_PER_RUN;
    const parentAgentId = String(action?.parent_agent_id || action?.agent_id || "router").trim().toLowerCase() || "router";
    const childAgentIds = children
      .map((row) => String(row?.agent_id || "").trim().toLowerCase())
      .filter(Boolean);
    if (childAgentIds.length > 0) {
      await bot.sendMessage(
        chatId,
        `📣 @${parentAgentId} → ${childAgentIds.map((id) => `@${id}`).join(", ")} (병렬)`,
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined
      );
    }
    const childSteps = executionGraph
      ? await executionGraph.createSpawnChildSteps({
        parentAction: action,
        children,
      })
      : [];
    const childStepByIndex = new Map(
      childSteps.map((row) => [Number(row.index), row])
    );

    const childResults = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxParallel, children.length) }, async () => {
      while (cursor < children.length) {
        const idx = cursor;
        cursor += 1;
        const child = children[idx];
        const agentId = String(child?.agent_id || "").trim().toLowerCase();
        const goal = String(child?.goal || "").trim();
        if (!agentId || !goal) continue;
        const childStep = childStepByIndex.get(idx);
        const childStepNodeId = String(childStep?.node_id || "").trim();
        const preparedContext = await prepareStepLensContext({
          agentId,
          goal,
          lens: (child?.lens && typeof child.lens === "object")
            ? child.lens
            : (action?.lens && typeof action.lens === "object" ? action.lens : null),
          detailContext,
          stepNodeId: childStepNodeId,
        });
        if (executionGraph && childStepNodeId) {
          await executionGraph.markStepNodeRunning(childStepNodeId, {
            extra: preparedContext?.context_info || {},
          });
        }
        const childToolCall = executionGraph
          ? await executionGraph.startToolCall(childStepNodeId, {
            toolName: "run_agent",
            inputPreview: clip(`@${agentId} ${goal}`, 900),
            status: "running",
          })
          : null;
        const childToolCallNodeId = String(childToolCall?.id || "").trim();
        try {
          const result = await runSingleAgent({
            agentId,
            goal,
            detailContext,
            stepNodeId: childStepNodeId,
            preparedContext,
          });
          if (executionGraph && childStepNodeId) {
            const preview = outputPreviewFromResult(result);
            await executionGraph.finishToolCall(childToolCallNodeId, {
              status: "done",
              outputPreview: preview,
            });
            await executionGraph.recordToolResult({
              stepNodeId: childStepNodeId,
              toolCallNodeId: childToolCallNodeId,
              toolName: "run_agent",
              outputPreview: preview,
              status: "done",
            });
            await executionGraph.markStepNodeDone(childStepNodeId, {
              output: preview,
              extra: preparedContext?.context_info || {},
            });
          }
          childResults.push({
            agent_id: agentId,
            status: "ok",
            output: String(result?.output || ""),
            provider: String(result?.provider || ""),
            step_node_id: childStepNodeId || undefined,
          });
        } catch (e) {
          if (executionGraph && childStepNodeId) {
            const preview = String(e?.message ?? e);
            await executionGraph.finishToolCall(childToolCallNodeId, {
              status: "error",
              error: preview,
            });
            await executionGraph.recordToolResult({
              stepNodeId: childStepNodeId,
              toolCallNodeId: childToolCallNodeId,
              toolName: "run_agent",
              outputPreview: preview,
              status: "error",
              error: preview,
            });
            await executionGraph.markStepNodeError(childStepNodeId, e, {
              output: preview,
              extra: preparedContext?.context_info || {},
            });
          }
          childResults.push({
            agent_id: agentId,
            status: "error",
            error: String(e?.message ?? e),
            step_node_id: childStepNodeId || undefined,
          });
          if (isCancelledError(e)) throw e;
        }
      }
    });
    const settledWorkers = await Promise.allSettled(workers);
    for (const row of settledWorkers) {
      if (row.status === "rejected" && isCancelledError(row.reason)) {
        throw row.reason;
      }
    }

    const okCount = childResults.filter((row) => row.status === "ok").length;
    const errorCount = childResults.filter((row) => row.status === "error").length;
    if (executionGraph && parentStepNodeId) {
      const join = await executionGraph.createJoinStep({
        parentAction: action,
        childStepNodeIds: childResults.map((row) => String(row?.step_node_id || "").trim()).filter(Boolean),
        agentId: "router",
        goal: "병렬 실행 결과를 결합",
        summary: `spawn join ok=${okCount}, error=${errorCount}`,
      });
      const joinNodeId = String(join?.node_id || "").trim();
      if (joinNodeId) {
        await executionGraph.markStepNodeRunning(joinNodeId, {
          extra: {
            mode: "spawn_join",
          },
        });
        await executionGraph.markStepNodeDone(joinNodeId, {
          output: `ok=${okCount}, error=${errorCount}`,
          extra: {
            mode: "spawn_join",
          },
        });
      }
    }
    return {
      summary: `병렬 실행 완료: ok=${okCount}, error=${errorCount}`,
      children: childResults,
    };
  };

  return {
    runAgent: async ({ action, detailContext }) => {
      return await runActionWithGraph({
        action,
        detailContext,
        toolName: "run_agent",
        work: async ({ stepNodeId, preparedContext }) => {
          return await runSingleAgent({
            agentId: String(action.agent_id || "").trim().toLowerCase(),
            goal: String(action.goal || "").trim(),
            detailContext,
            stepNodeId,
            preparedContext,
          });
        },
      });
    },
    spawnAgents: async ({ action, detailContext }) => {
      return await runActionWithGraph({
        action,
        detailContext,
        toolName: "spawn_agents",
        work: async ({ stepNodeId }) => {
          return await runSpawnAgents({
            action,
            detailContext,
            parentStepNodeId: stepNodeId,
          });
        },
      });
    },
    proposeAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "propose_agent",
        work: async () => {
          return await createAgentDraftProposal(bot, chatId, userId, jobId, action);
        },
      });
    },
    createAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "create_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("create_agent requires MEMORY_MODE=goc");
          }
          const profile = action?.agent && typeof action.agent === "object" ? action.agent : {};
          const created = await withBoundGocActor(async () => {
            return await createAgentProfile(requireGocClient(), {
              baseDir: jobs.baseDir,
              profile,
              format: action?.format || "json",
              actor: `telegram:${userId}`,
            });
          });
          await refreshAgentRegistry({ includeCompiled: true });
          const createdId = String(profile.id || created?.created?.id || "").trim();
          return {
            agent_id: createdId,
            text: createdId
              ? `✅ agent 생성 완료: @${createdId}`
              : "✅ agent 생성 완료",
          };
        },
      });
    },
    updateAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "update_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("update_agent requires MEMORY_MODE=goc");
          }
          const targetAgentId = String(action?.agentId || "").trim().toLowerCase();
          const updated = await withBoundGocActor(async () => {
            return await updateAgentProfile(requireGocClient(), {
              baseDir: jobs.baseDir,
              agentId: targetAgentId,
              patch: action?.patch || {},
              format: action?.format || "json",
              actor: `telegram:${userId}`,
            });
          });
          await refreshAgentRegistry({ includeCompiled: true });
          return {
            agent_id: targetAgentId || String(updated?.created?.id || "").trim(),
            text: targetAgentId
              ? `✅ agent 수정 완료: @${targetAgentId}`
              : "✅ agent 수정 완료",
          };
        },
      });
    },
    createAgentDefinition: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "create_agent_definition",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("create_agent_definition requires MEMORY_MODE=goc");
          }
          const rawSpec = action?.agent_spec && typeof action.agent_spec === "object"
            ? action.agent_spec
            : {};
          const spec = buildGocAgentCreateSpec(rawSpec);
          if (!spec.name) {
            throw new Error("create_agent_definition requires agent_spec.name");
          }
          const { created, createdId, addedToConversation, convRowsAfterAdd } = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.createAgent !== "function") {
              throw new Error("GoC createAgent API unavailable");
            }
            const created = await client.createAgent(spec);
            const createdId = String(created?.id || "").trim();
            let addedToConversation = false;
            let convRowsAfterAdd = null;
            if (action?.add_to_conversation === true && runtime?.map?.threadId && createdId) {
              await client.ensureConversation(runtime.map.threadId);
              await client.addConversationAgent(runtime.map.threadId, createdId, action?.enabled !== false);
              if (typeof client.listConversationAgents === "function") {
                convRowsAfterAdd = await client.listConversationAgents(runtime.map.threadId);
              }
              addedToConversation = true;
            }
            return { created, createdId, addedToConversation, convRowsAfterAdd };
          });
          if (Array.isArray(convRowsAfterAdd)) {
            const enabled = Array.from(new Set(
              convRowsAfterAdd
                .filter((row) => row?.enabled !== false)
                .map((row) => String(row?.agent_id || "").trim().toLowerCase())
                .filter(Boolean)
            ));
            runtime.conversationAgents = convRowsAfterAdd;
            runtime.enabledAgentIds = enabled;
            runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
              .filter((agent) => enabled.includes(String(agent?.id || "").trim().toLowerCase()));
            runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
          }
          await refreshAgentRegistry({ includeCompiled: true });
          const createdName = String(created?.name || spec.name || "").trim() || "(unnamed)";
          const createdModel = String(created?.model || spec.model || "").trim() || "n/a";
          const createdTools = Array.isArray(created?.tools) && created.tools.length > 0
            ? created.tools
            : (Array.isArray(spec.tools) ? spec.tools : []);
          const toolsText = createdTools.length > 0 ? createdTools.join(", ") : "(none)";
          return {
            id: createdId,
            agent_id: createdId,
            name: createdName,
            model: createdModel,
            tools: createdTools,
            added_to_conversation: addedToConversation,
            text: [
              "✅ agent definition 생성 완료",
              `- name: ${createdName}`,
              `- agent_id: ${createdId || "unknown"}`,
              `- model: ${createdModel}`,
              `- tools: ${toolsText}`,
              `- conversation 추가: ${addedToConversation ? "yes" : "no"}`,
            ].join("\n"),
          };
        },
      });
    },
    forkAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "fork_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("fork_agent requires MEMORY_MODE=goc");
          }
          const sourceId = String(action?.agent_id || "").trim().toLowerCase();
          if (!sourceId) throw new Error("fork_agent requires agent_id");
          const forked = await withBoundGocActor(async () => {
            const client = requireGocClient();
            if (typeof client.forkAgent !== "function") {
              throw new Error("GoC forkAgent API unavailable");
            }
            return await client.forkAgent(sourceId);
          });
          const forkedId = String(forked?.id || "").trim().toLowerCase();
          await refreshAgentRegistry({ includeCompiled: true });
          return {
            id: forkedId,
            agent_id: forkedId,
            source_agent_id: sourceId,
            text: forkedId
              ? `✅ agent fork 완료: @${sourceId} -> @${forkedId}`
              : `✅ agent fork 요청 완료: @${sourceId}`,
          };
        },
      });
    },
    addAgentToConversation: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "add_agent_to_conversation",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("add_agent_to_conversation requires MEMORY_MODE=goc");
          }
          const threadId = String(runtime?.map?.threadId || "").trim();
          if (!threadId) throw new Error("conversation thread is not ready");
          const agentId = String(action?.agent_id || "").trim().toLowerCase();
          if (!agentId) throw new Error("add_agent_to_conversation requires agent_id");
          const convRows = await withBoundGocActor(async () => {
            const client = requireGocClient();
            await client.ensureConversation(threadId);
            await client.addConversationAgent(threadId, agentId, action?.enabled !== false);
            if (typeof client.listConversationAgents !== "function") {
              throw new Error("listConversationAgents API unavailable");
            }
            return await client.listConversationAgents(threadId);
          });
          const enabled = Array.from(new Set(
            convRows
              .filter((row) => row?.enabled !== false)
              .map((row) => String(row?.agent_id || "").trim().toLowerCase())
              .filter(Boolean)
          ));
          runtime.conversationAgents = convRows;
          runtime.enabledAgentIds = enabled;
          runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
            .filter((agent) => enabled.includes(String(agent?.id || "").trim().toLowerCase()));
          runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
          return {
            agent_id: agentId,
            enabled_agents: enabled,
            source: "conversation_agents",
            text: `✅ conversation에 @${agentId} 추가 완료`,
          };
        },
      });
    },
    removeAgentFromConversation: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "remove_agent_from_conversation",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("remove_agent_from_conversation requires MEMORY_MODE=goc");
          }
          const threadId = String(runtime?.map?.threadId || "").trim();
          if (!threadId) throw new Error("conversation thread is not ready");
          const agentId = String(action?.agent_id || "").trim().toLowerCase();
          if (!agentId) throw new Error("remove_agent_from_conversation requires agent_id");
          const convRows = await withBoundGocActor(async () => {
            const client = requireGocClient();
            await client.ensureConversation(threadId);
            await client.removeConversationAgent(threadId, agentId);
            if (typeof client.listConversationAgents !== "function") {
              throw new Error("listConversationAgents API unavailable");
            }
            return await client.listConversationAgents(threadId);
          });
          const enabled = Array.from(new Set(
            convRows
              .filter((row) => row?.enabled !== false)
              .map((row) => String(row?.agent_id || "").trim().toLowerCase())
              .filter(Boolean)
          ));
          runtime.conversationAgents = convRows;
          runtime.enabledAgentIds = enabled;
          runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
            .filter((agent) => enabled.includes(String(agent?.id || "").trim().toLowerCase()));
          runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
          return {
            agent_id: agentId,
            enabled_agents: enabled,
            source: "conversation_agents",
            text: `🛑 conversation에서 @${agentId} 제거 완료`,
          };
        },
      });
    },
    openContext: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "open_context",
        work: async () => {
          const target = action.scope === "global" ? "global" : jobId;
          const info = await buildContextInfo(target, { chatId, userId: currentTelegramUserId || undefined });
          return {
            scope: info.scope,
            link: info.link,
            text: info.lines.join("\n"),
          };
        },
      });
    },
    needMoreDetail: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "need_more_detail",
        work: async () => {
          if (!runtime.map?.ctxSharedId || memoryModeWithFallback() !== "goc") {
            throw new Error("need_more_detail requires MEMORY_MODE=goc");
          }
          const contextSetId = String(action.context_set_id || runtime.map.ctxSharedId).trim() || runtime.map.ctxSharedId;
          return await expandDetailContext({
            client: requireGocClient(),
            contextSetId,
            nodeIds: action.node_ids || [],
            depth: action.depth || 1,
            maxChars: action.max_chars || 7000,
          });
        },
      });
    },
    getStatus: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "get_status",
        work: async () => {
          return buildChatStatusCard(chatId, runtime);
        },
      });
    },
    interrupt: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "interrupt",
        work: async () => {
          const mode = String(action?.mode || "").trim().toLowerCase() === "cancel" ? "cancel" : "replan";
          requestChatInterrupt(chatId, {
            mode,
            reason: String(action?.note || "").trim(),
          });
          if (mode === "cancel") {
            chatSessionStore.upsert(chatId, {
              pending_user_messages: [],
              pending_approval: null,
              state: "idle",
            });
          }
          return {
            mode,
            text: mode === "cancel"
              ? "⛔️ 현재 실행을 중단했어요. 다음 지시를 주세요."
              : "🔄 현재 실행을 중단하고 새 지시로 재계획할게요.",
          };
        },
      });
    },
    summarize: async ({ action, results }) => {
      return await runActionWithGraph({
        action,
        toolName: "summarize",
        work: async () => {
          const okCount = results.filter((row) => row.status === "ok").length;
          const errorCount = results.filter((row) => row.status === "error").length;
          return { text: `실행 완료: ok=${okCount}, error=${errorCount}` };
        },
      });
    },
    searchPublicAgents: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "search_public_agents",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("search_public_agents requires MEMORY_MODE=goc");
          }
          const client = requireGocClient();
          const allBlueprints = await listPublicBlueprints(client);
          const filtered = filterPublicBlueprintCandidates(
            allBlueprints,
            action.query || "",
            action.limit || 5
          );
          chatSessionStore.upsert(chatId, {
            public_search_cache: filtered.map((row) => ({
              blueprint_id: row.blueprint_id,
              public_node_id: row.public_node_id,
              agent_id: row.agent_id,
              title: row.title,
              tags: row.tags,
              updated_at: new Date().toISOString(),
            })),
          });
          return { items: filtered, total: allBlueprints.length };
        },
      });
    },
    installAgentBlueprint: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "install_agent_blueprint",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("install_agent_blueprint requires MEMORY_MODE=goc");
          }
          if (!runtime.agentsSlot?.threadId || !runtime.agentsSlot?.ctxId) {
            throw new Error("agents thread/context is not ready");
          }
          const client = requireGocClient();
          const allBlueprints = await listPublicBlueprints(client);
          const byNode = new Map(allBlueprints.map((row) => [String(row.public_node_id || "").trim(), row]));
          const byBlueprintId = new Map(allBlueprints.map((row) => [String(row.blueprint_id || "").trim(), row]));
          const byAgentId = new Map(
            allBlueprints
              .map((row) => [String(row.agent_id || "").trim().toLowerCase(), row])
              .filter((entry) => entry[0])
          );

          let selected = null;
          const requestedNode = String(action.public_node_id || "").trim();
          const requestedBlueprint = String(action.blueprint_id || "").trim();
          const override = String(action.agent_id_override || "").trim().toLowerCase();
          if (requestedNode && byNode.has(requestedNode)) selected = byNode.get(requestedNode);
          if (!selected && requestedBlueprint && byBlueprintId.has(requestedBlueprint)) selected = byBlueprintId.get(requestedBlueprint);
          if (!selected && override && byAgentId.has(override)) selected = byAgentId.get(override);
          if (!selected) {
            const session = chatSessionStore.get(chatId);
            const cached = resolveInstallCandidateFromSession(session, action);
            if (cached?.public_node_id && byNode.has(cached.public_node_id)) {
              selected = byNode.get(cached.public_node_id);
            } else if (cached?.blueprint_id && byBlueprintId.has(cached.blueprint_id)) {
              selected = byBlueprintId.get(cached.blueprint_id);
            } else if (cached?.agent_id && byAgentId.has(cached.agent_id)) {
              selected = byAgentId.get(cached.agent_id);
            }
          }
          if (!selected && allBlueprints.length === 1) selected = allBlueprints[0];
          if (!selected) {
            throw new Error("설치할 blueprint를 특정하지 못했습니다. 먼저 public agent 검색 후 후보를 지정하세요.");
          }

          const installed = await installBlueprint(client, selected.resource || selected, {
            agentsThreadId: runtime.agentsSlot.threadId,
            ctxId: runtime.agentsSlot.ctxId,
            agentIdOverride: override || "",
          });
          await refreshAgentRegistry({ includeCompiled: true });
          tracking.append(jobId, "decisions.md", [
            "## /chat install_agent_blueprint",
            `- blueprint_id: ${installed.blueprint_id || selected.blueprint_id || "unknown"}`,
            `- public_node_id: ${installed.public_node_id || selected.public_node_id || "unknown"}`,
            `- installed_agent_id: ${installed.agent_id || "unknown"}`,
            `- created_node: ${installed.created?.id || "unknown"}`,
          ].join("\n"));
          return {
            ...installed,
            node_id: installed?.created?.id || "",
          };
        },
      });
    },
    publishAgent: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "publish_agent",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("publish_agent requires MEMORY_MODE=goc");
          }
          if (!runtime.agentsSlot?.threadId || !runtime.agentsSlot?.ctxId) {
            throw new Error("agents thread/context is not ready");
          }
          const client = requireGocClient();
          const targetAgentId = String(action.agent_id || "").trim().toLowerCase();
          if (targetAgentId && typeof client.publishAgent === "function") {
            const published = await client.publishAgent(targetAgentId, true);
            tracking.append(jobId, "decisions.md", [
              "## /chat publish_agent",
              `- agent_id: ${targetAgentId}`,
              `- published: ${published?.published === true ? "true" : "requested"}`,
              `- note: GoC agents catalog publish`,
            ].join("\n"));
            return {
              request_id: String(published?.id || targetAgentId),
              source_node_id: "",
              agent_id: targetAgentId,
            };
          }
          const targetNode = await findLatestAgentProfileNodeForPublish(
            client,
            runtime.agentsSlot,
            {
              agentNodeId: action.agent_node_id || "",
              agentId: action.agent_id || "",
            }
          );
          if (!targetNode?.id) {
            throw new Error("publish 대상 agent_profile node를 찾지 못했습니다.");
          }
          const request = await client.createPublishRequest(String(targetNode.id));
          tracking.append(jobId, "decisions.md", [
            "## /chat publish_agent",
            `- source_node_id: ${String(targetNode.id)}`,
            `- request_id: ${request.request_id || "unknown"}`,
            "- note: admin approval required",
          ].join("\n"));
          return request;
        },
      });
    },
    listAgents: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "list_agents",
        work: async () => {
          const convRows = Array.isArray(runtime?.conversationAgents) ? runtime.conversationAgents : [];
          const enabled = normalizeCatalogIds(runtime?.enabledAgentIds || []);
          const members = normalizeCatalogIds(convRows.map((row) => row?.agent_id));
          const disabled = action?.include_disabled === false
            ? []
            : members.filter((id) => !enabled.includes(id));
          const lines = ["현재 conversation agent 상태"];
          lines.push(`- thread_id: ${String(runtime?.map?.threadId || "").trim() || "(none)"}`);
          lines.push(enabled.length > 0
            ? `- enabled: ${enabled.map((id) => `@${id}`).join(", ")}`
            : "- enabled: (none)");
          if (action?.include_disabled !== false) {
            lines.push(disabled.length > 0
              ? `- disabled: ${disabled.map((id) => `@${id}`).join(", ")}`
              : "- disabled: (none)");
          }
          return { text: lines.join("\n") };
        },
      });
    },
    listTools: async ({ action }) => {
      return await runActionWithGraph({
        action,
        toolName: "list_tools",
        work: async () => {
          const enabled = normalizeCatalogIds(runtime.toolSelection?.enabled_ids || runtime.tools || []);
          const disabled = action?.include_disabled === false
            ? []
            : normalizeCatalogIds(runtime.toolSelection?.disabled_ids || []);
          const lines = ["현재 job tool 상태"];
          lines.push(enabled.length > 0
            ? `- enabled: ${enabled.join(", ")}`
            : "- enabled: (none)");
          if (action?.include_disabled !== false) {
            lines.push(disabled.length > 0
              ? `- disabled: ${disabled.join(", ")}`
              : "- disabled: (none)");
          }
          return { text: lines.join("\n") };
        },
      });
    },
    updateJobConfigSelection: async ({ action, op, kind, id }) => {
      return await runActionWithGraph({
        action,
        toolName: action?.type || "update_job_config_selection",
        work: async () => {
          if (memoryModeWithFallback() !== "goc") {
            throw new Error("selection update requires MEMORY_MODE=goc");
          }
          const updated = await withBoundGocActor(async () => {
            return await updateJobConfigSelection(requireGocClient(), {
              jobId,
              op,
              kind,
              id,
              actor: `telegram:${userId}`,
              agentsCatalog: runtime.agentsCatalog || runtime.agents || [],
              toolsCatalog: runtime.toolsCatalog || runtime.tools || [],
            });
          });
          if (String(updated?.source || "").trim().toLowerCase() === "conversation_agents") {
            const enabled = Array.isArray(updated?.enabledAgentIds)
              ? updated.enabledAgentIds.map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
              : [];
            runtime.conversationAgents = Array.isArray(updated?.conversationAgents) ? updated.conversationAgents : [];
            runtime.enabledAgentIds = enabled;
            runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
              .filter((agent) => enabled.includes(String(agent?.id || "").trim().toLowerCase()));
            runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
          } else {
            const normalized = normalizeSupervisorJobConfig(
              updated.config || {},
              {
                agentsCatalog: runtime.agentsCatalog || runtime.agents || [],
                toolsCatalog: runtime.toolsCatalog || runtime.tools || [],
              }
            );
            const enabledAgentSet = new Set(
              (Array.isArray(normalized.enabledAgentIds) ? normalized.enabledAgentIds : [])
                .map((entry) => String(entry || "").trim().toLowerCase())
                .filter(Boolean)
            );
            const enabledToolSet = new Set(
              (Array.isArray(normalized.enabledToolIds) ? normalized.enabledToolIds : [])
                .map((entry) => String(entry || "").trim().toLowerCase())
                .filter(Boolean)
            );
            runtime.jobConfig = normalized.configNormalized;
            runtime.enabledAgentIds = normalized.enabledAgentIds;
            runtime.enabledToolIds = normalized.enabledToolIds;
            runtime.agents = (Array.isArray(runtime.agentsCatalog) ? runtime.agentsCatalog : [])
              .filter((agent) => enabledAgentSet.has(String(agent?.id || "").trim().toLowerCase()));
            runtime.tools = (Array.isArray(runtime.toolsCatalog) ? runtime.toolsCatalog : [])
              .filter((tool) => enabledToolSet.has(String(tool?.id || "").trim().toLowerCase()));
            runtime.agentSelection = summarizeSelectionState({ catalog: runtime.agentsCatalog || [], enabled: runtime.agents });
            runtime.toolSelection = summarizeSelectionState({ catalog: runtime.toolsCatalog || [], enabled: runtime.tools });
          }
          return {
            ...updated,
            enabled_agent_ids: runtime.enabledAgentIds,
            enabled_tool_ids: runtime.enabledToolIds,
          };
        },
      });
    },
  };
}

async function runSupervisorChat(
  bot,
  chatId,
  userId,
  message,
  {
    debug = false,
    chatInfo = null,
    inputKind = "chat_message",
    telegramMessageId = null,
    forceMode = "normal",
  } = {}
) {
  const chatKey = String(chatId);
  const verbose = !!(debug || CHAT_VERBOSE);
  const cleanForceMode = normalizeForceMode(forceMode);
  let currentJobId = resolveCurrentJobIdForChat(chatId);
  let createdNewJob = false;
  if (currentJobId) {
    try {
      runDir(currentJobId);
    } catch {
      currentJobId = "";
    }
  }
  if (!currentJobId) {
    const job = await createJob(message, { ownerUserId: userId, ownerChatId: chatId });
    currentJobId = String(job.jobId);
    createdNewJob = true;
    if (memoryModeWithFallback() === "goc") {
      try {
        await loadSupervisorRuntime(currentJobId, {
          chatMeta: chatInfo,
          includeContext: false,
          includeGlobal: false,
          telegramUserId: userId,
        });
      } catch (e) {
        jobs.log(currentJobId, `conversation membership preload failed: ${String(e?.message ?? e)}`);
      }
    }
  }
  tracking.init(currentJobId);
  rememberLastChatJob(chatId, currentJobId);
  chatSessionStore.upsert(chatId, {
    jobId: currentJobId,
    state: "routing",
    pending_approval: null,
    interrupt: null,
    agent_status: {},
  });

  if (!createdNewJob) {
    jobs.appendConversation(currentJobId, "user", message, {
      kind: inputKind || "chat_message",
      chat_id: String(chatId || ""),
      user_id: String(userId || ""),
      telegram_message_id: telegramMessageId || undefined,
    });
  }
  const userMessageGoc = await appendChatMessageToGoc(currentJobId, {
    role: "user",
    text: message,
    kind: inputKind || "chat_message",
    chatId,
    userId,
  });

  const controller = resetJobAbortController(currentJobId);
  activeJobByChat.set(chatKey, currentJobId);
  let executionGraph = null;
  let runtime = null;
  let contextEngine = null;
  let finalAssistantText = "";
  const sessionAtStart = chatSessionStore.get(chatId);
  let currentTurnAckMessageId = Number(sessionAtStart?.current_turn_ack_message_id || 0);
  if (!(Number.isFinite(currentTurnAckMessageId) && currentTurnAckMessageId > 0)) {
    currentTurnAckMessageId = Number(await sendRouterAckMessage(bot, chatId, {
      replyToMessageId: telegramMessageId,
    }) || 0);
  }

  try {
    runtime = await loadSupervisorRuntime(currentJobId, {
      chatMeta: chatInfo,
      telegramUserId: userId,
    });
    contextEngine = makeContextEngine({
      memoryMode: memoryModeWithFallback(),
      jobs,
      gocClient: memoryModeWithFallback() === "goc" ? requireGocClient() : null,
      runtime,
      logger: (line) => jobs.log(currentJobId, line),
    });
    if (typeof contextEngine.setRuntime === "function") {
      contextEngine.setRuntime(runtime);
    }
    executionGraph = (
      memoryModeWithFallback() === "goc"
      && runtime?.map?.threadId
      && runtime?.map?.ctxSharedId
    )
      ? new GocExecutionGraphRecorder({
        client: requireGocClient(),
        threadId: runtime.map.threadId,
        contextSetId: runtime.map.ctxSharedId,
        sharedContextSetId: runtime.map.ctxSharedId,
        contextMeta: runtime.contextMeta || null,
        runId: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
        chatId: String(chatId || ""),
        jobId: String(currentJobId || ""),
        logger: (line) => jobs.log(currentJobId, line),
      })
      : null;
    if (executionGraph) {
      await executionGraph.startRun({
        userMessageNodeId: String(userMessageGoc?.id || "").trim(),
        userText: message,
      });
    }
    const autopilotEnabled = AUTOPILOT_ENABLED;
    const maxTurns = autopilotEnabled ? AUTOPILOT_MAX_TURNS : 1;
    const maxTotalActions = autopilotEnabled ? AUTOPILOT_MAX_TOTAL_ACTIONS : 4;
    const callbacks = buildSupervisorExecutionCallbacks({
      bot,
      chatId,
      userId,
      jobId: currentJobId,
      runtime,
      controller,
      verbose,
      contextEngine,
      onAgentStatusChanged: async ({ agentId = "", state = "", goal = "", error = "" } = {}) => {
        await sendAgentStatusTransitionMessage(bot, chatId, {
          agentId,
          state,
          goal,
          error,
          replyToMessageId: getCurrentTurnReplyMessageId(chatId),
        });
      },
      executionGraph,
    });

    let turn = 0;
    let totalActions = 0;
    let lastUserText = message;
    let routePlan = null;
    let execution = null;
    let followupHint = "";
    let stopReason = "done";
    let stalledTurns = 0;
    let previousRemainingSignature = "";
    let forcedAwaitReason = "";

    let deliverables = [];
    let completedDeliverables = [];
    let suggestedActions = [];
    let mergedResults = [];
    let mergedOutputs = [];
    const runThreadId = String(runtime?.map?.threadId || "").trim();
    const sharedCtxId = String(runtime?.map?.ctxSharedId || "").trim();

    while (turn < maxTurns) {
      turn += 1;
      const routerRunMeta = {
        runId: String(executionGraph?.runId || "").trim() || undefined,
        threadId: runThreadId,
        sharedContextSetId: sharedCtxId,
      };
      let routerCtx = {
        contextText: String(runtime?.contextSummary || "").trim(),
        meta: {},
      };
      if (contextEngine && typeof contextEngine.prepareRouterContext === "function") {
        if (typeof contextEngine.setRuntime === "function") {
          contextEngine.setRuntime(runtime);
        }
        await contextEngine.onRunStart({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          runMeta: routerRunMeta,
        }).catch(() => null);
        const preparedRouter = await contextEngine.prepareRouterContext({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          agentId: "router",
          stepKind: "router",
          goal: lastUserText,
          userMessageText: lastUserText,
          budgetTokens: 900,
          runMeta: routerRunMeta,
        }).catch(() => null);
        if (preparedRouter && typeof preparedRouter === "object") {
          routerCtx = {
            contextText: String(preparedRouter.contextText || "").trim(),
            meta: preparedRouter.meta && typeof preparedRouter.meta === "object"
              ? preparedRouter.meta
              : {},
          };
        }
        await contextEngine.recordMeta({
          jobId: currentJobId,
          chatId: String(chatId || ""),
          threadId: runThreadId,
          agentId: "router",
          stepKind: "router",
          goal: lastUserText,
          userMessageText: lastUserText,
          runMeta: routerRunMeta,
          meta: routerCtx.meta,
        }).catch(() => {});
      }
      if (routerCtx.contextText) {
        runtime.contextSummary = routerCtx.contextText;
      }
      const progressSummary = buildAutopilotProgressSummary({
        turn,
        maxTurns,
        deliverables,
        completedDeliverables,
        results: mergedResults,
        outputs: mergedOutputs,
        suggestedActions,
        followupHint,
      });
      const teamRecommendation = recommendTeamForTask(lastUserText, runtime);
      const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
        source: "team_builder",
        teamPlan: {
          mode: "chat_supervisor",
          roles: (Array.isArray(teamRecommendation?.selected_existing_agents)
            ? teamRecommendation.selected_existing_agents
            : [])
            .map((row) => ({
              id: String(row?.role || "").trim().toLowerCase(),
              role_type: String(row?.role || "").trim().toLowerCase(),
              role_label: String(row?.role || "").trim().toLowerCase(),
              template_id: String(row?.agent_id || "").trim().toLowerCase(),
              provider: String(row?.provider || "").trim().toLowerCase() || undefined,
              model: undefined,
              assigned_goal: String(lastUserText || "").trim() || undefined,
              capability_tags: [],
            }))
            .filter((row) => row.id),
          dependencies: [],
          execution_order: (Array.isArray(teamRecommendation?.selected_existing_agents)
            ? teamRecommendation.selected_existing_agents
            : [])
            .map((row) => String(row?.role || "").trim().toLowerCase())
            .filter(Boolean),
          reason: String(teamRecommendation?.can_satisfy_without_creation === true
            ? "selected_existing_agents"
            : "missing_capabilities").trim(),
          budget: {},
        },
        runtimeAgents: (Array.isArray(teamRecommendation?.selected_existing_agents)
          ? teamRecommendation.selected_existing_agents
          : [])
          .map((row) => ({
            instance_id: `chat_role_${String(row?.role || "").trim().toLowerCase() || "role"}_${String(row?.agent_id || "").trim().toLowerCase() || "ephemeral"}`,
            template_id: String(row?.agent_id || "").trim().toLowerCase() || undefined,
            role_label: String(row?.role || "").trim().toLowerCase() || "role",
            provider: String(row?.provider || "").trim().toLowerCase() || undefined,
            model: undefined,
            assigned_goal: String(lastUserText || "").trim() || undefined,
            capability_tags: [],
            lens_spec: undefined,
            status: "ready",
            ephemeral: false,
            fallback: false,
          })),
      });
      const rawRoutePlan = await routeWithSupervisor(lastUserText, {
        agents: runtime.agents,
        agentsCatalog: runtime.agentsCatalog,
        teamRecommendation,
        enabledAgentIds: runtime.enabledAgentIds,
        tools: runtime.tools,
        jobConfig: runtime.jobConfig,
        currentJobId,
        currentContextSetId: sharedCtxId,
        progressSummary,
        suggestedActions,
        originalUserMessage: message,
        autopilotTurn: turn,
        workspaceRoot: runWorkspaceDir(currentJobId),
        cwd: runWorkspaceDir(currentJobId),
        signal: controller.signal,
        locale: "ko-KR",
        routerPolicy: memory.getRouterPrompt(),
        contextSummary: routerCtx.contextText || runtime.contextSummary,
        geminiConcurrencyKey: `job:${String(currentJobId || "").trim()}`,
        onGeminiRetry: async ({ retryCount = 0, maxRetries = 0 } = {}) => {
          await sendGeminiRetryMessage(bot, chatId, {
            retryCount,
            maxRetries,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
        onGeminiModelSwitch: async ({ toModel = "" } = {}) => {
          await sendGeminiModelSwitchMessage(bot, chatId, {
            toModel,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
        onGeminiGiveUp: async ({ reason = "" } = {}) => {
          await sendGeminiGiveUpMessage(bot, chatId, {
            reason,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
      });
      routePlan = sanitizeSupervisorRoutePlan(rawRoutePlan, {
        message: lastUserText,
        agents: runtime.agents,
        allowReadOnlyControl: false,
        forceMode: cleanForceMode,
      });
      if (
        (!Array.isArray(routePlan?.actions) || routePlan.actions.length === 0)
        && routePlan?.done !== true
        && routePlan?.await_user !== true
        && Array.isArray(suggestedActions)
        && suggestedActions.length > 0
      ) {
        routePlan = {
          ...routePlan,
          reason: `${String(routePlan.reason || "supervisor route")}; suggested_actions_fallback`,
          actions: suggestedActions.slice(0, 4),
        };
      }
      routePlan = rewritePlanToReuseAgents(routePlan, runtime, {
        message: lastUserText,
        teamRecommendation,
      });
      runtime.runtimeTeamSnapshot = runtimeTeamSnapshot;
      routePlan = {
        ...routePlan,
        runtime_team_snapshot: runtimeTeamSnapshot,
      };
      followupHint = String(routePlan?.followup_hint || "").trim();
      deliverables = normalizeDeliverableList([
        ...deliverables,
        ...(Array.isArray(routePlan?.deliverables) ? routePlan.deliverables : []),
      ], { max: 24 });
      completedDeliverables = normalizeDeliverableList([
        ...completedDeliverables,
        ...(Array.isArray(routePlan?.completed_deliverables) ? routePlan.completed_deliverables : []),
      ], { max: 24 });
      completedDeliverables = completedDeliverables.filter((entry) => {
        if (deliverables.length === 0) return true;
        return deliverables.some((item) => item.toLowerCase() === String(entry || "").trim().toLowerCase());
      });

      const planActions = Array.isArray(routePlan?.actions) ? routePlan.actions : [];
      if ((totalActions + planActions.length) > maxTotalActions) {
        forcedAwaitReason = `자동 실행 한도(${maxTotalActions} actions)에 도달했습니다.`;
        stopReason = "max_total_actions";
        break;
      }
      totalActions += planActions.length;

      if (executionGraph) {
        await executionGraph.queueMainSteps(planActions);
      }
      const queuedAgentStatus = buildQueuedAgentStatusFromActions(planActions);

      chatSessionStore.upsert(chatId, {
        state: "executing",
        agent_status: queuedAgentStatus,
        last_route: {
          reason: routePlan.reason,
          actions: planActions,
          runtime_team_snapshot: runtimeTeamSnapshot,
          done: routePlan.done === true,
          await_user: routePlan.await_user === true,
          deliverables,
          completed_deliverables: completedDeliverables,
          followup_hint: followupHint || undefined,
          turn,
          total_actions: totalActions,
          final_response_style: routePlan.final_response_style || runtime.jobConfig?.final_response_style || "concise",
        },
      });
      const planPreviewMessageId = await sendPlanPreviewMessage(bot, chatId, {
        actions: planActions,
        replyToMessageId: currentTurnAckMessageId,
      });
      if (Number.isFinite(Number(planPreviewMessageId)) && Number(planPreviewMessageId) > 0) {
        chatSessionStore.upsert(chatId, {
          current_turn_plan_message_id: Number(planPreviewMessageId),
        });
      }

      if (verbose) {
        await bot.sendMessage(chatId, [
          `🧭 /chat(supervisor) route turn=${turn}`,
          `reason=${routePlan.reason || "(none)"}`,
          `done=${routePlan.done === true ? "true" : "false"}`,
          `await_user=${routePlan.await_user === true ? "true" : "false"}`,
          ...(planActions.map((row) => `- ${chatActionLabel(row)}`)),
        ].join("\n"));
      }

      if (routePlan.await_user === true && planActions.length === 0) {
        execution = {
          results: [],
          outputs: [],
          currentJobId: String(currentJobId || ""),
          pendingApproval: null,
          blocked_index: -1,
          remaining_actions: [],
        };
        stopReason = "await_user";
        break;
      }

      execution = await executeSupervisorActions({
        chatId,
        userId,
        jobId: currentJobId,
        plan: routePlan,
        originalUserText: message,
        forceMode: cleanForceMode,
        jobConfig: runtime.jobConfig,
        agents: runtime.agents,
        tools: runtime.tools,
        sessionStore: chatSessionStore,
        callbacks,
      });
      const turnResults = Array.isArray(execution?.results) ? execution.results : [];
      const turnOutputs = Array.isArray(execution?.outputs) ? execution.outputs : [];
      mergedResults = [...mergedResults, ...turnResults];
      mergedOutputs = [...mergedOutputs, ...turnOutputs];

      const suggestedFromTurn = collectSuggestedActionsFromOutputs(turnOutputs);
      if (suggestedFromTurn.length > 0) {
        suggestedActions = mergeSuggestedActions(suggestedActions, suggestedFromTurn, { max: 16 });
      }
      completedDeliverables = updateCompletedDeliverablesFromOutputs(
        deliverables,
        completedDeliverables,
        turnOutputs
      );

      tracking.append(currentJobId, "decisions.md", [
        "## /chat supervisor routing",
        `- turn: ${turn}`,
        `- message: ${clip(lastUserText, 260)}`,
        `- reason: ${routePlan.reason || "(none)"}`,
        `- runtime_team_source: ${String(routePlan?.runtime_team_snapshot?.source || "team_builder")}`,
        `- actions: ${planActions.map((row) => chatActionLabel(row)).join(" -> ") || "(none)"}`,
        `- mode: ${runtime.mode}`,
        `- pending_approval: ${execution.pendingApproval ? execution.pendingApproval.reason : "none"}`,
        `- done: ${routePlan.done === true ? "true" : "false"}`,
        `- await_user: ${routePlan.await_user === true ? "true" : "false"}`,
      ].join("\n"));

      if (execution.pendingApproval) {
        stopReason = "pending_approval";
        break;
      }
      if (routePlan.await_user === true) {
        stopReason = "await_user";
        break;
      }
      if (routePlan.done === true) {
        stopReason = "done";
        break;
      }

      if (!autopilotEnabled) {
        stopReason = "single_turn";
        break;
      }
      if (turn >= maxTurns) {
        stopReason = "max_turns";
        break;
      }

      const remaining = deliverables.filter((item) => {
        const key = String(item || "").trim().toLowerCase();
        return !completedDeliverables.some((doneItem) => String(doneItem || "").trim().toLowerCase() === key);
      });
      const remainingSignature = remaining
        .map((row) => String(row || "").trim().toLowerCase())
        .sort()
        .join("|");
      if (remaining.length > 0 && remainingSignature && remainingSignature === previousRemainingSignature) {
        stalledTurns += 1;
      } else {
        stalledTurns = 0;
      }
      previousRemainingSignature = remainingSignature;
      if (remaining.length > 0 && stalledTurns >= 1) {
        forcedAwaitReason = `남은 deliverable(${remaining.join(", ")}) 진행에 추가 지시가 필요합니다.`;
        stopReason = "stalled";
        break;
      }

      await bot.sendMessage(
        chatId,
        "🔄 다음 단계 진행 중…",
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined
      );
      lastUserText = buildAutopilotFollowupMessage({
        originalUserText: message,
        deliverables,
        completedDeliverables,
        followupHint,
        suggestedActions,
      });
    }

    routePlan = routePlan && typeof routePlan === "object"
      ? routePlan
      : {
        reason: "autopilot_no_route",
        actions: [],
        final_response_style: "concise",
        done: false,
        await_user: true,
        deliverables,
        completed_deliverables: completedDeliverables,
      };
    execution = execution && typeof execution === "object"
      ? execution
      : {
        results: [],
        outputs: [],
        currentJobId: String(currentJobId || ""),
        pendingApproval: null,
        blocked_index: -1,
        remaining_actions: [],
      };

    const mergedExecution = {
      ...execution,
      currentJobId: String(currentJobId || ""),
      results: mergedResults,
      outputs: mergedOutputs,
    };

    if (forcedAwaitReason && !mergedExecution.pendingApproval) {
      routePlan = {
        ...routePlan,
        done: false,
        await_user: true,
        followup_hint: forcedAwaitReason,
      };
    }

    if (mergedExecution.pendingApproval) {
      const pendingApproval = {
        ...mergedExecution.pendingApproval,
        blocked_index: Number.isFinite(Number(mergedExecution.blocked_index))
          ? Number(mergedExecution.blocked_index)
          : Number(mergedExecution.pendingApproval?.blocked_index ?? -1),
        remaining_actions: Array.isArray(mergedExecution.remaining_actions)
          ? mergedExecution.remaining_actions
          : (Array.isArray(mergedExecution.pendingApproval?.remaining_actions)
            ? mergedExecution.pendingApproval.remaining_actions
            : []),
        already_done: {
          results: mergedResults,
          outputs: mergedOutputs,
        },
      };
      chatSessionStore.upsert(chatId, {
        jobId: currentJobId,
        state: "awaiting_approval",
        pending_approval: pendingApproval,
      });
      mergedExecution.pendingApproval = pendingApproval;
      tracking.append(currentJobId, "decisions.md", [
        "## /chat approval required",
        `- reason: ${pendingApproval.reason}`,
        `- action: ${chatActionLabel(pendingApproval.action)}`,
      ].join("\n"));
    }

    const contextOutputs = (Array.isArray(mergedExecution.outputs) ? mergedExecution.outputs : [])
      .filter((row) => String(row?.mode || "") === "context_link")
      .map((row) => String(row?.output || "").trim())
      .filter(Boolean);
    const hasAgentOutput = (Array.isArray(mergedExecution.outputs) ? mergedExecution.outputs : [])
      .some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
    const pendingPrompt = mergedExecution.pendingApproval?.id
      ? buildPendingApprovalPrompt(mergedExecution.pendingApproval)
      : null;
    const isMutatingConfirm = String(mergedExecution.pendingApproval?.gate_type || "").trim().toLowerCase() === "mutating_confirm";
    const finalReply = isMutatingConfirm
      ? String(pendingPrompt?.text || "변경 적용 전 확인이 필요합니다.")
      : (routePlan.await_user === true && mergedOutputs.length === 0
        ? String(routePlan.followup_hint || forcedAwaitReason || "다음 진행을 위해 추가 입력이 필요합니다.")
        : ((!hasAgentOutput && contextOutputs.length > 0)
          ? contextOutputs.join("\n\n")
          : await synthesizeChatReply(message, routePlan, mergedExecution)));
    let replyText = mergedExecution.pendingApproval
      ? (isMutatingConfirm
        ? finalReply
        : `${finalReply}\n\n⚠️ 승인 필요: ${mergedExecution.pendingApproval.reason}\n다음 명령으로 risk를 낮추거나 요청을 분할해 주세요.`)
      : finalReply;

    if (!mergedExecution.pendingApproval && routePlan.await_user === true) {
      const hint = String(routePlan.followup_hint || forcedAwaitReason || "").trim();
      if (hint) {
        replyText = `${replyText}\n\n🧩 추가 입력 필요: ${hint}`;
      }
    }

    if (verbose) {
      await sendLong(bot, chatId, formatChatSummary(routePlan, mergedExecution.results));
      await bot.sendMessage(chatId, `autopilot_stop_reason=${stopReason}`);
    }
    finalAssistantText = replyText;
    if (!isMutatingConfirm) {
      await sendLong(bot, chatId, replyText);
    }
    jobs.appendConversation(currentJobId, "assistant", replyText, {
      kind: mergedExecution.pendingApproval ? "chat_reply_pending_approval" : "chat_reply",
      chat_id: String(chatId || ""),
      user_id: String(userId || ""),
    });
    await appendChatMessageToGoc(currentJobId, {
      role: "assistant",
      text: replyText,
      kind: mergedExecution.pendingApproval ? "chat_reply_pending_approval" : "chat_reply",
      chatId,
      userId,
      replyTo: String(userMessageGoc?.id || "").trim(),
    });
    if (executionGraph) {
      await executionGraph.finishRun({
        status: (mergedExecution.pendingApproval || routePlan.await_user === true)
          ? "await_user"
          : "done",
        summary: clip(replyText, 900),
      });
    }
    if (mergedExecution.pendingApproval?.id) {
      const prompt = pendingPrompt || buildPendingApprovalPrompt(mergedExecution.pendingApproval);
      await bot.sendMessage(
        chatId,
        prompt.text,
        {
          reply_to_message_id: Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? Number(getCurrentTurnReplyMessageId(chatId))
            : undefined,
          reply_markup: {
            inline_keyboard: prompt.keyboard,
          },
        }
      );
    }
    await maybeAutoSendOutputs(bot, chatId, currentJobId, {
      when: "run_end",
      replyToMessageId: getCurrentTurnReplyMessageId(chatId),
    }).catch(() => null);
    return { routePlan, execution: mergedExecution, jobId: currentJobId };
  } catch (e) {
    if (executionGraph) {
      try {
        await executionGraph.finishRun({
          status: "error",
          error: String(e?.message ?? e),
          summary: "supervisor run failed",
        });
      } catch {}
    } else if (memoryModeWithFallback() === "goc") {
      try {
        const runtime = await loadSupervisorRuntime(currentJobId, {
          chatMeta: chatInfo,
          telegramUserId: userId,
        });
        if (runtime?.map?.ctxSharedId) {
          try {
            const meta = await requireGocClient().getContextSet(runtime.map.ctxSharedId);
            runtime.contextMeta = {
              context_set_id: runtime.map.ctxSharedId,
              version: String(meta?.version || "").trim(),
              active_node_ids: Array.isArray(meta?.activeNodeIds)
                ? meta.activeNodeIds.map((row) => String(row || "").trim()).filter(Boolean)
                : [],
            };
          } catch {
            runtime.contextMeta = null;
          }
        }
        if (runtime?.map?.threadId && runtime?.map?.ctxSharedId) {
          executionGraph = new GocExecutionGraphRecorder({
            client: requireGocClient(),
            threadId: runtime.map.threadId,
            contextSetId: runtime.map.ctxSharedId,
            sharedContextSetId: runtime.map.ctxSharedId,
            contextMeta: runtime.contextMeta || null,
            runId: `run_err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            chatId: String(chatId || ""),
            jobId: String(currentJobId || ""),
            logger: (line) => jobs.log(currentJobId, line),
          });
          await executionGraph.startRun({
            userMessageNodeId: String(userMessageGoc?.id || "").trim(),
            userText: message,
          });
          await executionGraph.finishRun({
            status: "error",
            error: String(e?.message ?? e),
            summary: "supervisor run failed",
          });
        }
      } catch {}
    }
    throw e;
  } finally {
    if (contextEngine && typeof contextEngine.onRunEnd === "function") {
      const runThreadId = String(runtime?.map?.threadId || "").trim();
      const sharedCtxId = String(runtime?.map?.ctxSharedId || "").trim();
      if (typeof contextEngine.setRuntime === "function") {
        contextEngine.setRuntime(runtime);
      }
      await contextEngine.onRunEnd({
        jobId: currentJobId,
        chatId: String(chatId || ""),
        threadId: runThreadId,
        lastUserText: message,
        lastAssistantText: finalAssistantText,
        runMeta: {
          runId: String(executionGraph?.runId || "").trim() || undefined,
          threadId: runThreadId,
          sharedContextSetId: sharedCtxId,
        },
      }).catch(() => null);
    }
    if (activeJobByChat.get(chatKey) === currentJobId) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(currentJobId);
    chatSessionStore.upsert(chatId, (session) => ({
      ...session,
      state: session.pending_approval ? "awaiting_approval" : "idle",
    }));
  }
}

async function executeChatActions(
  bot,
  chatId,
  userId,
  message,
  routePlan,
  {
    verbose = CHAT_VERBOSE,
    runtime = null,
    telegramUserId = "",
  } = {}
) {
  const effectiveTelegramUserId = String(telegramUserId || userId || "").trim();
  const actions = Array.isArray(routePlan?.actions) ? routePlan.actions : [];
  const results = [];
  const outputs = [];
  let currentJobId = resolveCurrentJobIdForChat(chatId);

  for (const action of actions) {
    const label = chatActionLabel(action);
    try {
      if (action.type === "show_agents") {
        const reg = await refreshAgentRegistry();
        await sendLong(bot, chatId, formatRegistryLines(reg));
        results.push({ label, status: "ok", note: `${reg.agents.length} agents` });
        continue;
      }

      if (action.type === "open_context") {
        const target = action.scope === "global"
          ? "global"
          : String(action.jobId || currentJobId || "").trim();
        await sendContextInfo(bot, chatId, target, {
          userId,
          createIfMissing: true,
        });
        results.push({ label, status: "ok", note: target || "current" });
        continue;
      }

      if (action.type === "create_agent") {
        if (memoryModeWithFallback() !== "goc") throw new Error("create_agent requires MEMORY_MODE=goc");
        const created = await createAgentProfile(requireGocClient(), {
          baseDir: jobs.baseDir,
          profile: action.agent,
          format: action.format || "json",
          actor: `telegram:${userId}`,
        });
        await refreshAgentRegistry({ includeCompiled: true });
        results.push({ label, status: "ok", note: `node=${created.created?.id || "unknown"}` });
        continue;
      }

      if (action.type === "update_agent") {
        if (memoryModeWithFallback() !== "goc") throw new Error("update_agent requires MEMORY_MODE=goc");
        const updated = await updateAgentProfile(requireGocClient(), {
          baseDir: jobs.baseDir,
          agentId: action.agentId,
          patch: action.patch || {},
          format: action.format || "json",
          actor: `telegram:${userId}`,
        });
        await refreshAgentRegistry({ includeCompiled: true });
        results.push({ label, status: "ok", note: `node=${updated.created?.id || "unknown"}` });
        continue;
      }

      if (action.type === "run_agent") {
        const agentId = resolveAgentId(action.agent || "");
        const prompt = String(action.prompt || "").trim();
        if (!agentId || !prompt) throw new Error("run_agent requires agent and prompt");

        let targetJobId = String(action.jobId || currentJobId || "").trim();
        if (!targetJobId) {
          const job = await createJob(message || prompt, { ownerUserId: userId, ownerChatId: chatId });
          targetJobId = String(job.jobId);
          currentJobId = targetJobId;
          if (verbose) await bot.sendMessage(chatId, `✅ /chat job created: ${targetJobId}\nworkspace: ${runWorkspaceDir(targetJobId)}`);
        } else {
          runDir(targetJobId);
        }

        const controller = resetJobAbortController(targetJobId);
        const chatKey = String(chatId);
        activeJobByChat.set(chatKey, targetJobId);
        rememberLastChatJob(chatId, targetJobId);
        if (verbose) await bot.sendMessage(chatId, `🤖 ${agentId} 실행 중…`);

        try {
          const result = await enqueue(
            () => executeAgentRun(
              bot,
              chatId,
              targetJobId,
              { type: "agent_run", agent: agentId, prompt },
              {
                signal: controller.signal,
                notify: verbose,
                runtime,
                telegramUserId: effectiveTelegramUserId,
              }
            ),
            { jobId: targetJobId, signal: controller.signal, label: `chat_agent_run_${agentId}` }
          );
          if (verbose) await sendLong(bot, chatId, `🤖 ${agentId} 완료 (${result.mode})\n${clip(result.output, 3000)}`);
          outputs.push({
            agentId,
            provider: result.provider,
            mode: result.mode,
            output: String(result.output || ""),
            jobId: targetJobId,
          });
          currentJobId = targetJobId;
          results.push({ label, status: "ok", note: `jobId=${targetJobId}` });
        } finally {
          if (activeJobByChat.get(chatKey) === targetJobId) activeJobByChat.delete(chatKey);
          jobAbortControllers.delete(targetJobId);
        }
        continue;
      }

      results.push({ label, status: "skip", note: "unsupported action" });
    } catch (e) {
      results.push({ label, status: "error", note: clip(String(e?.message ?? e), 180) });
    }
  }

  return { results, currentJobId, outputs };
}

async function executeAgentRun(
  bot,
  chatId,
  jobId,
  act,
  {
    runtime = null,
    telegramUserId = "",
    signal = null,
    notify = true,
    onGeminiRetry = null,
    onGeminiModelSwitch = null,
    onGeminiGiveUp = null,
    geminiConcurrencyKey = "",
  } = {}
) {
  const cleanTelegramUserId = String(telegramUserId || "").trim();
  const restoreActor = bindGocActor(cleanTelegramUserId);
  try {
    const agentId = resolveAgentId(act.agent || "");
    const taskPrompt = String(act.prompt || "").trim();
    if (!agentId || !taskPrompt) throw new Error("invalid agent_run action");

    const agent = findAgentConfigInRuntime(agentId, runtime) || findAgentConfig(agentId);
    if (!agent) throw new Error(`Unknown agent: ${agentId}. Check conversation runtime/catalog.`);

    const provider = String(agent.provider || "gemini").trim().toLowerCase();
    const model = String(agent.model || provider).trim() || provider;
    const rolePrompt = String(agent.prompt || "").trim();
    const combinedInstruction = rolePrompt
      ? `[ROLE]\n${rolePrompt}\n\n[TASK]\n${taskPrompt}`
      : taskPrompt;
    const combinedGoal = rolePrompt
      ? `[ROLE]\n${rolePrompt}\n\n[TASK]\n${taskPrompt}`
      : taskPrompt;
    const combinedChatQuestion = rolePrompt
      ? `[AGENT ROLE]\n${rolePrompt}\n\n[QUESTION]\n${taskPrompt}`
      : taskPrompt;

    const runProvider = async (providerPrompt) => {
      if (provider === "chatgpt") {
        await sendChatGPTPrompt(bot, chatId, jobId, providerPrompt);
        return `ChatGPT prompt generated by agent=${agentId}\nquestion=${providerPrompt}`;
      }

      throw new Error(`Unsupported provider for agent ${agentId}: ${provider}`);
    };

    const appendLocalLogs = (output, mode) => {
      const section = `## Agent ${agentId} output (${mode})`;
      if (provider === "codex") {
        tracking.append(jobId, "progress.md", `${section}\n\n${output}\n`);
      } else {
        tracking.append(jobId, "research.md", `${section}\n\n${output}\n`);
      }
      jobs.appendConversation(jobId, agentId, output, { kind: "agent_run", provider, model, mode });
    };

    if (provider === "codex") {
      const output = await codexImplement(jobId, combinedInstruction, signal);
      await maybeAutoSendOutputs(bot, chatId, jobId, {
        when: "step",
        replyToMessageId: getCurrentTurnReplyMessageId(chatId),
      }).catch(() => null);
      const fallback = gocFallbackByJob.get(String(jobId));
      if (fallback) {
        if (notify) {
          await bot.sendMessage(chatId, `⚠️ GoC 컨텍스트 조회 실패로 local fallback 사용 중입니다.\nreason=${clip(fallback, 180)}`);
        }
        gocFallbackByJob.delete(String(jobId));
      }
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }
    if (provider === "gemini") {
      const output = await geminiResearch(jobId, combinedGoal, signal, {
        sectionTitle: `${agentId} notes`,
        outputGuide: [
          "출력:",
          "- 핵심 요약",
          "- 구현 전 확인사항",
          "- 리스크와 완화책",
          "- 검증 체크리스트",
        ].join("\n"),
        model,
        concurrencyKey: geminiConcurrencyKey || `job:${String(jobId || "").trim()}`,
        onGeminiRetry,
        onGeminiModelSwitch,
        onGeminiGiveUp,
      });
      await maybeAutoSendOutputs(bot, chatId, jobId, {
        when: "step",
        replyToMessageId: getCurrentTurnReplyMessageId(chatId),
      }).catch(() => null);
      const fallback = gocFallbackByJob.get(String(jobId));
      if (fallback) {
        if (notify) {
          await bot.sendMessage(chatId, `⚠️ GoC 컨텍스트 조회 실패로 local fallback 사용 중입니다.\nreason=${clip(fallback, 180)}`);
        }
        gocFallbackByJob.delete(String(jobId));
      }
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }
    if (provider === "chatgpt") {
      const output = await runProvider(combinedChatQuestion);
      appendLocalLogs(output, memoryModeWithFallback());
      return { output, mode: memoryModeWithFallback(), agent, provider, model };
    }

    const output = await runProvider(combinedChatQuestion);
    appendLocalLogs(output, memoryModeWithFallback());
    return { output, mode: memoryModeWithFallback(), agent, provider, model };
  } finally {
    restoreActor();
  }
}

async function executeRoutedPlan(bot, chatId, jobId, route, signal = null, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const runtimeTeamSnapshot = route?.runtime_team_snapshot && typeof route.runtime_team_snapshot === "object"
    ? route.runtime_team_snapshot
    : (opts?.runtimeTeamSnapshot && typeof opts.runtimeTeamSnapshot === "object"
      ? opts.runtimeTeamSnapshot
      : createRuntimeTeamSnapshot({
        teamPlan: route?.team_plan || null,
        runtimeAgents: route?.runtime_agents || [],
        source: "team_builder",
      }));
  let askedChatGPT = false;
  const actions = Array.isArray(route?.actions) ? route.actions : [];

  if (runtimeTeamSnapshot && Array.isArray(runtimeTeamSnapshot.runtime_agents) && runtimeTeamSnapshot.runtime_agents.length > 0) {
    tracking.append(jobId, "decisions.md", [
      "## Runtime team snapshot",
      `- source: ${String(runtimeTeamSnapshot.source || "team_builder")}`,
      `- generated_at: ${String(runtimeTeamSnapshot.generated_at || "")}`,
      `- roles: ${runtimeTeamSnapshot.runtime_agents.map((agent) => `${agent.role_label || "role"}:${agent.template_id || "ephemeral"}`).join(", ")}`,
    ].join("\n"));
  }

  for (const rawAct of actions) {
    const act = normalizeActionShape(rawAct);
    if (!act?.type) continue;

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfigInRuntime(act.agent, runtime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      await bot.sendMessage(chatId, `🤖 ${act.agent} 실행 중… (${provider})`);
      const result = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, act, {
          signal,
          runtime,
          telegramUserId,
        }),
        { jobId, signal, label: `agent_run_${act.agent}` }
      );
      await sendLong(bot, chatId, `🤖 ${act.agent} 완료 (${result.mode})\n${clip(result.output, 3500)}`);
      if (result.provider === "chatgpt") askedChatGPT = true;
      continue;
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId, signal);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}\n\n커밋: /commit ${jobId} <message>`);
      continue;
    }

    if (act.type === "chatgpt_prompt") {
      const q = String(act.question || "현재 상태에서 다음 단계 action plan(JSON)을 제안해줘.").trim();
      await sendChatGPTPrompt(bot, chatId, jobId, q);
      askedChatGPT = true;
    }
  }

  await maybeAutoSendOutputs(bot, chatId, jobId, {
    when: "run_end",
    replyToMessageId: getCurrentTurnReplyMessageId(chatId),
  }).catch(() => null);
  return { askedChatGPT, runtime_team_snapshot: runtimeTeamSnapshot };
}

async function executeActions(bot, chatId, jobId, plan, signal = null, opts = {}) {
  const runtime = opts?.runtime && typeof opts.runtime === "object" ? opts.runtime : null;
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  if (!plan || !Array.isArray(plan.actions)) return;
  const allowed = new Set(["track_append", "agent_run", "gemini", "codex", "git_summary", "chatgpt_prompt", "chatgpt", "commit_request"]);

  for (const rawAct of plan.actions) {
    if (!rawAct || !allowed.has(String(rawAct.type || "").trim().toLowerCase())) continue;
    const act = normalizeActionShape(rawAct);
    if (!act) continue;

    if (act.type === "track_append") {
      tracking.append(jobId, act.doc || "plan.md", String(act.markdown || ""));
      await bot.sendMessage(chatId, `📝 기록 업데이트: ${act.doc || "plan.md"}`);
    }

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfigInRuntime(act.agent, runtime) || findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      await bot.sendMessage(chatId, `🤖 ${act.agent} 실행 중… (${provider})`);
      const r = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, act, {
          signal,
          runtime,
          telegramUserId,
        }),
        { jobId, signal, label: `agent_run_${act.agent}` }
      );
      await sendLong(bot, chatId, `🤖 ${act.agent} 결과 (${r.mode})\n${clip(r.output, 3500)}`);
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId, signal);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}`);
    }

    if (act.type === "chatgpt_prompt") {
      const q = String(act.question || act.prompt || "").trim();
      if (!q) continue;
      await sendChatGPTPrompt(bot, chatId, jobId, q);
    }

    if (act.type === "commit_request") {
      const message = String(act.message || "").trim();
      if (!message) continue;
      const rec = approvals.request(jobId, { purpose: "git commit", summary: `Commit changes with message: ${message}`, payload: { action: "git_commit", message } });
      await bot.sendMessage(chatId,
        `🟡 커밋 승인 필요\njobId=${jobId}\nmessage=${message}\ntoken=${rec.token}`,
        { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve:${jobId}:${rec.token}` }, { text: "❌ Deny", callback_data: `deny:${jobId}:${rec.token}` }]] } }
      );
    }
  }

  await maybeAutoSendOutputs(bot, chatId, jobId, {
    when: "run_end",
    replyToMessageId: getCurrentTurnReplyMessageId(chatId),
  }).catch(() => null);
}

// GPT paste/apply state per chat
const awaiting = new Map(); // chatId -> { jobId, userId, expiresAt }
function setAwait(chatId, jobId, userId) { awaiting.set(String(chatId), { jobId, userId, expiresAt: Date.now() + 20 * 60 * 1000 }); }
function clearAwait(chatId) { awaiting.delete(String(chatId)); }
function getAwait(chatId) {
  const st = awaiting.get(String(chatId));
  if (!st) return null;
  if (Date.now() > st.expiresAt) { awaiting.delete(String(chatId)); return null; }
  return st;
}

function isHardStopMessage(text) {
  const msg = String(text || "").trim().toLowerCase();
  if (!msg) return false;
  return msg === "/stop"
    || msg === "stop"
    || msg.includes("중단")
    || msg.includes("취소")
    || msg.includes("멈춰")
    || msg.includes("cancel");
}

async function sendTextWithOptionalGocButton(
  bot,
  chatId,
  text,
  {
    miniAppLink = "",
    browserLink = "",
    miniAppLabel = "Open GoC (Mini App)",
    browserLabel = "Open GoC (Browser)",
  } = {}
) {
  return sendTextWithOptionalGocButtonAdapter(bot, chatId, text, {
    miniAppLink,
    browserLink,
    miniAppLabel,
    browserLabel,
    isHttps,
    isTelegramWebAppHttpsError,
  });
}

async function sendChatStatus(bot, chatId, { telegramUserId = "" } = {}) {
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  let runtime = null;
  if (currentJobId) {
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || "") },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch {
      runtime = null;
    }
  }
  const card = buildChatStatusCard(chatId, runtime);
  await sendLong(bot, chatId, card.text);
}

function buildAgentDisplayIndex(registry = null, runtime = null) {
  const index = new Map();
  const pushRows = (rows = []) => {
    for (const row of (Array.isArray(rows) ? rows : [])) {
      const id = String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase();
      if (!id) continue;
      index.set(id, row);
    }
  };
  pushRows(registry?.agents || []);
  pushRows(runtime?.agentsCatalog || []);
  pushRows(runtime?.agents || []);
  return index;
}

function formatAgentRef(agentId, agentIndex = new Map()) {
  const id = String(agentId || "").trim().toLowerCase();
  if (!id) return "@unknown";
  const row = agentIndex.get(id) || null;
  const name = String(row?.name || row?.title || row?.system_key || id).trim();
  const shortId = id.slice(0, 8) || "unknown";
  if (row && name) return `${name} [${shortId}]`;
  return `@${shortId}`;
}

async function sendAgentOrToolListQuick(bot, chatId, kind = "agent", rawArgs = "", opts = {}) {
  const cleanKind = String(kind || "").trim().toLowerCase() === "tool" ? "tool" : "agent";
  const tokens = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const sub = String(tokens[0] || "").trim().toLowerCase();
  const targetAgentId = String(tokens[1] || "").trim().toLowerCase();
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const restoreActor = bindGocActor(telegramUserId);

  try {
    if (cleanKind === "agent" && memoryModeWithFallback() === "goc" && (sub === "registry" || sub === "public")) {
      try {
        const client = requireGocClient();
        const scope = sub === "public" ? "public" : "my";
        const query = String(tokens.slice(1).join(" ") || "").trim().toLowerCase();
        const rows = await client.listAgents(scope);
        const filteredRows = query
          ? rows.filter((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const name = String(row?.name || "").trim().toLowerCase();
            const description = String(row?.description || "").trim().toLowerCase();
            return id.includes(query) || name.includes(query) || description.includes(query);
          })
          : rows;
        const lines = [
          sub === "public" ? "GoC Public Agent Catalog" : "GoC My Agent Catalog",
          ...((Array.isArray(filteredRows) ? filteredRows : []).slice(0, 50).map((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const provider = String(row?.provider || "gemini").trim().toLowerCase();
            const model = String(row?.model || provider || "gemini").trim();
            const published = row?.published === true ? "published" : "private";
            const name = String(row?.name || id || "unknown").trim();
            return `- ${name} [${id || "unknown"}] (${provider}/${model}, ${published})`;
          })),
        ];
        if (query) lines.push(`- filter: ${query}`);
        if ((Array.isArray(filteredRows) ? filteredRows : []).length === 0) lines.push("- (none)");
        await sendLong(bot, chatId, lines.join("\n"));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ ${sub} 조회 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (
      cleanKind === "agent"
      && memoryModeWithFallback() === "goc"
      && ["add", "remove", "enable", "disable"].includes(sub)
    ) {
      if (!targetAgentId) {
        await bot.sendMessage(chatId, "Usage: /agents add|remove|enable|disable <agent_id>");
        return;
      }
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어 conversation agent를 변경할 수 없습니다.");
        return;
      }
      try {
        const runtime = await loadSupervisorRuntime(currentJobId, {
          chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
          includeContext: false,
          includeGlobal: false,
          telegramUserId,
        });
        const threadId = String(runtime?.map?.threadId || "").trim();
        if (!threadId) throw new Error("threadId not ready");
        const client = requireGocClient();
        await client.ensureConversation(threadId);
        if (sub === "add") {
          await client.addConversationAgent(threadId, targetAgentId, true);
        } else if (sub === "remove") {
          await client.removeConversationAgent(threadId, targetAgentId);
        } else if (sub === "enable") {
          await client.patchConversationAgent(threadId, targetAgentId, { enabled: true }).catch(async () => {
            await client.addConversationAgent(threadId, targetAgentId, true);
          });
        } else if (sub === "disable") {
          await client.patchConversationAgent(threadId, targetAgentId, { enabled: false });
        }
        const updated = await client.listConversationAgents(threadId);
        const allAgentIds = Array.from(new Set(
          updated.map((row) => String(row?.agent_id || "").trim().toLowerCase()).filter(Boolean)
        ));
        const enabled = Array.from(new Set(
          updated
            .filter((row) => row?.enabled !== false)
            .map((row) => String(row?.agent_id || "").trim().toLowerCase())
            .filter(Boolean)
        ));
        const disabled = allAgentIds.filter((id) => !enabled.includes(id));
        let agentIndex = buildAgentDisplayIndex(agentRegistry, runtime);
        if (
          agentIndex.size === 0
          || [targetAgentId, ...allAgentIds].some((id) => !agentIndex.has(String(id || "").trim().toLowerCase()))
        ) {
          const refreshedRegistry = await refreshAgentRegistry({ includeCompiled: true });
          agentIndex = buildAgentDisplayIndex(refreshedRegistry, runtime);
        }
        const verb = sub === "add"
          ? "추가"
          : (sub === "remove" ? "제거" : (sub === "enable" ? "활성화" : "비활성화"));
        await sendLong(bot, chatId, [
          `✅ conversation agent ${verb} 완료`,
          `- job_id: ${currentJobId}`,
          `- agent: ${formatAgentRef(targetAgentId, agentIndex)}`,
          enabled.length > 0
            ? `- enabled: ${enabled.slice(0, 20).map((id) => formatAgentRef(id, agentIndex)).join(", ")}`
            : "- enabled: (none)",
          disabled.length > 0
            ? `- disabled: ${disabled.slice(0, 20).map((id) => formatAgentRef(id, agentIndex)).join(", ")}`
            : "- disabled: (none)",
        ].join("\n"));
      } catch (e) {
        await bot.sendMessage(chatId, `❌ /agents ${sub} 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (!currentJobId) {
      if (cleanKind === "agent") {
        const reg = await refreshAgentRegistry({ includeCompiled: true });
        const sampleRows = (Array.isArray(reg.agents) ? reg.agents : [])
          .filter((row) => String(row?.id || "").trim())
          .slice(0, 10);
        const agentIndex = buildAgentDisplayIndex(reg, null);
        const lines = [
          "현재 활성 job이 없습니다.",
          sampleRows.length > 0
            ? `등록된 agent(샘플): ${sampleRows.map((row) => formatAgentRef(row?.id, agentIndex)).join(", ")}`
            : "등록된 agent가 없습니다.",
          "작업 지시를 보내면 chat별 job이 생성됩니다.",
        ];
        let fallbackAgentsUi = null;
        if (memoryModeWithFallback() === "goc") {
          try {
            fallbackAgentsUi = await openAgentsUiInfo({ chatId, userId: telegramUserId });
          } catch {
            fallbackAgentsUi = null;
          }
        }
        await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
          miniAppLink: fallbackAgentsUi?.miniAppLink || "",
          browserLink: fallbackAgentsUi?.browserLink || fallbackAgentsUi?.link || "",
          miniAppLabel: "Open Agents Catalog",
          browserLabel: "Open Agents Catalog",
        });
        return;
      }
      await bot.sendMessage(chatId, "현재 활성 job이 없어 tool 목록을 확인할 수 없습니다.");
      return;
    }

    let runtime = null;
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 목록 조회 실패: ${String(e?.message ?? e)}`);
      return;
    }

    if (cleanKind === "agent") {
      let threadTeamInfo = null;
      try {
        threadTeamInfo = await openAgentsUiInfo({ chatId, jobId: currentJobId, userId: telegramUserId });
      } catch {
        threadTeamInfo = null;
      }
      const convRows = Array.isArray(runtime?.conversationAgents) ? runtime.conversationAgents : [];
      const enabled = runtime?.enabledAgentIds || [];
      const members = Array.from(new Set(
        convRows.map((row) => String(row?.agent_id || "").trim().toLowerCase()).filter(Boolean)
      ));
      const disabled = members.filter((id) => !enabled.includes(id));
      let agentIndex = buildAgentDisplayIndex(agentRegistry, runtime);
      if (
        agentIndex.size === 0
        || [...enabled, ...members].some((id) => !agentIndex.has(String(id || "").trim().toLowerCase()))
      ) {
        const refreshedRegistry = await refreshAgentRegistry({ includeCompiled: true });
        agentIndex = buildAgentDisplayIndex(refreshedRegistry, runtime);
      }
      const lines = [
        "현재 conversation membership",
        `- job_id: ${currentJobId}`,
        `- thread_id: ${String(runtime?.map?.threadId || "").trim() || "(none)"}`,
        enabled.length > 0
          ? `- enabled: ${enabled.slice(0, 20).map((id) => formatAgentRef(id, agentIndex)).join(", ")}`
          : "- enabled: (none)",
        disabled.length > 0
          ? `- disabled: ${disabled.slice(0, 20).map((id) => formatAgentRef(id, agentIndex)).join(", ")}`
          : "- disabled: (none)",
        runtime?.conversationMembershipWarning
          ? `- warning: ${clip(String(runtime.conversationMembershipWarning || ""), 220)}`
          : "",
        "명령: /agents registry | /agents public [query] | /agents add <id> | /agents remove <id> | /agents enable <id> | /agents disable <id>",
      ].filter(Boolean);
      await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
        miniAppLink: threadTeamInfo?.miniAppLink || "",
        browserLink: threadTeamInfo?.browserLink || threadTeamInfo?.link || "",
        miniAppLabel: "Open Thread Team",
        browserLabel: "Open Thread Team",
      });
      return;
    }

    let info = null;
    try {
      info = await buildContextInfo(currentJobId, { chatId, userId: telegramUserId || undefined });
    } catch {
      info = null;
    }

    const enabled = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];
    const disabled = runtime?.toolSelection?.disabled_ids || [];
    const lines = [
      "현재 job tool 목록",
      `- job_id: ${currentJobId}`,
      enabled.length > 0
        ? `- enabled: ${enabled.slice(0, 10).join(", ")}`
        : "- enabled: (none)",
      disabled.length > 0
        ? `- disabled: ${disabled.slice(0, 10).join(", ")}`
        : "- disabled: (none)",
      "정밀 편집은 GoC UI에서 할 수 있습니다.",
    ];
    await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
      miniAppLink: info?.miniAppLink || info?.link || "",
      browserLink: info?.browserLink || "",
    });
  } finally {
    restoreActor();
  }
}

function extractPlainChatMessage(msg, text, botUsername = "") {
  const raw = String(text || "").trim();
  if (!raw) return "";
  if (!TELEGRAM_REQUIRE_MENTION_IN_GROUP) return raw;

  const chatType = String(msg?.chat?.type || "").trim().toLowerCase();
  const isGroupChat = chatType === "group" || chatType === "supergroup";
  if (!isGroupChat) return raw;

  if (raw.startsWith("!")) {
    return raw.slice(1).trim();
  }

  const normalizedUsername = String(botUsername || "").trim().toLowerCase();
  if (!normalizedUsername) return "";

  const mentionPrefix = new RegExp(`^@${normalizedUsername}(?:\\s+|\\s*[:,]\\s*)?`, "i");
  if (mentionPrefix.test(raw)) {
    return raw.replace(mentionPrefix, "").trim();
  }

  const entities = Array.isArray(msg?.entities) ? msg.entities : [];
  for (const entity of entities) {
    if (!entity || entity.type !== "mention") continue;
    const offset = Number(entity.offset);
    const length = Number(entity.length);
    if (!Number.isFinite(offset) || !Number.isFinite(length) || length <= 1) continue;
    const mentioned = raw.slice(offset, offset + length).trim().toLowerCase();
    if (mentioned === `@${normalizedUsername}`) {
      const stripped = `${raw.slice(0, offset)} ${raw.slice(offset + length)}`.replace(/\s+/g, " ").trim();
      return stripped;
    }
  }
  return "";
}

const botOptions = {
  polling: {
    autoStart: false,
    interval: Number.isFinite(TELEGRAM_POLLING_INTERVAL_MS) ? TELEGRAM_POLLING_INTERVAL_MS : 1000,
    params: { timeout: Number.isFinite(TELEGRAM_POLLING_TIMEOUT_SEC) ? TELEGRAM_POLLING_TIMEOUT_SEC : 15 },
  },
};
if (TELEGRAM_FORCE_IPV4) botOptions.request = { family: 4 };
const bot = new TelegramBot(TOKEN, botOptions);
let botUsername = "";

const chatRunManager = new ChatRunManager({
  sessionStore: chatSessionStore,
  interruptDebounceMs: INTERRUPT_DEBOUNCE_MS,
  cancelCurrent: async ({ chatId, mode, reason }) => {
    return requestChatInterrupt(chatId, { mode, reason });
  },
  onAck: async ({ chatId, mode }) => {
    if (mode === "cancel") {
      await bot.sendMessage(chatId, "⛔️ 중단했어요. 다음 지시를 주세요.");
    }
  },
  onRunError: async ({ chatId, error }) => {
    if (isCancelledError(error)) return;
    await bot.sendMessage(chatId, `❌ /chat 실패: ${String(error?.message ?? error)}`);
  },
  runChat: async ({ chatId, userId, message, inputKind, pendingCount, telegramMessageId, forceMode, chatInfo }) => {
    await runSupervisorChat(
      bot,
      chatId,
      userId,
      message,
      {
        debug: false,
        chatInfo: chatInfo && typeof chatInfo === "object"
          ? chatInfo
          : { chat_id: String(chatId || "") },
        inputKind: inputKind || (pendingCount > 1 ? "interrupt_update" : "chat_message"),
        telegramMessageId,
        forceMode: normalizeForceMode(forceMode),
      }
    );
  },
});

let shuttingDown = false;
async function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await bot.stopPolling({ cancel: true }); } catch {}
  releaseSingleInstanceLock();
  process.exit(code);
}

let lastPollingErrorSig = "";
let lastPollingErrorAt = 0;
let suppressedPollingErrors = 0;

bot.on("polling_error", (error) => {
  const code = String(error?.code ?? "UNKNOWN");
  const message = String(error?.message ?? error);
  const telegramCode = Number(error?.response?.body?.error_code ?? 0);
  const sig = `${code}|${telegramCode}|${message}`;
  const now = Date.now();

  if (sig === lastPollingErrorSig && now - lastPollingErrorAt < 10000) {
    suppressedPollingErrors += 1;
    return;
  }
  if (suppressedPollingErrors > 0) {
    console.error(`polling_error repeated ${suppressedPollingErrors} times (suppressed).`);
    suppressedPollingErrors = 0;
  }
  lastPollingErrorSig = sig;
  lastPollingErrorAt = now;

  if (code === "ETELEGRAM" && telegramCode === 409) {
    console.error("Telegram polling conflict (409): another bot instance is already using this token.");
    console.error("Run only one instance (npm start or systemd service), then restart.");
    void shutdown(1);
    return;
  }

  if (code === "EFATAL" && message.includes("AggregateError")) {
    console.error("Telegram polling fatal network error (EFATAL AggregateError).");
    console.error("Check outbound network/DNS, and keep TELEGRAM_FORCE_IPV4=true if your host has unstable IPv6.");
    return;
  }

  console.error(`polling_error [${code}] ${message}`);
});

const onCallbackQuery = createTelegramCallbackQueryHandler({
  bot,
  isAllowedChat,
  isAllowedUser,
  setGocActingTelegramUser,
  bindGocActor,
  clip,
  openAgentsUiInfo,
  memoryModeWithFallback,
  requireGocClient,
  findDraftByNodeId,
  findLatestDraftByAgentId,
  buildAgentProfileFromProposal,
  resolveCurrentJobIdForChat,
  createAgentProfile,
  jobs,
  runDir,
  ensureJobThread,
  appendParticipantToJobConfig,
  tracking,
  refreshAgentRegistry,
  setAwait,
  rememberLastChatJob,
  approvals,
  runWorkspaceDir,
  runCommand,
  FENCE,
  sendLong,
  suggestNextPrompt,
  actionApprovalDeps: {
    chatSessionStore,
    resolveCurrentJobIdForChat,
    tracking,
    chatActionLabel,
    chatRunManager,
    loadSupervisorRuntime,
    memoryModeWithFallback,
    requireGocClient,
    jobs,
    GocExecutionGraphRecorder,
    resetJobAbortController,
    activeJobByChat,
    rememberLastChatJob,
    buildQueuedAgentStatusFromActions,
    sendPlanPreviewMessage,
    getCurrentTurnReplyMessageId,
    executeSupervisorActions,
    normalizeForceMode,
    buildSupervisorExecutionCallbacks,
    CHAT_VERBOSE,
    sendAgentStatusTransitionMessage,
    synthesizeChatReply,
    clip,
    sendLong,
    buildPendingApprovalPrompt,
    maybeAutoSendOutputs,
    markMutatingActionsConfirmed,
    jobAbortControllers,
  },
});
bot.on("callback_query", onCallbackQuery);

const handleTelegramCommand = createTelegramCommandHandler({
  bot,
  sendLong,
  formatRunningJobs,
  getAwait,
  clearAwait,
  setAwait,
  rememberLastChatJob,
  resetChatSession,
  activeJobByChat,
  lastChatJobByChat,
  cancelJobExecution,
  chatSessionStore,
  memory,
  formatMemorySummary,
  formatAgentMemorySummary,
  sendChatStatus,
  sendAgentOrToolListQuick,
  resolveLiveJobIdForChat,
  parseClampedInt,
  collectWorkspaceFileEntries,
  formatWorkspaceFileListText,
  deliverWorkspaceOutputs,
  OUTPUT_AUTO_SEND_MAX_FILES,
  sendWorkspaceFileByRelativePath,
  formatByteSize,
  clip,
  sendContextInfo,
  parseChatMessageWithFlags,
  sendRouterAckMessage,
  chatRunManager,
  runSupervisorChat,
  createJob,
  resetJobAbortController,
  runWorkspaceDir,
  loadSupervisorRuntime,
  decideRunRoute,
  tracking,
  actionLabel,
  executeRoutedPlan,
  suggestNextPrompt,
  isCancelledError,
  getGoalFromResearch,
  extractCodexInstruction,
  sendChatGPTPrompt,
  jobs,
  approvals,
  jobAbortControllers,
});

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (!chatId || !userId) return;
  if (!isAllowedChat(chatId) || !isAllowedUser(userId)) return;
  setGocActingTelegramUser(userId);

  if (hasTelegramUploadAttachment(msg)) {
    try {
      await handleTelegramFileUpload(bot, msg, { chatId, userId });
    } catch (e) {
      await bot.sendMessage(
        chatId,
        `❌ 파일 업로드 저장 실패: ${clip(String(e?.message ?? e), 220)}`,
        Number.isFinite(Number(msg?.message_id))
          ? { reply_to_message_id: Number(msg.message_id) }
          : undefined
      );
    }
  }

  const text = String(msg.text || msg.caption || "").trim();
  if (!text) return;

  // Paste mode capture (non-command)
  const st = getAwait(chatId);
  if (st && !text.startsWith("/")) {
    const jobId = st.jobId;
    tracking.append(jobId, "plan.md", `## ChatGPT reply (pasted)\n\n${text}\n`);
    jobs.appendConversation(jobId, "chatgpt", text, { kind: "plan_reply" });

    const plan = extractJsonPlan(text);
    if (plan && String(plan.jobId || "") === String(jobId)) {
      await bot.sendMessage(chatId, "✅ JSON 액션 플랜 감지. 실행을 시작합니다.");
      clearAwait(chatId);
      const controller = resetJobAbortController(jobId);
      const chatKey = String(chatId);
      activeJobByChat.set(chatKey, String(jobId));
      try {
        let runtimeForPlan = null;
        try {
          runtimeForPlan = await loadSupervisorRuntime(jobId, {
            chatMeta: {
              chat_id: String(chatId || ""),
              telegram_user_id: String(st.userId || userId || "").trim() || undefined,
            },
            includeContext: false,
            includeGlobal: false,
            telegramUserId: String(st.userId || userId || "").trim(),
          });
        } catch {
          runtimeForPlan = null;
        }
        await executeActions(bot, chatId, jobId, plan, controller.signal, {
          telegramUserId: st.userId || userId,
          runtime: runtimeForPlan,
        });
        await bot.sendMessage(chatId, "🏁 액션 플랜 실행 완료.");
        await suggestNextPrompt(bot, chatId, jobId, "현재 상태에서 다음으로 무엇을 해야 하는지 action plan(JSON)으로 제안해줘.", "action_plan", controller.signal);
      } catch (e) {
        if (isCancelledError(e)) {
          await bot.sendMessage(chatId, `⏹️ 액션 플랜 실행이 중단되었습니다. (jobId=${jobId})`);
        } else {
          await bot.sendMessage(chatId, `❌ 액션 실행 오류: ${String(e?.message ?? e)}`);
        }
      } finally {
        if (activeJobByChat.get(chatKey) === String(jobId)) activeJobByChat.delete(chatKey);
        jobAbortControllers.delete(String(jobId));
      }
    } else {
      await bot.sendMessage(chatId, "🟣 plan.md에 기록 완료. (JSON 플랜이 없어서 자동 실행은 하지 않았어요)");
    }
    return;
  }

  if (!text.startsWith("/")) {
    const plain = extractPlainChatMessage(msg, text, botUsername);
    if (!plain) return;
    if (isHardStopMessage(plain)) {
      await chatRunManager.hardCancel({
        chatId,
        reason: plain,
        userId,
        telegramMessageId: msg.message_id,
      });
      return;
    }
    await sendRouterAckMessage(bot, chatId, {
      replyToMessageId: msg.message_id,
    });
    await chatRunManager.handleIncoming({
      chatId,
      userId,
      text: plain,
      kind: "normal",
      telegramMessageId: msg.message_id,
      chatInfo: {
        chat_id: String(chatId || ""),
        title: String(msg.chat?.title || msg.chat?.username || "").trim(),
        type: String(msg.chat?.type || "").trim(),
      },
    });
    return;
  }

  const handledCommand = await handleTelegramCommand({ msg, text, chatId, userId });
  if (handledCommand) return;
});

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

console.log("Telegram orchestrator v2.1 started (polling).");
console.log(`Job workspace root: ${jobs.runsDir}/<jobId>/workspace`);
console.log(`Runs dir: ${jobs.runsDir}`);
console.log(`Telegram upload/download limit: ${formatByteSize(TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES)} (bot-api download)`);
console.log(`Telegram sendDocument limit: ${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}`);
console.log(`Output auto-send: ${OUTPUT_AUTO_SEND} (on=${OUTPUT_AUTO_SEND_ON}, max=${OUTPUT_AUTO_SEND_MAX_FILES})`);
console.log(`Memory mode: ${MEMORY_MODE} (effective=${memoryModeWithFallback()})`);
try {
  const me = await bot.getMe();
  botUsername = String(me?.username || "").trim().toLowerCase();
} catch {
  botUsername = "";
}
if (botUsername) {
  console.log(`Telegram bot username: @${botUsername}`);
}
if (gocInitError) console.log(`GoC init error: ${gocInitError}`);
console.log(`Agents registry: ${agentRegistry.path}`);
await bot.startPolling({ restart: true });
