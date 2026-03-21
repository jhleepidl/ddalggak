import { parseJsonObjectFromText } from "../shared/json_extract.js";
import { normalizeStringList } from "../shared/normalize.js";
import { resolveProviderActionRisk } from "../application/failure_recovery_policy.js";

export function normalizeForceMode(raw) {
  return String(raw || "").trim().toLowerCase() === "work" ? "work" : "normal";
}

export function normalizeRunRouteAction(raw, { resolveAgentId = null } = {}) {
  const type = String(raw?.type || "").trim().toLowerCase();
  if (!type) return null;
  const resolver = typeof resolveAgentId === "function"
    ? resolveAgentId
    : (value) => String(value || "").trim().toLowerCase();
  const inputs = raw?.inputs && typeof raw.inputs === "object" ? raw.inputs : {};

  if (type === "agent_run") {
    const agent = resolver(raw.agent || raw.agentId || raw.role);
    const prompt = String(raw.prompt || raw.task || raw.instruction || "").trim();
    if (!agent || !prompt) return null;
    return { type: "agent_run", agent, prompt, inputs };
  }

  if (type === "gemini" || type === "gemini_research") {
    const prompt = String(raw.prompt || raw.query || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "agent_run", agent: "researcher", prompt, inputs: {} };
  }

  if (type === "codex" || type === "codex_implement") {
    const instruction = String(raw.instruction || raw.prompt || raw.task || "").trim();
    if (!instruction) return null;
    return { type: "agent_run", agent: "builder", prompt: instruction, inputs: {} };
  }

  if (type === "git_summary") return { type: "git_summary" };

  if (type === "chatgpt_prompt") {
    const question = String(raw.question || raw.prompt || raw.task || "").trim();
    return { type: "chatgpt_prompt", question };
  }

  if (type === "chatgpt") {
    const prompt = String(raw.question || raw.prompt || raw.task || "").trim();
    if (!prompt) return null;
    return { type: "chatgpt_prompt", question: prompt };
  }

  if (["spawn_parallel", "checkpoint", "pause_children", "cancel_child", "reroute_child", "supervisor_decision", "synthesize_final", "gate_wait", "human_checkpoint", "tool_proxy_call", "memory_sync", "committee_consensus"].includes(type)) {
    const agents = Array.isArray(raw?.agents)
      ? raw.agents
        .map((agent) => {
          const childAgent = resolver(agent?.agent || agent?.agentId || agent?.agent_id || agent?.role);
          const childPrompt = String(agent?.prompt || agent?.goal || agent?.task || "").trim();
          if (!childAgent || !childPrompt) return null;
          return {
            type: "agent_run",
            agent: childAgent,
            prompt: childPrompt,
            inputs: agent?.inputs && typeof agent.inputs === "object" ? agent.inputs : {},
          };
        })
        .filter(Boolean)
      : [];
    return {
      type,
      agent: type === "synthesize_final"
        ? resolver(raw.agent || raw.agentId || raw.role || "synthesizer")
        : undefined,
      label: String(raw.label || raw.reason || raw.summary || "").trim() || undefined,
      prompt: String(raw.prompt || raw.goal || raw.summary || "").trim() || undefined,
      inputs,
      agents,
      metadata: raw?.metadata && typeof raw.metadata === "object" ? raw.metadata : undefined,
    };
  }

  return null;
}

export function parseRouterPlan(raw, { resolveAgentId = null } = {}) {
  const parsed = parseJsonObjectFromText(raw);
  if (!parsed || !Array.isArray(parsed.actions)) return null;
  const actions = parsed.actions
    .map((action) => normalizeRunRouteAction(action, { resolveAgentId }))
    .filter(Boolean);
  if (actions.length === 0) return null;
  return {
    actions,
    reason: String(parsed.reason || "").trim() || "(no reason)",
  };
}

export function normalizeRoutePlan(routePlan, {
  maxActions = 4,
  resolveAgentId = null,
} = {}) {
  const parsed = routePlan && typeof routePlan === "object" ? routePlan : {};
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const outActions = [];

  for (const action of actions) {
    if (outActions.length >= Math.max(1, Math.floor(Number(maxActions) || 4))) break;
    const normalized = normalizeRunRouteAction(action, { resolveAgentId });
    if (!normalized) continue;
    outActions.push(normalized);
  }

  return {
    reason: String(parsed.reason || "route plan").trim() || "route plan",
    actions: outActions,
    mode: String(parsed.mode || "").trim().toLowerCase() || undefined,
    action_source: String(parsed.action_source || parsed.actionSource || "").trim().toLowerCase() || undefined,
    done: parsed.done === true,
    await_user: parsed.await_user === true || parsed.awaitUser === true,
    deliverables: normalizeStringList(parsed.deliverables || [], { max: 24 }),
    completed_deliverables: normalizeStringList(
      parsed.completed_deliverables ?? parsed.completedDeliverables ?? [],
      { max: 24 }
    ),
    followup_hint: String((parsed.followup_hint ?? parsed.followupHint) || "").trim() || undefined,
    final_response_style: String(parsed.final_response_style || "concise").trim() || "concise",
    execution_graph: parsed.execution_graph && typeof parsed.execution_graph === "object"
      ? parsed.execution_graph
      : (parsed.executionGraph && typeof parsed.executionGraph === "object" ? parsed.executionGraph : undefined),
    parallel_groups: Array.isArray(parsed.parallel_groups)
      ? parsed.parallel_groups
      : (Array.isArray(parsed.parallelGroups) ? parsed.parallelGroups : []),
    checkpoints: Array.isArray(parsed.checkpoints) ? parsed.checkpoints : [],
    collaboration_cells: Array.isArray(parsed.collaboration_cells)
      ? parsed.collaboration_cells
      : (Array.isArray(parsed.collaborationCells) ? parsed.collaborationCells : []),
    supervisor_runtime: parsed.supervisor_runtime && typeof parsed.supervisor_runtime === "object"
      ? parsed.supervisor_runtime
      : (parsed.supervisorRuntime && typeof parsed.supervisorRuntime === "object" ? parsed.supervisorRuntime : undefined),
    authority_graph: Array.isArray(parsed.authority_graph)
      ? parsed.authority_graph
      : (Array.isArray(parsed.authorityGraph) ? parsed.authorityGraph : []),
    selection_explanations: Array.isArray(parsed.selection_explanations)
      ? parsed.selection_explanations
      : (Array.isArray(parsed.selectionExplanations) ? parsed.selectionExplanations : []),
  };
}

function normalizeActionAgentId(rawAction = {}) {
  return String(rawAction?.agent_id || rawAction?.agentId || rawAction?.agent || "").trim().toLowerCase();
}

export function sanitizeSupervisorRoutePlan(routePlan, {
  message = "",
  agents = [],
  allowReadOnlyControl = false,
  forceMode = "normal",
  isReadOnlyControlAction = () => false,
  isMutatingAction = () => false,
  isWorkLikeMessage = () => false,
  isCodeNotebookRequest = () => false,
  pickRuntimeDefaultAgentId = () => "",
  findDefaultChatAgentId = () => "",
  pickCoderAgentId = () => "",
  hasCoderDelegation = () => false,
  extractDeliverablesFromMessage = () => [],
} = {}) {
  const cleanForceMode = normalizeForceMode(forceMode);
  let done = routePlan?.done === true;
  const awaitUser = routePlan?.await_user === true || routePlan?.awaitUser === true;
  let deliverables = normalizeStringList(routePlan?.deliverables, { max: 24 });
  let completedDeliverables = normalizeStringList(
    routePlan?.completed_deliverables ?? routePlan?.completedDeliverables,
    { max: 24 }
  );
  const followupHint = String((routePlan?.followup_hint ?? routePlan?.followupHint) || "").trim();
  const sourceActions = Array.isArray(routePlan?.actions) ? routePlan.actions : [];

  const enabledAgentSet = new Set(
    (Array.isArray(agents) ? agents : [])
      .map((row) => String(row?.id || row?.agent_id || row?.agentId || "").trim().toLowerCase())
      .filter(Boolean)
  );

  const filtered = [];
  let droppedDisabledAgentActions = 0;

  for (const action of sourceActions) {
    if (!action || typeof action !== "object") continue;
    if (!allowReadOnlyControl && isReadOnlyControlAction(action)) continue;
    if (cleanForceMode === "work" && isMutatingAction(action)) continue;

    const type = String(action.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const targetAgentId = normalizeActionAgentId(action);
      if (!targetAgentId || !enabledAgentSet.has(targetAgentId)) {
        droppedDisabledAgentActions += 1;
        continue;
      }
      filtered.push({ ...action, agent_id: targetAgentId });
      continue;
    }

    if (type === "spawn_agents") {
      const children = Array.isArray(action.agents) ? action.agents : [];
      const nextChildren = [];
      for (const child of children) {
        const childAgentId = normalizeActionAgentId(child);
        const childGoal = String(child?.goal || child?.prompt || child?.task || "").trim();
        if (!childAgentId || !childGoal) continue;
        if (!enabledAgentSet.has(childAgentId)) {
          droppedDisabledAgentActions += 1;
          continue;
        }
        nextChildren.push({ ...child, agent_id: childAgentId });
        if (nextChildren.length >= 8) break;
      }
      if (nextChildren.length === 0) continue;
      filtered.push({ ...action, agents: nextChildren });
      continue;
    }

    filtered.push(action);
  }

  let actions = filtered;
  let reason = String(routePlan?.reason || "supervisor route").trim() || "supervisor route";
  if (droppedDisabledAgentActions > 0) reason = `${reason}; filtered_disabled_agents=${droppedDisabledAgentActions}`;

  if (actions.length === 0) {
    if (!done && !awaitUser && isWorkLikeMessage(message)) {
      const fallbackAgent = pickRuntimeDefaultAgentId(agents) || findDefaultChatAgentId();
      if (fallbackAgent) {
        actions = [{
          type: "run_agent",
          agent_id: fallbackAgent,
          goal: `사용자 요청을 계획하고 필요한 agent 작업을 제안/수행: ${String(message || "").trim()}`,
          risk: "L1",
        }];
        reason = `${reason}; empty_actions_work_like_runtime_fallback`;
        done = false;
      } else {
        actions = [{ type: "summarize", hint: "작업 실행 가능한 enabled agent가 없어 summarize로 종료", risk: "L0" }];
        reason = `${reason}; no_enabled_agents_summary_fallback`;
      }
    } else if (!done && !awaitUser) {
      const fallbackAgent = pickRuntimeDefaultAgentId(agents) || findDefaultChatAgentId();
      if (fallbackAgent) {
        actions = [{
          type: "run_agent",
          agent_id: fallbackAgent,
          goal: String(message || "").trim() || "현재 우선순위 작업을 진행해줘.",
          risk: "L1",
        }];
        reason = `${reason}; filtered_to_work_fallback`;
        done = false;
      } else {
        actions = [{ type: "summarize", hint: "작업 실행 가능한 enabled agent가 없어 summarize로 종료", risk: "L0" }];
        reason = `${reason}; filtered_to_summary_fallback`;
      }
    }
  }

  if (deliverables.length === 0) deliverables = normalizeStringList(extractDeliverablesFromMessage(message), { max: 24 });
  completedDeliverables = completedDeliverables.filter((entry) => deliverables.length === 0
    || deliverables.some((item) => item.toLowerCase() === String(entry || "").trim().toLowerCase()));

  if (!awaitUser && !done && isCodeNotebookRequest(message)) {
    const coderAgentId = pickCoderAgentId(agents);
    if (coderAgentId && !hasCoderDelegation(actions, coderAgentId)) {
      const coderAction = {
        type: "run_agent",
        agent_id: coderAgentId,
        goal: `요청된 코드/노트북 산출물을 구현: ${String(message || "").trim()}`,
        risk: resolveProviderActionRisk({
          action: {
            type: "run_agent",
            agent_id: coderAgentId,
            goal: `요청된 코드/노트북 산출물을 구현: ${String(message || "").trim()}`,
          },
          provider: 'codex',
          fallback: 'L2',
        }),
      };
      actions = actions.length < 4
        ? [...actions, coderAction]
        : [...actions.slice(0, 3), coderAction];
      reason = `${reason}; forced_coder_for_code_deliverable`;
      done = false;
    }
  }

  return {
    reason,
    actions: actions.slice(0, 4),
    final_response_style: routePlan?.final_response_style || "concise",
    done,
    await_user: awaitUser,
    deliverables,
    completed_deliverables: completedDeliverables,
    followup_hint: followupHint || undefined,
  };
}

export function validateRoutePlan(raw = {}) {
  const plan = normalizeRoutePlan(raw);
  const errors = [];
  if (!Array.isArray(plan.actions) || plan.actions.length === 0) errors.push("actions_required");
  return {
    ok: errors.length === 0,
    errors,
    route_plan: plan,
  };
}
