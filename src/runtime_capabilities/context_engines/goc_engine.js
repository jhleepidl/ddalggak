import { clip } from "../../textutil.js";
import { loadCurrentTaskPacket, renderTaskPacket, updateCurrentTaskPacket } from "../../application/task_packet.js";
import {
  normalizeScopeHintCore as normalizeLensSpecDomain,
  defaultScopeHintForAgent as defaultLensSpecForAgentDomain,
} from "../../domain/scope_hint_core.js";
import {
  normalizeRuntimeTeamSnapshot,
  normalizeRuntimeAuthority,
  normalizeActionSource,
  buildRuntimeMetadataPatch,
} from "../../application/runtime_metadata.js";
import { ContextEngineBase } from "./base.js";
import { buildContextEnvelope } from '../context_envelope.js';

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqIds(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function normalizeLensSpec(rawLens, { fallbackBudget = 1200, goal = "", defaultArtifactIds = [] } = {}) {
  const normalized = normalizeLensSpecDomain(rawLens, { fallbackBudget });
  if (!normalized.query && goal && normalized.mode === "unfold_query") {
    normalized.query = clip(goal, 300);
  }
  if (
    normalized.mode === "add_nodes"
    && (!Array.isArray(normalized.add_node_ids) || normalized.add_node_ids.length === 0)
    && Array.isArray(defaultArtifactIds)
    && defaultArtifactIds.length > 0
  ) {
    normalized.add_node_ids = uniqIds(defaultArtifactIds).slice(0, 3);
  }
  return normalized;
}

function defaultLensSpecForAgent({ agentId = "", goal = "", recentArtifactNodeIds = [] } = {}) {
  return defaultLensSpecForAgentDomain({
    agentId,
    goal,
    recentArtifactNodeIds,
  });
}

function parseNodeType(node = {}) {
  const row = asObject(node);
  const payload = asObject(row.payload);
  const raw = asObject(row.raw);
  const type = String(
    row.type
    || raw.node_type
    || raw.nodeType
    || raw.type
    || payload.type
    || payload.node_type
    || payload.nodeType
    || ""
  ).trim().toLowerCase();
  if (type) return type;
  const resourceKind = String(
    row.resourceKind
    || raw.resource_kind
    || raw.resourceKind
    || payload.resource_kind
    || payload.resourceKind
    || ""
  ).trim().toLowerCase();
  return resourceKind ? `resource:${resourceKind}` : "unknown";
}

function parseMessageRole(node = {}) {
  const row = asObject(node);
  const payload = asObject(row.payload);
  const raw = asObject(row.raw);
  return String(
    row.role
    || raw.role
    || raw.author_role
    || raw.authorRole
    || payload.role
    || ""
  ).trim().toLowerCase();
}

function summarizeTypeBreakdown(activeNodeIds = [], nodeMap = new Map()) {
  const breakdown = {};
  for (const idRaw of asArray(activeNodeIds)) {
    const id = String(idRaw || "").trim();
    if (!id) continue;
    const node = nodeMap.get(id);
    const type = parseNodeType(node);
    const role = parseMessageRole(node);
    const key = type === "message" && role ? `message:${role}` : type;
    breakdown[key] = Number(breakdown[key] || 0) + 1;
  }
  return breakdown;
}

function normalizePolicy(jobConfig = {}) {
  const cfg = asObject(jobConfig);
  const raw = asObject(cfg.context_policy);
  const excludeKinds = asArray(raw.exclude_resource_kinds).map((row) => String(row || "").trim().toLowerCase()).filter(Boolean);
  return {
    include_pinned: raw.include_pinned !== false,
    pinned_node_ids: uniqIds(raw.pinned_node_ids),
    recent_user_messages: clamp(raw.recent_user_messages, 1, 40, clamp(process.env.SHARED_CONTEXT_RECENT_USER_MESSAGES, 1, 40, 6)),
    recent_assistant_messages: clamp(raw.recent_assistant_messages, 1, 40, clamp(process.env.SHARED_CONTEXT_RECENT_ASSISTANT_MESSAGES, 1, 40, 6)),
    recent_steps: clamp(raw.recent_steps || raw.recent_run_step, 1, 80, clamp(process.env.SHARED_CONTEXT_RECENT_RUN_STEP, 1, 80, 10)),
    recent_artifacts: clamp(raw.recent_artifacts || raw.recent_tool_artifact, 1, 40, clamp(process.env.SHARED_CONTEXT_RECENT_TOOL_ARTIFACT, 1, 40, 5)),
    exclude_resource_kinds: excludeKinds.length > 0
      ? excludeKinds
      : String(process.env.SHARED_CONTEXT_EXCLUDE_RESOURCE_KINDS || "job_config,tracking_append")
        .split(",")
        .map((row) => String(row || "").trim().toLowerCase())
        .filter(Boolean),
  };
}

export class GocContextEngine extends ContextEngineBase {
  constructor({
    client = null,
    runtime = null,
    jobs = null,
    logger = null,
  } = {}) {
    super({
      memoryMode: "goc",
      jobs,
      logger,
    });
    this.client = client || null;
    this.runtime = runtime && typeof runtime === "object" ? runtime : {};
    this.sharedPolicy = normalizePolicy(this.runtime?.jobConfig || {});
    this.excludeKinds = this.sharedPolicy.exclude_resource_kinds || ["job_config", "tracking_append"];
  }

  _jobDir(jobId = "") {
    return this.jobs && typeof this.jobs.jobDir === 'function' ? this.jobs.jobDir(jobId) : '';
  }

  _taskPacketBlock(input = {}, { refresh = false } = {}) {
    const normalized = input && typeof input === 'object' ? input : {};
    const jobDir = this._jobDir(normalized.jobId || '');
    if (!jobDir) return '';
    const packet = loadCurrentTaskPacket({
      jobDir,
      runMeta: normalized.runMeta || {},
      currentUserText: normalized.stepKind === 'router' ? normalized.userMessageText : '',
      refresh,
    });
    return renderTaskPacket(packet, { roleId: normalized.roleId, maxChars: 1600 });
  }

  setRuntime(runtime = null) {
    this.runtime = runtime && typeof runtime === "object" ? runtime : {};
    this.sharedPolicy = normalizePolicy(this.runtime?.jobConfig || {});
    this.excludeKinds = this.sharedPolicy.exclude_resource_kinds || ["job_config", "tracking_append"];
  }

  _resolveSharedRef(input = {}) {
    const runMeta = asObject(input.runMeta);
    const threadId = String(
      runMeta.threadId
      || runMeta.thread_id
      || this.runtime?.map?.threadId
      || input.threadId
      || ""
    ).trim();
    const sharedContextSetId = String(
      runMeta.sharedContextSetId
      || runMeta.shared_context_set_id
      || runMeta.contextSetId
      || runMeta.context_set_id
      || this.runtime?.map?.ctxSharedId
      || this.runtime?.map?.ctxId
      || ""
    ).trim();
    return { threadId, sharedContextSetId };
  }

  async _compileWithBudget(contextSetId, budgetTokens, { includeMeta = true } = {}) {
    const ctxId = String(contextSetId || "").trim();
    if (!ctxId || !this.client) {
      return {
        text: "",
        tokenEstimate: 0,
        compiledChars: 0,
        activeNodeIds: [],
        contextVersion: "",
        typeBreakdown: {},
      };
    }
    const budget = this.normalizeBudget(budgetTokens, 1200);
    let maxChars = this.maxCharsFromBudget(budget);
    let excludeTypes = [];
    let best = {
      text: "",
      tokenEstimate: 0,
      compiledChars: 0,
      activeNodeIds: [],
      contextVersion: "",
      typeBreakdown: {},
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const compiled = await this.client.getCompiledContextWithMeta(ctxId, {
        include_meta: includeMeta,
        max_chars: maxChars,
        exclude_types: excludeTypes,
        exclude_resource_kinds: this.excludeKinds,
      });
      const text = String(compiled?.text || "").trim();
      const tokenEstimate = Number.isFinite(Number(compiled?.token_estimate))
        ? Math.max(0, Math.floor(Number(compiled.token_estimate)))
        : this.estimateTokens(text);
      best = {
        text,
        tokenEstimate,
        compiledChars: text.length,
        activeNodeIds: uniqIds(compiled?.active_node_ids || compiled?.activeNodeIds || []),
        contextVersion: String(compiled?.context_version || compiled?.version || "").trim(),
        typeBreakdown: asObject(compiled?.node_type_breakdown || compiled?.type_breakdown || {}),
      };
      if (best.tokenEstimate <= budget) return best;

      if (attempt === 1 && excludeTypes.length === 0) {
        excludeTypes = ["ToolCall", "Resource"];
      } else {
        maxChars = Math.max(1200, Math.floor(maxChars * 0.78));
      }
    }

    if (best.tokenEstimate > budget && best.text.length > this.maxCharsFromBudget(budget)) {
      const maxChars = this.maxCharsFromBudget(budget);
      best.text = `${best.text.slice(0, maxChars)}\n\n[context truncated: budget=${budget}]`;
      best.compiledChars = best.text.length;
      best.tokenEstimate = this.estimateTokens(best.text);
    }
    return best;
  }

  async _loadNodeMap(threadId, sharedContextSetId = "") {
    const tid = String(threadId || "").trim();
    if (!tid || !this.client) return new Map();
    const rows = await this.client.listNodes(tid, {
      contextSetId: String(sharedContextSetId || "").trim() || undefined,
    }).catch(() => []);
    const map = new Map();
    for (const row of asArray(rows)) {
      const id = String(row?.id || "").trim();
      if (!id) continue;
      map.set(id, row);
    }
    return map;
  }

  async rebuildSharedContext(input = {}, { compile = false } = {}) {
    if (!this.client) return null;
    const shared = this._resolveSharedRef(input);
    if (!shared.sharedContextSetId) return null;
    const policy = normalizePolicy(this.runtime?.jobConfig || {});
    const result = await this.client.rebuildContextSetActive(shared.sharedContextSetId, policy).catch(() => null);
    const ctx = await this.client.getContextSet(shared.sharedContextSetId).catch(() => null);
    const compiled = compile
      ? await this._compileWithBudget(shared.sharedContextSetId, 1300, { includeMeta: true })
      : null;

    const contextVersion = String(
      ctx?.version
      || (compiled ? compiled.contextVersion : "")
      || result?.context_version
      || ""
    ).trim();
    const activeNodeIds = uniqIds(
      ctx?.activeNodeIds
      || result?.active_node_ids
      || (compiled ? compiled.activeNodeIds : [])
      || []
    );
    let breakdown = asObject(result?.type_breakdown || result?.node_type_breakdown);
    if (Object.keys(breakdown).length === 0 && compile) {
      breakdown = asObject(compiled?.typeBreakdown || {});
    }
    if (Object.keys(breakdown).length === 0 && shared.threadId && activeNodeIds.length > 0) {
      const nodeMap = await this._loadNodeMap(shared.threadId, shared.sharedContextSetId);
      breakdown = summarizeTypeBreakdown(activeNodeIds, nodeMap);
    }
    this.log(
      `[context-engine:goc] rebuild_active shared=${shared.sharedContextSetId} active=${activeNodeIds.length} version=${contextVersion || "unknown"} compile=${compile ? "yes" : "no"}`
    );

    if (this.runtime && typeof this.runtime === "object") {
      if (compile) {
        this.runtime.contextSummary = compiled?.text || this.runtime.contextSummary || "";
      }
      this.runtime.contextMeta = {
        context_set_id: shared.sharedContextSetId,
        version: contextVersion,
        active_node_ids: activeNodeIds,
      };
      this.runtime.sharedActiveTypeBreakdown = breakdown;
    }
    return {
      sharedContextSetId: shared.sharedContextSetId,
      contextVersion,
      activeNodeIds,
      typeBreakdown: breakdown,
      compiledText: compile ? (compiled?.text || "") : "",
      tokenEstimate: compile ? Number(compiled?.tokenEstimate || 0) : 0,
      compiledChars: compile ? Number(compiled?.compiledChars || 0) : 0,
    };
  }

  async onRunStart(input = {}) {
    return await this.rebuildSharedContext(input, { compile: false });
  }

  async onRunEnd(input = {}) {
    const row = input && typeof input === 'object' ? input : {};
    const jobDir = this._jobDir(row.jobId || '');
    if (jobDir && String(row.lastUserText || '').trim()) {
      updateCurrentTaskPacket({ jobDir, currentUserText: row.lastUserText, runMeta: row.runMeta || {}, persist: true });
    }
    return await this.rebuildSharedContext(input, { compile: false });
  }

  async prepareRouterContext(input = {}) {
    const normalized = this.normalizeInput(input, { stepKind: "router", agentId: "router" });
    const taskPacketText = this._taskPacketBlock(normalized, { refresh: !!String(normalized.userMessageText || '').trim() });
    const shared = this._resolveSharedRef(normalized);
    if (!this.client || !shared.sharedContextSetId) {
      return {
        contextText: buildContextEnvelope([{ key: 'current_task_packet', raw: taskPacketText }]).text,
        meta: {
          mode: "goc",
          budgetTokens: normalized.budgetTokens,
          estimatedTokens: this.estimateTokens(taskPacketText),
          compiledChars: taskPacketText.length,
          contextFallback: "task_packet_only",
        },
      };
    }
    const compiled = await this._compileWithBudget(shared.sharedContextSetId, normalized.budgetTokens, { includeMeta: true });
    const contextVersion = String(
      this.runtime?.contextMeta?.version
      || compiled.contextVersion
      || ""
    ).trim();
    const activeNodeIds = uniqIds(
      this.runtime?.contextMeta?.active_node_ids
      || compiled.activeNodeIds
      || []
    );
    const typeBreakdown = asObject(this.runtime?.sharedActiveTypeBreakdown || compiled.typeBreakdown);
    const contextText = buildContextEnvelope([
      { key: 'current_task_packet', raw: taskPacketText },
      { key: 'raw', raw: compiled.text },
    ]).text;
    const taskPacket = loadCurrentTaskPacket({
      jobDir: this._jobDir(normalized.jobId || ''),
      runMeta: normalized.runMeta || {},
      currentUserText: normalized.stepKind === 'router' ? normalized.userMessageText : '',
      refresh: false,
    });
    return {
      contextText,
      meta: {
        mode: "goc",
        budgetTokens: normalized.budgetTokens,
        estimatedTokens: compiled.tokenEstimate,
        compiledChars: contextText.length,
        taskPacketVersion: Number.isFinite(Number(taskPacket?.version)) ? Math.floor(Number(taskPacket.version)) : undefined,
        taskPacketDeliverablesCount: Array.isArray(taskPacket?.deliverables) ? taskPacket.deliverables.length : 0,
        taskPacketProhibitionsCount: Array.isArray(taskPacket?.prohibitions) ? taskPacket.prohibitions.length : 0,
        sharedContextSetId: shared.sharedContextSetId,
        lensContextSetId: shared.sharedContextSetId,
        contextVersion,
        contextActiveNodeIds: activeNodeIds,
        activeNodeIdsCount: activeNodeIds.length,
        typeBreakdown,
        lensSpec: { mode: "shared_only", budget_tokens: normalized.budgetTokens },
        lensAddedCount: 0,
        lensRemovedCount: 0,
      },
    };
  }

  async prepareStepContext(input = {}) {
    const normalized = this.normalizeInput(input, { stepKind: "agent" });
    const taskPacketText = this._taskPacketBlock(normalized, { refresh: false });
    const shared = this._resolveSharedRef(normalized);
    if (!this.client || !shared.sharedContextSetId) {
      return {
        contextText: buildContextEnvelope([{ key: 'current_task_packet', raw: taskPacketText }]).text,
        meta: {
          mode: "goc",
          budgetTokens: normalized.budgetTokens,
          estimatedTokens: this.estimateTokens(taskPacketText),
          compiledChars: taskPacketText.length,
          contextFallback: "task_packet_only",
        },
      };
    }

    const defaultLens = defaultLensSpecForAgent({
      agentId: normalized.agentId,
      goal: normalized.goal || normalized.userMessageText,
      recentArtifactNodeIds: this.runtime?.recentArtifactNodeIds || [],
    });
    const lensSpec = normalizeLensSpec(
      normalized.lensSpec || defaultLens,
      {
        fallbackBudget: normalized.budgetTokens || defaultLens.budget_tokens || 1200,
        goal: normalized.goal || normalized.userMessageText,
        defaultArtifactIds: this.runtime?.recentArtifactNodeIds || [],
      }
    );

    const sharedCompiled = await this._compileWithBudget(
      shared.sharedContextSetId,
      Math.max(700, Math.floor(lensSpec.budget_tokens * 0.75)),
      { includeMeta: false }
    );
    let lensContextSetId = shared.sharedContextSetId;
    let lensAddedCount = 0;
    let lensRemovedCount = 0;

    const skipCloneSharedOnly = lensSpec.mode === "shared_only" && !normalized.detailContext;
    if (!skipCloneSharedOnly) {
      const cloned = await this.client.cloneContextSet(
        shared.sharedContextSetId,
        `lens:${normalized.agentId || "agent"}@${Date.now().toString(36)}`,
        {
          kind: "agent_lens",
          agent_id: normalized.agentId || undefined,
          goal: normalized.goal || undefined,
          job_id: normalized.jobId || undefined,
          chat_id: normalized.chatId || undefined,
          run_id: String(normalized.runMeta?.runId || "").trim() || undefined,
          step_id: String(normalized.runMeta?.stepId || "").trim() || undefined,
          lens_spec: lensSpec,
        }
      );
      lensContextSetId = String(cloned?.id || "").trim() || shared.sharedContextSetId;
    }

    if (lensContextSetId !== shared.sharedContextSetId || lensSpec.mode !== "shared_only") {
      if (lensSpec.mode === "unfold_query" && lensSpec.query) {
        const plan = await this.client.unfoldPlan(lensContextSetId, lensSpec.query, lensSpec).catch(() => null);
        const applied = await this.client.applyUnfoldPlan(lensContextSetId, plan || {}, lensSpec).catch(() => null);
        lensAddedCount += asArray(applied?.added_node_ids).length;
      }
      if (asArray(lensSpec.add_node_ids).length > 0) {
        const addIds = uniqIds(lensSpec.add_node_ids);
        await this.client.activateNodes(lensContextSetId, addIds).catch(() => {});
        lensAddedCount += addIds.length;
      }
      if (asArray(lensSpec.remove_node_ids).length > 0) {
        const removeIds = uniqIds(lensSpec.remove_node_ids);
        await this.client.deactivateNodes(lensContextSetId, removeIds).catch(() => {});
        lensRemovedCount += removeIds.length;
      }
    }

    const lensCompiled = await this._compileWithBudget(lensContextSetId, lensSpec.budget_tokens, { includeMeta: true });
    const contextText = lensContextSetId === shared.sharedContextSetId
      ? buildContextEnvelope([
        { key: 'current_task_packet', raw: taskPacketText },
        { key: 'raw', raw: lensCompiled.text },
      ]).text
      : buildContextEnvelope([
        { key: 'current_task_packet', raw: taskPacketText },
        { key: 'shared_summary', body: clip(sharedCompiled.text || "", 2400) },
        { key: 'lens_context', body: lensCompiled.text || "" },
      ]).text;

    const contextVersion = String(
      lensCompiled.contextVersion
      || this.runtime?.contextMeta?.version
      || ""
    ).trim();
    const activeNodeIds = uniqIds(lensCompiled.activeNodeIds || []);
    let typeBreakdown = asObject(lensCompiled.typeBreakdown);
    if (Object.keys(typeBreakdown).length === 0 && shared.threadId && activeNodeIds.length > 0) {
      const nodeMap = await this._loadNodeMap(shared.threadId, lensContextSetId);
      typeBreakdown = summarizeTypeBreakdown(activeNodeIds, nodeMap);
    }

    const taskPacket = loadCurrentTaskPacket({
      jobDir: this._jobDir(normalized.jobId || ''),
      runMeta: normalized.runMeta || {},
      currentUserText: '',
      refresh: false,
    });

    return {
      contextText,
      meta: {
        mode: "goc",
        budgetTokens: lensSpec.budget_tokens,
        estimatedTokens: lensCompiled.tokenEstimate,
        compiledChars: contextText.length,
        taskPacketVersion: Number.isFinite(Number(taskPacket?.version)) ? Math.floor(Number(taskPacket.version)) : undefined,
        taskPacketDeliverablesCount: Array.isArray(taskPacket?.deliverables) ? taskPacket.deliverables.length : 0,
        taskPacketProhibitionsCount: Array.isArray(taskPacket?.prohibitions) ? taskPacket.prohibitions.length : 0,
        sharedContextSetId: shared.sharedContextSetId,
        lensContextSetId,
        contextVersion,
        contextActiveNodeIds: activeNodeIds,
        activeNodeIdsCount: activeNodeIds.length,
        typeBreakdown,
        lensSpec,
        lensAddedCount,
        lensRemovedCount,
      },
    };
  }

  async recordMeta(args = {}) {
    const row = asObject(args);
    const runMeta = asObject(row.runMeta);
    const contextMeta = asObject(row.meta);
    const threadId = String(
      row.threadId
      || runMeta.threadId
      || runMeta.thread_id
      || this.runtime?.map?.threadId
      || ""
    ).trim();
    const contextSetId = String(
      runMeta.sharedContextSetId
      || runMeta.shared_context_set_id
      || runMeta.contextSetId
      || runMeta.context_set_id
      || this.runtime?.map?.ctxSharedId
      || this.runtime?.map?.ctxId
      || ""
    ).trim();
    const stepNodeId = String(runMeta.stepNodeId || runMeta.step_node_id || "").trim();
    if (String(row.stepKind || '').trim().toLowerCase() === 'router' && String(row.userMessageText || '').trim()) {
      const jobDir = this._jobDir(row.jobId || '');
      if (jobDir) updateCurrentTaskPacket({ jobDir, currentUserText: row.userMessageText, runMeta, persist: true });
    }
    const runNodeId = String(runMeta.runNodeId || runMeta.run_node_id || "").trim();
    const runtimeTeamSnapshot = normalizeRuntimeTeamSnapshot(runMeta);
    const runtimeAuthority = normalizeRuntimeAuthority(runMeta);
    const actionSource = normalizeActionSource(runMeta.action_source || runMeta.actionSource || "");
    const runtimeMetadataPatch = buildRuntimeMetadataPatch({
      runtime_team_snapshot: runtimeTeamSnapshot,
      runtime_authority: runtimeAuthority || undefined,
      action_source: actionSource || undefined,
      ...(runtimeAuthority || {}),
    }, {
      includeFlattened: true,
    });
    const hasRuntimeMetadataPatch = Object.keys(runtimeMetadataPatch).length > 0;

    if (this.client && threadId && (stepNodeId || runNodeId || hasRuntimeMetadataPatch)) {
      const ts = new Date().toISOString();
      const payload = {
        mode: "goc",
        ts,
        job_id: String(row.jobId || "").trim() || undefined,
        chat_id: String(row.chatId || "").trim() || undefined,
        step_kind: String(row.stepKind || "").trim() || undefined,
        agent_id: String(row.agentId || "").trim().toLowerCase() || undefined,
        goal: clip(String(row.goal || "").trim(), 400) || undefined,
        run_meta: runMeta,
        context_meta: contextMeta,
        ...runtimeMetadataPatch,
      };
      const metaResource = await this.client.createResource(threadId, {
        name: `context_meta@${ts}`,
        summary: clip(`context meta ${String(row.stepKind || "step").trim() || "step"} ${String(row.agentId || "").trim()}`, 180),
        text_mode: "plain",
        raw_text: clip(JSON.stringify(payload, null, 2), 18000),
        resource_kind: "context_meta",
        uri: String(row.jobId || "").trim()
          ? `ddalggak://jobs/${String(row.jobId || "").trim()}/context_meta/${Date.now().toString(36)}`
          : undefined,
        context_set_id: contextSetId || undefined,
        auto_activate: false,
        payload_json: payload,
      }).catch(() => null);
      const metaNodeId = String(metaResource?.id || "").trim();
      if (metaNodeId) {
        if (stepNodeId) {
          await this.client.createEdge(threadId, stepNodeId, metaNodeId, "HAS_PART").catch(() => {});
        } else if (runNodeId) {
          await this.client.createEdge(threadId, runNodeId, metaNodeId, "HAS_PART").catch(() => {});
        }
      }
    }

    return await super.recordMeta(args);
  }
}
