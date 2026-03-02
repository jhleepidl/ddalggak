import { randomUUID } from "node:crypto";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
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
  if (type === "spawn_agents") return "router";
  if (type === "need_more_detail") return "context";
  return "system";
}

function actionGoal(action) {
  const type = actionType(action);
  if (type === "spawn_agents") return String(action?.summary || action?.goal || "").trim();
  return String(action?.goal || action?.prompt || action?.task || action?.hint || "").trim();
}

function safeErrorMessage(error) {
  return String(error?.message ?? error ?? "").trim();
}

export class GocExecutionGraphRecorder {
  constructor({
    client,
    threadId = "",
    contextSetId = "",
    runId = "",
    chatId = "",
    jobId = "",
    logger = null,
  } = {}) {
    this.client = client || null;
    this.threadId = String(threadId || "").trim();
    this.contextSetId = String(contextSetId || "").trim();
    this.runId = String(runId || "").trim() || `run_${randomUUID()}`;
    this.chatId = String(chatId || "").trim();
    this.jobId = String(jobId || "").trim();
    this.logger = typeof logger === "function" ? logger : null;

    this.runNodeId = "";
    this.payloadByNodeId = new Map();
    this.stepMetaByAction = new WeakMap();
  }

  isEnabled() {
    return !!(this.client && this.threadId);
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

  async startRun({ userMessageNodeId = "", userText = "" } = {}) {
    if (!this.isEnabled()) return null;
    if (this.runNodeId) return { id: this.runNodeId };
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
    await this._updateNodePayload(this.runNodeId, {
      status: normalizedStatus,
      ended_at: nowIso(),
      summary: clipPreview(summary, 1000) || undefined,
      error: clipPreview(error, 1000) || undefined,
    }, {
      summary: clipPreview(summary || error || normalizedStatus, 220),
    });
  }

  async queueMainSteps(actions = []) {
    if (!this.isEnabled()) return;
    const rows = Array.isArray(actions) ? actions : [];
    let previousStepNodeId = "";
    for (let i = 0; i < rows.length; i += 1) {
      const action = rows[i];
      if (!action || typeof action !== "object") continue;
      const type = actionType(action);
      const stepId = `step_${randomUUID()}`;
      const goal = actionGoal(action);
      const agentId = actionAgentId(action);
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
      };
      const created = await this._createNode("Step", {
        name: `step:${stepId}`,
        summary: clipPreview(`${type}${agentId ? ` @${agentId}` : ""} ${goal}`.trim(), 240),
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

  async markStepError(action, error, { output = "", extra = {} } = {}) {
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
    if (!this.isEnabled()) return [];
    const list = Array.isArray(children) ? children : [];
    const parentNodeId = this.getStepNodeId(parentAction);
    const out = [];
    for (let i = 0; i < list.length; i += 1) {
      const child = asObject(list[i]);
      const childAgentId = String(child.agent_id || child.agent || "").trim().toLowerCase();
      const childGoal = String(child.goal || child.prompt || child.task || "").trim();
      if (!childAgentId || !childGoal) continue;
      const childStepId = `step_${randomUUID()}`;
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
      };
      const childNode = await this._createNode("Step", {
        name: `step:${childStepId}`,
        summary: clipPreview(`spawn @${childAgentId} ${childGoal}`, 240),
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
    if (!this.isEnabled()) return null;
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

  async attachArtifact(stepNodeId, {
    name = "",
    summary = "",
    text = "",
    uri = "",
    payload = {},
  } = {}) {
    if (!this.isEnabled()) return null;
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

