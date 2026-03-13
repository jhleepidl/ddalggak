import fs from "node:fs";
import path from "node:path";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

function cleanId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

function uniqIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const id = cleanId(raw);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeTeamRow(raw = {}, {
  threadId = "",
  conversationId = "",
  defaultEnabled = true,
  orderIndex = 0,
  source = "",
} = {}) {
  const row = asObject(raw);
  const agentId = cleanId(row.agent_id || row.agentId || row.id);
  if (!agentId) return null;
  const enabledRaw = row.enabled;
  const enabled = typeof enabledRaw === "boolean" ? enabledRaw : (defaultEnabled !== false);
  const orderIdxRaw = Number(row.order_index ?? row.orderIndex ?? row.order);
  const normalizedOrder = Number.isFinite(orderIdxRaw) ? Math.max(0, Math.floor(orderIdxRaw)) : Math.max(0, Math.floor(Number(orderIndex) || 0));
  const overrides = asObject(row.overrides_json ?? row.overridesJson ?? row.overrides);
  const createdAt = String(row.created_at || row.createdAt || nowIso()).trim();
  const updatedAt = String(row.updated_at || row.updatedAt || nowIso()).trim();
  const cleanThreadId = String(row.thread_id || row.threadId || threadId).trim();
  const cleanConversationId = String(row.conversation_id || row.conversationId || conversationId).trim();
  return {
    id: String(row.id || `${cleanThreadId || "local"}:${agentId}`).trim(),
    thread_id: cleanThreadId,
    conversation_id: cleanConversationId,
    agent_id: agentId,
    enabled,
    order_index: normalizedOrder,
    overrides_json: overrides,
    order: normalizedOrder,
    overrides,
    created_at: createdAt,
    updated_at: updatedAt,
    source: String(source || row.source || "").trim() || undefined,
    raw: row.raw && typeof row.raw === "object" ? row.raw : row,
  };
}

function sortTeamRows(rows = []) {
  return asArray(rows)
    .map((row, idx) => ({ row, idx }))
    .sort((a, b) => {
      const ao = Number(a.row?.order_index ?? a.row?.order ?? a.idx);
      const bo = Number(b.row?.order_index ?? b.row?.order ?? b.idx);
      if (Number.isFinite(ao) && Number.isFinite(bo) && ao !== bo) return ao - bo;
      return String(a.row?.agent_id || "").localeCompare(String(b.row?.agent_id || ""));
    })
    .map((entry) => entry.row);
}

function summarizeTarget(target = {}, fallback = {}) {
  const row = asObject(target);
  const fallbackRow = asObject(fallback);
  return {
    thread_id: String(
      row.thread_id
      || row.threadId
      || fallbackRow.thread_id
      || fallbackRow.threadId
      || ""
    ).trim(),
    conversation_id: String(
      row.conversation_id
      || row.conversationId
      || fallbackRow.conversation_id
      || fallbackRow.conversationId
      || ""
    ).trim(),
    workspace_id: String(
      row.workspace_id
      || row.workspaceId
      || fallbackRow.workspace_id
      || fallbackRow.workspaceId
      || ""
    ).trim(),
    account_id: String(
      row.account_id
      || row.accountId
      || fallbackRow.account_id
      || fallbackRow.accountId
      || ""
    ).trim(),
    source: String(row.source || fallbackRow.source || "").trim() || undefined,
    ensure_error: row.ensure_error || fallbackRow.ensure_error || null,
    ensured_thread_mismatch: row.ensured_thread_mismatch === true || fallbackRow.ensured_thread_mismatch === true,
    requested_target: row.requested_target && typeof row.requested_target === "object" ? row.requested_target : undefined,
    ensured_target: row.ensured_target && typeof row.ensured_target === "object" ? row.ensured_target : undefined,
  };
}

function normalizeWarnings(list = []) {
  return asArray(list).map((line) => String(line || "").trim()).filter(Boolean);
}

function localThreadId(jobId = "") {
  return `local:${String(jobId || "").trim()}`;
}

function normalizeLocalState(raw = {}, { jobId = "" } = {}) {
  const row = asObject(raw);
  const cleanJobId = String(jobId || row.job_id || "").trim();
  const threadId = String(row.thread_id || localThreadId(cleanJobId)).trim();
  const conversationId = String(row.conversation_id || localThreadId(cleanJobId)).trim();
  const rows = sortTeamRows(
    asArray(row.agents).map((entry, index) => normalizeTeamRow(entry, {
      threadId,
      conversationId,
      orderIndex: index,
      source: "local",
    })).filter(Boolean)
  );
  return {
    version: 1,
    job_id: cleanJobId,
    thread_id: threadId,
    conversation_id: conversationId,
    agents: rows.map((entry, index) => ({
      agent_id: cleanId(entry.agent_id),
      enabled: entry.enabled !== false,
      order_index: Number.isFinite(Number(entry.order_index)) ? Number(entry.order_index) : index,
      overrides_json: asObject(entry.overrides_json),
      created_at: String(entry.created_at || nowIso()),
      updated_at: String(entry.updated_at || nowIso()),
    })),
    updated_at: String(row.updated_at || nowIso()),
  };
}

export class LocalConversationTeamStore {
  constructor({
    jobs = null,
    baseDir = "",
    logger = null,
  } = {}) {
    this.source = "local";
    this.jobs = jobs || null;
    this.baseDir = String(baseDir || "").trim();
    this.logger = normalizeLogger(logger);
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  _jobDir(jobId = "") {
    const cleanJobId = String(jobId || "").trim();
    if (!cleanJobId) throw new Error("LocalConversationTeamStore requires jobId");
    if (this.jobs && typeof this.jobs.jobDir === "function") {
      return this.jobs.jobDir(cleanJobId);
    }
    if (!this.baseDir) throw new Error("LocalConversationTeamStore requires jobs or baseDir");
    const dir = path.join(this.baseDir, cleanJobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _statePath(jobId = "") {
    const dir = path.join(this._jobDir(jobId), "state");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "conversation_team.json");
  }

  _readState(jobId = "") {
    const cleanJobId = String(jobId || "").trim();
    const p = this._statePath(cleanJobId);
    if (!fs.existsSync(p)) {
      return normalizeLocalState({}, { jobId: cleanJobId });
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
      return normalizeLocalState(parsed, { jobId: cleanJobId });
    } catch {
      return normalizeLocalState({}, { jobId: cleanJobId });
    }
  }

  _writeState(jobId = "", state = {}) {
    const cleanJobId = String(jobId || "").trim();
    const normalized = normalizeLocalState(state, { jobId: cleanJobId });
    const p = this._statePath(cleanJobId);
    fs.writeFileSync(p, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return normalized;
  }

  _rowsFromState(state = {}) {
    const normalized = normalizeLocalState(state, { jobId: state?.job_id || "" });
    return sortTeamRows(
      asArray(normalized.agents).map((entry, index) => normalizeTeamRow(entry, {
        threadId: normalized.thread_id,
        conversationId: normalized.conversation_id,
        orderIndex: index,
        source: "local",
      })).filter(Boolean)
    );
  }

  _buildResult(state = {}, warnings = []) {
    const normalized = normalizeLocalState(state, { jobId: state?.job_id || "" });
    return {
      target: summarizeTarget({
        thread_id: normalized.thread_id,
        conversation_id: normalized.conversation_id,
        source: "local",
      }),
      rows: this._rowsFromState(normalized),
      warnings: normalizeWarnings(warnings),
    };
  }

  async listAgents({ jobId = "" } = {}) {
    const state = this._readState(jobId);
    return this._buildResult(state);
  }

  async ensureTeam({
    jobId = "",
    baselineAgentIds = [],
  } = {}) {
    const state = this._readState(jobId);
    if (asArray(state.agents).length === 0) {
      let index = 0;
      state.agents = uniqIds(baselineAgentIds).map((agentId) => ({
        agent_id: agentId,
        enabled: true,
        order_index: index++,
        overrides_json: {},
        created_at: nowIso(),
        updated_at: nowIso(),
      }));
      state.updated_at = nowIso();
      this._writeState(jobId, state);
      this._log(`[team-store:local] bootstrap job=${String(jobId || "").trim()} count=${state.agents.length}`);
    }
    return this._buildResult(state);
  }

  async addAgent({
    jobId = "",
    agentId = "",
    enabled = true,
  } = {}) {
    const cleanAgentId = cleanId(agentId);
    if (!cleanAgentId) throw new Error("addAgent requires agentId");
    const state = this._readState(jobId);
    const rows = this._rowsFromState(state);
    const now = nowIso();
    const existing = rows.find((row) => row.agent_id === cleanAgentId);
    if (existing) {
      existing.enabled = enabled !== false;
      existing.updated_at = now;
    } else {
      rows.push(normalizeTeamRow({
        agent_id: cleanAgentId,
        enabled: enabled !== false,
        order_index: rows.length,
        overrides_json: {},
        created_at: now,
        updated_at: now,
      }, {
        threadId: state.thread_id,
        conversationId: state.conversation_id,
        source: "local",
      }));
    }
    state.agents = sortTeamRows(rows).map((row, index) => ({
      agent_id: row.agent_id,
      enabled: row.enabled !== false,
      order_index: index,
      overrides_json: asObject(row.overrides_json),
      created_at: String(row.created_at || now),
      updated_at: String(row.updated_at || now),
    }));
    state.updated_at = now;
    const written = this._writeState(jobId, state);
    const outputRows = this._rowsFromState(written);
    const mutationRow = outputRows.find((row) => row.agent_id === cleanAgentId) || null;
    return {
      ...this._buildResult(written),
      mutation_response: mutationRow,
    };
  }

  async removeAgent({
    jobId = "",
    agentId = "",
  } = {}) {
    const cleanAgentId = cleanId(agentId);
    if (!cleanAgentId) throw new Error("removeAgent requires agentId");
    const state = this._readState(jobId);
    const now = nowIso();
    state.agents = this._rowsFromState(state)
      .filter((row) => row.agent_id !== cleanAgentId)
      .map((row, index) => ({
        agent_id: row.agent_id,
        enabled: row.enabled !== false,
        order_index: index,
        overrides_json: asObject(row.overrides_json),
        created_at: String(row.created_at || now),
        updated_at: now,
      }));
    state.updated_at = now;
    const written = this._writeState(jobId, state);
    return {
      ...this._buildResult(written),
      mutation_response: {
        ok: true,
        agent_id: cleanAgentId,
        thread_id: String(written.thread_id || "").trim(),
        conversation_id: String(written.conversation_id || "").trim(),
      },
    };
  }

  async setAgentEnabled({
    jobId = "",
    agentId = "",
    enabled = true,
  } = {}) {
    return await this.addAgent({
      jobId,
      agentId,
      enabled,
    });
  }
}

export class GocConversationTeamStore {
  constructor({
    client = null,
    resolveMembershipTarget = null,
    logger = null,
  } = {}) {
    this.source = "goc";
    this.client = client || null;
    this.resolveMembershipTarget = typeof resolveMembershipTarget === "function"
      ? resolveMembershipTarget
      : null;
    this.logger = normalizeLogger(logger);
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  _requireClient() {
    if (!this.client) throw new Error("GoC conversation team store requires client");
    return this.client;
  }

  _normalizeRows(rows = [], {
    threadId = "",
    conversationId = "",
  } = {}) {
    return sortTeamRows(
      asArray(rows).map((row, index) => normalizeTeamRow(row, {
        threadId,
        conversationId,
        orderIndex: index,
        source: "goc",
      })).filter(Boolean)
    );
  }

  async _resolveTarget({
    threadId = "",
    conversationId = "",
    jobId = "",
    source = "",
  } = {}) {
    const cleanThreadId = String(threadId || "").trim();
    const cleanConversationId = String(conversationId || "").trim();
    if (!cleanThreadId && !cleanConversationId) {
      throw new Error("GocConversationTeamStore requires threadId or conversationId");
    }

    if (this.resolveMembershipTarget) {
      const resolved = await this.resolveMembershipTarget(this._requireClient(), {
        threadId: cleanThreadId,
        conversationId: cleanConversationId,
        jobId: String(jobId || "").trim(),
        source: source || "goc_team_store",
      });
      return summarizeTarget(resolved, {
        thread_id: cleanThreadId,
        conversation_id: cleanConversationId,
        source: "goc",
      });
    }

    return summarizeTarget({
      thread_id: cleanThreadId,
      conversation_id: cleanConversationId,
      source: "goc",
    });
  }

  async _listStrict(target = {}) {
    const client = this._requireClient();
    const listMembers = typeof client.listTeamMembers === "function"
      ? client.listTeamMembers.bind(client)
      : (typeof client.listConversationAgents === "function"
        ? client.listConversationAgents.bind(client)
        : null);
    if (!listMembers) {
      throw new Error("listTeamMembers API unavailable");
    }
    const rows = await listMembers(target);
    return this._normalizeRows(rows, {
      threadId: target.thread_id,
      conversationId: target.conversation_id,
    });
  }

  async listAgents({
    threadId = "",
    conversationId = "",
    membershipTarget = null,
    jobId = "",
    source = "",
  } = {}) {
    const warnings = [];
    const target = membershipTarget
      ? summarizeTarget(membershipTarget, { source: "goc" })
      : await this._resolveTarget({
        threadId,
        conversationId,
        jobId,
        source,
      });
    let rows = [];
    try {
      rows = await this._listStrict(target);
    } catch (error) {
      warnings.push(`team_sync:list_explicit_members:${String(error?.message ?? error)}`);
      rows = [];
    }
    return {
      target,
      rows,
      warnings: normalizeWarnings(warnings),
    };
  }

  async ensureTeam({
    threadId = "",
    conversationId = "",
    jobId = "",
    source = "",
    baselineAgentIds = [],
  } = {}) {
    const warnings = [];
    const target = await this._resolveTarget({
      threadId,
      conversationId,
      jobId,
      source: source || "ensure_team",
    });
    const baselineIds = uniqIds(baselineAgentIds);
    let rows = [];

    try {
      rows = await this._listStrict(target);
    } catch (error) {
      warnings.push(`team_sync:list_explicit_members:${String(error?.message ?? error)}`);
    }

    return {
      target,
      rows,
      baseline_agent_ids: baselineIds,
      warnings: normalizeWarnings(warnings),
    };
  }

  async addAgent({
    threadId = "",
    conversationId = "",
    membershipTarget = null,
    jobId = "",
    source = "",
    agentId = "",
    enabled = true,
  } = {}) {
    const client = this._requireClient();
    const addMember = typeof client.addTeamMember === "function"
      ? client.addTeamMember.bind(client)
      : (typeof client.addConversationAgent === "function"
        ? client.addConversationAgent.bind(client)
        : null);
    const target = membershipTarget
      ? summarizeTarget(membershipTarget, { source: "goc" })
      : await this._resolveTarget({ threadId, conversationId, jobId, source });
    const cleanAgentId = cleanId(agentId);
    if (!cleanAgentId) throw new Error("addAgent requires agentId");
    if (!addMember) throw new Error("addTeamMember API unavailable");
    const mutationResponse = await addMember(target, cleanAgentId, enabled !== false);
    const rows = await this._listStrict(target);
    return {
      target,
      rows,
      warnings: [],
      mutation_response: normalizeTeamRow(mutationResponse, {
        threadId: target.thread_id,
        conversationId: target.conversation_id,
        source: "goc",
      }),
    };
  }

  async removeAgent({
    threadId = "",
    conversationId = "",
    membershipTarget = null,
    jobId = "",
    source = "",
    agentId = "",
  } = {}) {
    const client = this._requireClient();
    const removeMember = typeof client.removeTeamMember === "function"
      ? client.removeTeamMember.bind(client)
      : (typeof client.removeConversationAgent === "function"
        ? client.removeConversationAgent.bind(client)
        : null);
    const target = membershipTarget
      ? summarizeTarget(membershipTarget, { source: "goc" })
      : await this._resolveTarget({ threadId, conversationId, jobId, source });
    const cleanAgentId = cleanId(agentId);
    if (!cleanAgentId) throw new Error("removeAgent requires agentId");
    if (!removeMember) throw new Error("removeTeamMember API unavailable");
    const mutationResponse = await removeMember(target, cleanAgentId);
    const rows = await this._listStrict(target);
    return {
      target,
      rows,
      warnings: [],
      mutation_response: normalizeTeamRow(mutationResponse, {
        threadId: target.thread_id,
        conversationId: target.conversation_id,
        source: "goc",
      }) || {
        ok: mutationResponse?.ok === true,
        agent_id: cleanAgentId,
        thread_id: target.thread_id,
        conversation_id: target.conversation_id,
      },
    };
  }

  async setAgentEnabled({
    threadId = "",
    conversationId = "",
    membershipTarget = null,
    jobId = "",
    source = "",
    agentId = "",
    enabled = true,
  } = {}) {
    const client = this._requireClient();
    const patchMember = typeof client.patchTeamMember === "function"
      ? client.patchTeamMember.bind(client)
      : (typeof client.patchConversationAgent === "function"
        ? client.patchConversationAgent.bind(client)
        : null);
    const addMember = typeof client.addTeamMember === "function"
      ? client.addTeamMember.bind(client)
      : (typeof client.addConversationAgent === "function"
        ? client.addConversationAgent.bind(client)
        : null);
    const target = membershipTarget
      ? summarizeTarget(membershipTarget, { source: "goc" })
      : await this._resolveTarget({ threadId, conversationId, jobId, source });
    const cleanAgentId = cleanId(agentId);
    if (!cleanAgentId) throw new Error("setAgentEnabled requires agentId");

    let mutationResponse = null;
    if (patchMember) {
      mutationResponse = await patchMember(target, cleanAgentId, {
        enabled: enabled !== false,
      }).catch(async () => {
        if (addMember) {
          return await addMember(target, cleanAgentId, enabled !== false);
        }
        throw new Error("team member patch is not supported");
      });
    } else if (addMember) {
      mutationResponse = await addMember(target, cleanAgentId, enabled !== false);
    } else {
      throw new Error("team member patch is not supported");
    }
    const rows = await this._listStrict(target);
    return {
      target,
      rows,
      warnings: [],
      mutation_response: normalizeTeamRow(mutationResponse, {
        threadId: target.thread_id,
        conversationId: target.conversation_id,
        source: "goc",
      }) || {
        agent_id: cleanAgentId,
        thread_id: target.thread_id,
        conversation_id: target.conversation_id,
        enabled: enabled !== false,
      },
    };
  }
}
