import fs from "node:fs";
import path from "node:path";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSession(chatId, raw = {}) {
  const row = asObject(raw);
  const budgetRaw = asObject(row.budget);
  return {
    chat_id: String(chatId || row.chat_id || "").trim(),
    jobId: String(row.jobId || "").trim(),
    state: String(row.state || "idle").trim() || "idle",
    budget: {
      max_actions: Number.isFinite(Number(budgetRaw.max_actions)) ? Math.max(1, Math.floor(Number(budgetRaw.max_actions))) : 4,
      used_actions: Number.isFinite(Number(budgetRaw.used_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.used_actions))) : 0,
      blocked_actions: Number.isFinite(Number(budgetRaw.blocked_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.blocked_actions))) : 0,
    },
    pending_approval: row.pending_approval && typeof row.pending_approval === "object" ? row.pending_approval : null,
    last_route: row.last_route && typeof row.last_route === "object" ? row.last_route : null,
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

