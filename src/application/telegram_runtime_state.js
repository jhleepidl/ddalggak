import path from "node:path";
import process from "node:process";

import { Jobs } from "../jobs.js";
import { Tracking } from "../tracking.js";
import { Approvals } from "../approvals.js";
import { OrchestratorMemory } from "../settings.js";
import { orchestratorNotes } from "../prompts.js";
import { loadAgents, getAgent } from "../agents.js";
import { GocClient } from "../goc_client.js";
import { ChatSessionStore } from "../chat/session.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./job_runtime.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FENCE = "```";

const jobs = new Jobs();
const tracking = new Tracking(jobs);
const approvals = new Approvals(jobs);

const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
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
  codex: "builder",
  chatgpt: "synthesizer",
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
  } catch (error) {
    gocReady = false;
    gocInitError = String(error?.message ?? error);
    console.error(`[memory] GoC init failed, fallback to local: ${gocInitError}`);
  }
}

const TRACK_DOC_NAMES = ["plan.md", "research.md", "progress.md", "decisions.md"];
const gocFallbackByJob = new Map();

const jobRuntimeState = createJobRuntimeState();
const { jobAbortControllers, activeJobByChat, lastChatJobByChat } = jobRuntimeState;
const agentStatusMessageStateByChat = new Map();
let running = 0;
const queue = [];
const awaiting = new Map();

function setAgentRegistry(nextRegistry = null) {
  if (nextRegistry && typeof nextRegistry === "object") {
    agentRegistry = nextRegistry;
  }
  return agentRegistry;
}

function setGocInitStatus({ client = gocClient, ready = gocReady, error = gocInitError } = {}) {
  gocClient = client || null;
  gocReady = !!ready && !!gocClient;
  gocInitError = String(error || "").trim();
  return {
    gocClient,
    gocReady,
    gocInitError,
  };
}

function isAllowedChat(chatId) { void chatId; return true; }
function isAllowedUser(userId) { return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(String(userId)); }

function runDir(jobId) {
  return jobs.jobDir(jobId);
}

function runWorkspaceDir(jobId) {
  return jobs.workspaceDir(jobId);
}

function resolveWorkspacePath(jobId, userPath = ".", { asDirectory = false } = {}) {
  return jobs.ensureWorkspacePath(jobId, userPath, { asDirectory });
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

function runSharedDir(jobId) {
  return path.join(runDir(jobId), "shared");
}

function loadLocalContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
  let out = "";
  for (const name of docNames) {
    try {
      const text = tracking.read(jobId, name);
      const clipped = text.length > maxCharsPerDoc ? text.slice(-maxCharsPerDoc) : text;
      out += `\n\n---\n\n### ${path.join(runSharedDir(jobId), name)}\n\n${clipped}\n`;
    } catch (error) {
      out += `\n\n---\n\n### ${path.join(runSharedDir(jobId), name)}\n\n[read failed: ${String(error?.message ?? error)}]\n`;
    }
  }
  return out.trim() || "(none)";
}

function resolveCurrentJobIdForChat(chatId) {
  const chatKey = String(chatId);
  const fromSession = chatSessionStore.get(chatId)?.jobId || "";
  return activeJobByChat.get(chatKey) || getAwait(chatId)?.jobId || fromSession || lastChatJobByChat.get(chatKey) || "";
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

function rememberLastChatJob(chatId, jobId) {
  const chatKey = String(chatId);
  const key = String(jobId || "").trim();
  if (!key) return;
  lastChatJobByChat.set(chatKey, key);
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
    throw new Error(gocInitError || "GoC is not ready");
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
    const previous = String(client.actorTelegramUserId || "").trim();
    const next = String(telegramUserId || "").trim();
    if (next && typeof client.setActorTelegramUserId === "function") {
      client.setActorTelegramUserId(next);
    }
    return () => {
      try {
        if (typeof client.setActorTelegramUserId === "function") {
          client.setActorTelegramUserId(previous);
        }
      } catch {}
    };
  } catch {
    return () => {};
  }
}

function makeCancelledError(jobId) {
  return makeCancelledErrorDomain(jobId);
}

function isCancelledError(error) {
  return isCancelledErrorDomain(error);
}

function resetJobAbortController(jobId) {
  return jobRuntimeState.resetJobAbortController(jobId);
}

function cancelJobExecution(jobId) {
  return jobRuntimeState.cancelJobExecution(jobId, queue);
}

function setAwait(chatId, jobId, userId) {
  awaiting.set(String(chatId), {
    jobId,
    userId,
    expiresAt: Date.now() + 20 * 60 * 1000,
  });
}

function clearAwait(chatId) {
  awaiting.delete(String(chatId));
}

function getAwait(chatId) {
  const state = awaiting.get(String(chatId));
  if (!state) return null;
  if (Date.now() > state.expiresAt) {
    awaiting.delete(String(chatId));
    return null;
  }
  return state;
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

function resetChatSession(chatId) {
  const chatKey = String(chatId);
  requestChatInterrupt(chatId, { mode: "cancel", reason: "chat_reset" });
  activeJobByChat.delete(chatKey);
  lastChatJobByChat.delete(chatKey);
  clearAwait(chatId);
  chatSessionStore.clear(chatId);
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
  try {
    item.resolve(await item.fn());
  } catch (error) {
    item.reject(error);
  } finally {
    running -= 1;
    pump();
  }
}

export {
  TOKEN,
  FENCE,
  AUTO_SUGGEST_ENABLED,
  CHAT_VERBOSE,
  TELEGRAM_REQUIRE_MENTION_IN_GROUP,
  TELEGRAM_FORCE_IPV4,
  TELEGRAM_POLLING_INTERVAL_MS,
  TELEGRAM_POLLING_TIMEOUT_SEC,
  TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES,
  TELEGRAM_SEND_MAX_BYTES,
  TELEGRAM_UPLOAD_ALLOWED_EXTS,
  TELEGRAM_SINGLE_INSTANCE_LOCK,
  LOCK_FILE,
  OUTPUT_AUTO_SEND,
  OUTPUT_AUTO_SEND_MAX_FILES,
  OUTPUT_AUTO_SEND_ON,
  MEMORY_MODE,
  GOC_UI_TOKEN_TTL_SEC,
  GOC_UI_BROWSER_TOKEN_TTL_SEC,
  GOC_UI_LINK_MODE,
  MAX_PARALLEL_PER_RUN,
  INTERRUPT_DEBOUNCE_MS,
  AGENT_STATUS_MESSAGE_THROTTLE_MS,
  AUTOPILOT_ENABLED,
  AUTOPILOT_MAX_TURNS,
  AUTOPILOT_MAX_TOTAL_ACTIONS,
  SHARED_CONTEXT_RECENT_USER_MESSAGES,
  SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES,
  SHARED_CONTEXT_RECENT_RUN_STEP,
  SHARED_CONTEXT_RECENT_TOOL_ARTIFACT,
  SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS,
  TRACK_DOC_NAMES,
  LEGACY_AGENT_MAP,
  jobs,
  tracking,
  approvals,
  memory,
  chatSessionStore,
  agentRegistry,
  gocClient,
  gocReady,
  gocInitError,
  gocFallbackByJob,
  queue,
  jobAbortControllers,
  activeJobByChat,
  lastChatJobByChat,
  agentStatusMessageStateByChat,
  setAgentRegistry,
  setGocInitStatus,
  isAllowedChat,
  isAllowedUser,
  runDir,
  runWorkspaceDir,
  resolveWorkspacePath,
  formatFileMtime,
  runSharedDir,
  loadLocalContextDocs,
  resolveCurrentJobIdForChat,
  resolveLiveJobIdForChat,
  parseClampedInt,
  rememberLastChatJob,
  resolveAgentId,
  findAgentConfig,
  findAgentConfigInRuntime,
  memoryModeWithFallback,
  requireGocClient,
  setGocActingTelegramUser,
  bindGocActor,
  makeCancelledError,
  isCancelledError,
  resetJobAbortController,
  cancelJobExecution,
  setAwait,
  clearAwait,
  getAwait,
  requestChatInterrupt,
  resetChatSession,
  enqueue,
};
