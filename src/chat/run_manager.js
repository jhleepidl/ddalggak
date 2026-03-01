function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePendingEntry(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const text = String(row.text || "").trim();
  if (!text) return null;
  return {
    ts: String(row.ts || nowIso()),
    user_id: String(row.user_id || row.userId || "").trim(),
    text,
    telegram_message_id: Number.isFinite(Number(row.telegram_message_id))
      ? Number(row.telegram_message_id)
      : (Number.isFinite(Number(row.telegramMessageId))
        ? Number(row.telegramMessageId)
        : null),
  };
}

export function mergePendingMessages(list = []) {
  const rows = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const normalized = normalizePendingEntry(entry);
    if (normalized) rows.push(normalized);
  }
  if (rows.length === 0) {
    return {
      text: "",
      latest: null,
      rows: [],
      count: 0,
    };
  }
  const latest = rows[rows.length - 1];
  const previous = rows.slice(0, -1).map((row) => row.text).filter(Boolean);
  const extras = previous.length > 0
    ? `\n\n추가 지시사항:\n${previous.map((row) => `- ${row}`).join("\n")}`
    : "";
  return {
    text: `${latest.text}${extras}`.trim(),
    latest,
    rows,
    count: rows.length,
  };
}

export class ChatRunManager {
  constructor({
    sessionStore,
    runChat,
    cancelCurrent = null,
    onAck = null,
    onRunError = null,
    interruptDebounceMs = 500,
  } = {}) {
    if (!sessionStore || typeof sessionStore.get !== "function" || typeof sessionStore.upsert !== "function") {
      throw new Error("ChatRunManager requires sessionStore");
    }
    if (typeof runChat !== "function") {
      throw new Error("ChatRunManager requires runChat callback");
    }
    this.sessionStore = sessionStore;
    this.runChat = runChat;
    this.cancelCurrent = cancelCurrent;
    this.onAck = onAck;
    this.onRunError = onRunError;
    const debounceRaw = Number(interruptDebounceMs);
    this.interruptDebounceMs = Number.isFinite(debounceRaw) ? Math.max(0, Math.floor(debounceRaw)) : 500;
    this.chatState = new Map();
  }

  _slot(chatId) {
    const key = String(chatId || "").trim();
    if (!this.chatState.has(key)) {
      this.chatState.set(key, {
        running: false,
        promise: null,
        lastAckAtMs: 0,
        chatInfo: null,
        nextInputKind: null,
      });
    }
    return this.chatState.get(key);
  }

  _markInterrupt(chatId, mode, reason) {
    const now = nowIso();
    this.sessionStore.upsert(chatId, (session) => ({
      ...session,
      interrupt: {
        requested: true,
        mode: mode === "cancel" ? "cancel" : "replan",
        reason: String(reason || "").trim(),
        ts: now,
      },
    }));
  }

  _appendPending(chatId, { userId = "", text = "", telegramMessageId = null } = {}) {
    const normalized = normalizePendingEntry({
      ts: nowIso(),
      user_id: String(userId || "").trim(),
      text,
      telegram_message_id: telegramMessageId,
    });
    if (!normalized) return;
    this.sessionStore.upsert(chatId, (session) => {
      const current = Array.isArray(session.pending_user_messages) ? session.pending_user_messages : [];
      return {
        ...session,
        pending_user_messages: [...current, normalized].slice(-50),
      };
    });
  }

  _drainPending(chatId) {
    let rows = [];
    this.sessionStore.upsert(chatId, (session) => {
      rows = Array.isArray(session.pending_user_messages) ? session.pending_user_messages : [];
      return {
        ...session,
        pending_user_messages: [],
      };
    });
    return rows;
  }

  async _cancelCurrent(chatId, { mode = "replan", reason = "" } = {}) {
    if (typeof this.cancelCurrent !== "function") return;
    await this.cancelCurrent({
      chatId,
      mode,
      reason,
    });
  }

  async _ack(chatId, mode, reason) {
    if (typeof this.onAck !== "function") return;
    const slot = this._slot(chatId);
    const now = Date.now();
    if (mode === "replan" && this.interruptDebounceMs > 0 && (now - slot.lastAckAtMs) < this.interruptDebounceMs) {
      return;
    }
    slot.lastAckAtMs = now;
    await this.onAck({
      chatId,
      mode,
      reason,
    });
  }

  _startDrain(chatId) {
    const slot = this._slot(chatId);
    if (slot.running) return slot.promise;
    slot.running = true;
    slot.promise = this._drainLoop(chatId)
      .finally(() => {
        slot.running = false;
        slot.promise = null;
      });
    return slot.promise;
  }

  async _drainLoop(chatId) {
    while (true) {
      let batch = this._drainPending(chatId);
      if (!Array.isArray(batch) || batch.length === 0) break;

      if (this.interruptDebounceMs > 0) {
        await sleep(this.interruptDebounceMs);
        const extra = this._drainPending(chatId);
        if (Array.isArray(extra) && extra.length > 0) batch = [...batch, ...extra];
      }

      const merged = mergePendingMessages(batch);
      if (!merged.text) continue;
      const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      const slot = this._slot(chatId);
      const inputKind = slot.nextInputKind
        || (merged.count > 1 ? "interrupt_update" : "chat_message");
      slot.nextInputKind = null;
      this.sessionStore.upsert(chatId, (session) => ({
        ...session,
        active_run_id: runId,
        interrupt: null,
        state: "routing",
      }));

      try {
        const chatInfo = slot.chatInfo && typeof slot.chatInfo === "object"
          ? { ...slot.chatInfo }
          : null;
        await this.runChat({
          chatId,
          userId: merged.latest?.user_id || "",
          message: merged.text,
          runId,
          inputKind,
          pendingCount: merged.count,
          pendingRows: merged.rows,
          telegramMessageId: merged.latest?.telegram_message_id || null,
          chatInfo,
        });
      } catch (e) {
        if (typeof this.onRunError === "function") {
          await this.onRunError({
            chatId,
            message: merged.text,
            error: e,
          });
        }
      } finally {
        this.sessionStore.upsert(chatId, (session) => ({
          ...session,
          active_run_id: null,
          interrupt: null,
          state: session.pending_approval ? "awaiting_approval" : "idle",
        }));
      }

      const next = this.sessionStore.get(chatId);
      const pending = Array.isArray(next.pending_user_messages) ? next.pending_user_messages : [];
      if (pending.length === 0) break;
    }
  }

  isRunning(chatId) {
    return !!this._slot(chatId)?.running;
  }

  getState(chatId) {
    const slot = this._slot(chatId);
    return {
      running: !!slot.running,
      lastAckAtMs: Number(slot.lastAckAtMs || 0),
    };
  }

  async hardCancel({ chatId, reason = "", userId = "", telegramMessageId = null } = {}) {
    const cleanReason = String(reason || "").trim();
    const slot = this._slot(chatId);
    slot.nextInputKind = null;
    this.sessionStore.upsert(chatId, (session) => ({
      ...session,
      pending_approval: null,
      pending_user_messages: [],
      interrupt: {
        requested: true,
        mode: "cancel",
        reason: cleanReason || "user_cancel",
        ts: nowIso(),
      },
      state: "idle",
    }));
    await this._cancelCurrent(chatId, { mode: "cancel", reason: cleanReason || "user_cancel" });
    await this._ack(chatId, "cancel", cleanReason || "user_cancel");
    void userId;
    void telegramMessageId;
  }

  async handleIncoming({
    chatId,
    userId = "",
    text = "",
    telegramMessageId = null,
    chatInfo = null,
  } = {}) {
    const cleanText = String(text || "").trim();
    if (!cleanText) return { status: "ignored" };

    const slot = this._slot(chatId);
    if (chatInfo && typeof chatInfo === "object") {
      slot.chatInfo = { ...chatInfo };
    }
    this._appendPending(chatId, {
      userId,
      text: cleanText,
      telegramMessageId,
    });

    const session = this.sessionStore.get(chatId);
    const state = String(session.state || "idle").trim().toLowerCase();
    const busy = slot.running || state === "routing" || state === "executing";
    const awaitingApproval = state === "awaiting_approval" || !!session.pending_approval;

    if (busy || awaitingApproval) {
      this.sessionStore.upsert(chatId, {
        pending_approval: null,
      });
      slot.nextInputKind = "interrupt_update";
      this._markInterrupt(chatId, "replan", cleanText);
      await this._cancelCurrent(chatId, { mode: "replan", reason: cleanText });
      await this._ack(chatId, "replan", cleanText);
      if (!slot.running) this._startDrain(chatId);
      return { status: "queued_interrupt" };
    }

    this._startDrain(chatId);
    return { status: "started" };
  }
}
