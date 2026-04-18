import { buildPreviewAgentDisplayIndex, formatChatAgentDisplayName, resolveActionAgentNameHint } from "../shared/agent_labels.js";
import { randomUUID } from "node:crypto";
import { OPENHARNESS_RUN_SYNC_SCHEMA_VERSION, OPENHARNESS_RUN_TRACE_SCHEMA_VERSION, buildHarnessPackageRef } from "../shared/openharness_contracts.js";
import { isHarnessLifecycleVisible, isHarnessTimelineEnabled } from "../application/harness_runtime_behavior.js";
import {
  normalizeActionSource as normalizeActionSourceShared,
  normalizeRuntimeMetadataEnvelope,
  mergeRuntimeMetadataEnvelope,
  buildRuntimeMetadataPatch,
  buildRuntimeRolePayload,
  resolveRuntimeAgentForAction,
} from "../application/runtime_metadata.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

function userFacingAgentLabel(agentId = '', action = null, runtimeMetadata = null) {
  const nameHint = action ? resolveActionAgentNameHint(action) : '';
  const index = buildPreviewAgentDisplayIndex({
    runtimeSnapshot: runtimeMetadata || null,
    actions: action ? [action] : [],
  });
  return formatChatAgentDisplayName(agentId || nameHint, index, { nameHint, fallbackLabel: 'Agent' });
}

function nowIso() {
  return new Date().toISOString();
}

function clipPreview(text, max = 600) {
  const src = String(text || "");
  if (!src) return "";
  if (src.length <= max) return src;
  return `${src.slice(0, Math.max(0, max - 1))}…`;
}

function actionType(action) {
  return String(action?.type || "").trim().toLowerCase();
}

function actionAgentId(action) {
  const type = actionType(action);
  if (type === "run_agent") return String(action?.agent_id || action?.agent || "").trim().toLowerCase();
  if (type === "agent_run") return String(action?.agent || action?.agent_id || "").trim().toLowerCase();
  if (type === "synthesize_final") return String(action?.agent || action?.agent_id || "synthesizer").trim().toLowerCase();
  if (type === "spawn_agents") return "router";
  if (type === "spawn_parallel") return "router";
  if (type === "need_more_detail") return "context";
  return "system";
}

function actionGoal(action) {
  const type = actionType(action);
  if (type === "spawn_agents" || type === "spawn_parallel") return String(action?.summary || action?.goal || action?.prompt || "").trim();
  if (type === "chatgpt_prompt") return String(action?.question || action?.prompt || "").trim();
  return String(action?.goal || action?.prompt || action?.task || action?.hint || "").trim();
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "").trim();
}

function normalizeActionSource(value = "") {
  return normalizeActionSourceShared(value);
}

function normalizeRuntimeMetadata(raw = {}) {
  return normalizeRuntimeMetadataEnvelope(raw);
}

function mergeRuntimeMetadata(a = null, b = null) {
  return mergeRuntimeMetadataEnvelope(a, b);
}

function runtimeMetadataPatch(metadata = null) {
  return buildRuntimeMetadataPatch(metadata, {
    includeFlattened: true,
  });
}

function runtimeAgentForAction(action = {}, runtimeTeamSnapshot = null) {
  return resolveRuntimeAgentForAction(action, runtimeTeamSnapshot);
}

function runtimeRolePatchFromAgent(runtimeAgent = null) {
  return buildRuntimeRolePayload(runtimeAgent);
}

export class GocExecutionGraphRecorder {
  constructor({
    client,
    threadId = "",
    contextSetId = "",
    sharedContextSetId = "",
    contextMeta = null,
    runId = "",
    chatId = "",
    jobId = "",
    logger = null,
    harnessPackage = null,
    runtimeBundleRef = null,
    runtimePolicy = null,
  } = {}) {
    this.client = client || null;
    this.threadId = String(threadId || "").trim();
    this.contextSetId = String(contextSetId || "").trim();
    this.sharedContextSetId = String(sharedContextSetId || contextSetId || "").trim();
    const meta = asObject(contextMeta);
    this.contextMeta = {
      version: String(meta.version || "").trim(),
      active_node_ids: Array.isArray(meta.active_node_ids)
        ? meta.active_node_ids.map((row) => String(row || "").trim()).filter(Boolean)
        : (Array.isArray(meta.activeNodeIds)
          ? meta.activeNodeIds.map((row) => String(row || "").trim()).filter(Boolean)
          : []),
    };
    this.runId = String(runId || "").trim() || `run_${randomUUID()}`;
    this.chatId = String(chatId || "").trim();
    this.jobId = String(jobId || "").trim();
    this.logger = typeof logger === "function" ? logger : null;
    this.harnessPackageRef = harnessPackage ? buildHarnessPackageRef(harnessPackage) : null;
    this.runtimeBundleRef = asObject(runtimeBundleRef);
    this.runtimePolicy = runtimePolicy || null;

    this.runNodeId = "";
    this.payloadByNodeId = new Map();
    this.stepMetaByAction = new WeakMap();
    this.runtimeMetadata = null;
  }

  _sharedContextPayload() {
    return {
      context_set_id: this.contextSetId || undefined,
      context_version: this.contextMeta.version || undefined,
      context_active_node_ids: this.contextMeta.active_node_ids.length > 0
        ? this.contextMeta.active_node_ids
        : undefined,
      shared_context_set_id: this.sharedContextSetId || this.contextSetId || undefined,
      shared_context_version: this.contextMeta.version || undefined,
      shared_context_active_node_ids: this.contextMeta.active_node_ids.length > 0
        ? this.contextMeta.active_node_ids
        : undefined,
    };
  }

  isEnabled() {
    return this._timelineEnabled() && !!(this.client && this.threadId);
  }

  _timelineEnabled() {
    return isHarnessTimelineEnabled(this.runtimePolicy);
  }

  _lifecycleEnabled() {
    return isHarnessLifecycleVisible(this.runtimePolicy);
  }

  getRunNodeId() {
    return this.runNodeId;
  }

  getStepNodeId(action) {
    const meta = this.stepMetaByAction.get(action);
    return String(meta?.nodeId || "").trim();
  }

  _log(message) {
    if (this.logger) {
      try {
        this.logger(String(message || ""));
      } catch {}
    }
  }

  _rememberPayload(nodeId, payload) {
    const id = String(nodeId || "").trim();
    if (!id) return;
    const row = asObject(payload);
    this.payloadByNodeId.set(id, row);
  }

  _mergePayload(nodeId, patch = {}) {
    const id = String(nodeId || "").trim();
    if (!id) return asObject(patch);
    const current = asObject(this.payloadByNodeId.get(id));
    const merged = {
      ...current,
      ...asObject(patch),
    };
    this.payloadByNodeId.set(id, merged);
    return merged;
  }

  async _createEdge(fromId, toId, type) {
    if (!this.isEnabled()) return;
    const from = String(fromId || "").trim();
    const to = String(toId || "").trim();
    const edgeType = String(type || "").trim();
    if (!from || !to || !edgeType) return;
    try {
      await this.client.createEdge(this.threadId, from, to, edgeType);
    } catch (e) {
      this._log(`[goc-exec] createEdge failed type=${edgeType} from=${from} to=${to}: ${safeErrorMessage(e)}`);
    }
  }

  async _createNode(nodeType, { name = "", summary = "", payload = {} } = {}) {
    if (!this.isEnabled()) return null;
    const type = String(nodeType || "").trim();
    if (!type) return null;
    try {
      const created = await this.client.createNode(this.threadId, {
        name: String(name || "").trim() || `${type.toLowerCase()}@${nowIso()}`,
        summary: String(summary || "").trim(),
        node_type: type,
        type,
        context_set_id: this.contextSetId || undefined,
        auto_activate: true,
        payload_json: asObject(payload),
      });
      const nodeId = String(created?.id || "").trim();
      if (nodeId) this._rememberPayload(nodeId, payload);
      return created;
    } catch (e) {
      this._log(`[goc-exec] createNode failed type=${type}: ${safeErrorMessage(e)}`);
      return null;
    }
  }

  async _updateNodePayload(nodeId, patch = {}, { summary = undefined } = {}) {
    if (!this.isEnabled()) return;
    const id = String(nodeId || "").trim();
    if (!id) return;
    const payload = this._mergePayload(id, patch);
    try {
      await this.client.updateNode(id, {
        payload_json: payload,
        summary: typeof summary === "string" ? summary : undefined,
      });
    } catch (e) {
      this._log(`[goc-exec] updateNode failed node=${id}: ${safeErrorMessage(e)}`);
    }
  }

  _runtimeMetadataPatch() {
    return runtimeMetadataPatch(this.runtimeMetadata);
  }

  _contractPayload() {
    return {
      run_trace_schema_version: OPENHARNESS_RUN_TRACE_SCHEMA_VERSION,
      run_sync_schema_version: OPENHARNESS_RUN_SYNC_SCHEMA_VERSION,
      run_sync_source: "ddalggak",
      run_sync_target: "goc",
      harness_package_ref: this.harnessPackageRef || undefined,
      runtime_bundle_ref: Object.keys(this.runtimeBundleRef).length > 0 ? this.runtimeBundleRef : undefined,
    };
  }

  async setRuntimeMetadata(metadata = null, { updateRun = true } = {}) {
    const normalized = normalizeRuntimeMetadata(metadata);
    if (!normalized) return;
    this.runtimeMetadata = mergeRuntimeMetadata(this.runtimeMetadata, normalized);
    if (updateRun && this.runNodeId) {
      await this._updateNodePayload(this.runNodeId, this._runtimeMetadataPatch());
    }
  }

  async updateRunMetadata(metadata = null) {
    await this.setRuntimeMetadata(metadata, { updateRun: true });
  }

  async startRun({ userMessageNodeId = "", userText = "", metadata = null } = {}) {
    if (!this.isEnabled()) return null;
    if (this.runNodeId) return { id: this.runNodeId };
    await this.setRuntimeMetadata(metadata, { updateRun: false });
    const startedAt = nowIso();
    const payload = {
      run_id: this.runId,
      chat_id: this.chatId || undefined,
      job_id: this.jobId || undefined,
      status: "running",
      started_at: startedAt,
      ended_at: null,
      user_message_node_id: String(userMessageNodeId || "").trim() || undefined,
      user_message_preview: clipPreview(userText, 300) || undefined,
      ...this._runtimeMetadataPatch(),
      ...this._sharedContextPayload(),
      ...this._contractPayload(),
    };
    const run = await this._createNode("Run", {
      name: `run:${this.runId}`,
      summary: clipPreview(userText, 240),
      payload,
    });
    const runNodeId = String(run?.id || "").trim();
    if (!runNodeId) return null;
    this.runNodeId = runNodeId;
    const userMessageId = String(userMessageNodeId || "").trim();
    if (userMessageId) {
      await this._createEdge(userMessageId, runNodeId, "IN_RUN");
    }
    return run;
  }

  async finishRun({ status = "done", summary = "", error = "" } = {}) {
    if (!this.runNodeId) return;
    const normalizedStatus = String(status || "").trim().toLowerCase() || "done";
    const staleQueuedReason = normalizedStatus === "await_user"
      ? "await_user"
      : (normalizedStatus === "done" ? "superseded" : normalizedStatus);
    await this._markQueuedStepsInactive({
      reason: staleQueuedReason,
    });
    await this._updateNodePayload(this.runNodeId, {
      status: normalizedStatus,
      ended_at: nowIso(),
      summary: clipPreview(summary, 1000) || undefined,
      error: clipPreview(error, 1000) || undefined,
    }, {
      summary: clipPreview(summary || error || normalizedStatus, 220),
    });
  }

  async _markQueuedStepsInactive({ reason = "superseded" } = {}) {
    if (!this.isEnabled()) return;
    const skippedAt = nowIso();
    const cleanReason = clipPreview(reason || "superseded", 1200) || "superseded";
    const entries = [...this.payloadByNodeId.entries()];
    for (const [nodeId, payloadRaw] of entries) {
      const payload = asObject(payloadRaw);
      if (!payload.step_id) continue;
      if (String(payload.run_id || "").trim() !== this.runId) continue;
      if (String(payload.status || "").trim().toLowerCase() !== "queued") continue;
      await this._updateNodePayload(nodeId, {
        status: "skipped",
        ended_at: skippedAt,
        skip_reason: cleanReason,
      }, {
        summary: clipPreview(cleanReason, 220),
      });
    }
  }

  async queueMainSteps(actions = [], { metadata = null } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return;
    await this.setRuntimeMetadata(metadata, { updateRun: true });
    const rows = Array.isArray(actions) ? actions : [];
    let previousStepNodeId = "";
    for (let i = 0; i < rows.length; i += 1) {
      const action = rows[i];
      if (!action || typeof action !== "object") continue;
      const type = actionType(action);
      const stepId = `step_${randomUUID()}`;
      const goal = actionGoal(action);
      const agentId = actionAgentId(action);
      const runtimeRolePatch = runtimeRolePatchFromAgent(runtimeAgentForAction(
        action,
        this.runtimeMetadata?.runtime_team_snapshot || null
      ));
      const inputs = asObject(action?.inputs);
      const payload = {
        run_id: this.runId,
        step_id: stepId,
        step_index: i,
        action_type: type,
        agent_id: agentId || undefined,
        goal: goal || undefined,
        status: "queued",
        started_at: null,
        ended_at: null,
        error: null,
        lens_context_set_id: this.sharedContextSetId || this.contextSetId || undefined,
        lens_spec: action?.lens && typeof action.lens === "object"
          ? action.lens
          : { mode: "shared_only" },
        parallel_group_id: String(inputs.parallel_group_id || inputs.parallelGroupId || "").trim() || undefined,
        dependency_slot_ids: Array.isArray(inputs.dependency_slot_ids)
          ? inputs.dependency_slot_ids
          : (Array.isArray(inputs.dependencySlotIds) ? inputs.dependencySlotIds : undefined),
        collaboration_cell_ids: Array.isArray(inputs.collaboration_cell_ids)
          ? inputs.collaboration_cell_ids
          : (Array.isArray(inputs.collaborationCellIds) ? inputs.collaborationCellIds : undefined),
        checkpoint_ids: Array.isArray(inputs.checkpoint_ids)
          ? inputs.checkpoint_ids
          : undefined,
        report_back_to_instance_ids: Array.isArray(inputs.report_back_to_instance_ids)
          ? inputs.report_back_to_instance_ids
          : (Array.isArray(inputs.reportBackToInstanceIds) ? inputs.reportBackToInstanceIds : undefined),
        supervisor_instance_id: String(
          inputs.supervisor_instance_id || inputs.supervisorInstanceId || ""
        ).trim() || undefined,
        ...runtimeRolePatch,
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
      };
      const created = await this._createNode("Step", {
        name: `step:${stepId}`,
        summary: clipPreview(`${type}${agentId ? ` ${userFacingAgentLabel(agentId, action, this.runtimeMetadata?.runtime_team_snapshot || this.runtimeMetadata || null)}` : ""} ${goal}`.trim(), 240),
        payload,
      });
      const stepNodeId = String(created?.id || "").trim();
      if (!stepNodeId) continue;
      this.stepMetaByAction.set(action, {
        nodeId: stepNodeId,
        stepId,
        index: i,
      });
      if (this.runNodeId) {
        await this._createEdge(this.runNodeId, stepNodeId, "INVOKES");
      }
      if (previousStepNodeId) {
        await this._createEdge(previousStepNodeId, stepNodeId, "NEXT");
      }
      previousStepNodeId = stepNodeId;
    }
  }

  async markStepRunning(action, { extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = this.getStepNodeId(action);
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "running",
      started_at: nowIso(),
      ended_at: null,
      error: null,
      ...asObject(extra),
    });
  }

  async markStepDone(action, { output = "", extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = this.getStepNodeId(action);
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "done",
      ended_at: nowIso(),
      output_preview: clipPreview(output, 1400) || undefined,
      ...asObject(extra),
    }, {
      summary: clipPreview(output, 220),
    });
  }

  async markStepSkipped(action, { reason = "", extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = this.getStepNodeId(action);
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "skipped",
      ended_at: nowIso(),
      skip_reason: clipPreview(reason, 1200) || undefined,
      ...asObject(extra),
    }, {
      summary: clipPreview(reason || "skipped", 220),
    });
  }

  async markStepError(action, error, { output = "", extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = this.getStepNodeId(action);
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "error",
      ended_at: nowIso(),
      output_preview: clipPreview(output, 900) || undefined,
      error: clipPreview(safeErrorMessage(error), 1400) || "unknown error",
      ...asObject(extra),
    }, {
      summary: clipPreview(safeErrorMessage(error), 220),
    });
  }

  async markStepNodeRunning(stepNodeId, { extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = String(stepNodeId || "").trim();
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "running",
      started_at: nowIso(),
      ended_at: null,
      error: null,
      ...asObject(extra),
    });
  }

  async markStepNodeDone(stepNodeId, { output = "", extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = String(stepNodeId || "").trim();
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "done",
      ended_at: nowIso(),
      output_preview: clipPreview(output, 1400) || undefined,
      ...asObject(extra),
    }, {
      summary: clipPreview(output, 220),
    });
  }

  async markStepNodeError(stepNodeId, error, { output = "", extra = {} } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = String(stepNodeId || "").trim();
    if (!nodeId) return;
    await this._updateNodePayload(nodeId, {
      status: "error",
      ended_at: nowIso(),
      output_preview: clipPreview(output, 900) || undefined,
      error: clipPreview(safeErrorMessage(error), 1400) || "unknown error",
      ...asObject(extra),
    }, {
      summary: clipPreview(safeErrorMessage(error), 220),
    });
  }

  async createSpawnChildSteps({ parentAction, children = [] } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return [];
    const list = Array.isArray(children) ? children : [];
    const parentNodeId = this.getStepNodeId(parentAction);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const child = asObject(list[i]);
      const childAgentId = String(child.agent_id || child.agent || "").trim().toLowerCase();
      const childGoal = String(child.goal || child.prompt || child.task || "").trim();
      if (!childAgentId || !childGoal) continue;
      const childStepId = `step_${randomUUID()}`;
      const childRuntimeRolePatch = runtimeRolePatchFromAgent(runtimeAgentForAction(
        { type: "run_agent", agent_id: childAgentId, inputs: child.inputs || {} },
        this.runtimeMetadata?.runtime_team_snapshot || null
      ));
      const childInputs = asObject(child.inputs);
      const payload = {
        run_id: this.runId,
        step_id: childStepId,
        parent_step_node_id: parentNodeId || undefined,
        action_type: "run_agent",
        mode: "spawn_child",
        agent_id: childAgentId,
        goal: childGoal,
        status: "queued",
        started_at: null,
        ended_at: null,
        error: null,
        lens_context_set_id: this.sharedContextSetId || this.contextSetId || undefined,
        lens_spec: child.lens && typeof child.lens === "object"
          ? child.lens
          : { mode: "shared_only" },
        parallel_group_id: String(childInputs.parallel_group_id || childInputs.parallelGroupId || "").trim() || undefined,
        dependency_slot_ids: Array.isArray(childInputs.dependency_slot_ids)
          ? childInputs.dependency_slot_ids
          : (Array.isArray(childInputs.dependencySlotIds) ? childInputs.dependencySlotIds : undefined),
        collaboration_cell_ids: Array.isArray(childInputs.collaboration_cell_ids)
          ? childInputs.collaboration_cell_ids
          : (Array.isArray(childInputs.collaborationCellIds) ? childInputs.collaborationCellIds : undefined),
        checkpoint_ids: Array.isArray(childInputs.checkpoint_ids)
          ? childInputs.checkpoint_ids
          : undefined,
        report_back_to_instance_ids: Array.isArray(childInputs.report_back_to_instance_ids)
          ? childInputs.report_back_to_instance_ids
          : (Array.isArray(childInputs.reportBackToInstanceIds) ? childInputs.reportBackToInstanceIds : undefined),
        supervisor_instance_id: String(
          childInputs.supervisor_instance_id || childInputs.supervisorInstanceId || ""
        ).trim() || undefined,
        ...childRuntimeRolePatch,
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
      };
      const childNode = await this._createNode("Step", {
        name: `step:${childStepId}`,
        summary: clipPreview(`spawn ${userFacingAgentLabel(childAgentId, { type: 'run_agent', agent_id: childAgentId, inputs: child.inputs || {} }, this.runtimeMetadata?.runtime_team_snapshot || this.runtimeMetadata || null)} ${childGoal}`, 240),
        payload,
      });
      const childNodeId = String(childNode?.id || "").trim();
      if (!childNodeId) continue;
      if (parentNodeId) await this._createEdge(parentNodeId, childNodeId, "SPLIT_FROM");
      if (this.runNodeId) await this._createEdge(this.runNodeId, childNodeId, "INVOKES");
      out.push({
        index: i,
        agent_id: childAgentId,
        goal: childGoal,
        node_id: childNodeId,
        step_id: childStepId,
      });
    }
    return out;
  }

  async createJoinStep({
    parentAction,
    childStepNodeIds = [],
    agentId = "router",
    goal = "",
    summary = "",
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const parentNodeId = this.getStepNodeId(parentAction);
    const joinStepId = `step_${randomUUID()}`;
    const payload = {
      run_id: this.runId,
      step_id: joinStepId,
      action_type: "join",
      mode: "spawn_join",
      parent_step_node_id: parentNodeId || undefined,
      agent_id: String(agentId || "").trim().toLowerCase() || "router",
      goal: String(goal || summary || "병렬 결과 결합").trim(),
      status: "queued",
      started_at: null,
      ended_at: null,
      error: null,
      ...this._runtimeMetadataPatch(),
      ...this._sharedContextPayload(),
      ...this._contractPayload(),
    };
    const joinNode = await this._createNode("Step", {
      name: `step:${joinStepId}`,
      summary: clipPreview(summary || goal || "spawn join", 240),
      payload,
    });
    const joinNodeId = String(joinNode?.id || "").trim();
    if (!joinNodeId) return null;
    if (this.runNodeId) await this._createEdge(this.runNodeId, joinNodeId, "INVOKES");
    for (const childNodeIdRaw of Array.isArray(childStepNodeIds) ? childStepNodeIds : []) {
      const childNodeId = String(childNodeIdRaw || "").trim();
      if (!childNodeId) continue;
      await this._createEdge(childNodeId, joinNodeId, "JOINS");
    }
    return {
      node_id: joinNodeId,
      step_id: joinStepId,
    };
  }

  async startToolCall(stepNodeId, {
    toolName = "",
    inputPreview = "",
    status = "running",
    extraPayload = {},
  } = {}) {
    if (!this._lifecycleEnabled()) return null;
    const cleanStepId = String(stepNodeId || "").trim();
    const name = String(toolName || "").trim() || "tool";
    if (!cleanStepId) return null;
    const payload = {
      run_id: this.runId,
      step_node_id: cleanStepId,
      tool_name: name,
      input_preview: clipPreview(inputPreview, 1400),
      status: String(status || "").trim().toLowerCase() || "running",
      started_at: nowIso(),
      ...asObject(extraPayload),
    };
    const call = await this._createNode("ToolCall", {
      name: `toolcall:${name}@${nowIso()}`,
      summary: clipPreview(`${name}: ${inputPreview}`, 220),
      payload,
    });
    const callNodeId = String(call?.id || "").trim();
    if (callNodeId) await this._createEdge(cleanStepId, callNodeId, "HAS_PART");
    return call;
  }

  async finishToolCall(toolCallNodeId, {
    status = "done",
    outputPreview = "",
    error = "",
    extraPayload = {},
  } = {}) {
    if (!this._lifecycleEnabled()) return;
    const nodeId = String(toolCallNodeId || "").trim();
    if (!nodeId) return;
    const normalizedStatus = String(status || "").trim().toLowerCase() || "done";
    await this._updateNodePayload(nodeId, {
      status: normalizedStatus,
      ended_at: nowIso(),
      output_preview: clipPreview(outputPreview, 1200) || undefined,
      error: clipPreview(error, 1200) || undefined,
      ...asObject(extraPayload),
    }, {
      summary: clipPreview(error || outputPreview || normalizedStatus, 220),
    });
  }

  async recordToolResult({
    stepNodeId = "",
    toolCallNodeId = "",
    toolName = "",
    outputPreview = "",
    status = "done",
    error = "",
    extraPayload = {},
  } = {}) {
    if (!this._lifecycleEnabled()) return null;
    const stepId = String(stepNodeId || "").trim();
    if (!stepId) return null;
    const name = String(toolName || "").trim() || "tool";
    const payload = {
      run_id: this.runId,
      step_node_id: stepId,
      tool_name: name,
      output_preview: clipPreview(outputPreview, 1800),
      status: String(status || "").trim().toLowerCase() || "done",
      error: clipPreview(error, 1200) || undefined,
      ts: nowIso(),
      ...asObject(extraPayload),
    };
    const result = await this._createNode("ToolResult", {
      name: `toolresult:${name}@${nowIso()}`,
      summary: clipPreview(error || outputPreview || name, 220),
      payload,
    });
    const resultNodeId = String(result?.id || "").trim();
    if (!resultNodeId) return null;
    const callNodeId = String(toolCallNodeId || "").trim();
    if (callNodeId) await this._createEdge(callNodeId, resultNodeId, "RETURNS");
    await this._createEdge(stepId, resultNodeId, "HAS_PART");
    return result;
  }


  async recordParticipantContribution({
    participant = null,
    contribution = null,
    decision = null,
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const participantRow = asObject(participant);
    const contributionRow = asObject(contribution);
    const decisionRow = asObject(decision);
    const label = String(participantRow.label || participantRow.participant_id || 'participant').trim() || 'participant';
    const kind = String(contributionRow.kind || 'note').trim() || 'note';
    const node = await this._createNode('ParticipantSignal', {
      name: `participant:${label}@${nowIso()}`,
      summary: clipPreview(`${label} ${kind}: ${contributionRow.summary || contributionRow.content || decisionRow.action || ''}`, 220),
      payload: {
        run_id: this.runId,
        participant,
        contribution,
        decision,
        ts: nowIso(),
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
        ...this._contractPayload(),
      },
    });
    const nodeId = String(node?.id || '').trim();
    if (nodeId && this.runNodeId) await this._createEdge(this.runNodeId, nodeId, 'HAS_PART');
    return node;
  }

  async recordParticipantDigest({
    turn_id: turnId = '',
    mode = '',
    item_count: itemCount = 0,
    participant_labels: participantLabels = [],
    participant_ids: participantIds = [],
    contribution_ids: contributionIds = [],
    kinds = [],
    prompt_block: promptBlock = '',
    digest_block: digestBlock = '',
    signature = '',
    kind_counts: kindCounts = null,
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const labels = Array.isArray(participantLabels) ? participantLabels.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 8) : [];
    const summarySeed = labels.length > 0 ? labels.join(', ') : 'participant signals';
    const node = await this._createNode('ParticipantDigest', {
      name: `participant-digest@${nowIso()}`,
      summary: clipPreview(`folded ${Number(itemCount) || 0} signals · ${summarySeed}`, 220),
      payload: {
        run_id: this.runId,
        turn_id: String(turnId || '').trim() || undefined,
        mode: String(mode || '').trim().toLowerCase() || undefined,
        item_count: Math.max(0, Math.floor(Number(itemCount) || 0)),
        participant_labels: labels,
        participant_ids: Array.isArray(participantIds) ? participantIds.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 8) : [],
        contribution_ids: Array.isArray(contributionIds) ? contributionIds.map((row) => String(row || '').trim()).filter(Boolean).slice(0, 16) : [],
        kinds: Array.isArray(kinds) ? kinds.map((row) => String(row || '').trim().toLowerCase()).filter(Boolean).slice(0, 8) : [],
        kind_counts: asObject(kindCounts),
        prompt_block: clipPreview(promptBlock, 2400) || undefined,
        digest_block: clipPreview(digestBlock, 1800) || undefined,
        signature: String(signature || '').trim() || undefined,
        ts: nowIso(),
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
        ...this._contractPayload(),
      },
    });
    const nodeId = String(node?.id || '').trim();
    if (nodeId && this.runNodeId) await this._createEdge(this.runNodeId, nodeId, 'HAS_PART');
    return node;
  }

  async recordChannelVerifierDecision({
    status = '',
    overall_recommendation: overallRecommendation = '',
    motif = null,
    participant_policy: participantPolicy = null,
    participation_pct: participationPct = 0,
    score = 0,
    goal_excerpt: goalExcerpt = '',
    execution_pattern: executionPattern = '',
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const motifRow = asObject(motif);
    const participantRow = asObject(participantPolicy);
    const summary = [
      String(overallRecommendation || '').trim() || 'hold',
      motifRow.recommendation ? `motif=${motifRow.recommendation}` : '',
      participantRow.recommendation ? `participant=${participantRow.recommendation}` : '',
      Number.isFinite(Number(participationPct)) ? `participation=${Math.round(Number(participationPct) || 0)}%` : '',
    ].filter(Boolean).join(' · ');
    const node = await this._createNode('ChannelVerifierDecision', {
      name: `channel-verifier@${nowIso()}`,
      summary: clipPreview(summary || 'channel verifier evaluated active experiment channels', 220),
      payload: {
        run_id: this.runId,
        status: String(status || '').trim().toLowerCase() || undefined,
        overall_recommendation: String(overallRecommendation || '').trim().toLowerCase() || undefined,
        motif: motifRow,
        participant_policy: participantRow,
        participation_pct: Number.isFinite(Number(participationPct)) ? Number(participationPct) : undefined,
        score: Number.isFinite(Number(score)) ? Number(score) : undefined,
        goal_excerpt: clipPreview(goalExcerpt, 280) || undefined,
        execution_pattern: String(executionPattern || '').trim().toLowerCase() || undefined,
        ts: nowIso(),
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
        ...this._contractPayload(),
      },
    });
    const nodeId = String(node?.id || '').trim();
    if (nodeId && this.runNodeId) await this._createEdge(this.runNodeId, nodeId, 'HAS_PART');
    return node;
  }


  async recordChannelPromotionApplied({
    overall_recommendation: overallRecommendation = '',
    goal_excerpt: goalExcerpt = '',
    motif = null,
    participant_policy: participantPolicy = null,
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const motifRow = asObject(motif);
    const participantRow = asObject(participantPolicy);
    const summary = [
      String(overallRecommendation || '').trim() || 'hold',
      asArray(motifRow.promoted_motif_ids).length > 0 ? `promoted=${asArray(motifRow.promoted_motif_ids).length}` : '',
      asArray(motifRow.rolled_back_motif_ids).length > 0 ? `rolled_back=${asArray(motifRow.rolled_back_motif_ids).length}` : '',
      participantRow.snapshot ? 'participant_snapshot=applied' : '',
    ].filter(Boolean).join(' · ');
    const node = await this._createNode('ChannelPromotionApplied', {
      name: `channel-promotion@${nowIso()}`,
      summary: clipPreview(summary || 'channel promotion summary applied', 220),
      payload: {
        run_id: this.runId,
        overall_recommendation: String(overallRecommendation || '').trim().toLowerCase() || undefined,
        goal_excerpt: clipPreview(goalExcerpt, 280) || undefined,
        motif: motifRow,
        participant_policy: participantRow,
        ts: nowIso(),
        ...this._runtimeMetadataPatch(),
        ...this._sharedContextPayload(),
        ...this._contractPayload(),
      },
    });
    const nodeId = String(node?.id || '').trim();
    if (nodeId && this.runNodeId) await this._createEdge(this.runNodeId, nodeId, 'HAS_PART');
    return node;
  }

  async attachArtifact(stepNodeId, {
    name = "",
    summary = "",
    text = "",
    uri = "",
    payload = {},
  } = {}) {
    if (!this.isEnabled() || !this._lifecycleEnabled()) return null;
    const stepId = String(stepNodeId || "").trim();
    if (!stepId) return null;
    const artifactText = String(text || "");
    if (!artifactText.trim()) return null;
    try {
      const resource = await this.client.createResource(this.threadId, {
        name: String(name || "").trim() || `artifact@${nowIso()}`,
        summary: String(summary || "").trim() || clipPreview(artifactText, 220),
        text_mode: "plain",
        raw_text: artifactText,
        resource_kind: "artifact",
        uri: String(uri || "").trim() || undefined,
        context_set_id: this.contextSetId || undefined,
        auto_activate: true,
        payload_json: {
          run_id: this.runId,
          step_node_id: stepId,
          ...asObject(payload),
        },
      });
      const resourceNodeId = String(resource?.id || "").trim();
      if (resourceNodeId) await this._createEdge(stepId, resourceNodeId, "ATTACHED_TO");
      return resource;
    } catch (e) {
      this._log(`[goc-exec] attachArtifact failed: ${safeErrorMessage(e)}`);
      return null;
    }
  }
}
