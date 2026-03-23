import fs from "node:fs";
import path from "node:path";
import { clip } from "../../textutil.js";
import { readIterationDelta, readRoleSummary } from "../../application/summary_memory.js";
import { ContextEngineBase } from "./base.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
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

function normalizeRole(raw) {
  const role = String(raw || "").trim().toLowerCase();
  if (!role) return "user";
  return role;
}

function readFileIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function writeFileIfMissing(filePath, content = "") {
  try {
    if (fs.existsSync(filePath)) return;
    fs.writeFileSync(filePath, content, "utf8");
  } catch {}
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clipTail(text = "", maxChars = 5000) {
  const raw = String(text || "");
  if (raw.length <= maxChars) return raw;
  return raw.slice(raw.length - maxChars);
}

function focusHeaderFor({ stepKind = "agent", agentId = "", roleId = "", goal = "", lensSpec = null } = {}) {
  const cleanStepKind = String(stepKind || "").trim().toLowerCase();
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  const cleanRoleId = String(roleId || "").trim().toLowerCase();
  const lens = lensSpec && typeof lensSpec === "object" ? lensSpec : {};
  if (cleanStepKind === "router" || ["router", "planner"].includes(cleanAgentId) || ["router", "operator", "planner"].includes(cleanRoleId)) {
    return "Focus: 사용자 요구를 분해하고 남은 deliverable 중심으로 다음 작업을 결정한다.";
  }
  if (["researcher"].includes(cleanAgentId) || ["researcher"].includes(cleanRoleId)) {
    return "Focus: 근거 중심 조사 결과, 리스크, 검증 포인트를 우선한다.";
  }
  if (["coder", "builder"].includes(cleanAgentId) || ["coder", "builder"].includes(cleanRoleId)) {
    return "Focus: 실행 가능한 코드/노트북 산출물과 검증 단계를 우선한다.";
  }
  if (["reviewer", "critic"].includes(cleanAgentId) || ["reviewer", "critic"].includes(cleanRoleId)) {
    return "Focus: 결함, 회귀 위험, 미검증 지점을 우선해 점검한다.";
  }
  const query = String(lens.query || "").trim();
  if (query) return `Focus: ${clip(query, 240)}`;
  if (goal) return `Focus: ${clip(goal, 240)}`;
  return "Focus: 요청과 직접 관련된 최신 맥락만 사용한다.";
}

function formatPinsSection(pins = null) {
  const payload = asObject(pins);
  if (Array.isArray(payload.items) && payload.items.length > 0) {
    return payload.items
      .map((row, idx) => `${idx + 1}. ${String(row || "").trim()}`)
      .filter((row) => row.length > 3)
      .join("\n");
  }
  const facts = Array.isArray(payload.facts) ? payload.facts : [];
  if (facts.length > 0) {
    return facts
      .map((row, idx) => `${idx + 1}. ${String(row || "").trim()}`)
      .filter((row) => row.length > 3)
      .join("\n");
  }
  const entries = Object.entries(payload)
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .filter((row) => row.length > 3)
    .slice(0, 20);
  return entries.join("\n");
}

function normalizePinText(text = "", maxChars = 320) {
  return clip(String(text || "").replace(/\s+/g, " ").trim(), maxChars);
}

function isUserDirectiveLike(text = "") {
  const clean = normalizePinText(text, 420);
  if (!clean || clean.length < 8) return false;
  return /(반드시|절대로|하지\s*마|하지마|아니라|기억해|기억해둬|잊지\s*마|잊지마|must|never|do not|don't|instead|rather than|not\s+.*but)/i.test(clean);
}

function formatTurns(turns = []) {
  return (Array.isArray(turns) ? turns : [])
    .map((row) => {
      const role = normalizeRole(row.role);
      const text = clip(String(row.text || "").trim(), 1000);
      if (!text) return "";
      return `- ${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

function firstIndexByRole(turns = [], role = "assistant") {
  const cleanRole = String(role || "").trim().toLowerCase();
  const rows = Array.isArray(turns) ? turns : [];
  for (let i = 0; i < rows.length; i += 1) {
    if (normalizeRole(rows[i]?.role) === cleanRole) return i;
  }
  return -1;
}

export class LocalContextEngine extends ContextEngineBase {
  constructor({
    jobs = null,
    logger = null,
  } = {}) {
    super({
      memoryMode: "local",
      jobs,
      logger,
    });
    this.defaultRecentTurns = clamp(process.env.LOCAL_RECENT_TURNS, 2, 30, 8);
  }

  _memoryPath(jobId, name = "") {
    const dir = this.ensureLocalMemoryDir(jobId);
    if (!dir) return "";
    return path.join(dir, name);
  }

  _ensureMemoryFiles(jobId) {
    const summaryPath = this._memoryPath(jobId, "summary.md");
    const pinsPath = this._memoryPath(jobId, "pins.json");
    const turnsPath = this._memoryPath(jobId, "turns.jsonl");
    if (summaryPath) {
      writeFileIfMissing(summaryPath, "# rolling summary\n\n");
    }
    if (pinsPath) {
      writeFileIfMissing(pinsPath, "{\n  \"items\": []\n}\n");
    }
    if (turnsPath) {
      writeFileIfMissing(turnsPath, "");
    }
  }

  _loadSummary(jobId) {
    const p = this._memoryPath(jobId, "summary.md");
    const raw = readFileIfExists(p);
    return clip(String(raw || "").trim(), 5000);
  }

  _loadPins(jobId) {
    const p = this._memoryPath(jobId, "pins.json");
    const raw = readFileIfExists(p);
    return asObject(parseJsonMaybe(raw));
  }

  _upsertPinnedUserDirective(jobId, text = "") {
    const clean = normalizePinText(text, 320);
    if (!jobId || !isUserDirectiveLike(clean)) return null;
    const p = this._memoryPath(jobId, "pins.json");
    if (!p) return null;
    const payload = this._loadPins(jobId);
    const existing = Array.isArray(payload.items)
      ? payload.items
      : (Array.isArray(payload.facts) ? payload.facts : []);
    const normalizedExisting = existing
      .map((entry) => normalizePinText(entry, 320))
      .filter(Boolean);
    const deduped = [clean, ...normalizedExisting.filter((entry) => entry.toLowerCase() !== clean.toLowerCase())]
      .slice(0, 8);
    try {
      fs.writeFileSync(p, `${JSON.stringify({ items: deduped }, null, 2)}
`, "utf8");
      return deduped.length;
    } catch {
      return null;
    }
  }


  _loadTurnsFromJsonl(jobId, maxTurns = 8) {
    const p = this._memoryPath(jobId, "turns.jsonl");
    const raw = readFileIfExists(p);
    const lines = String(raw || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const parsed = parseJsonMaybe(line);
      if (!parsed || typeof parsed !== "object") continue;
      const role = normalizeRole(parsed.role || parsed.author || parsed.agent || "user");
      const text = String(parsed.text || parsed.content || "").trim();
      if (!text) continue;
      rows.push({
        role,
        text,
        ts: String(parsed.ts || parsed.created_at || "").trim(),
      });
    }
    if (rows.length <= maxTurns) return rows;
    return rows.slice(rows.length - maxTurns);
  }

  _loadRecentTurns(jobId, maxTurns = 8) {
    const jsonlTurns = this._loadTurnsFromJsonl(jobId, maxTurns);
    if (jsonlTurns.length > 0) return jsonlTurns;
    if (!this.jobs || typeof this.jobs.tailConversation !== "function") return [];
    const convo = this.jobs.tailConversation(jobId, Math.max(20, maxTurns * 3));
    const normalized = convo
      .map((row) => ({
        role: normalizeRole(row?.role),
        text: String(row?.text || "").trim(),
        ts: String(row?.ts || "").trim(),
      }))
      .filter((row) => row.text);
    if (normalized.length <= maxTurns) return normalized;
    return normalized.slice(normalized.length - maxTurns);
  }

  _loadToolSnippets(jobId, maxItems = 4) {
    if (!this.jobs || typeof this.jobs.tailConversation !== "function") return [];
    const convo = this.jobs.tailConversation(jobId, 80);
    const rows = convo
      .filter((row) => {
        const role = normalizeRole(row?.role);
        const kind = String(row?.kind || "").trim().toLowerCase();
        if (kind.includes("tool")) return true;
        return !["user", "assistant"].includes(role);
      })
      .slice(-maxItems);
    return rows.map((row) => {
      const role = normalizeRole(row?.role);
      const text = clip(String(row?.text || "").trim(), 420);
      return text ? `- ${role}: ${text}` : "";
    }).filter(Boolean);
  }

  _renderContext({
    focusHeader = "",
    constraintsText = "",
    pinsText = "",
    summaryText = "",
    roleSummaryText = "",
    deltaSummaryText = "",
    turns = [],
    toolSnippets = [],
    includeToolSnippets = true,
  } = {}) {
    const sections = [];
    if (focusHeader) sections.push(`[FOCUS]\n${focusHeader}`);
    if (constraintsText) sections.push(`[JOB CONSTRAINTS]\n${constraintsText}`);
    if (pinsText) sections.push(`[PINNED FACTS]\n${pinsText}`);
    if (roleSummaryText) sections.push(`[ROLE SUMMARY]\n${roleSummaryText}`);
    if (deltaSummaryText) sections.push(`[ITERATION DELTA]\n${deltaSummaryText}`);
    if (summaryText) sections.push(`[ROLLING SUMMARY]\n${summaryText}`);
    if (turns.length > 0) sections.push(`[RECENT TURNS]\n${formatTurns(turns)}`);
    if (includeToolSnippets && toolSnippets.length > 0) {
      sections.push(`[RECENT TOOL RESULTS]\n${toolSnippets.join("\n")}`);
    }
    return sections.join("\n\n");
  }

  _enforceBudget({
    budgetTokens = 1200,
    focusHeader = "",
    constraintsText = "",
    pinsText = "",
    summaryText = "",
    roleSummaryText = "",
    deltaSummaryText = "",
    turns = [],
    toolSnippets = [],
  } = {}) {
    const maxChars = this.maxCharsFromBudget(budgetTokens);
    const workingTurns = Array.isArray(turns) ? [...turns] : [];
    const hasStructuredSummary = !!String(roleSummaryText || "").trim() || !!String(deltaSummaryText || "").trim();
    let workingSummary = clip(String(summaryText || ""), hasStructuredSummary ? 1800 : 3200);
    const workingRoleSummary = clip(String(roleSummaryText || ""), 1000);
    const workingDeltaSummary = clip(String(deltaSummaryText || ""), 800);
    let includeTools = Array.isArray(toolSnippets) && toolSnippets.length > 0;

    let text = this._renderContext({
      focusHeader,
      constraintsText,
      pinsText,
      summaryText: workingSummary,
      roleSummaryText: workingRoleSummary,
      deltaSummaryText: workingDeltaSummary,
      turns: workingTurns,
      toolSnippets,
      includeToolSnippets: includeTools,
    });
    let estimated = this.estimateTokens(text);
    while (estimated > budgetTokens) {
      if (includeTools) {
        includeTools = false;
      } else {
        const assistantIdx = firstIndexByRole(workingTurns, "assistant");
        if (assistantIdx >= 0) {
          workingTurns.splice(assistantIdx, 1);
        } else {
          const userIdx = firstIndexByRole(workingTurns, "user");
          if (userIdx >= 0) {
            workingTurns.splice(userIdx, 1);
          } else if (workingSummary.length > 420) {
            workingSummary = workingSummary.slice(0, Math.max(420, Math.floor(workingSummary.length * 0.7)));
          } else if (workingTurns.length > 2) {
            workingTurns.shift();
          } else {
            break;
          }
        }
      }
      text = this._renderContext({
        focusHeader,
        constraintsText,
        pinsText,
        summaryText: workingSummary,
        roleSummaryText: workingRoleSummary,
        deltaSummaryText: workingDeltaSummary,
        turns: workingTurns,
        toolSnippets,
        includeToolSnippets: includeTools,
      });
      estimated = this.estimateTokens(text);
    }
    if (text.length > maxChars) {
      text = `${text.slice(0, maxChars)}\n\n[context truncated]`;
      estimated = this.estimateTokens(text);
    }
    return {
      text,
      estimatedTokens: estimated,
      recentTurnsCount: workingTurns.length,
      summaryChars: workingSummary.length,
      includeTools,
    };
  }

  _constraintsFromInput(input = {}) {
    const runMeta = asObject(input.runMeta);
    const constraints = asObject(runMeta.jobConfig || runMeta.job_config);
    if (!constraints || Object.keys(constraints).length === 0) return "";
    const allowActions = Array.isArray(constraints.allow_actions)
      ? constraints.allow_actions.slice(0, 16).join(", ")
      : "";
    const responseStyle = String(constraints.final_response_style || "").trim();
    const maxActions = Number.isFinite(Number(constraints?.budget?.max_actions))
      ? Math.max(1, Math.floor(Number(constraints.budget.max_actions)))
      : "";
    const lines = [];
    if (responseStyle) lines.push(`- final_response_style: ${responseStyle}`);
    if (maxActions) lines.push(`- budget.max_actions: ${maxActions}`);
    if (allowActions) lines.push(`- allow_actions: ${allowActions}`);
    return lines.join("\n");
  }

  async _prepare(input = {}, fallback = {}) {
    const normalized = this.normalizeInput(input, fallback);
    this._ensureMemoryFiles(normalized.jobId);
    const budgetTokens = this.normalizeBudget(
      normalized.budgetTokens,
      this.defaultBudgetFor(normalized)
    );
    const pinsPayload = this._loadPins(normalized.jobId);
    const pinsText = formatPinsSection(pinsPayload);
    const summaryText = this._loadSummary(normalized.jobId);
    const recentTurns = this._loadRecentTurns(
      normalized.jobId,
      clamp(process.env.LOCAL_RECENT_TURNS, 2, 30, this.defaultRecentTurns)
    );
    const resolvedJobDir = this.jobs && typeof this.jobs.jobDir === "function" ? this.jobs.jobDir(normalized.jobId) : "";
    const roleSummaryText = normalized.stepKind === "agent"
      ? readRoleSummary({ jobDir: resolvedJobDir, roleId: normalized.roleId, agentId: normalized.agentId })
      : "";
    const deltaSummaryText = normalized.stepKind === "agent"
      ? readIterationDelta({ jobDir: resolvedJobDir })
      : "";
    const toolSnippets = this._loadToolSnippets(normalized.jobId, 4);
    const constraintsText = this._constraintsFromInput(normalized);
    const focusHeader = focusHeaderFor({
      stepKind: normalized.stepKind,
      agentId: normalized.agentId,
      roleId: normalized.roleId,
      goal: normalized.goal || normalized.userMessageText,
      lensSpec: normalized.lensSpec,
    });

    const packed = this._enforceBudget({
      budgetTokens,
      focusHeader,
      constraintsText,
      pinsText,
      summaryText,
      roleSummaryText,
      deltaSummaryText,
      turns: recentTurns,
      toolSnippets,
    });

    return {
      contextText: packed.text,
      meta: {
        mode: "local",
        budgetTokens,
        estimatedTokens: packed.estimatedTokens,
        compiledChars: packed.text.length,
        localRecentTurnsCount: packed.recentTurnsCount,
        localSummaryChars: packed.summaryChars,
        localPinnedCount: Array.isArray(pinsPayload.items)
          ? pinsPayload.items.length
          : (Array.isArray(pinsPayload.facts) ? pinsPayload.facts.length : Object.keys(pinsPayload).length),
        roleSummaryChars: roleSummaryText.length,
        deltaSummaryChars: deltaSummaryText.length,
      },
    };
  }

  async prepareRouterContext(input = {}) {
    return await this._prepare(input, { stepKind: "router", agentId: "router" });
  }

  async prepareStepContext(input = {}) {
    return await this._prepare(input, { stepKind: "agent" });
  }

  async onRunEnd(input = {}) {
    const row = asObject(input);
    const jobId = String(row.jobId || "").trim();
    if (!jobId) return null;
    this._ensureMemoryFiles(jobId);

    const userText = clip(String(row.lastUserText || "").trim(), 1000);
    const assistantText = clip(String(row.lastAssistantText || "").trim(), 1400);
    if (!userText && !assistantText) return null;

    const summaryPath = this._memoryPath(jobId, "summary.md");
    const currentSummary = String(readFileIfExists(summaryPath) || "").trim();
    const summaryBody = currentSummary.startsWith("# rolling summary")
      ? currentSummary.slice("# rolling summary".length).trim()
      : currentSummary;

    const recentSection = [
      "## recent",
      userText ? `- user: ${userText}` : "",
      assistantText ? `- assistant: ${assistantText}` : "",
    ].filter(Boolean).join("\n");

    const nextBody = clipTail(
      [summaryBody, recentSection].filter(Boolean).join("\n\n").trim(),
      4700
    );
    const nextSummary = clipTail(`# rolling summary\n\n${nextBody}`.trim(), 5000);
    try {
      fs.writeFileSync(summaryPath, `${nextSummary}\n`, "utf8");
    } catch {}

    if (userText) {
      this.appendLocalLog(jobId, "turns.jsonl", {
        role: "user",
        text: userText,
      });
      this._upsertPinnedUserDirective(jobId, userText);
    }
    if (assistantText) {
      this.appendLocalLog(jobId, "turns.jsonl", {
        role: "assistant",
        text: assistantText,
      });
    }
    return {
      ok: true,
      summaryChars: nextSummary.length,
    };
  }

  async recordMeta(args = {}) {
    const row = asObject(args);
    const jobId = String(row.jobId || "").trim();
    const meta = asObject(row.meta);
    const runMeta = asObject(row.runMeta);
    this.appendLocalLog(jobId, "context_meta.jsonl", {
      mode: "local",
      step_kind: String(row.stepKind || "").trim() || undefined,
      agent_id: String(row.agentId || "").trim().toLowerCase() || undefined,
      role_id: String(row.roleId || row.role_id || "").trim().toLowerCase() || undefined,
      goal: clip(String(row.goal || "").trim(), 320) || undefined,
      run_meta: runMeta,
      context_meta: meta,
    });

    const userMessageText = String(row.userMessageText || "").trim();
    if (userMessageText) {
      const normalizedStepKind = String(row.stepKind || "").trim().toLowerCase();
      this.appendLocalLog(jobId, "turns.jsonl", {
        role: normalizedStepKind === "router" ? "user" : "system",
        text: clip(userMessageText, 1000),
      });
      if (normalizedStepKind === "router") this._upsertPinnedUserDirective(jobId, userMessageText);
    }
    return await super.recordMeta(args);
  }
}
