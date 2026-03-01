import crypto from "node:crypto";
import {
  actionNeedsApproval,
  isActionAllowed,
  parseAllowlist,
} from "./actions.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function actionLabel(action) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!type) return "(unknown)";
  if (type === "run_agent") return `run_agent:${action.agent_id || "unknown"}`;
  if (type === "propose_agent") return `propose_agent:${action.agent_id || "unknown"}`;
  if (type === "need_more_detail") return `need_more_detail:${action.context_set_id || "unknown"}`;
  if (type === "search_public_agents") return `search_public_agents:${action.query || ""}`;
  if (type === "install_agent_blueprint") return `install_agent_blueprint:${action.blueprint_id || action.public_node_id || ""}`;
  if (type === "publish_agent") return `publish_agent:${action.agent_id || action.agent_node_id || ""}`;
  if (type === "disable_agent") return `disable_agent:${action.agent_id || "unknown"}`;
  if (type === "enable_agent") return `enable_agent:${action.agent_id || "unknown"}`;
  if (type === "disable_tool") return `disable_tool:${action.tool_id || "unknown"}`;
  if (type === "enable_tool") return `enable_tool:${action.tool_id || "unknown"}`;
  if (type === "list_agents") return "list_agents";
  if (type === "list_tools") return "list_tools";
  if (type === "create_agent") return `create_agent:${action.agent?.id || action.agent_id || "unknown"}`;
  if (type === "update_agent") return `update_agent:${action.agentId || action.agent_id || "unknown"}`;
  if (type === "get_status") return "get_status";
  if (type === "interrupt") return `interrupt:${action.mode || "replan"}`;
  if (type === "spawn_agents") return `spawn_agents:${Array.isArray(action.agents) ? action.agents.length : 0}`;
  if (type === "open_context") return `open_context:${action.scope || "current"}`;
  return type;
}

function getProviderByAgent(agents = [], agentId = "") {
  const key = String(agentId || "").trim().toLowerCase();
  if (!key) return "";
  const rows = Array.isArray(agents) ? agents : [];
  const found = rows.find((agent) => String(agent?.id || "").trim().toLowerCase() === key);
  return String(found?.provider || "").trim().toLowerCase();
}

function nextApprovalId() {
  return `appr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function isAbortLikeError(error) {
  const code = String(error?.code || "").trim().toUpperCase();
  if (code === "ECANCELLED" || code === "ABORT_ERR") return true;
  const message = String(error?.message || "").toLowerCase();
  return message.includes("cancelled")
    || message.includes("aborted")
    || message.includes("aborterror");
}

function makeCancelledError(reason = "cancelled") {
  const e = new Error(String(reason || "cancelled"));
  e.code = "ECANCELLED";
  return e;
}

function readInterruptState(sessionStore, chatId) {
  if (!sessionStore || typeof sessionStore.get !== "function") return null;
  const session = sessionStore.get(chatId);
  const interrupt = session?.interrupt && typeof session.interrupt === "object"
    ? session.interrupt
    : null;
  if (!interrupt || interrupt.requested !== true) return null;
  return {
    requested: true,
    mode: String(interrupt.mode || "").trim().toLowerCase() === "cancel" ? "cancel" : "replan",
    reason: String(interrupt.reason || "").trim(),
    ts: String(interrupt.ts || "").trim(),
  };
}

export async function executeSupervisorActions({
  chatId,
  userId,
  jobId,
  plan,
  jobConfig = {},
  agents = [],
  tools = [],
  sessionStore = null,
  callbacks = {},
} = {}) {
  const config = asObject(jobConfig);
  const budgetCfg = asObject(config.budget);
  const approvalCfg = asObject(config.approval);
  const allowlist = parseAllowlist(config, tools);
  const actions = Array.isArray(plan?.actions) ? plan.actions : [];
  const maxActions = Number.isFinite(Number(budgetCfg.max_actions))
    ? Math.max(1, Math.floor(Number(budgetCfg.max_actions)))
    : 4;

  const results = [];
  const outputs = [];
  let detailContext = "";
  let pendingApproval = null;
  let blockedIndex = -1;
  let remainingActions = [];
  let usedActions = 0;
  let blockedActions = 0;
  let interruptedByReplan = false;

  if (sessionStore) {
    sessionStore.upsert(chatId, {
      jobId: String(jobId || "").trim(),
      state: "executing",
      pending_approval: null,
      budget: {
        max_actions: maxActions,
      },
    });
  }

  for (let i = 0; i < actions.length; i += 1) {
    const action = actions[i];
    const label = actionLabel(action);
    const interruptBefore = readInterruptState(sessionStore, chatId);
    if (interruptBefore?.requested) {
      if (interruptBefore.mode === "cancel") {
        throw makeCancelledError(interruptBefore.reason || `interrupt(cancel) before ${label}`);
      }
      interruptedByReplan = true;
      results.push({
        label: "interrupt",
        status: "skip",
        note: interruptBefore.reason
          ? `replan requested before ${label}: ${interruptBefore.reason}`
          : `replan requested before ${label}`,
      });
      break;
    }

    if (!isActionAllowed(action, allowlist)) {
      blockedActions += 1;
      results.push({ label, status: "blocked", note: "not in allowlist" });
      continue;
    }
    if (usedActions >= maxActions) {
      blockedActions += 1;
      results.push({ label, status: "blocked", note: `budget exceeded (max_actions=${maxActions})` });
      break;
    }

    const provider = action?.type === "run_agent"
      ? getProviderByAgent(agents, action.agent_id)
      : "";
    const approval = actionNeedsApproval(action, {
      approval: approvalCfg,
      provider,
    });
    if (approval.required) {
      blockedActions += 1;
      blockedIndex = i;
      remainingActions = actions.slice(i);
      pendingApproval = {
        id: nextApprovalId(),
        chat_id: String(chatId || ""),
        job_id: String(jobId || ""),
        action,
        reason: approval.reason,
        blocked_index: i,
        remaining_actions: remainingActions,
        already_done: {
          results: [...results],
          outputs: [...outputs],
        },
        requested_by: String(userId || ""),
        ts: new Date().toISOString(),
      };
      results.push({ label, status: "blocked", note: `approval required: ${approval.reason}` });
      if (sessionStore) {
        sessionStore.upsert(chatId, {
          state: "awaiting_approval",
          pending_approval: pendingApproval,
        });
      }
      break;
    }

    try {
      if (action.type === "need_more_detail") {
        if (typeof callbacks.needMoreDetail !== "function") {
          throw new Error("needMoreDetail callback is missing");
        }
        const expanded = await callbacks.needMoreDetail({
          action,
          jobId,
          detailContext,
        });
        detailContext = String(expanded?.detail_context || detailContext || "");
        const usedNodeCount = Array.isArray(expanded?.used_node_ids) ? expanded.used_node_ids.length : 0;
        results.push({ label, status: "ok", note: `detail_nodes=${usedNodeCount}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "run_agent") {
        if (typeof callbacks.runAgent !== "function") {
          throw new Error("runAgent callback is missing");
        }
        const runResult = await callbacks.runAgent({
          action,
          jobId,
          detailContext,
        });
        const outputText = String(runResult?.output || "");
        outputs.push({
          agentId: String(action.agent_id || "").trim().toLowerCase(),
          provider: String(runResult?.provider || provider || "").trim().toLowerCase(),
          mode: String(runResult?.mode || ""),
          output: outputText,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `provider=${provider || "unknown"}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "spawn_agents") {
        if (typeof callbacks.spawnAgents !== "function") {
          throw new Error("spawnAgents callback is missing");
        }
        const spawned = await callbacks.spawnAgents({
          action,
          jobId,
          detailContext,
        });
        const children = Array.isArray(spawned?.children) ? spawned.children : [];
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "spawn_agents",
          output: String(spawned?.summary || spawned?.text || "").trim() || `spawn finished (${children.length})`,
          children,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `children=${children.length}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "propose_agent") {
        if (typeof callbacks.proposeAgent !== "function") {
          throw new Error("proposeAgent callback is missing");
        }
        const draft = await callbacks.proposeAgent({
          action,
          jobId,
          userId,
          chatId,
        });
        results.push({
          label,
          status: "ok",
          note: `draft=${draft?.draft_id || draft?.id || action.agent_id || "unknown"}`,
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "create_agent") {
        if (typeof callbacks.createAgent !== "function") {
          throw new Error("createAgent callback is missing");
        }
        const created = await callbacks.createAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "create_agent",
          output: String(created?.text || created?.message || "").trim()
            || `agent 생성 완료: @${String(created?.agent_id || action.agent?.id || "").trim()}`,
          jobId: String(jobId || ""),
        });
        results.push({
          label,
          status: "ok",
          note: String(created?.agent_id || action.agent?.id || "created"),
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "update_agent") {
        if (typeof callbacks.updateAgent !== "function") {
          throw new Error("updateAgent callback is missing");
        }
        const updated = await callbacks.updateAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "update_agent",
          output: String(updated?.text || updated?.message || "").trim()
            || `agent 수정 완료: @${String(updated?.agent_id || action.agentId || "").trim()}`,
          jobId: String(jobId || ""),
        });
        results.push({
          label,
          status: "ok",
          note: String(updated?.agent_id || action.agentId || "updated"),
        });
        usedActions += 1;
        continue;
      }

      if (action.type === "search_public_agents") {
        if (typeof callbacks.searchPublicAgents !== "function") {
          throw new Error("searchPublicAgents callback is missing");
        }
        const found = await callbacks.searchPublicAgents({
          action,
          jobId,
          chatId,
          userId,
        });
        const list = Array.isArray(found?.items) ? found.items : [];
        const lines = list.length > 0
          ? list.map((row, index) => {
            const agentId = String(row?.agent_id || "").trim();
            const blueprintId = String(row?.blueprint_id || "").trim();
            const title = String(row?.title || "").trim();
            const tags = Array.isArray(row?.tags) && row.tags.length > 0 ? ` tags=${row.tags.join(",")}` : "";
            return `${index + 1}. ${title || blueprintId || agentId} (${agentId ? `@${agentId}` : "agent:n/a"}, blueprint=${blueprintId || "n/a"})${tags}`;
          }).join("\n")
          : "검색 결과가 없습니다.";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "public_search",
          output: lines,
          items: list,
          query: String(action.query || ""),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `candidates=${list.length}` });
        usedActions += 1;
        continue;
      }

      if (action.type === "install_agent_blueprint") {
        if (typeof callbacks.installAgentBlueprint !== "function") {
          throw new Error("installAgentBlueprint callback is missing");
        }
        const installed = await callbacks.installAgentBlueprint({
          action,
          jobId,
          chatId,
          userId,
          outputs,
          results,
        });
        const agentId = String(installed?.agent_id || "").trim().toLowerCase();
        const blueprintId = String(installed?.blueprint_id || "").trim();
        const line = agentId
          ? `설치 완료: @${agentId}\n이제 @${agentId} 로 사용 가능`
          : "설치 완료";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "install_agent_blueprint",
          output: line,
          installed_agent_id: agentId,
          blueprint_id: blueprintId,
          public_node_id: String(installed?.public_node_id || "").trim(),
          node_id: String(installed?.node_id || installed?.created?.id || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: agentId ? `@${agentId}` : (blueprintId || "installed") });
        usedActions += 1;
        continue;
      }

      if (action.type === "publish_agent") {
        if (typeof callbacks.publishAgent !== "function") {
          throw new Error("publishAgent callback is missing");
        }
        const requested = await callbacks.publishAgent({
          action,
          jobId,
          chatId,
          userId,
        });
        const requestId = String(
          requested?.request_id
          || requested?.id
          || requested?.publish_request_id
          || ""
        ).trim();
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "publish_agent_request",
          output: requestId
            ? `공개 요청 접수됨: request_id=${requestId}\n관리자 승인 후 라이브러리에 반영됩니다.`
            : "공개 요청이 생성되었습니다. 관리자 승인 후 반영됩니다.",
          request_id: requestId,
          source_node_id: String(requested?.source_node_id || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: requestId || "request created" });
        usedActions += 1;
        continue;
      }

      if (action.type === "open_context") {
        if (typeof callbacks.openContext !== "function") {
          throw new Error("openContext callback is missing");
        }
        const opened = await callbacks.openContext({
          action,
          jobId,
          chatId,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "context_link",
          output: String(opened?.text || opened?.link || "").trim(),
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: String(opened?.scope || action.scope || "current") });
        usedActions += 1;
        continue;
      }

      if (action.type === "disable_agent" || action.type === "enable_agent" || action.type === "disable_tool" || action.type === "enable_tool") {
        if (typeof callbacks.updateJobConfigSelection !== "function") {
          throw new Error("updateJobConfigSelection callback is missing");
        }
        const kind = action.type.endsWith("_tool") ? "tool" : "agent";
        const op = action.type.startsWith("enable_") ? "enable" : "disable";
        const targetId = kind === "tool"
          ? String(action.tool_id || "").trim().toLowerCase()
          : String(action.agent_id || "").trim().toLowerCase();
        if (!targetId) throw new Error(`${action.type} requires ${kind}_id`);

        const updated = await callbacks.updateJobConfigSelection({
          jobId,
          op,
          kind,
          id: targetId,
          action,
          chatId,
          userId,
        });
        const marker = op === "enable" ? "✅" : "🚫";
        const line = kind === "agent"
          ? `${marker} @${targetId} ${op === "enable" ? "enabled" : "disabled"}`
          : `${marker} tool ${targetId} ${op === "enable" ? "enabled" : "disabled"}`;
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "job_config_selection",
          output: line,
          kind,
          op,
          id: targetId,
          updated: updated || null,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: line.replace(/^[✅🚫]\s*/, "") });
        usedActions += 1;
        if (i < actions.length - 1) {
          results.push({
            label: "selection_update",
            status: "skip",
            note: "job_config updated; apply on next /chat",
          });
        }
        break;
      }

      if (action.type === "list_agents") {
        let text = "";
        if (typeof callbacks.listAgents === "function") {
          const listed = await callbacks.listAgents({
            action,
            jobId,
            chatId,
            userId,
          });
          text = String(listed?.text || "").trim();
        }
        if (!text) {
          const ids = (Array.isArray(agents) ? agents : [])
            .map((row) => String(row?.id || "").trim().toLowerCase())
            .filter(Boolean);
          text = ids.length > 0
            ? `현재 job에서 사용 가능한 agent:\n${ids.map((id) => `- @${id}`).join("\n")}`
            : "현재 job에서 사용 가능한 agent가 없습니다.";
        }
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "list_agents",
          output: text,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "listed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "list_tools") {
        let text = "";
        if (typeof callbacks.listTools === "function") {
          const listed = await callbacks.listTools({
            action,
            jobId,
            chatId,
            userId,
          });
          text = String(listed?.text || "").trim();
        }
        if (!text) {
          const ids = (Array.isArray(tools) ? tools : [])
            .map((row) => String(row?.id || row?.name || "").trim().toLowerCase())
            .filter(Boolean);
          text = ids.length > 0
            ? `현재 job에서 사용 가능한 tool:\n${ids.map((id) => `- ${id}`).join("\n")}`
            : "현재 job에서 사용 가능한 tool이 없습니다.";
        }
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "list_tools",
          output: text,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "listed" });
        usedActions += 1;
        continue;
      }

      if (action.type === "get_status") {
        if (typeof callbacks.getStatus !== "function") {
          throw new Error("getStatus callback is missing");
        }
        const status = await callbacks.getStatus({
          action,
          chatId,
          jobId,
          userId,
          sessionStore,
        });
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "get_status",
          output: String(status?.text || "").trim() || "현재 상태를 확인했습니다.",
          status: status?.status || null,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: "status" });
        usedActions += 1;
        continue;
      }

      if (action.type === "interrupt") {
        if (typeof callbacks.interrupt !== "function") {
          throw new Error("interrupt callback is missing");
        }
        const interrupted = await callbacks.interrupt({
          action,
          chatId,
          jobId,
          userId,
        });
        const mode = String(action.mode || interrupted?.mode || "replan").trim().toLowerCase() === "cancel"
          ? "cancel"
          : "replan";
        outputs.push({
          agentId: "system",
          provider: "system",
          mode: "interrupt",
          output: String(interrupted?.text || "").trim()
            || (mode === "cancel" ? "⛔️ 현재 실행을 중단했습니다." : "🔄 재계획을 위해 현재 실행을 선점 중단합니다."),
          interrupt_mode: mode,
          jobId: String(jobId || ""),
        });
        results.push({ label, status: "ok", note: `mode=${mode}` });
        usedActions += 1;
        interruptedByReplan = true;
        break;
      }

      if (action.type === "summarize") {
        if (typeof callbacks.summarize === "function") {
          const summary = await callbacks.summarize({
            action,
            jobId,
            outputs,
            results,
            detailContext,
          });
          if (summary?.text) {
            outputs.push({
              agentId: "supervisor",
              provider: "system",
              mode: "summary",
              output: String(summary.text),
              jobId: String(jobId || ""),
            });
          }
        }
        results.push({ label, status: "ok", note: action.hint || "checkpoint" });
        usedActions += 1;
        continue;
      }

      blockedActions += 1;
      results.push({ label, status: "skip", note: "unsupported action" });
    } catch (e) {
      if (isAbortLikeError(e)) throw e;
      results.push({ label, status: "error", note: String(e?.message ?? e) });
    }

    const interruptAfter = readInterruptState(sessionStore, chatId);
    if (interruptAfter?.requested) {
      if (interruptAfter.mode === "cancel") {
        throw makeCancelledError(interruptAfter.reason || `interrupt(cancel) after ${label}`);
      }
      interruptedByReplan = true;
      results.push({
        label: "interrupt",
        status: "skip",
        note: interruptAfter.reason
          ? `replan requested after ${label}: ${interruptAfter.reason}`
          : `replan requested after ${label}`,
      });
      break;
    }
  }

  if (sessionStore) {
    sessionStore.upsert(chatId, {
      state: pendingApproval
        ? "awaiting_approval"
        : (interruptedByReplan ? "idle" : "done"),
      pending_approval: pendingApproval,
      interrupt: null,
      budget: {
        max_actions: maxActions,
        used_actions: usedActions,
        blocked_actions: blockedActions,
      },
    });
  }

  return {
    results,
    outputs,
    currentJobId: String(jobId || ""),
    detailContext,
    pendingApproval,
    blocked_index: blockedIndex,
    remaining_actions: remainingActions,
  };
}
