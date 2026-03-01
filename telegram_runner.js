import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import TelegramBot from "node-telegram-bot-api";

import { Workspace } from "./src/workspace.js";
import { Jobs } from "./src/jobs.js";
import { Tracking } from "./src/tracking.js";
import { Approvals } from "./src/approvals.js";
import { runCommand } from "./src/proc.js";
import { runCodexExec } from "./src/codex.js";
import { runGeminiPrompt } from "./src/gemini.js";
import { OrchestratorMemory } from "./src/settings.js";
import { orchestratorNotes, buildChatGPTNextStepPrompt } from "./src/prompts.js";
import { clip, chunk, extractCodexInstruction, extractJsonPlan } from "./src/textutil.js";
import { loadAgents, getAgent } from "./src/agents.js";
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
import { executeSupervisorActions } from "./src/chat/executor.js";
import { expandDetailContext } from "./src/chat/unfold.js";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) { console.error("Missing TELEGRAM_BOT_TOKEN"); process.exit(1); }

const FENCE = "```";

const workspace = new Workspace();
const jobs = new Jobs(workspace);
const tracking = new Tracking(jobs);
const approvals = new Approvals(jobs);

const ALLOWED_CHATS = (process.env.TELEGRAM_ALLOWED_CHAT_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const ALLOWED_USERS = (process.env.TELEGRAM_ALLOWED_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY ?? 1);
const AUTO_SUGGEST_ENABLED = String(process.env.AUTO_SUGGEST_GPT_PROMPT ?? "true").toLowerCase() !== "false";
const CHAT_VERBOSE = String(process.env.CHAT_VERBOSE ?? "false").toLowerCase() === "true";
const TELEGRAM_FORCE_IPV4 = String(process.env.TELEGRAM_FORCE_IPV4 ?? "true").toLowerCase() !== "false";
const TELEGRAM_POLLING_INTERVAL_MS = Number(process.env.TELEGRAM_POLLING_INTERVAL_MS ?? 1000);
const TELEGRAM_POLLING_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLLING_TIMEOUT_SEC ?? 15);
const TELEGRAM_SINGLE_INSTANCE_LOCK = String(process.env.TELEGRAM_SINGLE_INSTANCE_LOCK ?? "true").toLowerCase() !== "false";
const LOCK_FILE = process.env.TELEGRAM_LOCK_FILE || path.join(workspace.root, ".orchestrator", "telegram_runner.lock");
const MEMORY_MODE = String(process.env.MEMORY_MODE || "local").trim().toLowerCase() === "goc" ? "goc" : "local";
const GOC_UI_TOKEN_TTL_SEC = Number(process.env.GOC_UI_TOKEN_TTL_SEC ?? 21600);
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

function isAllowedChat(chatId) { return ALLOWED_CHATS.length === 0 || ALLOWED_CHATS.includes(String(chatId)); }
function isAllowedUser(userId) { return ALLOWED_USERS.length === 0 || ALLOWED_USERS.includes(String(userId)); }
const TRACK_DOC_NAMES = ["plan.md", "research.md", "progress.md", "decisions.md"];
const gocFallbackByJob = new Map();

function runDir(jobId) {
  return jobs.jobDir(jobId);
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

function buildGocUiLink({ threadId, ctxId, token }) {
  const base = String(process.env.GOC_UI_BASE || "").trim().replace(/\/+$/, "");
  if (!base) throw new Error("Missing GOC_UI_BASE");
  return `${base}?thread=${encodeURIComponent(String(threadId || ""))}&ctx=${encodeURIComponent(String(ctxId || ""))}#token=${encodeURIComponent(String(token || ""))}`;
}

function resolveCurrentJobIdForChat(chatId) {
  const chatKey = String(chatId);
  return activeJobByChat.get(chatKey) || getAwait(chatId)?.jobId || lastChatJobByChat.get(chatKey) || "";
}

function rememberLastChatJob(chatId, jobId) {
  const chatKey = String(chatId);
  const key = String(jobId || "").trim();
  if (!key) return;
  lastChatJobByChat.set(chatKey, key);
}

function resetChatSession(chatId) {
  const chatKey = String(chatId);
  activeJobByChat.delete(chatKey);
  lastChatJobByChat.delete(chatKey);
  clearAwait(chatId);
  chatSessionStore.clear(chatId);
}

async function buildContextInfo(target, { chatId = null } = {}) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error(`GoC disabled (mode=${MEMORY_MODE}, effective=${memoryModeWithFallback()})`);
  }

  const client = requireGocClient();
  const minted = await client.mintUiToken(GOC_UI_TOKEN_TTL_SEC);
  const targetRaw = String(target || "").trim();
  const resolved = targetRaw || (chatId == null ? "" : resolveCurrentJobIdForChat(chatId));

  if (!resolved) {
    throw new Error("Usage: /context <jobId|global>  (jobId omitted uses current running job)");
  }

  if (resolved.toLowerCase() === "global") {
    const g = await ensureGlobalThread(client, {
      baseDir: jobs.baseDir,
      title: "global:shared",
    });
    const link = buildGocUiLink({ threadId: g.threadId, ctxId: g.ctxId, token: minted.token });
    return {
      scope: "global",
      threadId: g.threadId,
      ctxId: g.ctxId,
      link,
      tokenExp: minted.exp || null,
      lines: [
        "global context",
        `thread=${g.threadId}`,
        `ctx=${g.ctxId}`,
        minted.exp ? `token_exp=${minted.exp}` : "",
        link,
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
  });
  const link = buildGocUiLink({
    threadId: map.threadId,
    ctxId: map.ctxSharedId,
    token: minted.token,
  });
  return {
    scope: "job",
    jobId,
    threadId: map.threadId,
    ctxId: map.ctxSharedId,
    link,
    tokenExp: minted.exp || null,
    lines: [
      `jobId=${jobId}`,
      `thread=${map.threadId}`,
      `ctx=${map.ctxSharedId}`,
      minted.exp ? `token_exp=${minted.exp}` : "",
      link,
      "",
      "UI에서 편집/활성 토글/삭제하면 다음 스텝 호출부터 반영됩니다.",
    ].filter(Boolean),
  };
}

async function sendContextInfo(bot, chatId, target) {
  const info = await buildContextInfo(target, { chatId });
  await sendLong(bot, chatId, info.lines.join("\n"));
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

function convoToText(convo) {
  if (!convo || convo.length === 0) return "(none)";
  return convo.map(r => `- ${r.role}: ${r.text}`).join("\n");
}

async function sendLong(bot, chatId, text) {
  for (const part of chunk(text, 3800)) await bot.sendMessage(chatId, part);
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

function findFirstJsonObject(text) {
  const s = String(text || "");
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inStr = false;
      }
      continue;
    }
    if (ch === "\"") {
      inStr = true;
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

function parseAutoSuggestDecision(raw) {
  const text = String(raw || "");
  const candidates = [];

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const c of candidates) {
    if (!c) continue;
    const direct = (() => { try { return JSON.parse(c); } catch { return null; } })();
    if (direct && typeof direct === "object") return direct;

    const objText = findFirstJsonObject(c);
    if (!objText) continue;
    try {
      const parsed = JSON.parse(objText);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function parseJsonObjectFromText(raw) {
  const text = String(raw || "");
  const candidates = [];
  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(text.trim());

  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
    const objText = findFirstJsonObject(c);
    if (!objText) continue;
    try {
      const parsed = JSON.parse(objText);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

function normalizeRouterAction(raw) {
  const type = String(raw?.type || "").trim().toLowerCase();
  if (!type) return null;

  if (type === "agent_run") {
    const agent = resolveAgentId(raw.agent || raw.agentId || raw.role);
    const prompt = String(raw.prompt || raw.task || raw.instruction || "").trim();
    const inputs = raw.inputs && typeof raw.inputs === "object" ? raw.inputs : {};
    if (!agent || !prompt) return null;
    return { type: "agent_run", agent, prompt, inputs };
  }

  if (type === "gemini" || type === "gemini_research") {
    const prompt = String(raw.prompt || raw.query || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "researcher", prompt, inputs: {} };
  }

  if (type === "codex" || type === "codex_implement") {
    const instruction = String(raw.instruction || raw.prompt || raw.task || "").trim();
    if (!instruction) return null;
    return { type: "agent_run", agent: "coder", prompt: instruction, inputs: {} };
  }

  if (type === "git_summary") return { type: "git_summary" };

  if (type === "chatgpt_prompt") {
    const question = String(raw.question || raw.prompt || raw.task || "").trim();
    return { type: "chatgpt_prompt", question };
  }

  if (type === "chatgpt") {
    const prompt = String(raw.question || raw.prompt || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "planner", prompt, inputs: {} };
  }

  return null;
}

function parseRouterPlan(raw) {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed || !Array.isArray(parsed.actions)) return null;
  const actions = parsed.actions.map(normalizeRouterAction).filter(Boolean);
  if (actions.length === 0) return null;
  return {
    actions,
    reason: String(parsed.reason || "").trim() || "(no reason)",
  };
}

// concurrency gate
let running = 0;
const queue = [];
const jobAbortControllers = new Map(); // jobId -> AbortController
const activeJobByChat = new Map(); // chatId -> jobId
const lastChatJobByChat = new Map(); // chatId -> last /chat jobId

function makeCancelledError(jobId) {
  const e = new Error(`Cancelled job ${jobId}`);
  e.code = "ECANCELLED";
  return e;
}

function isCancelledError(e) {
  return e?.code === "ECANCELLED" || String(e?.message ?? "").includes("Cancelled job");
}

function resetJobAbortController(jobId) {
  const key = String(jobId);
  const controller = new AbortController();
  jobAbortControllers.set(key, controller);
  return controller;
}

function cancelJobExecution(jobId) {
  const key = String(jobId);
  let aborted = false;
  const controller = jobAbortControllers.get(key);
  if (controller && !controller.signal.aborted) {
    controller.abort();
    aborted = true;
  }

  let dropped = 0;
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (String(queue[i]?.jobId ?? "") !== key) continue;
    queue[i].reject(makeCancelledError(key));
    queue.splice(i, 1);
    dropped += 1;
  }

  jobAbortControllers.delete(key);
  return { aborted, dropped };
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
  const roleMemo = memory.getAgentRole("gemini");
  const ctx = await loadContextDocs(jobId, ["research.md"]);
  const prompt = [
    ctx,
    "",
    "역할 메모리:",
    roleMemo,
    "",
    `run dir: ${runDir(jobId)}`,
    `tracking docs dir: ${runSharedDir(jobId)}`,
    "",
    "제약:",
    "- 코드 작성/수정/패치 제안 금지",
    "- 터미널 명령 제안 최소화",
    "- 설계/리스크/검증 관점으로만 답변",
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
  const r = await runGeminiPrompt({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt, signal });
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
  const prompt = [
    ctx,
    "",
    "역할 메모리:",
    roleMemo,
    "",
    "너는 코드 수정 에이전트다.",
    "규칙:",
    "- 네트워크 접근 금지.",
    `- CODEX_WORKSPACE_ROOT(코드 작업 영역) 내부 파일만 수정: ${workspace.root}`,
    `- 현재 run dir: ${runDir(jobId)}`,
    "- 아래 트래킹 문서는 run/shared에서만 관리하고, CODEX_WORKSPACE_ROOT 루트에 동명 파일을 만들지 말 것:",
    trackDocs,
    "- 테스트 실행은 하지 말고, 필요한 테스트를 제안만.",
    "- 변경 요약(파일별 이유) 포함.",
    "",
    "작업:",
    instruction,
    "",
  ].join("\n");
  const r = await runCodexExec({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt, signal });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "progress.md", `## Codex output\n\n${out}\n`);
  jobs.appendConversation(jobId, "codex", out, { kind: "implementation" });
  ensureCommandOk("Codex", r);
  return out;
}

async function gitSummary(jobId, signal = null) {
  const status = await runCommand("git", ["status", "--porcelain=v1"], { cwd: workspace.root, abortSignal: signal });
  const diff = await runCommand("git", ["diff"], { cwd: workspace.root, timeoutMs: 120000, abortSignal: signal });
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
  if (mode === "continue") {
    return {
      actions: [
        { type: "agent_run", agent: "coder", prompt: seedInstruction || "run/shared 문서를 반영해 CODEX_WORKSPACE_ROOT 코드 변경을 진행하라.", inputs: {} },
        { type: "git_summary" },
      ],
      reason: "fallback: continue default",
    };
  }
  return {
    actions: [
      { type: "agent_run", agent: "researcher", prompt: goal, inputs: {} },
      { type: "agent_run", agent: "coder", prompt: goal, inputs: {} },
      { type: "git_summary" },
    ],
    reason: "fallback: run default",
  };
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
      () => runGeminiPrompt({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt, signal }),
      { jobId, signal, label: "agent_router" }
    );
    const out = (r.stdout || r.stderr || "").trim();
    if (!r.ok) return defaultRouteFor(mode, goal, seedInstruction);

    const planned = parseRouterPlan(out);
    if (!planned) return defaultRouteFor(mode, goal, seedInstruction);

    const normalized = [];
    for (const a of planned.actions) {
      if (normalized.length >= 4) break;
      if (a.type === "agent_run") {
        const agent = resolveAgentId(a.agent || "");
        const promptText = String(a.prompt || "").trim() || (agent === "coder" ? (seedInstruction || goal) : goal);
        if (!agent || !promptText) continue;
        normalized.push({ type: "agent_run", agent, prompt: promptText, inputs: a.inputs && typeof a.inputs === "object" ? a.inputs : {} });
        continue;
      }
      if (a.type === "chatgpt_prompt") {
        normalized.push({ type: "chatgpt_prompt", question: a.question || "현재 상태에서 다음 단계를 action plan(JSON)으로 제안해줘." });
        continue;
      }
      if (a.type === "git_summary") {
        normalized.push({ type: "git_summary" });
      }
    }
    if (normalized.length === 0) return defaultRouteFor(mode, goal, seedInstruction);
    return { actions: normalized, reason: planned.reason };
  } catch {
    return defaultRouteFor(mode, goal, seedInstruction);
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
      () => runGeminiPrompt({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt, signal }),
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
  if (type === "disable_agent") return `disable_agent:${action.agent_id || "unknown"}`;
  if (type === "enable_agent") return `enable_agent:${action.agent_id || "unknown"}`;
  if (type === "disable_tool") return `disable_tool:${action.tool_id || "unknown"}`;
  if (type === "enable_tool") return `enable_tool:${action.tool_id || "unknown"}`;
  if (type === "list_agents") return "list_agents";
  if (type === "list_tools") return "list_tools";
  if (type === "open_context") return `open_context:${action.scope || "current"}`;
  if (type === "create_agent") return `create_agent:${action.agent?.id || "unknown"}`;
  if (type === "update_agent") return `update_agent:${action.agentId || "unknown"}`;
  return type;
}

function formatChatSummary(routePlan, results) {
  const lines = [
    "🧭 /chat summary",
    `reason=${String(routePlan?.reason || "(none)")}`,
    `actions=${Array.isArray(routePlan?.actions) ? routePlan.actions.length : 0}`,
  ];
  for (const row of results) {
    lines.push(`- ${row.label}: ${row.status}${row.note ? ` (${row.note})` : ""}`);
  }
  return lines.join("\n");
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
    }
    filtered.push({ ...action, agent: agentId || action.agent });
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
    if (!jobId) return workspace.root;
    try {
      return runDir(jobId);
    } catch {
      return workspace.root;
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
      () => runGeminiPrompt({ workspaceRoot: workspace.root, cwd, prompt }),
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

function buildAgentProfileFromProposal(action) {
  const id = String(action?.agent_id || "").trim().toLowerCase();
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

async function loadSupervisorRuntime(jobId) {
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
      jobConfig: fallbackNormalized.configNormalized,
      jobConfigNodeId: "",
      agentsCatalog: reg.agents,
      toolsCatalog: [],
      enabledAgentIds: fallbackNormalized.enabledAgentIds,
      enabledToolIds: fallbackNormalized.enabledToolIds,
      agentSelection: summarizeSelectionState({ catalog: reg.agents, enabled: fallbackAgents }),
      toolSelection: summarizeSelectionState({ catalog: [], enabled: [] }),
      agents: fallbackAgents,
      tools: [],
      contextSummary: loadLocalContextDocs(jobId, TRACK_DOC_NAMES, 2200),
      globalSummary: "",
    };
  }

  const client = requireGocClient();
  const map = await ensureJobThread(client, {
    jobId,
    jobDir: runDir(jobId),
    title: `job:${jobId}`,
  });
  const agentsSlot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const toolsSlot = await ensureToolsThread(client, { baseDir: jobs.baseDir });

  const jobResources = await listActiveResourcesByKind(client, {
    threadId: map.threadId,
    ctxId: map.ctxSharedId,
    resourceKind: "job_config",
  });
  const latestJobNode = jobResources[jobResources.length - 1] || null;
  const rawJobConfig = latestJobNode ? parseStructuredFromResource(latestJobNode, "job_config") : null;

  const toolRows = await listActiveResourcesByKind(client, {
    threadId: toolsSlot.threadId,
    ctxId: toolsSlot.ctxId,
    resourceKind: "tool_spec",
  });
  const toolsCatalog = toolRows
    .map((resource) => normalizeToolSpec(parseStructuredFromResource(resource, "tool_spec")))
    .filter(Boolean);

  const normalized = normalizeSupervisorJobConfig(
    rawJobConfig || { job_id: String(jobId || "").trim() },
    { agentsCatalog: reg.agents, toolsCatalog }
  );
  const enabledAgentSet = new Set(
    (Array.isArray(normalized.enabledAgentIds) ? normalized.enabledAgentIds : [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const enabledToolSet = new Set(
    (Array.isArray(normalized.enabledToolIds) ? normalized.enabledToolIds : [])
      .map((id) => String(id || "").trim().toLowerCase())
      .filter(Boolean)
  );
  const enabledAgents = (Array.isArray(reg.agents) ? reg.agents : [])
    .filter((agent) => enabledAgentSet.has(String(agent?.id || "").trim().toLowerCase()));
  const enabledTools = toolsCatalog
    .filter((tool) => enabledToolSet.has(String(tool?.id || "").trim().toLowerCase()));

  let contextSummary = "";
  try {
    contextSummary = await client.getCompiledContext(map.ctxSharedId);
  } catch {
    contextSummary = loadLocalContextDocs(jobId, TRACK_DOC_NAMES, 2200);
  }

  let globalSummary = "";
  try {
    const globalSlot = await ensureGlobalThread(client, { baseDir: jobs.baseDir, title: "global:shared" });
    globalSummary = await client.getCompiledContext(globalSlot.ctxId);
  } catch {
    globalSummary = "";
  }

  return {
    mode: "goc",
    map,
    agentsSlot,
    toolsSlot,
    jobConfig: normalized.configNormalized,
    jobConfigNodeId: String(latestJobNode?.id || "").trim(),
    agentsCatalog: reg.agents,
    toolsCatalog,
    enabledAgentIds: normalized.enabledAgentIds,
    enabledToolIds: normalized.enabledToolIds,
    agentSelection: summarizeSelectionState({ catalog: reg.agents, enabled: enabledAgents }),
    toolSelection: summarizeSelectionState({ catalog: toolsCatalog, enabled: enabledTools }),
    agents: enabledAgents,
    tools: enabledTools,
    contextSummary: contextSummary || "",
    globalSummary: globalSummary || "",
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

async function openAgentsUiInfo() {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error("open_agents_ui requires MEMORY_MODE=goc");
  }
  const client = requireGocClient();
  const minted = await client.mintUiToken(GOC_UI_TOKEN_TTL_SEC);
  const slot = await ensureAgentsThread(client, { baseDir: jobs.baseDir });
  const link = buildGocUiLink({
    threadId: slot.threadId,
    ctxId: slot.ctxId,
    token: minted.token,
  });
  return {
    threadId: slot.threadId,
    ctxId: slot.ctxId,
    link,
    tokenExp: minted.exp || null,
    lines: [
      "agents context",
      `thread=${slot.threadId}`,
      `ctx=${slot.ctxId}`,
      minted.exp ? `token_exp=${minted.exp}` : "",
      link,
    ].filter(Boolean),
  };
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

  if (jobId) {
    tracking.append(jobId, "decisions.md", [
      "## /chat propose_agent",
      `- agent_id: ${profile.id}`,
      `- draft_node: ${created?.id || "unknown"}`,
      `- proposed_by: telegram:${userId}`,
    ].join("\n"));
  }

  await bot.sendMessage(
    chatId,
    `🧪 agent draft 생성됨\nagent_id=${profile.id}\ndraft_node=${created?.id || "unknown"}\n승인 후 participants에 반영됩니다.`,
    {
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `approve_agent:${profile.id}` },
          { text: "❌ Reject", callback_data: `reject_agent:${profile.id}` },
          { text: "🧭 Agents UI", callback_data: "open_agents_ui" },
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
  const resources = await listActiveResourcesByKind(client, {
    threadId: slot.threadId,
    ctxId: slot.ctxId,
    resourceKind: "agent_profile_draft",
  });

  for (let i = resources.length - 1; i >= 0; i -= 1) {
    const row = resources[i];
    const payload = row?.payload && typeof row.payload === "object" ? row.payload : {};
    const draft = parseStructuredFromResource(row, "agent_profile_draft") || parseStructuredFromResource(row, "agent_profile");
    const id = String(
      payload.agent_id
      || draft?.id
      || ""
    ).trim().toLowerCase();
    if (id !== key) continue;
    return { slot, resource: row, payload, draft };
  }
  return null;
}

async function appendParticipantToJobConfig(client, { jobId, agentId, actor = "" }) {
  const map = await ensureJobThread(client, {
    jobId,
    jobDir: runDir(jobId),
    title: `job:${jobId}`,
  });

  const resources = await listActiveResourcesByKind(client, {
    threadId: map.threadId,
    ctxId: map.ctxSharedId,
    resourceKind: "job_config",
  });
  const latest = resources[resources.length - 1] || null;
  const currentRaw = latest ? parseStructuredFromResource(latest, "job_config") : {};
  const normalizedCurrent = normalizeSupervisorJobConfig(
    currentRaw || { job_id: String(jobId || "").trim() },
    { agentsCatalog: [{ id: String(agentId || "").trim().toLowerCase() }], toolsCatalog: [] }
  );
  const current = normalizedCurrent.configNormalized;
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
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  const participants = Array.from(new Set([
    ...(Array.isArray(current.participants) ? current.participants : []),
    cleanAgentId,
  ].filter(Boolean)));
  const currentAgentSet = current.agent_set && typeof current.agent_set === "object"
    ? current.agent_set
    : { mode: "all_enabled", selected: [], disabled: [] };
  const nextAgentSet = {
    mode: String(currentAgentSet.mode || "").trim().toLowerCase() === "selected" ? "selected" : "all_enabled",
    selected: uniq(currentAgentSet.selected),
    disabled: uniq((Array.isArray(currentAgentSet.disabled) ? currentAgentSet.disabled : []).filter((id) => id !== cleanAgentId)),
  };
  if (nextAgentSet.mode === "selected" && cleanAgentId) {
    nextAgentSet.selected = uniq([...nextAgentSet.selected, cleanAgentId]);
  }
  const nextConfig = {
    ...current,
    version: Math.max(2, Number(current.version || 2) || 2),
    schema_version: Math.max(2, Number(current.schema_version || current.schemaVersion || 2) || 2),
    participants,
    agent_set: nextAgentSet,
    updated_at: new Date().toISOString(),
  };

  const created = await client.createResource(map.threadId, {
    name: `job_config@${new Date().toISOString()}`,
    summary: `job_config update (${agentId})`,
    text_mode: "plain",
    raw_text: `${JSON.stringify(nextConfig, null, 2)}\n`,
    resource_kind: "job_config",
    uri: `ddalggak://jobs/${jobId}/job_config`,
    context_set_id: map.ctxSharedId,
    auto_activate: true,
    attach_to: latest?.id || undefined,
    payload_json: {
      op: "approve_agent",
      job_id: jobId,
      agent_id: agentId,
      approved_by: actor || undefined,
      ts: new Date().toISOString(),
      job_config: nextConfig,
    },
  });
  if (latest?.id && created?.id && latest.id !== created.id) {
    try {
      await client.createEdge(map.threadId, latest.id, created.id, "NEXT_PART");
    } catch {}
  }
  return { map, created, config: nextConfig };
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
  const resources = await listActiveResourcesByKind(client, {
    threadId: map.threadId,
    ctxId: map.ctxSharedId,
    resourceKind: "job_config",
  });
  const latest = resources[resources.length - 1] || null;
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
      auto_activate: true,
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
}) {
  return {
    runAgent: async ({ action, detailContext }) => {
      const detail = String(detailContext || "").trim();
      const promptSegments = [
        String(action.goal || "").trim(),
        runtime.contextSummary ? `[JOB COMPILED CONTEXT]\n${clip(runtime.contextSummary, 9000)}` : "",
        detail ? `[DETAIL CONTEXT]\n${detail}` : "",
        runtime.globalSummary ? `[GLOBAL MEMORY]\n${clip(runtime.globalSummary, 5000)}` : "",
      ].filter(Boolean);
      const finalPrompt = promptSegments.join("\n\n");
      return await enqueue(
        () => executeAgentRun(
          bot,
          chatId,
          jobId,
          { type: "agent_run", agent: String(action.agent_id || "").trim().toLowerCase(), prompt: finalPrompt },
          { signal: controller.signal, notify: verbose }
        ),
        { jobId, signal: controller.signal, label: `chat_v2_run_${String(action.agent_id || "agent")}` }
      );
    },
    proposeAgent: async ({ action }) => {
      return await createAgentDraftProposal(bot, chatId, userId, jobId, action);
    },
    openContext: async ({ action }) => {
      const target = action.scope === "global" ? "global" : jobId;
      const info = await buildContextInfo(target, { chatId });
      return {
        scope: info.scope,
        link: info.link,
        text: info.lines.join("\n"),
      };
    },
    needMoreDetail: async ({ action }) => {
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
    summarize: async ({ results }) => {
      const okCount = results.filter((row) => row.status === "ok").length;
      const errorCount = results.filter((row) => row.status === "error").length;
      return { text: `실행 완료: ok=${okCount}, error=${errorCount}` };
    },
    searchPublicAgents: async ({ action }) => {
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
    installAgentBlueprint: async ({ action }) => {
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
    publishAgent: async ({ action }) => {
      if (memoryModeWithFallback() !== "goc") {
        throw new Error("publish_agent requires MEMORY_MODE=goc");
      }
      if (!runtime.agentsSlot?.threadId || !runtime.agentsSlot?.ctxId) {
        throw new Error("agents thread/context is not ready");
      }
      const client = requireGocClient();
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
    listAgents: async ({ action }) => {
      const enabled = normalizeCatalogIds(runtime.agentSelection?.enabled_ids || runtime.agents || []);
      const disabled = action?.include_disabled === false
        ? []
        : normalizeCatalogIds(runtime.agentSelection?.disabled_ids || []);
      const lines = ["현재 job agent 상태"];
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
    listTools: async ({ action }) => {
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
    updateJobConfigSelection: async ({ op, kind, id }) => {
      if (memoryModeWithFallback() !== "goc") {
        throw new Error("selection update requires MEMORY_MODE=goc");
      }
      const updated = await updateJobConfigSelection(requireGocClient(), {
        jobId,
        op,
        kind,
        id,
        actor: `telegram:${userId}`,
        agentsCatalog: runtime.agentsCatalog || runtime.agents || [],
        toolsCatalog: runtime.toolsCatalog || runtime.tools || [],
      });
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
      return {
        ...updated,
        enabled_agent_ids: runtime.enabledAgentIds,
        enabled_tool_ids: runtime.enabledToolIds,
      };
    },
  };
}

async function runSupervisorChat(bot, chatId, userId, message, { debug = false } = {}) {
  const chatKey = String(chatId);
  const verbose = !!(debug || CHAT_VERBOSE);
  let currentJobId = resolveCurrentJobIdForChat(chatId);
  if (!currentJobId) {
    const job = await createJob(message, { ownerUserId: userId, ownerChatId: chatId });
    currentJobId = String(job.jobId);
  } else {
    runDir(currentJobId);
  }
  tracking.init(currentJobId);
  rememberLastChatJob(chatId, currentJobId);
  chatSessionStore.upsert(chatId, {
    jobId: currentJobId,
    state: "routing",
    pending_approval: null,
  });

  const controller = resetJobAbortController(currentJobId);
  activeJobByChat.set(chatKey, currentJobId);

  try {
    const runtime = await loadSupervisorRuntime(currentJobId);
    const routePlan = await routeWithSupervisor(message, {
      agents: runtime.agents,
      tools: runtime.tools,
      jobConfig: runtime.jobConfig,
      currentJobId,
      currentContextSetId: runtime.map?.ctxSharedId || "",
      workspaceRoot: workspace.root,
      cwd: runDir(currentJobId),
      signal: controller.signal,
      locale: "ko-KR",
      routerPolicy: memory.getRouterPrompt(),
      contextSummary: runtime.contextSummary,
    });

    chatSessionStore.upsert(chatId, {
      state: "executing",
      last_route: {
        reason: routePlan.reason,
        actions: Array.isArray(routePlan.actions) ? routePlan.actions : [],
        final_response_style: routePlan.final_response_style || runtime.jobConfig?.final_response_style || "concise",
      },
    });

    if (verbose) {
      await bot.sendMessage(chatId, [
        "🧭 /chat(supervisor) route",
        `reason=${routePlan.reason || "(none)"}`,
        ...(Array.isArray(routePlan.actions) ? routePlan.actions.map((row) => `- ${chatActionLabel(row)}`) : []),
      ].join("\n"));
    }

    const execution = await executeSupervisorActions({
      chatId,
      userId,
      jobId: currentJobId,
      plan: routePlan,
      jobConfig: runtime.jobConfig,
      agents: runtime.agents,
      tools: runtime.tools,
      sessionStore: chatSessionStore,
      callbacks: buildSupervisorExecutionCallbacks({
        bot,
        chatId,
        userId,
        jobId: currentJobId,
        runtime,
        controller,
        verbose,
      }),
    });

    tracking.append(currentJobId, "decisions.md", [
      "## /chat supervisor routing",
      `- message: ${clip(message, 260)}`,
      `- reason: ${routePlan.reason || "(none)"}`,
      `- actions: ${(Array.isArray(routePlan.actions) ? routePlan.actions : []).map((row) => chatActionLabel(row)).join(" -> ") || "(none)"}`,
      `- mode: ${runtime.mode}`,
      `- pending_approval: ${execution.pendingApproval ? execution.pendingApproval.reason : "none"}`,
    ].join("\n"));

    if (execution.pendingApproval) {
      chatSessionStore.upsert(chatId, {
        jobId: currentJobId,
        state: "awaiting_approval",
        pending_approval: {
          ...execution.pendingApproval,
          blocked_index: Number.isFinite(Number(execution.blocked_index))
            ? Number(execution.blocked_index)
            : Number(execution.pendingApproval?.blocked_index ?? -1),
          remaining_actions: Array.isArray(execution.remaining_actions)
            ? execution.remaining_actions
            : (Array.isArray(execution.pendingApproval?.remaining_actions)
              ? execution.pendingApproval.remaining_actions
              : []),
        },
      });
      tracking.append(currentJobId, "decisions.md", [
        "## /chat approval required",
        `- reason: ${execution.pendingApproval.reason}`,
        `- action: ${chatActionLabel(execution.pendingApproval.action)}`,
      ].join("\n"));
    }

    const contextOutputs = (Array.isArray(execution.outputs) ? execution.outputs : [])
      .filter((row) => String(row?.mode || "") === "context_link")
      .map((row) => String(row?.output || "").trim())
      .filter(Boolean);
    const hasAgentOutput = (Array.isArray(execution.outputs) ? execution.outputs : [])
      .some((row) => String(row?.agentId || "").trim().toLowerCase() !== "system");
    const finalReply = (!hasAgentOutput && contextOutputs.length > 0)
      ? contextOutputs.join("\n\n")
      : await synthesizeChatReply(message, routePlan, execution);
    const replyText = execution.pendingApproval
      ? `${finalReply}\n\n⚠️ 승인 필요: ${execution.pendingApproval.reason}\n다음 명령으로 risk를 낮추거나 요청을 분할해 주세요.`
      : finalReply;

    if (verbose) {
      await sendLong(bot, chatId, formatChatSummary(routePlan, execution.results));
    }
    await sendLong(bot, chatId, replyText);
    if (execution.pendingApproval?.id) {
      await bot.sendMessage(
        chatId,
        `승인 대기 중입니다.\nreason=${execution.pendingApproval.reason}\naction=${chatActionLabel(execution.pendingApproval.action)}`,
        {
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `approve_action:${execution.pendingApproval.id}` },
              { text: "❌ Reject", callback_data: `reject_action:${execution.pendingApproval.id}` },
            ]],
          },
        }
      );
    }
    return { routePlan, execution, jobId: currentJobId };
  } finally {
    if (activeJobByChat.get(chatKey) === currentJobId) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(currentJobId);
    chatSessionStore.upsert(chatId, (session) => ({
      ...session,
      state: session.pending_approval ? "awaiting_approval" : "idle",
    }));
  }
}

async function executeChatActions(bot, chatId, userId, message, routePlan, { verbose = CHAT_VERBOSE } = {}) {
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
        await sendContextInfo(bot, chatId, target);
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
          if (verbose) await bot.sendMessage(chatId, `✅ /chat job created: ${targetJobId}\nrun_dir: ${runDir(targetJobId)}`);
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
              { signal: controller.signal, notify: verbose }
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

async function executeAgentRun(bot, chatId, jobId, act, { signal = null, notify = true } = {}) {
  await refreshAgentRegistry();
  const agentId = resolveAgentId(act.agent || "");
  const taskPrompt = String(act.prompt || "").trim();
  if (!agentId || !taskPrompt) throw new Error("invalid agent_run action");

  const agent = findAgentConfig(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}. Check agents registry: ${agentRegistry.path}`);

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
    });
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
}

async function executeRoutedPlan(bot, chatId, jobId, route, signal = null, opts = {}) {
  void opts;
  let askedChatGPT = false;
  const actions = Array.isArray(route?.actions) ? route.actions : [];

  for (const rawAct of actions) {
    const act = normalizeActionShape(rawAct);
    if (!act?.type) continue;

    if (act.type === "agent_run") {
      const agentInfo = findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      await bot.sendMessage(chatId, `🤖 ${act.agent} 실행 중… (${provider})`);
      const result = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, act, { signal }),
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

  return { askedChatGPT };
}

async function executeActions(bot, chatId, jobId, plan, signal = null, opts = {}) {
  void opts;
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
      const agentInfo = findAgentConfig(act.agent);
      const provider = String(agentInfo?.provider || "").trim().toLowerCase() || "unknown";
      await bot.sendMessage(chatId, `🤖 ${act.agent} 실행 중… (${provider})`);
      const r = await enqueue(
        () => executeAgentRun(bot, chatId, jobId, act, { signal }),
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

const botOptions = {
  polling: {
    autoStart: false,
    interval: Number.isFinite(TELEGRAM_POLLING_INTERVAL_MS) ? TELEGRAM_POLLING_INTERVAL_MS : 1000,
    params: { timeout: Number.isFinite(TELEGRAM_POLLING_TIMEOUT_SEC) ? TELEGRAM_POLLING_TIMEOUT_SEC : 15 },
  },
};
if (TELEGRAM_FORCE_IPV4) botOptions.request = { family: 4 };
const bot = new TelegramBot(TOKEN, botOptions);

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

bot.on("callback_query", async (q) => {
  try {
    const msg = q.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const userId = q.from?.id;
    if (!isAllowedChat(chatId) || !isAllowedUser(userId)) return;

    const data = String(q.data || "").trim();
    if (data.startsWith("approve_action:") || data.startsWith("reject_action:")) {
      const isApprove = data.startsWith("approve_action:");
      const approvalId = String(data.split(":")[1] || "").trim();
      const session = chatSessionStore.get(chatId);
      const pending = session?.pending_approval && typeof session.pending_approval === "object"
        ? session.pending_approval
        : null;

      if (!pending?.id) {
        await bot.answerCallbackQuery(q.id, { text: "pending approval 없음" });
        await bot.sendMessage(chatId, "현재 승인 대기 중인 액션이 없습니다.");
        return;
      }
      if (String(pending.id) !== approvalId) {
        await bot.answerCallbackQuery(q.id, { text: "approval id 불일치" });
        await bot.sendMessage(chatId, "승인 토큰이 현재 대기 상태와 일치하지 않습니다.");
        return;
      }

      const pendingJobId = String(pending.job_id || session.jobId || resolveCurrentJobIdForChat(chatId) || "").trim();
      if (!pendingJobId) {
        chatSessionStore.upsert(chatId, { state: "idle", pending_approval: null });
        await bot.answerCallbackQuery(q.id, { text: "job 없음" });
        await bot.sendMessage(chatId, "승인 재개 대상 jobId를 찾지 못해 pending 상태를 정리했습니다.");
        return;
      }

      if (!isApprove) {
        chatSessionStore.upsert(chatId, {
          jobId: pendingJobId,
          state: "idle",
          pending_approval: null,
        });
        tracking.append(pendingJobId, "decisions.md", [
          "## /chat approval rejected",
          `- approval_id: ${approvalId}`,
          `- action: ${chatActionLabel(pending.action)}`,
          `- rejected_by: telegram:${userId}`,
        ].join("\n"));
        await bot.answerCallbackQuery(q.id, { text: "rejected" });
        await bot.sendMessage(chatId, "승인 거절됨. 대기 중이던 액션은 취소되었습니다.");
        return;
      }

      await bot.answerCallbackQuery(q.id, { text: "approved" });
      const remainingActions = Array.isArray(pending.remaining_actions) && pending.remaining_actions.length > 0
        ? pending.remaining_actions
        : (pending.action ? [pending.action] : []);
      if (remainingActions.length === 0) {
        chatSessionStore.upsert(chatId, {
          jobId: pendingJobId,
          state: "idle",
          pending_approval: null,
        });
        await bot.sendMessage(chatId, "재개할 남은 action이 없어 승인 대기를 해제했습니다.");
        return;
      }

      const resumedActions = remainingActions.map((action, index) => {
        if (index !== 0) return action;
        return { ...action, approved: true, _approved: true };
      });
      const runtime = await loadSupervisorRuntime(pendingJobId);
      const controller = resetJobAbortController(pendingJobId);
      const chatKey = String(chatId);
      activeJobByChat.set(chatKey, pendingJobId);
      rememberLastChatJob(chatId, pendingJobId);
      chatSessionStore.upsert(chatId, {
        jobId: pendingJobId,
        state: "executing",
        pending_approval: null,
      });

      try {
        const resumePlan = {
          reason: `resume_after_approval:${approvalId}`,
          actions: resumedActions,
          final_response_style: runtime.jobConfig?.final_response_style || "concise",
        };
        const resumedExecution = await executeSupervisorActions({
          chatId,
          userId,
          jobId: pendingJobId,
          plan: resumePlan,
          jobConfig: runtime.jobConfig,
          agents: runtime.agents,
          tools: runtime.tools,
          sessionStore: chatSessionStore,
          callbacks: buildSupervisorExecutionCallbacks({
            bot,
            chatId,
            userId,
            jobId: pendingJobId,
            runtime,
            controller,
            verbose: CHAT_VERBOSE,
          }),
        });

        const prevDone = pending.already_done && typeof pending.already_done === "object"
          ? pending.already_done
          : {};
        const mergedExecution = {
          ...resumedExecution,
          currentJobId: pendingJobId,
          results: [
            ...(Array.isArray(prevDone.results) ? prevDone.results : []),
            ...(Array.isArray(resumedExecution.results) ? resumedExecution.results : []),
          ],
          outputs: [
            ...(Array.isArray(prevDone.outputs) ? prevDone.outputs : []),
            ...(Array.isArray(resumedExecution.outputs) ? resumedExecution.outputs : []),
          ],
        };
        const summaryPlan = session.last_route && typeof session.last_route === "object"
          ? session.last_route
          : resumePlan;
        const finalReply = await synthesizeChatReply("승인된 액션 재개", summaryPlan, mergedExecution);
        const replyText = resumedExecution.pendingApproval
          ? `${finalReply}\n\n⚠️ 추가 승인 필요: ${resumedExecution.pendingApproval.reason}`
          : finalReply;
        await sendLong(bot, chatId, replyText);

        tracking.append(pendingJobId, "decisions.md", [
          "## /chat approval resumed",
          `- approval_id: ${approvalId}`,
          `- resumed_actions: ${resumedActions.map((row) => chatActionLabel(row)).join(" -> ")}`,
          `- pending_after_resume: ${resumedExecution.pendingApproval ? "yes" : "no"}`,
          `- approved_by: telegram:${userId}`,
        ].join("\n"));

        if (resumedExecution.pendingApproval?.id) {
          chatSessionStore.upsert(chatId, {
            jobId: pendingJobId,
            state: "awaiting_approval",
            pending_approval: {
              ...resumedExecution.pendingApproval,
              blocked_index: Number.isFinite(Number(resumedExecution.blocked_index))
                ? Number(resumedExecution.blocked_index)
                : Number(resumedExecution.pendingApproval?.blocked_index ?? -1),
              remaining_actions: Array.isArray(resumedExecution.remaining_actions)
                ? resumedExecution.remaining_actions
                : (Array.isArray(resumedExecution.pendingApproval?.remaining_actions)
                  ? resumedExecution.pendingApproval.remaining_actions
                  : []),
            },
          });
          await bot.sendMessage(
            chatId,
            `추가 승인 대기 중입니다.\nreason=${resumedExecution.pendingApproval.reason}\naction=${chatActionLabel(resumedExecution.pendingApproval.action)}`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: "✅ Approve", callback_data: `approve_action:${resumedExecution.pendingApproval.id}` },
                  { text: "❌ Reject", callback_data: `reject_action:${resumedExecution.pendingApproval.id}` },
                ]],
              },
            }
          );
        } else {
          chatSessionStore.upsert(chatId, {
            jobId: pendingJobId,
            state: "idle",
            pending_approval: null,
          });
        }
      } finally {
        if (activeJobByChat.get(chatKey) === pendingJobId) activeJobByChat.delete(chatKey);
        jobAbortControllers.delete(pendingJobId);
      }
      return;
    }

    if (data === "open_agents_ui") {
      try {
        const info = await openAgentsUiInfo();
        await bot.answerCallbackQuery(q.id, { text: "agents ui" });
        await sendLong(bot, chatId, info.lines.join("\n"));
      } catch (e) {
        await bot.answerCallbackQuery(q.id, { text: "failed" });
        await bot.sendMessage(chatId, `❌ agents ui 열기 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (data.startsWith("approve_agent:") || data.startsWith("reject_agent:")) {
      const isApprove = data.startsWith("approve_agent:");
      const agentId = String(data.split(":")[1] || "").trim().toLowerCase();
      if (!agentId) {
        await bot.answerCallbackQuery(q.id, { text: "agent_id 누락" });
        return;
      }
      if (memoryModeWithFallback() !== "goc") {
        await bot.answerCallbackQuery(q.id, { text: "MEMORY_MODE=goc 필요" });
        await bot.sendMessage(chatId, "❌ agent draft 승인/거절은 MEMORY_MODE=goc에서만 동작합니다.");
        return;
      }

      const client = requireGocClient();
      const found = await findLatestDraftByAgentId(client, agentId);
      if (!found?.resource) {
        await bot.answerCallbackQuery(q.id, { text: "draft 없음" });
        await bot.sendMessage(chatId, `draft를 찾지 못했습니다. agent_id=${agentId}`);
        return;
      }

      const draftProfile = buildAgentProfileFromProposal(found.draft || { agent_id: agentId })
        || {
          id: agentId,
          name: agentId,
          description: "",
          provider: "gemini",
          model: "gemini",
          prompt: "",
          meta: {},
        };
      const draftJobId = String(found.payload?.job_id || resolveCurrentJobIdForChat(chatId) || "").trim();

      if (isApprove) {
        const created = await createAgentProfile(client, {
          baseDir: jobs.baseDir,
          profile: draftProfile,
          format: "json",
          actor: `telegram:${userId}`,
        });
        try {
          await client.deactivateNodes(found.slot.ctxId, [found.resource.id]);
        } catch {}

        if (draftJobId) {
          try {
            await appendParticipantToJobConfig(client, {
              jobId: draftJobId,
              agentId,
              actor: `telegram:${userId}`,
            });
            tracking.append(draftJobId, "decisions.md", [
              "## /chat approve_agent",
              `- agent_id: ${agentId}`,
              `- draft_node: ${found.resource.id}`,
              `- activated_node: ${created?.created?.id || "unknown"}`,
              `- approved_by: telegram:${userId}`,
            ].join("\n"));
          } catch (e) {
            if (draftJobId) {
              tracking.append(draftJobId, "decisions.md", [
                "## /chat approve_agent (participant update failed)",
                `- agent_id: ${agentId}`,
                `- error: ${String(e?.message ?? e)}`,
              ].join("\n"));
            }
          }
        }

        await refreshAgentRegistry({ includeCompiled: true });
        await bot.answerCallbackQuery(q.id, { text: `approved ${agentId}` });
        await bot.sendMessage(chatId, [
          `✅ approve_agent 완료`,
          `agent_id=${agentId}`,
          `agent_profile_node=${created?.created?.id || "unknown"}`,
          draftJobId ? `job_id=${draftJobId} participants 반영` : "job_id 정보를 찾지 못해 participants 반영은 생략",
        ].join("\n"));
      } else {
        try {
          await client.deactivateNodes(found.slot.ctxId, [found.resource.id]);
        } catch {}
        if (draftJobId) {
          tracking.append(draftJobId, "decisions.md", [
            "## /chat reject_agent",
            `- agent_id: ${agentId}`,
            `- draft_node: ${found.resource.id}`,
            `- rejected_by: telegram:${userId}`,
          ].join("\n"));
        }
        await bot.answerCallbackQuery(q.id, { text: `rejected ${agentId}` });
        await bot.sendMessage(chatId, `🛑 reject_agent 완료\nagent_id=${agentId}\ndraft_node=${found.resource.id}`);
      }
      return;
    }

    if (data.startsWith("gptapply:")) {
      const targetJobId = String(data.slice("gptapply:".length) || "").trim() || resolveCurrentJobIdForChat(chatId);
      if (!targetJobId) {
        await bot.answerCallbackQuery(q.id, { text: "jobId를 찾지 못했습니다." });
        await bot.sendMessage(chatId, "붙여넣기 모드를 시작할 jobId를 찾지 못했어요.\nUsage: /gptapply [jobId]");
        return;
      }
      setAwait(chatId, targetJobId, userId);
      rememberLastChatJob(chatId, targetJobId);
      await bot.answerCallbackQuery(q.id, { text: `paste mode: ${targetJobId}` });
      await bot.sendMessage(chatId, "🟣 이제 답변을 그대로 붙여넣어 주세요. (20분 내)\nJSON 액션 플랜이 있으면 자동 실행됩니다.\n종료: /gptdone");
      return;
    }

    const [action, jobId, token] = data.split(":");
    if (!["approve", "deny"].includes(action) || !jobId || !token) return;
    const decision = action === "approve" ? "approve" : "deny";
    const rec = approvals.decide(jobId, token, decision, "via telegram button");
    await bot.answerCallbackQuery(q.id, { text: `OK: ${rec.status}` });
    await bot.sendMessage(chatId, `🔐 ${rec.status.toUpperCase()}: ${token}`);

    if (rec.status === "approved" && rec.payload?.action === "git_commit") {
      const msg2 = rec.payload.message ?? "commit";
      const add = await runCommand("git", ["add", "-A"], { cwd: workspace.root });
      const commit = await runCommand("git", ["commit", "-m", msg2], { cwd: workspace.root });
      tracking.append(jobId, "progress.md", `## git commit\n\n${FENCE}\n${add.stdout || add.stderr}\n${commit.stdout || commit.stderr}\n${FENCE}\n`);
      await sendLong(bot, chatId, `✅ 커밋 완료\n${clip(commit.stdout || commit.stderr, 3500)}`);
      await suggestNextPrompt(bot, chatId, jobId, "커밋 이후 다음 단계(테스트/PR/배포 등)를 결정해줘.", "commit");
    }
  } catch {}
});

bot.on("message", async (msg) => {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  if (!chatId || !userId) return;
  if (!isAllowedChat(chatId) || !isAllowedUser(userId)) return;

  const text = (msg.text || "").trim();
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
        await executeActions(bot, chatId, jobId, plan, controller.signal, {
          telegramUserId: st.userId || userId,
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

  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  if (cmd === "/help") {
    await bot.sendMessage(chatId, "Commands:\n- /whoami\n- /running\n- /stop [jobId]\n- /memory [show|md|policy|routing|role|agents|note|lesson|reset]\n- /settings ... (alias)\n- /agents\n- /chat [--debug] <message>|reset\n- /context <jobId|global>  (jobId 생략 시 현재 job)\n- /run <goal>\n- /continue <jobId>\n- /gptprompt <jobId> <question>\n- /gptapply [jobId]\n- /gptdone\n- /commit <jobId> <message>");
    return;
  }

  if (cmd === "/whoami") {
    await bot.sendMessage(chatId, `chat_id=${chatId}\nuser_id=${userId}`);
    return;
  }

  if (cmd === "/running") {
    await sendLong(bot, chatId, formatRunningJobs(chatId));
    return;
  }

  if (cmd === "/stop") {
    const chatKey = String(chatId);
    const fromAwait = getAwait(chatId)?.jobId;
    const targetJobId = args || activeJobByChat.get(chatKey) || fromAwait;
    if (!targetJobId) {
      if (lastChatJobByChat.has(chatKey)) {
        resetChatSession(chatId);
        await bot.sendMessage(chatId, "✅ 현재 /chat 세션을 초기화했어요.");
        return;
      }
      await bot.sendMessage(chatId, `중단할 jobId를 찾지 못했어요. Usage: /stop <jobId>\n\n${formatRunningJobs(chatId)}`);
      return;
    }

    const { aborted, dropped } = cancelJobExecution(targetJobId);
    if (activeJobByChat.get(chatKey) === String(targetJobId)) activeJobByChat.delete(chatKey);
    if (fromAwait && String(fromAwait) === String(targetJobId)) clearAwait(chatId);
    if (lastChatJobByChat.get(chatKey) === String(targetJobId)) lastChatJobByChat.delete(chatKey);

    if (!aborted && dropped === 0) {
      await bot.sendMessage(chatId, `중단할 실행이 없어요. (jobId=${targetJobId})\n이미 종료되었거나 큐에 없습니다.\n\n${formatRunningJobs(chatId)}`);
      return;
    }
    await bot.sendMessage(chatId, `⏹️ 중단 요청 완료\njobId=${targetJobId}\n실행중 중단=${aborted}\n큐 제거=${dropped}`);
    return;
  }

  if (cmd === "/memory" || cmd === "/settings") {
    const sub = String(rest[0] || "show").trim().toLowerCase();

    if (sub === "show") {
      await sendLong(bot, chatId, formatMemorySummary());
      return;
    }

    if (sub === "md") {
      await sendLong(bot, chatId, memory.readMarkdown());
      return;
    }

    if (sub === "reset") {
      memory.reset();
      await sendLong(bot, chatId, `✅ 메모리를 기본값으로 되돌렸습니다.\n\n${formatMemorySummary()}`);
      return;
    }

    if (sub === "policy") {
      const value = rest.slice(1).join(" ").trim();
      if (!value) return bot.sendMessage(chatId, "Usage: /memory policy <자연어 프롬프트>");
      try {
        memory.setPolicyPrompt(value);
        await sendLong(bot, chatId, `✅ reflection prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (sub === "routing") {
      const value = rest.slice(1).join(" ").trim();
      if (!value) return bot.sendMessage(chatId, "Usage: /memory routing <자연어 프롬프트>");
      try {
        memory.setRouterPrompt(value);
        await sendLong(bot, chatId, `✅ router prompt 업데이트 완료.\n\n${formatMemorySummary()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 업데이트 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (sub === "role") {
      const agent = String(rest[1] || "").trim().toLowerCase();
      const value = rest.slice(2).join(" ").trim();
      if (!agent || !value) return bot.sendMessage(chatId, "Usage: /memory role <gemini|codex|chatgpt> <자연어 역할>");
      try {
        memory.setAgentRole(agent, value);
        await sendLong(bot, chatId, `✅ ${agent} role 업데이트 완료.\n\n${formatAgentMemorySummary()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ role 업데이트 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (sub === "agents") {
      await sendLong(bot, chatId, formatAgentMemorySummary());
      return;
    }

    if (sub === "note") {
      const value = rest.slice(1).join(" ").trim();
      if (!value) return bot.sendMessage(chatId, "Usage: /memory note <메모>");
      try {
        memory.addOperatorNote(value);
        await sendLong(bot, chatId, `✅ operator note 추가 완료.\n\n${formatMemorySummary()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 메모 추가 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    if (sub === "lesson") {
      const value = rest.slice(1).join(" ").trim();
      if (!value) return bot.sendMessage(chatId, "Usage: /memory lesson <교훈>");
      try {
        memory.addRecentLesson(value);
        await sendLong(bot, chatId, `✅ recent lesson 추가 완료.\n\n${formatMemorySummary()}`);
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 교훈 추가 실패: ${String(e?.message ?? e)}`);
      }
      return;
    }

    await bot.sendMessage(chatId, "Usage:\n/memory show\n/memory md\n/memory policy <자연어 프롬프트>\n/memory routing <자연어 프롬프트>\n/memory role <gemini|codex|chatgpt> <자연어 역할>\n/memory agents\n/memory note <메모>\n/memory lesson <교훈>\n/memory reset");
    return;
  }

  if (cmd === "/gptdone") {
    clearAwait(chatId);
    await bot.sendMessage(chatId, "✅ gpt paste 모드를 종료했어요.");
    return;
  }

  if (cmd === "/agents") {
    const reg = await refreshAgentRegistry();
    const lines = [
      `memory_mode=${MEMORY_MODE}`,
      `effective_mode=${memoryModeWithFallback()}`,
      `registry=${reg.path}`,
      "",
      ...reg.agents.map((row) => `- ${row.id}: provider=${row.provider}, model=${row.model}${row.description ? `, ${row.description}` : ""}`),
    ];
    await sendLong(bot, chatId, lines.join("\n"));
    return;
  }

  if (cmd === "/context") {
    try {
      const arg = String(rest[0] || "").trim();
      await sendContextInfo(bot, chatId, arg);
    } catch (e) {
      await bot.sendMessage(chatId, `❌ /context 실패: ${String(e?.message ?? e)}`);
    }
    return;
  }

  if (cmd === "/chat") {
    const raw = String(args || "").trim();
    if (!raw) return bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");
    if (raw.toLowerCase() === "reset") {
      resetChatSession(chatId);
      await bot.sendMessage(chatId, "✅ /chat 세션을 초기화했습니다.");
      return;
    }
    const parsed = parseChatMessageWithFlags(raw);
    const message = parsed.message;
    if (!message) return bot.sendMessage(chatId, "Usage: /chat [--debug] <message>\n세션 초기화: /chat reset");

    try {
      await runSupervisorChat(bot, chatId, userId, message, {
        debug: parsed.debug,
      });
    } catch (e) {
      await bot.sendMessage(chatId, `❌ /chat 실패: ${String(e?.message ?? e)}`);
    }
    return;
  }

  if (cmd === "/run") {
    if (!args) return bot.sendMessage(chatId, "Usage: /run <goal>");
    const goal = args;
    await bot.sendMessage(chatId, "🚀 시작합니다…");
    try {
      const job = await createJob(goal, { ownerUserId: userId, ownerChatId: chatId });
      const jobId = String(job.jobId);
      const controller = resetJobAbortController(jobId);
      const chatKey = String(chatId);
      activeJobByChat.set(chatKey, jobId);
      await bot.sendMessage(chatId, `✅ Job created: ${job.jobId}\ngoal: ${goal}\nrun_dir: ${runDir(jobId)}\n복잡하면: /gptprompt ${job.jobId} <질문>`);

      try {
        const route = await decideRunRoute(jobId, {
          mode: "run",
          goal,
          seedInstruction: goal,
          signal: controller.signal,
        });
        tracking.append(jobId, "decisions.md", [
          "## Multi-Agent routing",
          `- mode: run`,
          `- reason: ${route.reason}`,
          `- actions: ${route.actions.map((a) => actionLabel(a)).join(" -> ")}`,
        ].join("\n"));
        await bot.sendMessage(chatId, `🧭 Multi-Agent 라우팅\n${route.actions.map((a) => `- ${actionLabel(a)}`).join("\n")}`);

        const routed = await executeRoutedPlan(bot, chatId, jobId, route, controller.signal, {
          telegramUserId: userId,
        });
        if (!routed.askedChatGPT) {
          await suggestNextPrompt(bot, chatId, jobId, "현재 상태에서 다음 단계를 action plan(JSON)으로 제안해줘.", "run", controller.signal);
        }
      } finally {
        if (activeJobByChat.get(chatKey) === jobId) activeJobByChat.delete(chatKey);
        jobAbortControllers.delete(jobId);
      }
    } catch (e) {
      if (isCancelledError(e)) {
        await bot.sendMessage(chatId, "⏹️ 작업이 중단되었습니다.");
      } else {
        await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
      }
    }
    return;
  }

  if (cmd === "/continue") {
    if (!args) return bot.sendMessage(chatId, "Usage: /continue <jobId>");
    const jobId = args;
    const jobKey = String(jobId);
    const controller = resetJobAbortController(jobKey);
    const chatKey = String(chatId);
    activeJobByChat.set(chatKey, jobKey);
    await bot.sendMessage(chatId, `▶️ Continue job ${jobId}\nrun_dir: ${runDir(jobKey)}`);

    let instruction = "run/shared의 plan.md와 research.md를 반영해 CODEX_WORKSPACE_ROOT 코드 변경을 진행해라.";
    try {
      const planText = tracking.read(jobId, "plan.md");
      const extracted = extractCodexInstruction(planText);
      if (extracted) instruction = extracted;
    } catch {}

    try {
      const goal = getGoalFromResearch(jobKey);
      const route = await decideRunRoute(jobKey, {
        mode: "continue",
        goal,
        seedInstruction: instruction,
        signal: controller.signal,
      });
      tracking.append(jobKey, "decisions.md", [
        "## Multi-Agent routing",
        `- mode: continue`,
        `- reason: ${route.reason}`,
        `- actions: ${route.actions.map((a) => actionLabel(a)).join(" -> ")}`,
      ].join("\n"));
      await bot.sendMessage(chatId, `🧭 Multi-Agent 라우팅\n${route.actions.map((a) => `- ${actionLabel(a)}`).join("\n")}`);

      const routed = await executeRoutedPlan(bot, chatId, jobKey, route, controller.signal, {
        telegramUserId: userId,
      });
      if (!routed.askedChatGPT) {
        await suggestNextPrompt(bot, chatId, jobKey, "현재 변경 결과를 바탕으로 다음 action plan(JSON)을 제안해줘.", "continue", controller.signal);
      }
    } catch (e) {
      if (isCancelledError(e)) {
        await bot.sendMessage(chatId, `⏹️ 작업이 중단되었습니다. (jobId=${jobKey})`);
      } else {
        await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
      }
    } finally {
      if (activeJobByChat.get(chatKey) === jobKey) activeJobByChat.delete(chatKey);
      jobAbortControllers.delete(jobKey);
    }
    return;
  }

  if (cmd === "/gptprompt") {
    const parts = rest;
    const jobId = parts[0];
    const question = parts.slice(1).join(" ").trim();
    if (!jobId || !question) return bot.sendMessage(chatId, "Usage: /gptprompt <jobId> <question>");

    jobs.appendConversation(jobId, "user", `/gptprompt ${question}`, { kind: "gptprompt" });
    await sendChatGPTPrompt(bot, chatId, jobId, question);
    return;
  }

  if (cmd === "/gptapply") {
    const targetJobId = String(args || resolveCurrentJobIdForChat(chatId) || "").trim();
    if (!targetJobId) return bot.sendMessage(chatId, "Usage: /gptapply [jobId]");
    setAwait(chatId, targetJobId, userId);
    rememberLastChatJob(chatId, targetJobId);
    await bot.sendMessage(chatId, "🟣 이제 ChatGPT 답변을 그대로 붙여넣어 주세요. (20분 내)\nJSON 액션 플랜이 있으면 자동 실행됩니다.\n종료: /gptdone");
    return;
  }

  if (cmd === "/commit") {
    const parts = rest;
    const jobId = parts[0];
    const message = parts.slice(1).join(" ").trim();
    if (!jobId || !message) return bot.sendMessage(chatId, "Usage: /commit <jobId> <message>");
    const rec = approvals.request(jobId, { purpose: "git commit", summary: `Commit changes with message: ${message}`, payload: { action: "git_commit", message } });

    await bot.sendMessage(chatId,
      `🟡 커밋 승인 필요\njobId=${jobId}\nmessage=${message}\ntoken=${rec.token}`,
      { reply_markup: { inline_keyboard: [[{ text: "✅ Approve", callback_data: `approve:${jobId}:${rec.token}` }, { text: "❌ Deny", callback_data: `deny:${jobId}:${rec.token}` }]] } }
    );
    return;
  }

  if (cmd.startsWith("/")) {
    await bot.sendMessage(chatId, "알 수 없는 명령입니다. /help 를 참고하세요.");
  }
});

process.on("SIGINT", () => { void shutdown(0); });
process.on("SIGTERM", () => { void shutdown(0); });

console.log("Telegram orchestrator v2.1 started (polling).");
console.log(`Codex workspace root: ${workspace.root}`);
console.log(`Runs dir: ${jobs.runsDir}`);
console.log(`Memory mode: ${MEMORY_MODE} (effective=${memoryModeWithFallback()})`);
if (gocInitError) console.log(`GoC init error: ${gocInitError}`);
console.log(`Agents registry: ${agentRegistry.path}`);
await bot.startPolling({ restart: true });
