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
const TELEGRAM_FORCE_IPV4 = String(process.env.TELEGRAM_FORCE_IPV4 ?? "true").toLowerCase() !== "false";
const TELEGRAM_POLLING_INTERVAL_MS = Number(process.env.TELEGRAM_POLLING_INTERVAL_MS ?? 1000);
const TELEGRAM_POLLING_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLLING_TIMEOUT_SEC ?? 15);
const TELEGRAM_SINGLE_INSTANCE_LOCK = String(process.env.TELEGRAM_SINGLE_INSTANCE_LOCK ?? "true").toLowerCase() !== "false";
const LOCK_FILE = process.env.TELEGRAM_LOCK_FILE || path.join(workspace.root, ".orchestrator", "telegram_runner.lock");

const memory = new OrchestratorMemory({ baseDir: jobs.baseDir });

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

function runDir(jobId) {
  return jobs.jobDir(jobId);
}

function runSharedDir(jobId) {
  return path.join(runDir(jobId), "shared");
}

function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
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

function formatMemorySummary() {
  const s = memory.getSummary();
  return [
    "🧠 현재 메모리 기반 설정",
    `memory.file=${s.filePath}`,
    "",
    "Auto-Suggest Reflection Prompt (preview):",
    s.policyPreview || "(empty)",
    "",
    `operator_notes=${s.noteCount}`,
    `recent_lessons=${s.lessonCount}`,
    "",
    "명령:",
    "/memory show",
    "/memory md",
    "/memory policy <자연어 프롬프트>",
    "/memory note <메모>",
    "/memory lesson <교훈>",
    "/memory reset",
    "",
    "호환 alias:",
    "/settings ...  (=/memory ...)",
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

// concurrency gate
let running = 0;
const queue = [];
const jobAbortControllers = new Map(); // jobId -> AbortController
const activeJobByChat = new Map(); // chatId -> jobId

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

async function createJob(goal) {
  const job = jobs.createJob({ title: goal.slice(0, 80) });
  tracking.init(job.jobId);
  tracking.append(job.jobId, "plan.md", orchestratorNotes({ goal }), { timestamp: false });
  tracking.append(job.jobId, "research.md", `## Goal\n\n${goal}\n`, { timestamp: false });
  tracking.append(job.jobId, "progress.md", `## Started\n- goal: ${goal}\n`, { timestamp: false });
  jobs.appendConversation(job.jobId, "user", goal, { kind: "goal" });
  return job;
}

async function geminiResearch(jobId, goal, signal = null) {
  const ctx = loadContextDocs(jobId, ["research.md"]);
  const prompt = [
    "역할: 기술 리서처",
    `run dir: ${runDir(jobId)}`,
    `tracking docs dir: ${runSharedDir(jobId)}`,
    "",
    "제약:",
    "- 코드 작성/수정/패치 제안 금지",
    "- 터미널 명령 제안 최소화",
    "- 설계/리스크/검증 관점으로만 답변",
    "",
    ctx,
    "",
    "다음 목표를 달성하기 위한 구현 단계와 리스크를 한국어로 간결하게 작성해줘.",
    "",
    `목표: ${goal}`,
    "",
    "출력:",
    "- 요약",
    "- 구현 단계(번호)",
    "- 리스크/주의",
    "- 검증(테스트/체크)",
  ].join("\n");
  const r = await runGeminiPrompt({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt, signal });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "research.md", `## Gemini notes\n\n${out}\n`);
  jobs.appendConversation(jobId, "gemini", out, { kind: "research" });
  ensureCommandOk("Gemini", r);
  return out;
}

async function codexImplement(jobId, instruction, signal = null) {
  const ctx = loadContextDocs(jobId, ["plan.md", "research.md"], 6000);
  const trackDocs = TRACK_DOC_NAMES.map(n => `- ${path.join(runSharedDir(jobId), n)}`).join("\n");
  const prompt = [
    ctx,
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

async function reflectAutoSuggest(jobId, trigger, question, signal = null) {
  if (!AUTO_SUGGEST_ENABLED) {
    return { shouldAsk: false, reason: "AUTO_SUGGEST_GPT_PROMPT=false" };
  }

  const goal = getGoalFromResearch(jobId);
  const docs = loadContextDocs(jobId, ["research.md", "plan.md", "progress.md", "decisions.md"], 2200);
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

  const goal = getGoalFromResearch(jobId);
  const docs = loadContextDocs(jobId, ["research.md", "plan.md", "progress.md"], 3000);
  const convo = jobs.tailConversation(jobId, 60);
  const prompt = buildChatGPTNextStepPrompt({ jobId, goal, question, contextDocsText: docs, convoText: convoToText(convo) });
  await bot.sendMessage(chatId, `🧩 다음 단계 결정을 위해 ChatGPT에 물어볼 프롬프트를 자동 생성했어요.\n답을 받은 뒤 /gptapply ${jobId} 후 답을 붙여넣으면 자동 실행됩니다.`);
  await sendLong(bot, chatId, prompt);
}

async function executeActions(bot, chatId, jobId, plan, signal = null) {
  if (!plan || !Array.isArray(plan.actions)) return;
  const allowed = new Set(["track_append", "gemini", "codex", "git_summary", "commit_request"]);

  for (const act of plan.actions) {
    if (!act || !allowed.has(act.type)) continue;

    if (act.type === "track_append") {
      tracking.append(jobId, act.doc || "plan.md", String(act.markdown || ""));
      await bot.sendMessage(chatId, `📝 기록 업데이트: ${act.doc || "plan.md"}`);
    }

    if (act.type === "gemini") {
      const p = String(act.prompt || "").trim();
      if (!p) continue;
      await bot.sendMessage(chatId, "🧠 Gemini 실행 중…");
      const researchOnlyPrompt = [
        "역할: 기술 리서치/검토 어시스턴트",
        `run dir: ${runDir(jobId)}`,
        `tracking docs dir: ${runSharedDir(jobId)}`,
        "규칙: 코드 작성/수정/패치 지시를 하지 말고, 분석/근거/검증 체크리스트 중심으로 답하라.",
        "",
        p,
      ].join("\n");
      const r = await enqueue(
        () => runGeminiPrompt({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt: researchOnlyPrompt, signal }),
        { jobId, signal, label: "gemini_action" }
      );
      const out = (r.stdout || r.stderr || "");
      tracking.append(jobId, "research.md", `## Gemini (from ChatGPT plan)\n\n${out}\n`);
      jobs.appendConversation(jobId, "gemini", out, { kind: "from_chatgpt_plan" });
      ensureCommandOk("Gemini", r);
      await sendLong(bot, chatId, `🧠 Gemini 결과\n${clip(out, 3500)}`);
    }

    if (act.type === "codex") {
      const p = String(act.prompt || "").trim();
      if (!p) continue;
      await bot.sendMessage(chatId, "🛠️ Codex 실행 중…");
      const trackDocs = TRACK_DOC_NAMES.map(n => `- ${path.join(runSharedDir(jobId), n)}`).join("\n");
      const codexActionPrompt = [
        "규칙:",
        `- CODEX_WORKSPACE_ROOT(코드 작업 영역): ${workspace.root}`,
        `- 현재 run dir: ${runDir(jobId)}`,
        "- run/shared 트래킹 문서를 CODEX_WORKSPACE_ROOT 루트에 새로 만들지 말 것:",
        trackDocs,
        "",
        p,
      ].join("\n");
      const r = await enqueue(
        () => runCodexExec({ workspaceRoot: workspace.root, cwd: runDir(jobId), prompt: codexActionPrompt, signal }),
        { jobId, signal, label: "codex_action" }
      );
      const out = (r.stdout || r.stderr || "");
      tracking.append(jobId, "progress.md", `## Codex (from ChatGPT plan)\n\n${out}\n`);
      jobs.appendConversation(jobId, "codex", out, { kind: "from_chatgpt_plan" });
      ensureCommandOk("Codex", r);
      await sendLong(bot, chatId, `🛠️ Codex 결과\n${clip(out, 3500)}`);
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId, signal);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}`);
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

    const data = String(q.data || "");
    const [action, jobId, token] = data.split(":");
    if (!action || !jobId || !token) return;

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
        await executeActions(bot, chatId, jobId, plan, controller.signal);
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
    await bot.sendMessage(chatId, "Commands:\n- /whoami\n- /stop [jobId]\n- /memory [show|md|policy|note|lesson|reset]\n- /settings ... (alias)\n- /run <goal>\n- /continue <jobId>\n- /gptprompt <jobId> <question>\n- /gptapply <jobId>\n- /gptdone\n- /commit <jobId> <message>");
    return;
  }

  if (cmd === "/whoami") {
    await bot.sendMessage(chatId, `chat_id=${chatId}\nuser_id=${userId}`);
    return;
  }

  if (cmd === "/stop") {
    const chatKey = String(chatId);
    const fromAwait = getAwait(chatId)?.jobId;
    const targetJobId = args || activeJobByChat.get(chatKey) || fromAwait;
    if (!targetJobId) {
      await bot.sendMessage(chatId, "중단할 jobId를 찾지 못했어요. Usage: /stop <jobId>");
      return;
    }

    const { aborted, dropped } = cancelJobExecution(targetJobId);
    if (activeJobByChat.get(chatKey) === String(targetJobId)) activeJobByChat.delete(chatKey);
    if (fromAwait && String(fromAwait) === String(targetJobId)) clearAwait(chatId);

    if (!aborted && dropped === 0) {
      await bot.sendMessage(chatId, `중단할 실행이 없어요. (jobId=${targetJobId})`);
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

    await bot.sendMessage(chatId, "Usage:\n/memory show\n/memory md\n/memory policy <자연어 프롬프트>\n/memory note <메모>\n/memory lesson <교훈>\n/memory reset");
    return;
  }

  if (cmd === "/gptdone") {
    clearAwait(chatId);
    await bot.sendMessage(chatId, "✅ gpt paste 모드를 종료했어요.");
    return;
  }

  if (cmd === "/run") {
    if (!args) return bot.sendMessage(chatId, "Usage: /run <goal>");
    const goal = args;
    await bot.sendMessage(chatId, "🚀 시작합니다…");
    try {
      const job = await createJob(goal);
      const jobId = String(job.jobId);
      const controller = resetJobAbortController(jobId);
      const chatKey = String(chatId);
      activeJobByChat.set(chatKey, jobId);
      await bot.sendMessage(chatId, `✅ Job created: ${job.jobId}\ngoal: ${goal}\nrun_dir: ${runDir(jobId)}\n복잡하면: /gptprompt ${job.jobId} <질문>`);

      try {
        await bot.sendMessage(chatId, "🧠 Gemini 조사 중…");
        try {
          const g = await enqueue(
            () => geminiResearch(jobId, goal, controller.signal),
            { jobId, signal: controller.signal, label: "gemini_research" }
          );
          await sendLong(bot, chatId, `🧠 Gemini 완료\n${clip(g, 3500)}`);
        } catch (e) {
          if (isCancelledError(e)) throw e;
          await bot.sendMessage(chatId, `⚠️ Gemini 실패(계속 진행): ${String(e?.message ?? e)}`);
        }

        await bot.sendMessage(chatId, "🛠️ Codex 구현 중…");
        const c = await enqueue(
          () => codexImplement(jobId, goal, controller.signal),
          { jobId, signal: controller.signal, label: "codex_run" }
        );
        await sendLong(bot, chatId, `🛠️ Codex 완료\n${clip(c, 3500)}`);

        const { status, diff } = await gitSummary(jobId, controller.signal);
        await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}\n\n커밋: /commit ${jobId} <message>`);

        await suggestNextPrompt(bot, chatId, jobId, "현재 상태에서 다음 단계를 action plan(JSON)으로 제안해줘.", "run", controller.signal);
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
      const c = await enqueue(
        () => codexImplement(jobKey, instruction, controller.signal),
        { jobId: jobKey, signal: controller.signal, label: "codex_continue" }
      );
      await sendLong(bot, chatId, `🛠️ Codex 완료\n${clip(c, 3500)}`);

      const { status, diff } = await gitSummary(jobKey, controller.signal);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}`);

      await suggestNextPrompt(bot, chatId, jobKey, "현재 변경 결과를 바탕으로 다음 action plan(JSON)을 제안해줘.", "continue", controller.signal);
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

    const goal = getGoalFromResearch(jobId);
    const docs = loadContextDocs(jobId, ["research.md", "plan.md", "progress.md"], 3000);
    const convo = jobs.tailConversation(jobId, 60);
    const prompt = buildChatGPTNextStepPrompt({ jobId, goal, question, contextDocsText: docs, convoText: convoToText(convo) });

    jobs.appendConversation(jobId, "user", `/gptprompt ${question}`, { kind: "gptprompt" });

    await bot.sendMessage(chatId, `🧩 아래 프롬프트를 통째로 복사해서 ChatGPT에 넣으세요.\n답을 받은 뒤: /gptapply ${jobId} → 답을 그대로 붙여넣으면 자동 실행됩니다.\n종료: /gptdone`);
    await sendLong(bot, chatId, prompt);
    return;
  }

  if (cmd === "/gptapply") {
    if (!args) return bot.sendMessage(chatId, "Usage: /gptapply <jobId>");
    setAwait(chatId, args, userId);
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
await bot.startPolling({ restart: true });
