import fs from "node:fs";
import path from "node:path";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeRoleId(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesAny(value, candidates = []) {
  const clean = normalizeRoleId(value);
  if (!clean) return false;
  return (Array.isArray(candidates) ? candidates : []).some((candidate) => clean === normalizeRoleId(candidate));
}

export class ContextEngineBase {
  constructor({
    memoryMode = "local",
    jobs = null,
    logger = null,
  } = {}) {
    this.memoryMode = String(memoryMode || "local").trim().toLowerCase() === "goc"
      ? "goc"
      : "local";
    this.jobs = jobs || null;
    this.logger = typeof logger === "function" ? logger : null;
  }

  log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  estimateTokens(text) {
    const src = String(text || "");
    if (!src) return 0;
    return Math.max(1, Math.ceil(src.length / 4));
  }

  maxCharsFromBudget(budgetTokens, fallback = 3600) {
    const budget = clampInt(budgetTokens, 100, 24000, fallback);
    return Math.max(1200, Math.floor(budget * 4));
  }

  normalizeBudget(budgetTokens, fallback = 1200) {
    return clampInt(budgetTokens, 200, 24000, clampInt(fallback, 200, 24000, 1200));
  }

  defaultBudgetFor({ stepKind = "agent", agentId = "", roleId = "" } = {}) {
    const cleanStepKind = String(stepKind || "").trim().toLowerCase();
    const cleanAgentId = normalizeRoleId(agentId);
    const cleanRoleId = normalizeRoleId(roleId);
    if (cleanStepKind === "router" || matchesAny(cleanAgentId, ["router", "planner"]) || matchesAny(cleanRoleId, ["router", "operator", "planner"])) return 900;
    if (matchesAny(cleanAgentId, ["coder", "builder"]) || matchesAny(cleanRoleId, ["coder", "builder"])) return 1400;
    if (matchesAny(cleanAgentId, ["researcher", "reviewer", "critic"]) || matchesAny(cleanRoleId, ["researcher", "reviewer", "critic"])) return 1200;
    if (matchesAny(cleanRoleId, ["synthesizer", "writer"])) return 1000;
    return 1200;
  }

  normalizeInput(input = {}, fallback = {}) {
    const row = asObject(input);
    const stepKindRaw = String(row.stepKind || fallback.stepKind || "agent").trim().toLowerCase();
    return {
      ...row,
      jobId: String(row.jobId || fallback.jobId || "").trim(),
      chatId: String(row.chatId || fallback.chatId || "").trim(),
      threadId: String(row.threadId || fallback.threadId || "").trim(),
      userId: String(row.userId || fallback.userId || "").trim(),
      agentId: String(row.agentId || fallback.agentId || "").trim().toLowerCase(),
      roleId: normalizeRoleId(row.roleId || row.role_id || fallback.roleId || fallback.role_id || ""),
      goal: String(row.goal || fallback.goal || "").trim(),
      userMessageText: String(row.userMessageText || fallback.userMessageText || "").trim(),
      stepKind: stepKindRaw === "router" ? "router" : "agent",
      budgetTokens: this.normalizeBudget(
        row.budgetTokens,
        this.defaultBudgetFor({
          stepKind: stepKindRaw,
          agentId: row.agentId || fallback.agentId || "",
          roleId: row.roleId || row.role_id || fallback.roleId || fallback.role_id || "",
        })
      ),
      lensSpec: row.lensSpec && typeof row.lensSpec === "object" ? row.lensSpec : null,
      runMeta: row.runMeta && typeof row.runMeta === "object" ? row.runMeta : {},
      detailContext: String(row.detailContext || "").trim(),
    };
  }

  ensureLocalMemoryDir(jobId) {
    const cleanJobId = String(jobId || "").trim();
    if (!cleanJobId || !this.jobs || typeof this.jobs.jobDir !== "function") return "";
    const dir = path.join(this.jobs.jobDir(cleanJobId), "local_memory");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  appendLocalLog(jobId, fileName, record = {}) {
    const dir = this.ensureLocalMemoryDir(jobId);
    if (!dir) return;
    const name = String(fileName || "").trim() || "context_meta.jsonl";
    const p = path.join(dir, name);
    const row = {
      ts: new Date().toISOString(),
      ...asObject(record),
    };
    try {
      fs.appendFileSync(p, `${JSON.stringify(row)}\n`, "utf8");
    } catch {}
  }

  async onRunStart(_input = {}) {
    return null;
  }

  async onRunEnd(_input = {}) {
    return null;
  }

  async prepareRouterContext(_input = {}) {
    throw new Error("prepareRouterContext is not implemented");
  }

  async prepareStepContext(_input = {}) {
    throw new Error("prepareStepContext is not implemented");
  }

  async recordMeta({
    jobId = "",
    chatId = "",
    agentId = "",
    roleId = "",
    stepKind = "agent",
    goal = "",
    runMeta = {},
    meta = {},
  } = {}) {
    this.appendLocalLog(jobId, "context_meta.jsonl", {
      mode: this.memoryMode,
      chat_id: String(chatId || "").trim() || undefined,
      agent_id: String(agentId || "").trim() || undefined,
      role_id: normalizeRoleId(roleId) || undefined,
      step_kind: String(stepKind || "").trim() || undefined,
      goal: String(goal || "").trim() || undefined,
      run_meta: asObject(runMeta),
      context_meta: asObject(meta),
    });
    return true;
  }
}

