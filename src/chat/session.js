import fs from "node:fs";
import path from "node:path";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePendingApproval(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = { ...raw };
  const previewLines = Array.isArray(row.preview_lines)
    ? row.preview_lines.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  const actionsSummary = Array.isArray(row.actions_summary)
    ? row.actions_summary.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    ...row,
    id: String(row.id || "").trim(),
    chat_id: String(row.chat_id || "").trim(),
    job_id: String(row.job_id || "").trim(),
    reason: String(row.reason || "").trim(),
    ts: String(row.ts || nowIso()),
    original_user_text: String(row.original_user_text || "").trim(),
    force_mode: String(row.force_mode || "").trim().toLowerCase() === "work" ? "work" : "normal",
    gate_type: String(row.gate_type || "").trim() || undefined,
    mode_choice_required: row.mode_choice_required === true,
    preview_reason: String(row.preview_reason || row.reason || "").trim() || undefined,
    actions_summary: actionsSummary,
    action_source: String(row.action_source || row.actionSource || "").trim() || undefined,
    checkpoint_id: String(row.checkpoint_id || "").trim() || undefined,
    checkpoint_ids: Array.isArray(row.checkpoint_ids)
      ? row.checkpoint_ids.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 16)
      : [],
    checkpoint_status: String(row.checkpoint_status || "").trim() || undefined,
    supervisor_runtime: row.supervisor_runtime && typeof row.supervisor_runtime === "object"
      ? row.supervisor_runtime
      : (row.supervisorRuntime && typeof row.supervisorRuntime === "object" ? row.supervisorRuntime : undefined),
    runtime_team_snapshot: row.runtime_team_snapshot && typeof row.runtime_team_snapshot === "object"
      ? row.runtime_team_snapshot
      : (row.runtimeTeamSnapshot && typeof row.runtimeTeamSnapshot === "object" ? row.runtimeTeamSnapshot : undefined),
    cancel_impact: String(row.cancel_impact || "").trim() || undefined,
    preview_lines: previewLines,
  };
}

function normalizePublicSearchCache(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const blueprintId = String(row.blueprint_id || row.blueprintId || "").trim();
    const publicNodeId = String(row.public_node_id || row.publicNodeId || row.node_id || "").trim();
    const agentId = String(row.agent_id || row.agentId || "").trim().toLowerCase();
    if (!blueprintId && !publicNodeId && !agentId) continue;
    out.push({
      blueprint_id: blueprintId,
      public_node_id: publicNodeId,
      agent_id: agentId,
      title: String(row.title || "").trim(),
      tags: Array.isArray(row.tags)
        ? row.tags.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 16)
        : [],
      updated_at: String(row.updated_at || nowIso()),
    });
    if (out.length >= 20) break;
  }
  return out;
}


function clipSessionText(value = "", max = 5000) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeRecentAgentTurns(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const agentId = String(row.agent_id || row.agentId || row.id || "").trim().toLowerCase();
    if (!agentId) continue;
    out.push({
      agent_id: agentId,
      agent_name: String(row.agent_name || row.agentName || row.name || "").trim(),
      role: String(row.role || row.role_id || row.roleId || "").trim().toLowerCase(),
      provider: String(row.provider || "").trim().toLowerCase(),
      model: String(row.model || "").trim(),
      goal: clipSessionText(row.goal, 1200),
      output: clipSessionText(row.output, 5000),
      runtime_instance_id: String(row.runtime_instance_id || row.runtimeInstanceId || "").trim() || undefined,
      slot_id: String(row.slot_id || row.slotId || "").trim() || undefined,
      scope_id: String(row.scope_id || row.scopeId || "").trim() || undefined,
      ts: String(row.ts || nowIso()),
      job_id: String(row.job_id || row.jobId || "").trim() || undefined,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeAgentStatusMap(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [agentIdRaw, statusRaw] of Object.entries(row)) {
    const agentId = String(agentIdRaw || "").trim().toLowerCase();
    if (!agentId) continue;
    const status = statusRaw && typeof statusRaw === "object" ? statusRaw : {};
    const state = String(status.state || "").trim().toLowerCase();
    const normalizedState = ["queued", "running", "done", "error"].includes(state)
      ? state
      : "queued";
    out[agentId] = {
      state: normalizedState,
      goal: String(status.goal || "").trim(),
      started_at: String(status.started_at || status.startedAt || "").trim() || undefined,
      ended_at: String(status.ended_at || status.endedAt || "").trim() || undefined,
    };
  }
  return out;
}


function normalizeSessionTeamConfig(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const activeTeam = row.active_team && typeof row.active_team === 'object' ? row.active_team : null;
  const pendingTeam = row.pending_team && typeof row.pending_team === 'object' ? row.pending_team : null;
  return {
    status: String(row.status || (activeTeam ? 'active' : pendingTeam ? 'suggested' : 'none')).trim().toLowerCase() || 'none',
    active_team: activeTeam,
    pending_team: pendingTeam,
    updated_at: String(row.updated_at || nowIso()),
  };
}

function normalizeSession(chatId, raw = {}) {
  const row = asObject(raw);
  const budgetRaw = asObject(row.budget);
  const pendingMessagesRaw = Array.isArray(row.pending_user_messages)
    ? row.pending_user_messages
    : [];
  const pendingUserMessages = [];
  for (const entry of pendingMessagesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const text = String(entry.text || "").trim();
    if (!text) continue;
    pendingUserMessages.push({
      ts: String(entry.ts || nowIso()),
      user_id: String(entry.user_id || entry.userId || "").trim(),
      text,
      force_mode: String(entry.force_mode || entry.forceMode || "").trim().toLowerCase() === "work" ? "work" : "normal",
      telegram_message_id: Number.isFinite(Number(entry.telegram_message_id))
        ? Number(entry.telegram_message_id)
        : (Number.isFinite(Number(entry.telegramMessageId))
          ? Number(entry.telegramMessageId)
          : null),
    });
    if (pendingUserMessages.length >= 50) break;
  }
  const interruptRaw = row.interrupt && typeof row.interrupt === "object" ? row.interrupt : null;
  const interruptMode = String(interruptRaw?.mode || "").trim().toLowerCase();
  const interrupt = interruptRaw
    ? {
      requested: interruptRaw.requested !== false,
      mode: interruptMode === "cancel" ? "cancel" : "replan",
      reason: String(interruptRaw.reason || "").trim(),
      ts: String(interruptRaw.ts || nowIso()),
    }
    : null;
  const dashboardRaw = row.dashboard && typeof row.dashboard === "object" ? row.dashboard : null;
  const dashboardMessageId = Number.isFinite(Number(dashboardRaw?.message_id))
    ? Number(dashboardRaw.message_id)
    : (Number.isFinite(Number(dashboardRaw?.messageId))
      ? Number(dashboardRaw.messageId)
      : null);
  const currentTurnAckMessageId = Number.isFinite(Number(row.current_turn_ack_message_id))
    ? Number(row.current_turn_ack_message_id)
    : (Number.isFinite(Number(row.currentTurnAckMessageId))
      ? Number(row.currentTurnAckMessageId)
      : null);
  const currentTurnPlanMessageId = Number.isFinite(Number(row.current_turn_plan_message_id))
    ? Number(row.current_turn_plan_message_id)
    : (Number.isFinite(Number(row.currentTurnPlanMessageId))
      ? Number(row.currentTurnPlanMessageId)
      : null);
  return {
    chat_id: String(chatId || row.chat_id || "").trim(),
    jobId: String(row.jobId || "").trim(),
    state: String(row.state || "idle").trim() || "idle",
    active_run_id: String(row.active_run_id || row.activeRunId || "").trim() || null,
    budget: {
      max_actions: Number.isFinite(Number(budgetRaw.max_actions)) ? Math.max(1, Math.floor(Number(budgetRaw.max_actions))) : 4,
      used_actions: Number.isFinite(Number(budgetRaw.used_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.used_actions))) : 0,
      blocked_actions: Number.isFinite(Number(budgetRaw.blocked_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.blocked_actions))) : 0,
    },
    pending_approval: normalizePendingApproval(row.pending_approval),
    pending_user_messages: pendingUserMessages,
    interrupt,
    dashboard: dashboardMessageId ? { message_id: dashboardMessageId } : null,
    current_turn_ack_message_id: currentTurnAckMessageId,
    current_turn_plan_message_id: currentTurnPlanMessageId,
    agent_status: normalizeAgentStatusMap(row.agent_status),
    recent_agent_turns: normalizeRecentAgentTurns(row.recent_agent_turns || row.recentAgentTurns),
    last_route: row.last_route && typeof row.last_route === "object" ? row.last_route : null,
    public_search_cache: normalizePublicSearchCache(row.public_search_cache),
    team_config: normalizeSessionTeamConfig(row.team_config),
    updated_at: String(row.updated_at || nowIso()),
  };
}

function normalizeStore(raw = {}) {
  const row = asObject(raw);
  const sessionsRaw = asObject(row.sessions);
  const sessions = {};
  for (const [chatId, session] of Object.entries(sessionsRaw)) {
    const key = String(chatId || "").trim();
    if (!key) continue;
    sessions[key] = normalizeSession(key, session);
  }
  return {
    version: 1,
    updated_at: String(row.updated_at || nowIso()),
    sessions,
  };
}

export class ChatSessionStore {
  constructor({ baseDir } = {}) {
    const dir = path.resolve(baseDir || process.cwd());
    this.filePath = path.join(dir, "chat_sessions.json");
    this.state = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizeStore(parsed);
    } catch {
      return normalizeStore({});
    }
  }

  _save(next) {
    const normalized = normalizeStore(next);
    normalized.updated_at = nowIso();
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    this.state = normalized;
    return normalized;
  }

  get(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return normalizeSession("", {});
    const found = this.state.sessions[key];
    return normalizeSession(key, found || {});
  }

  upsert(chatId, patchOrUpdater = {}) {
    const key = String(chatId || "").trim();
    if (!key) throw new Error("ChatSessionStore.upsert requires chatId");
    const current = this.get(key);
    const patch = typeof patchOrUpdater === "function"
      ? asObject(patchOrUpdater(current))
      : asObject(patchOrUpdater);
    const next = normalizeSession(key, {
      ...current,
      ...patch,
      budget: {
        ...current.budget,
        ...(patch.budget && typeof patch.budget === "object" ? patch.budget : {}),
      },
      updated_at: nowIso(),
    });
    this._save({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [key]: next,
      },
    });
    return next;
  }

  clear(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return;
    const nextSessions = { ...this.state.sessions };
    delete nextSessions[key];
    this._save({
      ...this.state,
      sessions: nextSessions,
    });
  }
}
