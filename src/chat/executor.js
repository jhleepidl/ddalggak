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
      results.push({ label, status: "error", note: String(e?.message ?? e) });
    }
  }

  if (sessionStore) {
    sessionStore.upsert(chatId, {
      state: pendingApproval ? "awaiting_approval" : "done",
      pending_approval: pendingApproval,
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
