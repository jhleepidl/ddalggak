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
const AUTO_SUGGEST = String(process.env.AUTO_SUGGEST_GPT_PROMPT ?? "true").toLowerCase() !== "false";
const TELEGRAM_FORCE_IPV4 = String(process.env.TELEGRAM_FORCE_IPV4 ?? "true").toLowerCase() !== "false";
const TELEGRAM_POLLING_INTERVAL_MS = Number(process.env.TELEGRAM_POLLING_INTERVAL_MS ?? 1000);
const TELEGRAM_POLLING_TIMEOUT_SEC = Number(process.env.TELEGRAM_POLLING_TIMEOUT_SEC ?? 15);
const TELEGRAM_SINGLE_INSTANCE_LOCK = String(process.env.TELEGRAM_SINGLE_INSTANCE_LOCK ?? "true").toLowerCase() !== "false";
const LOCK_FILE = process.env.TELEGRAM_LOCK_FILE || path.join(workspace.root, ".orchestrator", "telegram_runner.lock");

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

function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
  let out = "";
  for (const name of docNames) {
    try {
      const t = tracking.read(jobId, name);
      const clipped = t.length > maxCharsPerDoc ? t.slice(-maxCharsPerDoc) : t;
      out += `\n\n---\n\n### ${name}\n\n${clipped}\n`;
    } catch (e) {
      out += `\n\n---\n\n### ${name}\n\n[read failed: ${String(e?.message ?? e)}]\n`;
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

// concurrency gate
let running = 0;
const queue = [];
async function enqueue(fn) { return await new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); }); }
async function pump() {
  if (running >= MAX_CONCURRENCY) return;
  const item = queue.shift();
  if (!item) return;
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

async function geminiResearch(jobId, goal) {
  const ctx = loadContextDocs(jobId, ["research.md"]);
  const prompt = `${ctx}\n\n다음 목표를 달성하기 위한 구현 단계와 리스크를 한국어로 간결하게 작성해줘.\n\n목표: ${goal}\n\n출력:\n- 요약\n- 구현 단계(번호)\n- 리스크/주의\n- 검증(테스트/체크)\n`;
  const r = await runGeminiPrompt({ workspaceRoot: workspace.root, prompt });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "research.md", `## Gemini notes\n\n${out}\n`);
  jobs.appendConversation(jobId, "gemini", out, { kind: "research" });
  return out;
}

async function codexImplement(jobId, instruction) {
  const ctx = loadContextDocs(jobId, ["plan.md", "research.md"], 6000);
  const prompt = `${ctx}\n\n너는 코드 수정 에이전트다.\n규칙:\n- 네트워크 접근 금지.\n- WORKSPACE_ROOT 내부 파일만 수정.\n- 테스트 실행은 하지 말고, 필요한 테스트를 제안만.\n- 변경 요약(파일별 이유) 포함.\n\n작업:\n${instruction}\n`;
  const r = await runCodexExec({ workspaceRoot: workspace.root, prompt });
  const out = (r.stdout || r.stderr || "");
  tracking.append(jobId, "progress.md", `## Codex output\n\n${out}\n`);
  jobs.appendConversation(jobId, "codex", out, { kind: "implementation" });
  return out;
}

async function gitSummary(jobId) {
  const status = await runCommand("git", ["status", "--porcelain=v1"], { cwd: workspace.root });
  const diff = await runCommand("git", ["diff"], { cwd: workspace.root, timeoutMs: 120000 });

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

async function suggestNextPrompt(bot, chatId, jobId, question) {
  if (!AUTO_SUGGEST) return;
  const goal = getGoalFromResearch(jobId);
  const docs = loadContextDocs(jobId, ["research.md", "plan.md", "progress.md"], 3000);
  const convo = jobs.tailConversation(jobId, 60);
  const prompt = buildChatGPTNextStepPrompt({ jobId, goal, question, contextDocsText: docs, convoText: convoToText(convo) });
  await bot.sendMessage(chatId, `🧩 다음 단계 결정을 위해 ChatGPT에 물어볼 프롬프트를 자동 생성했어요.\n답을 받은 뒤 /gptapply ${jobId} 후 답을 붙여넣으면 자동 실행됩니다.`);
  await sendLong(bot, chatId, prompt);
}

async function executeActions(bot, chatId, jobId, plan) {
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
      const r = await enqueue(() => runGeminiPrompt({ workspaceRoot: workspace.root, prompt: p }));
      const out = (r.stdout || r.stderr || "");
      tracking.append(jobId, "research.md", `## Gemini (from ChatGPT plan)\n\n${out}\n`);
      jobs.appendConversation(jobId, "gemini", out, { kind: "from_chatgpt_plan" });
      await sendLong(bot, chatId, `🧠 Gemini 결과\n${clip(out, 3500)}`);
    }

    if (act.type === "codex") {
      const p = String(act.prompt || "").trim();
      if (!p) continue;
      await bot.sendMessage(chatId, "🛠️ Codex 실행 중…");
      const r = await enqueue(() => runCodexExec({ workspaceRoot: workspace.root, prompt: p }));
      const out = (r.stdout || r.stderr || "");
      tracking.append(jobId, "progress.md", `## Codex (from ChatGPT plan)\n\n${out}\n`);
      jobs.appendConversation(jobId, "codex", out, { kind: "from_chatgpt_plan" });
      await sendLong(bot, chatId, `🛠️ Codex 결과\n${clip(out, 3500)}`);
    }

    if (act.type === "git_summary") {
      const { status, diff } = await gitSummary(jobId);
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
      await suggestNextPrompt(bot, chatId, jobId, "커밋 이후 다음 단계(테스트/PR/배포 등)를 결정해줘.");
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
      try {
        await executeActions(bot, chatId, jobId, plan);
        await bot.sendMessage(chatId, "🏁 액션 플랜 실행 완료.");
        await suggestNextPrompt(bot, chatId, jobId, "현재 상태에서 다음으로 무엇을 해야 하는지 action plan(JSON)으로 제안해줘.");
      } catch (e) {
        await bot.sendMessage(chatId, `❌ 액션 실행 오류: ${String(e?.message ?? e)}`);
      }
    } else {
      await bot.sendMessage(chatId, "🟣 plan.md에 기록 완료. (JSON 플랜이 없어서 자동 실행은 하지 않았어요)");
    }
    return;
  }

  const [cmd, ...rest] = text.split(/\s+/);
  const args = rest.join(" ").trim();

  if (cmd === "/help") {
    await bot.sendMessage(chatId, "Commands:\n- /whoami\n- /run <goal>\n- /continue <jobId>\n- /gptprompt <jobId> <question>\n- /gptapply <jobId>\n- /gptdone\n- /commit <jobId> <message>");
    return;
  }

  if (cmd === "/whoami") {
    await bot.sendMessage(chatId, `chat_id=${chatId}\nuser_id=${userId}`);
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
      await bot.sendMessage(chatId, `✅ Job created: ${job.jobId}\ngoal: ${goal}\n복잡하면: /gptprompt ${job.jobId} <질문>`);

      await bot.sendMessage(chatId, "🧠 Gemini 조사 중…");
      try {
        const g = await enqueue(() => geminiResearch(job.jobId, goal));
        await sendLong(bot, chatId, `🧠 Gemini 완료\n${clip(g, 3500)}`);
      } catch (e) {
        await bot.sendMessage(chatId, `⚠️ Gemini 실패(계속 진행): ${String(e?.message ?? e)}`);
      }

      await bot.sendMessage(chatId, "🛠️ Codex 구현 중…");
      const c = await enqueue(() => codexImplement(job.jobId, goal));
      await sendLong(bot, chatId, `🛠️ Codex 완료\n${clip(c, 3500)}`);

      const { status, diff } = await gitSummary(job.jobId);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}\n\n커밋: /commit ${job.jobId} <message>`);

      await suggestNextPrompt(bot, chatId, job.jobId, "현재 상태에서 다음 단계를 action plan(JSON)으로 제안해줘.");
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
    }
    return;
  }

  if (cmd === "/continue") {
    if (!args) return bot.sendMessage(chatId, "Usage: /continue <jobId>");
    const jobId = args;
    await bot.sendMessage(chatId, `▶️ Continue job ${jobId}`);

    let instruction = "plan.md와 research.md를 반영해 다음 변경을 진행해라.";
    try {
      const planText = tracking.read(jobId, "plan.md");
      const extracted = extractCodexInstruction(planText);
      if (extracted) instruction = extracted;
    } catch {}

    try {
      const c = await enqueue(() => codexImplement(jobId, instruction));
      await sendLong(bot, chatId, `🛠️ Codex 완료\n${clip(c, 3500)}`);

      const { status, diff } = await gitSummary(jobId);
      await sendLong(bot, chatId, `📌 git status\n${FENCE}\n${clip(status, 1500)}\n${FENCE}\n\n📌 git diff(일부)\n${FENCE}diff\n${clip(diff, 2500)}\n${FENCE}`);

      await suggestNextPrompt(bot, chatId, jobId, "현재 변경 결과를 바탕으로 다음 action plan(JSON)을 제안해줘.");
    } catch (e) {
      await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
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
console.log(`Workspace root: ${workspace.root}`);
await bot.startPolling({ restart: true });
