import path from "node:path";
import process from "node:process";

import { compactWithPinnedContext } from "../textutil.js";
import { formatActiveArtifactContext } from "./artifact_context.js";

import { Jobs } from "../jobs.js";
import { Tracking } from "../tracking.js";
import { Approvals } from "../approvals.js";
import { OrchestratorMemory } from "../settings.js";
import { orchestratorNotes } from "../prompts.js";
import { loadAgents, getAgent } from "../agents.js";
import { GocClient } from "../goc_client.js";
import {
  KNOWLEDGE_BASE_CONTRACT_FILE,
} from "../knowledge_base/runtime.js";
import { formatKnowledgeBaseMemoryMap, normalizeKnowledgeBaseProfile } from "../knowledge_base/profile.js";
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
const AUTO_SUGGEST_ENABLED = String(process.env.AUTO_SUGGEST_GPT_PROMPT ?? "false").toLowerCase() === "true";
const CHAT_VERBOSE = String(process.env.CHAT_VERBOSE ?? "false").toLowerCase() === "true";
const TELEGRAM_PROGRESS_DETAIL_MODE = String(process.env.TELEGRAM_PROGRESS_DETAIL_MODE ?? "compact").trim().toLowerCase() === "full" ? "full" : "compact";
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

const TRACK_DOC_NAMES = ["plan", "research", "progress", "decisions", "artifacts"];


const GOC_FALLBACK_TTL_MS = Number.isFinite(Number(process.env.GOC_FALLBACK_TTL_MS))
  ? Math.max(60_000, Math.floor(Number(process.env.GOC_FALLBACK_TTL_MS)))
  : 30 * 60 * 1000;
const GOC_FALLBACK_MAX_ENTRIES = Number.isFinite(Number(process.env.GOC_FALLBACK_MAX_ENTRIES))
  ? Math.max(50, Math.floor(Number(process.env.GOC_FALLBACK_MAX_ENTRIES)))
  : 1000;
const AGENT_STATUS_STATE_TTL_MS = Number.isFinite(Number(process.env.AGENT_STATUS_STATE_TTL_MS))
  ? Math.max(60_000, Math.floor(Number(process.env.AGENT_STATUS_STATE_TTL_MS)))
  : 6 * 60 * 60 * 1000;
const AGENT_STATUS_STATE_MAX_ENTRIES = Number.isFinite(Number(process.env.AGENT_STATUS_STATE_MAX_ENTRIES))
  ? Math.max(50, Math.floor(Number(process.env.AGENT_STATUS_STATE_MAX_ENTRIES)))
  : 500;
const AWAITING_STATE_TTL_MS = Number.isFinite(Number(process.env.AWAITING_STATE_TTL_MS))
  ? Math.max(60_000, Math.floor(Number(process.env.AWAITING_STATE_TTL_MS)))
  : 20 * 60 * 1000;
const AWAITING_STATE_MAX_ENTRIES = Number.isFinite(Number(process.env.AWAITING_STATE_MAX_ENTRIES))
  ? Math.max(50, Math.floor(Number(process.env.AWAITING_STATE_MAX_ENTRIES)))
  : 1000;

class ExpiringMap extends Map {
  constructor({ ttlMs = 0, maxEntries = 0 } = {}) {
    super();
    this.ttlMs = Number.isFinite(Number(ttlMs)) ? Math.max(0, Math.floor(Number(ttlMs))) : 0;
    this.maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(0, Math.floor(Number(maxEntries))) : 0;
  }

  #wrap(value) {
    return { value, expiresAt: this.ttlMs > 0 ? Date.now() + this.ttlMs : 0, touchedAt: Date.now() };
  }

  #unwrap(key, wrapped) {
    if (!wrapped || typeof wrapped !== 'object' || !('value' in wrapped)) return wrapped;
    if (wrapped.expiresAt > 0 && Date.now() > wrapped.expiresAt) {
      super.delete(key);
      return undefined;
    }
    wrapped.touchedAt = Date.now();
    return wrapped.value;
  }

  prune() {
    if (this.size === 0) return;
    for (const [key, wrapped] of super.entries()) this.#unwrap(key, wrapped);
    if (this.maxEntries > 0 && this.size > this.maxEntries) {
      const overflow = this.size - this.maxEntries;
      const ordered = Array.from(super.entries())
        .sort((a, b) => Number(a[1]?.touchedAt || 0) - Number(b[1]?.touchedAt || 0))
        .slice(0, overflow);
      for (const [key] of ordered) super.delete(key);
    }
  }

  get(key) {
    this.prune();
    return this.#unwrap(key, super.get(key));
  }

  set(key, value) {
    super.set(key, this.#wrap(value));
    this.prune();
    return this;
  }

  has(key) {
    this.prune();
    return super.has(key);
  }

  values() {
    this.prune();
    return Array.from(super.entries(), ([key, wrapped]) => this.#unwrap(key, wrapped)).values();
  }

  entries() {
    this.prune();
    return Array.from(super.entries(), ([key, wrapped]) => [key, this.#unwrap(key, wrapped)]).values();
  }

  [Symbol.iterator]() {
    return this.entries();
  }
}
const gocFallbackByJob = new ExpiringMap({ ttlMs: GOC_FALLBACK_TTL_MS, maxEntries: GOC_FALLBACK_MAX_ENTRIES });

const jobRuntimeState = createJobRuntimeState();
const { jobAbortControllers, activeJobByChat, lastChatJobByChat } = jobRuntimeState;
const agentStatusMessageStateByChat = new ExpiringMap({ ttlMs: AGENT_STATUS_STATE_TTL_MS, maxEntries: AGENT_STATUS_STATE_MAX_ENTRIES });
let running = 0;
const queue = [];
const awaiting = new ExpiringMap({ ttlMs: AWAITING_STATE_TTL_MS, maxEntries: AWAITING_STATE_MAX_ENTRIES });

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
  const sections = [];
  const activeArtifactContext = formatActiveArtifactContext(runDir(jobId), { maxChars: Math.max(900, Math.floor(maxCharsPerDoc * 0.9)) });
  if (activeArtifactContext) sections.push(activeArtifactContext);
  const profile = tracking.loadProfile(jobId);
  if (profile) {
    const summaryLimit = Math.max(900, Math.floor(maxCharsPerDoc / 2));
    const memoryMap = formatKnowledgeBaseMemoryMap(profile, { maxDocs: 6, includePolicy: true });
    const clippedMap = memoryMap.length > summaryLimit ? memoryMap.slice(0, summaryLimit) : memoryMap;
    sections.push(`### [memory_map]\n\n${clippedMap}`);
  }
  const seenDocNames = new Set();
  for (const name of docNames) {
    const resolvedName = tracking.resolveDocName(jobId, name);
    const resolvedKey = String(resolvedName || '').trim().toLowerCase();
    if (!resolvedKey || seenDocNames.has(resolvedKey) || resolvedKey === String(KNOWLEDGE_BASE_CONTRACT_FILE).toLowerCase()) continue;
    seenDocNames.add(resolvedKey);
    try {
      const text = tracking.read(jobId, name);
      const clipped = text.length > maxCharsPerDoc
        ? compactWithPinnedContext(text, maxCharsPerDoc, { maxPinLines: 12 })
        : text;
      sections.push(`### ${path.join(runSharedDir(jobId), resolvedName)}\n\n${clipped}`);
    } catch (error) {
      sections.push(`### ${path.join(runSharedDir(jobId), resolvedName)}\n\n[read failed: ${String(error?.message ?? error)}]`);
    }
  }
  return sections.length > 0 ? sections.join('\n\n---\n\n') : '(none)';
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
    // Prefer the configured runtime/team view over the static catalog. Catalog rows are
    // templates and may carry stale provider/model defaults that must not shadow an
    // explicit Room model-role assignment.
    ...(Array.isArray(runtime?.activeTeamConfig?.agents) ? runtime.activeTeamConfig.agents : []),
    ...(Array.isArray(runtime?.agents) ? runtime.agents : []),
    ...(Array.isArray(runtime?.conversationAgents) ? runtime.conversationAgents.map((row) => ({
      id: row?.agent_id || row?.agentId || row?.id,
      ...(row?.overrides_json && typeof row.overrides_json === "object" ? row.overrides_json : (row?.overridesJson && typeof row.overridesJson === "object" ? row.overridesJson : {})),
      provider: row?.overrides_json?.configured_provider || row?.overridesJson?.configured_provider || row?.overrides_json?.provider || row?.overridesJson?.provider,
      model: row?.overrides_json?.configured_model || row?.overridesJson?.configured_model || row?.overrides_json?.model || row?.overridesJson?.model,
      role: row?.overrides_json?.configured_role || row?.overridesJson?.configured_role || row?.overrides_json?.role || row?.overridesJson?.role,
    })) : []),
    ...(Array.isArray(runtime?.runtimeTeamSnapshot?.runtime_agents)
      ? runtime.runtimeTeamSnapshot.runtime_agents.map((row) => ({
          id: row?.template_id || row?.templateId || row?.agent_id || row?.agentId,
          name: row?.display_label || row?.displayLabel,
          provider: row?.provider,
          model: row?.model,
          role: row?.role_id || row?.roleId || row?.role_label || row?.roleLabel,
          attached_skill_ids: row?.attached_skill_ids || row?.attachedSkillIds,
          capabilities: row?.capability_tags || row?.capabilityTags,
          context_policy: row?.context_policy || row?.contextPolicy,
        }))
      : []),
    ...(Array.isArray(runtime?.agentsCatalog) ? runtime.agentsCatalog : []),
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

function runtimeQueueMaxSize() {
  const raw = Number(process.env.TELEGRAM_RUNTIME_QUEUE_MAX || 64);
  if (!Number.isFinite(raw)) return 64;
  return Math.max(1, Math.min(1000, Math.floor(raw)));
}

function makeQueueFullError() {
  const error = new Error(`runtime queue full: max=${runtimeQueueMaxSize()}`);
  error.code = 'EQUEUEFULL';
  error.category = 'backpressure';
  return error;
}

function pruneCancelledQueueItems() {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    const item = queue[i];
    if (!item?.signal?.aborted) continue;
    queue.splice(i, 1);
    try { item.reject(makeCancelledError(item.jobId || 'unknown')); } catch {}
  }
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
    expiresAt: Date.now() + AWAITING_STATE_TTL_MS,
  });
}

function clearAwait(chatId) {
  awaiting.delete(String(chatId));
}

function getAwait(chatId) {
  const state = awaiting.get(String(chatId));
  if (!state) return null;
  if (Number(state.expiresAt || 0) > 0 && Date.now() > state.expiresAt) {
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
    pruneCancelledQueueItems();
    if (signal?.aborted) {
      reject(makeCancelledError(String(jobId || 'unknown')));
      return;
    }
    if (queue.length >= runtimeQueueMaxSize()) {
      reject(makeQueueFullError());
      return;
    }
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
  TELEGRAM_PROGRESS_DETAIL_MODE,
  TELEGRAM_REQUIRE_MENTION_IN_GROUP,
  TELEGRAM_FORCE_IPV4,
  TELEGRAM_POLLING_INTERVAL_MS,
  TELEGRAM_POLLING_TIMEOUT_SEC,
  TELEGRAM_EFFECTIVE_DOWNLOAD_MAX_BYTES,
  TELEGRAM_SEND_MAX_BYTES,
  TELEGRAM_UPLOAD_ALLOWED_EXTS,
  TELEGRAM_SINGLE_INSTANCE_LOCK,
  LOCK_FILE,
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
