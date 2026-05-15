import fs from "node:fs";
import path from "node:path";
import { clip } from "../../textutil.js";
import { readIterationDelta, readRoleSummary } from "../../application/summary_memory.js";
import {
  buildMemoryTopologyPromptBlock,
  getAgentMemoryGrant,
  planMemoryTopology,
  shouldIncludeRoleLocalMemory,
} from "../../application/memory_topology.js";
import { runIdleMemoryMaintenance } from "../../application/idle_compaction.js";
import { buildChatMemoryAnchorPromptBlock, loadChatMemoryAnchor, updateChatMemoryAnchor } from "../../application/chat_memory_anchor.js";
import { buildMemoryDemandContext } from "../../application/memory_demand_context.js";
import { loadCurrentTaskPacket, renderTaskPacket, updateCurrentTaskPacket } from "../../application/task_packet.js";
import { ContextEngineBase } from "./base.js";
import { buildContextEnvelope } from '../context_envelope.js';

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

function isNoisyAssistantTelemetry(text = "") {
  const clean = String(text || '').trim();
  if (!clean) return false;
  return [
    /^현재까지 결과 요약:/,
    /^♻️\s*self-refine progress/i,
    /^📎\s*주요 산출물 후보/,
  ].some((pattern) => pattern.test(clean));
}

function summarizeAssistantForRollingSummary(text = "") {
  const clean = String(text || '').trim();
  if (!clean || isNoisyAssistantTelemetry(clean)) return '';
  return clean;
}

function compactRuntimeTeamSnapshot(snapshot = null) {
  const row = asObject(snapshot);
  if (Object.keys(row).length === 0) return undefined;
  const participants = Array.isArray(row.participants) ? row.participants : [];
  return {
    source: String(row.source || '').trim() || undefined,
    mode: String(row.mode || '').trim() || undefined,
    team_id: String(row.team_id || row.teamId || '').trim() || undefined,
    participant_count: participants.length || undefined,
    participant_ids: participants.map((entry) => String(entry?.id || entry?.agent_id || '').trim()).filter(Boolean).slice(0, 12),
  };
}

function compactTaskInterpretation(raw = null) {
  const row = asObject(raw);
  if (Object.keys(row).length === 0) return undefined;
  return {
    archetype: String(row.archetype || row.task_archetype || '').trim() || undefined,
    wants_code: row.wants_code === true ? true : undefined,
    wants_artifact: row.wants_artifact === true ? true : undefined,
    wants_review: row.wants_review === true ? true : undefined,
  };
}

function compactRunMetaForContextLog(runMeta = {}) {
  const raw = asObject(runMeta);
  const compact = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value == null) continue;
    if (key === 'runtime_team_snapshot' || key === 'runtimeTeamSnapshot') {
      const reduced = compactRuntimeTeamSnapshot(value);
      if (reduced) compact[key] = reduced;
      continue;
    }
    if (key === 'task_interpretation' || key === 'taskInterpretation') {
      const reduced = compactTaskInterpretation(value);
      if (reduced) compact[key] = reduced;
      continue;
    }
    if (typeof value === 'string') {
      const clean = String(value || '').trim();
      if (clean) compact[key] = clip(clean, 240);
      continue;
    }
    if (typeof value === 'boolean' || typeof value === 'number') {
      compact[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      const simplified = value
        .map((entry) => {
          if (typeof entry === 'string') return clip(String(entry || '').trim(), 120);
          if (entry && typeof entry === 'object') return undefined;
          return entry;
        })
        .filter(Boolean)
        .slice(0, 8);
      if (simplified.length > 0) compact[key] = simplified;
    }
  }
  return compact;
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
  const fallbackEntries = Object.entries(payload)
    .filter(([key, value]) => {
      if (key === 'items' && Array.isArray(value) && value.length === 0) return false;
      if (key === 'facts' && Array.isArray(value) && value.length === 0) return false;
      if (typeof value === 'string' && !String(value).trim()) return false;
      return true;
    })
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .filter((row) => row.length > 3)
    .slice(0, 20);
  return fallbackEntries.join("\n");
}

function normalizePinText(text = "", maxChars = 320) {
  return clip(String(text || "").replace(/\s+/g, " ").trim(), maxChars);
}

function normalizeDirectiveEntry(raw = {}, { pinnedFallback = false } = {}) {
  if (typeof raw === 'string') {
    const text = normalizePinText(raw, 320);
    return text ? { text, pinned: pinnedFallback, source: 'explicit', ts: '' } : null;
  }
  const row = asObject(raw);
  const text = normalizePinText(row.text || row.value || row.directive || row.content || '', 320);
  if (!text) return null;
  return {
    text,
    pinned: row.pinned === true || row.pin === true || pinnedFallback === true,
    source: String(row.source || row.origin || 'explicit').trim() || 'explicit',
    ts: String(row.ts || row.created_at || '').trim(),
    scope: String(row.scope || 'global').trim() || 'global',
  };
}

function normalizeDirectiveEntries(raw = [], { pinnedFallback = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const normalized = normalizeDirectiveEntry(entry, { pinnedFallback });
    if (!normalized) continue;
    const key = String(normalized.text || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function formatDirectiveEntries(entries = [], { onlyPinned = false, maxItems = 8 } = {}) {
  const rows = normalizeDirectiveEntries(entries)
    .filter((entry) => !onlyPinned || entry.pinned === true)
    .slice(0, Math.max(1, Math.floor(Number(maxItems) || 8)));
  return rows.map((entry, idx) => `${idx + 1}. ${entry.text}`).join('\n');
}

function classifyTurnKind(text = '', role = 'user') {
  const clean = normalizePinText(text, 420);
  const normalizedRole = normalizeRole(role);
  if (!clean) return 'other';
  if (normalizedRole === 'assistant') return 'assistant';
  if (/(반드시|절대로|하지\s*마|하지마|must|never|do not|don't|잊지\s*마|잊지마|기억해|기억해둬)/i.test(clean)) return 'directive';
  if (/(아니라|대신|different|not\s+the\s+same|rather than|instead|혼동하지\s*않도록|혼동하지\s*말|주의해|주의하|구분해|다른\s+모드|다르다|라고\.?$|라고\s)/i.test(clean)) return 'correction';
  if (/(좋아|그대로|진행해|승인|approve|approved|ok to proceed|continue)/i.test(clean)) return 'approval';
  if (/(싫어|하지\s*마|중단|취소|stop|cancel|replan)/i.test(clean)) return 'rejection';
  if (normalizedRole === 'user') return 'request';
  if (normalizedRole === 'system') return 'handoff';
  return 'other';
}

function isPriorityTurnKind(kind = '') {
  return ['directive', 'correction', 'approval', 'rejection'].includes(String(kind || '').trim().toLowerCase());
}

function isUserDirectiveLike(text = '') {
  const clean = normalizePinText(text, 420);
  if (!clean || clean.length < 8) return false;
  return isPriorityTurnKind(classifyTurnKind(clean, 'user'));
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

function buildActiveDirectivesText({ turns = [], directiveEntries = [], maxItems = 6 } = {}) {
  const items = [];
  const seen = new Set();
  const pushItem = (value = '') => {
    const clean = normalizePinText(value, 260);
    if (!clean) return;
    const key = clean.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push(clean);
  };

  for (const entry of normalizeDirectiveEntries(directiveEntries, { pinnedFallback: false })) {
    pushItem(entry.text);
  }

  const rows = Array.isArray(turns) ? turns : [];
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i] || {};
    if (normalizeRole(row.role) !== 'user') continue;
    const kind = classifyTurnKind(row.text, row.role);
    if (!isPriorityTurnKind(kind)) continue;
    pushItem(row.text);
    if (items.length >= Math.max(1, Math.floor(Number(maxItems) || 6))) break;
  }

  return items
    .slice(0, Math.max(1, Math.floor(Number(maxItems) || 6)))
    .map((row, idx) => `${idx + 1}. ${row}`)
    .join('\n');
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
    const directivesPath = this._memoryPath(jobId, "directives.json");
    const turnsPath = this._memoryPath(jobId, "turns.jsonl");
    if (summaryPath) {
      writeFileIfMissing(summaryPath, "# rolling summary\n\n");
    }
    if (pinsPath) {
      writeFileIfMissing(pinsPath, "{\n  \"items\": []\n}\n");
    }
    if (directivesPath) {
      writeFileIfMissing(directivesPath, "{\n  \"items\": []\n}\n");
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

  _jobDir(jobId) {
    return this.jobs && typeof this.jobs.jobDir === 'function' ? this.jobs.jobDir(jobId) : '';
  }

  _loadDirectiveEntries(jobId) {
    const localPath = this._memoryPath(jobId, 'directives.json');
    const localPayload = asObject(parseJsonMaybe(readFileIfExists(localPath)));
    const legacyPins = this._loadPins(jobId);
    const jobDir = this._jobDir(jobId);
    const externalPaths = [
      jobDir ? path.join(jobDir, 'shared', 'user_directives.json') : '',
      jobDir ? path.join(jobDir, 'workspace', '.orchestrator', 'user_directives.json') : '',
    ].filter(Boolean);
    const externalEntries = [];
    for (const filePath of externalPaths) {
      const payload = asObject(parseJsonMaybe(readFileIfExists(filePath)));
      externalEntries.push(...normalizeDirectiveEntries(payload.items || payload.directives || [], { pinnedFallback: true }));
    }
    return normalizeDirectiveEntries([
      ...(Array.isArray(localPayload.items) ? localPayload.items : []),
      ...(Array.isArray(legacyPins.items) ? legacyPins.items : []),
      ...(Array.isArray(legacyPins.facts) ? legacyPins.facts : []),
      ...externalEntries,
    ], { pinnedFallback: false });
  }

  _recordStickyDirectives(jobId, directives = []) {
    const cleanJobId = String(jobId || '').trim();
    if (!cleanJobId) return null;
    const normalized = normalizeDirectiveEntries(directives, { pinnedFallback: true });
    if (normalized.length === 0) return null;
    const filePath = this._memoryPath(cleanJobId, 'directives.json');
    const existingPayload = asObject(parseJsonMaybe(readFileIfExists(filePath)));
    const merged = normalizeDirectiveEntries([
      ...normalized,
      ...(Array.isArray(existingPayload.items) ? existingPayload.items : []),
    ], { pinnedFallback: false }).slice(0, 12);
    try {
      fs.writeFileSync(filePath, `${JSON.stringify({ items: merged }, null, 2)}
`, 'utf8');
      return merged.length;
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

  _loadAllTurns(jobId) {
    return this._loadTurnsFromJsonl(jobId, Number.MAX_SAFE_INTEGER);
  }

  _findLatestPriorityTurnInfo(turns = []) {
    const rows = Array.isArray(turns) ? turns : [];
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i] || {};
      if (normalizeRole(row.role) !== 'user') continue;
      const kind = classifyTurnKind(row.text, row.role);
      if (!isPriorityTurnKind(kind)) continue;
      return { index: i, ts: String(row.ts || '').trim(), kind, text: String(row.text || '').trim() };
    }
    return { index: -1, ts: '', kind: '', text: '' };
  }

  _selectTurnsForContext(jobId, { maxTurns = 8, taskPacket = null } = {}) {
    const rows = this._loadAllTurns(jobId);
    if (rows.length === 0) return [];
    const limit = Math.max(2, Math.floor(Number(maxTurns) || 8));
    if (rows.length <= limit) return rows;

    const packet = taskPacket && typeof taskPacket === 'object' ? taskPacket : null;
    const anchorQuotes = packet ? [
      ...(Array.isArray(packet.phase_user_quotes) ? packet.phase_user_quotes : []),
      String(packet.latest_user_quote || '').trim(),
      ...(Array.isArray(packet.carry_forward_quotes) ? packet.carry_forward_quotes.slice(0, 2) : []),
    ].map((row) => String(row || '').trim()).filter(Boolean) : [];
    if (anchorQuotes.length > 0) {
      const selectedIdx = new Set();
      for (const quote of anchorQuotes) {
        const key = quote.toLowerCase();
        for (let i = rows.length - 1; i >= 0; i -= 1) {
          const text = String(rows[i]?.text || '').trim().toLowerCase();
          if (!text || text !== key) continue;
          selectedIdx.add(i);
          if (i - 1 >= 0) selectedIdx.add(i - 1);
          if (i + 1 < rows.length) selectedIdx.add(i + 1);
          break;
        }
        if (selectedIdx.size >= limit) break;
      }
      if (selectedIdx.size > 0) {
        const selected = [...selectedIdx].sort((a, b) => a - b).map((idx) => rows[idx]).filter(Boolean);
        if (selected.length >= limit) return selected.slice(selected.length - limit);
        const remainder = [];
        for (let i = rows.length - 1; i >= 0 && (selected.length + remainder.length) < limit; i -= 1) {
          if (selectedIdx.has(i)) continue;
          const role = normalizeRole(rows[i]?.role);
          if (role !== 'user' && role !== 'system') continue;
          remainder.unshift(rows[i]);
        }
        const merged = [...remainder, ...selected];
        return merged.length > limit ? merged.slice(merged.length - limit) : merged;
      }
    }

    const priority = this._findLatestPriorityTurnInfo(rows);
    if (priority.index >= 0) {
      let selected = rows.slice(priority.index);
      if (selected.length > limit) return selected.slice(selected.length - limit);
      const prefix = [];
      for (let i = priority.index - 1; i >= 0 && (prefix.length + selected.length) < limit; i -= 1) {
        const row = rows[i] || {};
        const role = normalizeRole(row.role);
        const kind = classifyTurnKind(row.text, row.role);
        if (role === 'user' || role === 'system' || isPriorityTurnKind(kind)) {
          prefix.unshift(row);
        }
      }
      selected = [...prefix, ...selected];
      return selected.length > limit ? selected.slice(selected.length - limit) : selected;
    }

    return rows.slice(rows.length - limit);
  }

  _findLatestDirectiveTs(jobId) {
    const turns = this._loadAllTurns(jobId);
    return String(this._findLatestPriorityTurnInfo(turns)?.ts || '').trim();
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
    taskPacketText = "",
    activeDirectivesText = "",
    pinsText = "",
    summaryText = "",
    roleSummaryText = "",
    deltaSummaryText = "",
    turns = [],
    toolSnippets = [],
    includeToolSnippets = true,
    memoryTopologyText = "",
    chatMemoryAnchorText = "",
    memoryDemandText = "",
  } = {}) {
    const sections = [];
    if (focusHeader) sections.push(`[FOCUS]\n${focusHeader}`);
    if (chatMemoryAnchorText) sections.push(chatMemoryAnchorText);
    if (memoryTopologyText) sections.push(memoryTopologyText);
    if (memoryDemandText) sections.push(memoryDemandText);
    if (constraintsText) sections.push(`[JOB CONSTRAINTS]\n${constraintsText}`);
    if (taskPacketText) sections.push(taskPacketText);
    if (activeDirectivesText) sections.push(`[ACTIVE DIRECTIVES]\n${activeDirectivesText}`);
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
    taskPacketText = "",
    activeDirectivesText = "",
    pinsText = "",
    summaryText = "",
    roleSummaryText = "",
    deltaSummaryText = "",
    turns = [],
    toolSnippets = [],
    memoryTopologyText = "",
    chatMemoryAnchorText = "",
    memoryDemandText = "",
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
      taskPacketText,
      activeDirectivesText,
      pinsText,
      summaryText: workingSummary,
      roleSummaryText: workingRoleSummary,
      deltaSummaryText: workingDeltaSummary,
      turns: workingTurns,
      toolSnippets,
      includeToolSnippets: includeTools,
      memoryTopologyText,
      chatMemoryAnchorText,
      memoryDemandText,
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
        taskPacketText,
        activeDirectivesText,
        pinsText,
        summaryText: workingSummary,
        roleSummaryText: workingRoleSummary,
        deltaSummaryText: workingDeltaSummary,
        turns: workingTurns,
        toolSnippets,
        includeToolSnippets: includeTools,
        memoryTopologyText,
        chatMemoryAnchorText,
        memoryDemandText,
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
    const directiveEntries = this._loadDirectiveEntries(normalized.jobId);
    const pinsText = formatDirectiveEntries(directiveEntries, { onlyPinned: true, maxItems: 8 }) || formatPinsSection(pinsPayload);
    const resolvedJobDir = this.jobs && typeof this.jobs.jobDir === "function" ? this.jobs.jobDir(normalized.jobId) : "";
    const taskPacket = loadCurrentTaskPacket({
      jobDir: resolvedJobDir,
      runMeta: normalized.runMeta,
      currentUserText: normalized.stepKind === 'router' ? normalized.userMessageText : '',
      refresh: normalized.stepKind === 'router' && !!String(normalized.userMessageText || '').trim(),
    });
    const taskPacketText = renderTaskPacket(taskPacket, { roleId: normalized.roleId, maxChars: 1800 });
    const memoryTopology = resolvedJobDir
      ? planMemoryTopology({
          jobDir: resolvedJobDir,
          runMeta: normalized.runMeta,
          userText: normalized.userMessageText || normalized.goal,
          roleId: normalized.roleId,
          agentId: normalized.agentId,
          provider: normalized.provider || normalized.runMeta?.provider || '',
          persist: true,
          eventReason: normalized.stepKind === 'router' ? 'router_context' : 'agent_context',
        })
      : null;
    const memoryGrant = memoryTopology
      ? getAgentMemoryGrant(memoryTopology, { agentId: normalized.agentId, roleId: normalized.roleId, provider: normalized.provider || normalized.runMeta?.provider || '' })
      : null;
    const memoryTopologyText = memoryTopology
      ? buildMemoryTopologyPromptBlock(memoryTopology, memoryGrant)
      : '';
    const chatMemoryAnchor = resolvedJobDir
      ? updateChatMemoryAnchor({
          jobDir: resolvedJobDir,
          jobId: normalized.jobId,
          chatId: normalized.chatId,
          threadId: normalized.runMeta?.threadId || normalized.runMeta?.thread_id || normalized.threadId || '',
          runId: normalized.runMeta?.runId || normalized.runMeta?.run_id || '',
          topology: memoryTopology,
          reason: normalized.stepKind === 'router' ? 'router_context' : 'agent_context',
          userText: normalized.userMessageText || normalized.goal || '',
        })
      : null;
    const chatMemoryAnchorText = chatMemoryAnchor ? buildChatMemoryAnchorPromptBlock(chatMemoryAnchor) : '';
    const summaryText = this._loadSummary(normalized.jobId);
    const latestDirectiveTs = this._findLatestDirectiveTs(normalized.jobId);
    const recentTurns = this._selectTurnsForContext(
      normalized.jobId,
      { maxTurns: clamp(process.env.LOCAL_RECENT_TURNS, 2, 30, this.defaultRecentTurns), taskPacket }
    );
    const activeDirectivesText = buildActiveDirectivesText({ turns: recentTurns, directiveEntries, maxItems: 6 });
    const includeRoleLocalMemory = normalized.stepKind === "agent" && shouldIncludeRoleLocalMemory(memoryTopology || {}, memoryGrant);
    const roleSummaryText = includeRoleLocalMemory
      ? readRoleSummary({ jobDir: resolvedJobDir, roleId: normalized.roleId, agentId: normalized.agentId, sinceTs: latestDirectiveTs })
      : "";
    const deltaSummaryText = includeRoleLocalMemory
      ? readIterationDelta({ jobDir: resolvedJobDir, sinceTs: latestDirectiveTs })
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
    const memoryDemand = resolvedJobDir
      ? buildMemoryDemandContext({
          jobDir: resolvedJobDir,
          userText: normalized.userMessageText || normalized.goal || '',
          goal: normalized.goal || '',
          roleId: normalized.roleId,
          agentId: normalized.agentId,
          runMeta: normalized.runMeta,
          scopeHint: normalized.lensSpec,
          routerMemoryPlan: normalized.runMeta?.memoryRouting || normalized.runMeta?.memory_routing || null,
          persist: true,
          reason: normalized.stepKind === 'router' ? 'router_preflight' : 'agent_preflight',
          maxChars: clamp(process.env.MEMORY_DEMAND_CONTEXT_MAX_CHARS, 900, 6000, 2600),
        })
      : null;
    const memoryDemandText = memoryDemand?.text || '';

    const packed = this._enforceBudget({
      budgetTokens,
      focusHeader,
      constraintsText,
      taskPacketText,
      activeDirectivesText,
      pinsText,
      summaryText,
      roleSummaryText,
      deltaSummaryText,
      turns: recentTurns,
      toolSnippets,
      memoryTopologyText,
      chatMemoryAnchorText,
      memoryDemandText,
    });

    return {
      contextText: packed.text,
      meta: {
        mode: "local",
        memoryTopologyMode: memoryTopology?.mode || undefined,
        memoryTopologyStress: memoryTopology?.stress?.score,
        chatMemoryAnchorJobId: chatMemoryAnchor?.job_id || undefined,
        chatMemoryAnchorThreadId: chatMemoryAnchor?.thread_id || undefined,
        memoryReadSurfaces: memoryGrant?.read || undefined,
        memoryWriteSurfaces: memoryGrant?.write || undefined,
        memoryDemandReasons: memoryDemand?.demand?.reasons || undefined,
        memoryDemandSources: memoryDemand?.sources || undefined,
        memoryDemandItems: memoryDemand?.totalItems || 0,
        memoryDemandRetrievalMode: memoryDemand?.demand?.routerMemoryPlan?.classifier ? 'router_llm_preflight' : 'runtime_preflight',
        memoryDemandClassifier: memoryDemand?.demand?.routerMemoryPlan?.classifier || undefined,
        memoryDemandConfidence: memoryDemand?.demand?.routerMemoryPlan?.confidence,
        budgetTokens,
        estimatedTokens: packed.estimatedTokens,
        compiledChars: packed.text.length,
        localRecentTurnsCount: packed.recentTurnsCount,
        localSummaryChars: packed.summaryChars,
        localTaskPacketChars: taskPacketText.length,
        taskPacketVersion: Number.isFinite(Number(taskPacket?.version)) ? Math.floor(Number(taskPacket.version)) : undefined,
        taskPacketDeliverablesCount: Array.isArray(taskPacket?.deliverables) ? taskPacket.deliverables.length : 0,
        taskPacketProhibitionsCount: Array.isArray(taskPacket?.prohibitions) ? taskPacket.prohibitions.length : 0,
        localActiveDirectivesCount: activeDirectivesText ? activeDirectivesText.split('\n').filter(Boolean).length : 0,
        localPinnedCount: formatDirectiveEntries(directiveEntries, { onlyPinned: true, maxItems: 99 })
          ? formatDirectiveEntries(directiveEntries, { onlyPinned: true, maxItems: 99 }).split('\n').filter(Boolean).length
          : 0,
        latestDirectiveTs: latestDirectiveTs || undefined,
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
    const assistantSummaryText = summarizeAssistantForRollingSummary(assistantText);
    const assistantTurnText = isNoisyAssistantTelemetry(assistantText) ? '' : assistantText;
    if (!userText && !assistantSummaryText && !assistantTurnText) return null;

    const summaryPath = this._memoryPath(jobId, "summary.md");
    const currentSummary = String(readFileIfExists(summaryPath) || "").trim();
    const summaryBody = currentSummary.startsWith("# rolling summary")
      ? currentSummary.slice("# rolling summary".length).trim()
      : currentSummary;

    const recentSection = [
      "## recent",
      userText ? `- user: ${userText}` : "",
      assistantSummaryText ? `- assistant: ${assistantSummaryText}` : "",
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
    }
    if (assistantTurnText) {
      this.appendLocalLog(jobId, "turns.jsonl", {
        role: "assistant",
        text: assistantTurnText,
      });
    }
    const resolvedJobDir = this._jobDir(jobId);
    if (resolvedJobDir && userText) {
      updateCurrentTaskPacket({ jobDir: resolvedJobDir, currentUserText: userText, runMeta: row.runMeta || {}, persist: true });
    }
    let idleMaintenance = null;
    let chatMemoryAnchor = null;
    if (resolvedJobDir) {
      try {
        idleMaintenance = runIdleMemoryMaintenance({
          jobDir: resolvedJobDir,
          jobId,
          chatId: row.chatId || '',
          threadId: row.threadId || row.runMeta?.threadId || row.runMeta?.thread_id || '',
          runId: row.runMeta?.runId || row.runMeta?.run_id || '',
          force: false,
        });
      } catch (error) {
        idleMaintenance = { ok: false, error: String(error?.message || error || 'unknown') };
      }
      try {
        chatMemoryAnchor = updateChatMemoryAnchor({
          jobDir: resolvedJobDir,
          jobId,
          chatId: row.chatId || '',
          threadId: row.threadId || row.runMeta?.threadId || row.runMeta?.thread_id || '',
          runId: row.runMeta?.runId || row.runMeta?.run_id || '',
          topology: idleMaintenance?.topology || null,
          reason: 'run_end',
          userText,
          assistantText: assistantTurnText || assistantSummaryText,
        });
      } catch {}
    }
    return {
      ok: true,
      summaryChars: nextSummary.length,
      idleMaintenance,
      chatMemoryAnchor,
    };
  }

  async recordMeta(args = {}) {
    const row = asObject(args);
    const jobId = String(row.jobId || "").trim();
    if (jobId) this._ensureMemoryFiles(jobId);
    const meta = asObject(row.meta);
    const runMeta = asObject(row.runMeta);
    this.appendLocalLog(jobId, "context_meta.jsonl", {
      mode: "local",
      step_kind: String(row.stepKind || "").trim() || undefined,
      agent_id: String(row.agentId || "").trim().toLowerCase() || undefined,
      role_id: String(row.roleId || row.role_id || "").trim().toLowerCase() || undefined,
      goal: clip(String(row.goal || "").trim(), 320) || undefined,
      run_meta: compactRunMetaForContextLog(runMeta),
      context_meta: meta,
    }, { force: true });

    const userMessageText = String(row.userMessageText || "").trim();
    if (userMessageText) {
      const normalizedStepKind = String(row.stepKind || "").trim().toLowerCase();
      this.appendLocalLog(jobId, "turns.jsonl", {
        role: normalizedStepKind === "router" ? "user" : "system",
        text: clip(userMessageText, 1000),
      });
      if (normalizedStepKind === 'router') {
        const resolvedJobDir = this._jobDir(jobId);
        if (resolvedJobDir) {
          updateCurrentTaskPacket({ jobDir: resolvedJobDir, currentUserText: userMessageText, runMeta, persist: true });
        }
      }
    }
    const stickyDirectives = Array.isArray(row.stickyDirectives || row.sticky_directives)
      ? (row.stickyDirectives || row.sticky_directives)
      : (Array.isArray(runMeta.context_directives || runMeta.contextDirectives) ? (runMeta.context_directives || runMeta.contextDirectives) : []);
    if (stickyDirectives.length > 0) {
      this._recordStickyDirectives(jobId, stickyDirectives);
    }
    return true;
  }
}
