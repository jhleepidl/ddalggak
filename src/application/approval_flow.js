import { makeContextEngine } from "../context_engine/index.js";
import { normalizeActionSource, normalizeRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { markActionsSkipped, wasInterruptedByReplan } from "./run_status_cleanup.js";
import {
  isMutationOnlyTeamSetupPlan,
  isTeamMembershipMutationAction,
} from "../chat/action_classification.js";
import { isTeamSetupOnlyRequest } from "./team_intent.js";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function normalizeForceModeValue(raw = "") {
  return String(raw || "").trim().toLowerCase() === "work" ? "work" : "normal";
}

export function buildPostMutationRerouteKey({ jobId = "", userText = "" } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanText = String(userText || "").trim().toLowerCase().replace(/\s+/g, " ");
  return `${cleanJobId}::${cleanText}`;
}

function membershipActionKey(action = {}) {
  const type = String(action?.type || "").trim().toLowerCase();
  if (!isTeamMembershipMutationAction(type)) return "";
  const agentId = String(action?.agent_id || action?.agent || action?.agentId || "").trim().toLowerCase();
  if (!agentId) return "";
  return `${type}:${agentId}`;
}

export function summarizeMembershipMutationConfirmation({
  actions = [],
  outputs = [],
  results = [],
} = {}) {
  const actionRows = Array.isArray(actions) ? actions : [];
  const outputRows = Array.isArray(outputs) ? outputs : [];
  const resultRows = Array.isArray(results) ? results : [];
  const requestedKeys = [];
  const seenRequested = new Set();
  for (const action of actionRows) {
    const key = membershipActionKey(action);
    if (!key || seenRequested.has(key)) continue;
    seenRequested.add(key);
    requestedKeys.push(key);
  }

  const confirmedByKey = new Map();
  for (const row of outputRows) {
    const change = row?.membership_change && typeof row.membership_change === "object"
      ? row.membership_change
      : null;
    if (!change) continue;
    const key = membershipActionKey({
      type: change.action,
      agent_id: change.target_agent_id,
    });
    if (!key) continue;
    confirmedByKey.set(key, change.confirmed === true);
  }

  let confirmedCount = 0;
  const unresolvedKeys = [];
  for (const key of requestedKeys) {
    if (confirmedByKey.get(key) === true) {
      confirmedCount += 1;
      continue;
    }
    unresolvedKeys.push(key);
  }
  const failedCount = unresolvedKeys.length;
  const verificationErrorHints = resultRows
    .map((row) => String(row?.note || "").trim())
    .filter((note) => /membership|멤버십|readback|verification/i.test(note));
  return {
    required_count: requestedKeys.length,
    confirmed_count: confirmedCount,
    failed_count: failedCount,
    all_confirmed: requestedKeys.length === 0 || failedCount === 0,
    unresolved_keys: unresolvedKeys,
    verification_error_hints: verificationErrorHints.slice(0, 6),
  };
}

export function shouldTriggerPostMutationReroute({
  resumedActions = [],
  originalUserText = "",
  forceMode = "normal",
  workLikeHint = false,
  membershipConfirmation = null,
  rerouteGuard = null,
  rerouteLimit = 1,
} = {}) {
  if (!isMutationOnlyTeamSetupPlan(resumedActions)) {
    return {
      should_reroute: false,
      reason: "has_real_execution_or_non_team_actions",
      blocked_by_guard: false,
    };
  }
  const membership = membershipConfirmation && typeof membershipConfirmation === "object"
    ? membershipConfirmation
    : { required_count: 0, all_confirmed: true };
  if (Number(membership.required_count || 0) > 0 && membership.all_confirmed !== true) {
    return {
      should_reroute: false,
      reason: "membership_confirmation_failed",
      blocked_by_guard: false,
    };
  }
  const teamSetupOnly = isTeamSetupOnlyRequest(originalUserText, {
    forceMode: normalizeForceModeValue(forceMode),
    workLikeHint: workLikeHint === true,
  });
  if (teamSetupOnly) {
    return {
      should_reroute: false,
      reason: "team_setup_only_request",
      blocked_by_guard: false,
    };
  }
  const guard = asObject(rerouteGuard);
  const count = Number.isFinite(Number(guard.count))
    ? Math.max(0, Math.floor(Number(guard.count)))
    : 0;
  const limit = Math.max(1, Math.floor(Number(rerouteLimit) || 1));
  if (count >= limit) {
    return {
      should_reroute: false,
      reason: "reroute_limit_reached",
      blocked_by_guard: true,
    };
  }
  return {
    should_reroute: true,
    reason: "mutation_only_plan_for_work_request",
    blocked_by_guard: false,
  };
}

export function isActionApprovalCallbackData(data = "") {
  const raw = String(data || "").trim();
  return raw.startsWith("approve_action:")
    || raw.startsWith("reject_action:")
    || raw.startsWith("work_action:");
}

export async function handleActionApprovalCallback({
  q,
  msg,
  data,
  bot,
  chatId,
  userId,
  deps = {},
} = {}) {
  const {
    chatSessionStore,
    resolveCurrentJobIdForChat,
    tracking,
    chatActionLabel,
    chatRunManager,
    loadSupervisorRuntime,
    memoryModeWithFallback,
    requireGocClient,
    jobs,
    GocExecutionGraphRecorder,
    resetJobAbortController,
    activeJobByChat,
    rememberLastChatJob,
    buildQueuedAgentStatusFromActions,
    sendPlanPreviewMessage,
    getCurrentTurnReplyMessageId,
    executeSupervisorActions,
    normalizeForceMode,
    buildSupervisorExecutionCallbacks,
    CHAT_VERBOSE,
    sendAgentStatusTransitionMessage,
    synthesizeChatReply,
    clip,
    sendLong,
    buildPendingApprovalPrompt,
    maybeAutoSendOutputs,
    markMutatingActionsConfirmed,
    jobAbortControllers,
  } = deps;

  const isApprove = data.startsWith("approve_action:");
  const isWorkMode = data.startsWith("work_action:");
  const approvalId = String(data.split(":")[1] || "").trim();
  const session = chatSessionStore.get(chatId);
  const pending = session?.pending_approval && typeof session.pending_approval === "object"
    ? session.pending_approval
    : null;

  if (!pending?.id) {
    await bot.answerCallbackQuery(q.id, { text: "pending approval 없음" });
    await bot.sendMessage(chatId, "현재 승인 대기 중인 액션이 없습니다.");
    return { handled: true };
  }
  if (String(pending.id) !== approvalId) {
    await bot.answerCallbackQuery(q.id, { text: "approval id 불일치" });
    await bot.sendMessage(chatId, "승인 토큰이 현재 대기 상태와 일치하지 않습니다.");
    return { handled: true };
  }

  const pendingJobId = String(pending.job_id || session.jobId || resolveCurrentJobIdForChat(chatId) || "").trim();
  if (isWorkMode) {
    chatSessionStore.upsert(chatId, {
      jobId: pendingJobId || String(session.jobId || "").trim(),
      state: "idle",
      pending_approval: null,
      interrupt: null,
    });
    if (pendingJobId) {
      tracking.append(pendingJobId, "decisions.md", [
        "## /chat approval switched_to_work",
        `- approval_id: ${approvalId}`,
        `- action: ${String(pending?.action_display_label || "").trim() || chatActionLabel(pending.action)}`,
        `- switched_by: telegram:${userId}`,
      ].join("\n"));
    }

    const originalText = String(pending.original_user_text || "").trim();
    await bot.answerCallbackQuery(q.id, { text: "work mode" });
    if (!originalText) {
      await bot.sendMessage(chatId, "원문 메시지를 찾지 못해 작업 모드 재실행을 할 수 없습니다. 새 지시를 보내 주세요.");
      return { handled: true };
    }
    await bot.sendMessage(chatId, "🧩 작업 모드로 다시 처리할게요.");
    await chatRunManager.handleIncoming({
      chatId,
      userId,
      text: originalText,
      telegramMessageId: msg.message_id,
      kind: "normal",
      forceMode: "work",
      chatInfo: {
        chat_id: String(chatId || ""),
        title: String(msg.chat?.title || msg.chat?.username || "").trim(),
        type: String(msg.chat?.type || "").trim(),
      },
    });
    return { handled: true };
  }

  if (!pendingJobId) {
    chatSessionStore.upsert(chatId, { state: "idle", pending_approval: null });
    await bot.answerCallbackQuery(q.id, { text: "job 없음" });
    await bot.sendMessage(chatId, "승인 재개 대상 jobId를 찾지 못해 pending 상태를 정리했습니다.");
    return { handled: true };
  }

  if (!isApprove) {
    chatSessionStore.upsert(chatId, {
      jobId: pendingJobId,
      state: "idle",
      pending_approval: null,
    });
    tracking.append(pendingJobId, "decisions.md", [
      "## /chat approval rejected",
      `- approval_id: ${approvalId}`,
      `- action: ${String(pending?.action_display_label || "").trim() || chatActionLabel(pending.action)}`,
      `- rejected_by: telegram:${userId}`,
    ].join("\n"));
    await bot.answerCallbackQuery(q.id, { text: "rejected" });
    await bot.sendMessage(chatId, "승인 거절됨. 대기 중이던 액션은 취소되었습니다.");
    return { handled: true };
  }

  await bot.answerCallbackQuery(q.id, { text: "approved" });
  await bot.sendMessage(
    chatId,
    "✅ 승인 반영 중…",
    Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
      ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
      : undefined
  );
  const remainingActions = Array.isArray(pending.remaining_actions) && pending.remaining_actions.length > 0
    ? pending.remaining_actions
    : (pending.action ? [pending.action] : []);
  if (remainingActions.length === 0) {
    chatSessionStore.upsert(chatId, {
      jobId: pendingJobId,
      state: "idle",
      pending_approval: null,
    });
    await bot.sendMessage(chatId, "재개할 남은 action이 없어 승인 대기를 해제했습니다.");
    return { handled: true };
  }

  const resumedActions = markMutatingActionsConfirmed(remainingActions).map((action, index) => {
    if (index !== 0 || !action || typeof action !== "object") return action;
    return { ...action, approved: true, _approved: true };
  });
  const normalizeForceModeFn = typeof normalizeForceMode === "function"
    ? normalizeForceMode
    : normalizeForceModeValue;
  const resumeForceMode = normalizeForceModeFn(pending.force_mode || "normal");
  const runtime = await loadSupervisorRuntime(pendingJobId, {
    chatMeta: { chat_id: String(chatId || ""), telegram_user_id: String(userId || "") },
    telegramUserId: userId,
  });
  if (memoryModeWithFallback() === "goc" && runtime?.map?.ctxSharedId) {
    try {
      const meta = await requireGocClient().getContextSet(runtime.map.ctxSharedId);
      runtime.contextMeta = {
        context_set_id: runtime.map.ctxSharedId,
        version: String(meta?.version || "").trim(),
        active_node_ids: Array.isArray(meta?.activeNodeIds)
          ? meta.activeNodeIds.map((row) => String(row || "").trim()).filter(Boolean)
          : [],
      };
    } catch {
      runtime.contextMeta = {
        context_set_id: runtime.map.ctxSharedId,
        version: "",
        active_node_ids: [],
      };
    }
  } else {
    runtime.contextMeta = null;
  }
  const rawResumeRuntimeSnapshot = (
    pending?.runtime_team_snapshot
    || pending?.runtimeTeamSnapshot
    || session?.last_route?.runtime_team_snapshot
    || session?.last_route?.runtimeTeamSnapshot
    || runtime?.runtimeTeamSnapshot
    || runtime?.runtime_team_snapshot
    || null
  );
  const resumeRuntimeTeamSnapshot = normalizeRuntimeTeamSnapshot(rawResumeRuntimeSnapshot);
  const resumeActionSource = normalizeActionSource(
    pending?.action_source
    || pending?.actionSource
    || session?.last_route?.action_source
    || session?.last_route?.actionSource
    || "",
    { fallback: "explicit_route_plan" }
  ) || "explicit_route_plan";
  if (resumeRuntimeTeamSnapshot) {
    runtime.runtimeTeamSnapshot = resumeRuntimeTeamSnapshot;
  }
  const contextEngine = makeContextEngine({
    memoryMode: memoryModeWithFallback(),
    jobs,
    gocClient: memoryModeWithFallback() === "goc" ? requireGocClient() : null,
    runtime,
    logger: (line) => jobs.log(pendingJobId, line),
  });
  if (typeof contextEngine.setRuntime === "function") {
    contextEngine.setRuntime(runtime);
  }
  const resumeExecutionGraph = (
    memoryModeWithFallback() === "goc"
    && runtime?.map?.threadId
    && runtime?.map?.ctxSharedId
  )
    ? new GocExecutionGraphRecorder({
      client: requireGocClient(),
      threadId: runtime.map.threadId,
      contextSetId: runtime.map.ctxSharedId,
      sharedContextSetId: runtime.map.ctxSharedId,
      contextMeta: runtime.contextMeta || null,
      runId: `run_resume_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      chatId: String(chatId || ""),
      jobId: String(pendingJobId || ""),
      logger: (line) => jobs.log(pendingJobId, line),
    })
    : null;
  const controller = resetJobAbortController(pendingJobId);
  const chatKey = String(chatId);
  activeJobByChat.set(chatKey, pendingJobId);
  rememberLastChatJob(chatId, pendingJobId);
  const resumeThreadId = String(runtime?.map?.threadId || "").trim();
  const resumeSharedCtxId = String(runtime?.map?.ctxSharedId || "").trim();
  const resumeUserText = String(pending.original_user_text || "승인된 액션 재개");
  let resumeFinalAssistantText = "";
  const resumedAgentStatus = buildQueuedAgentStatusFromActions(resumedActions);
  if (chatRunManager && typeof chatRunManager.clearInterruptState === "function") {
    chatRunManager.clearInterruptState(chatId, {
      jobId: pendingJobId,
      clearPending: true,
      clearApproval: true,
      state: "executing",
    });
  }
  chatSessionStore.upsert(chatId, {
    jobId: pendingJobId,
    state: "executing",
    pending_approval: null,
    interrupt: null,
    pending_user_messages: [],
    agent_status: resumedAgentStatus,
    last_route: {
      reason: `resume_after_approval:${approvalId}`,
      actions: resumedActions,
      action_source: resumeActionSource,
      runtime_team_snapshot: resumeRuntimeTeamSnapshot,
      final_response_style: runtime.jobConfig?.final_response_style || "concise",
    },
  });
  await sendPlanPreviewMessage(bot, chatId, {
    actions: resumedActions,
    replyToMessageId: getCurrentTurnReplyMessageId(chatId),
  });

  try {
    const resumeRunMeta = {
      runId: String(resumeExecutionGraph?.runId || "").trim() || undefined,
      threadId: resumeThreadId,
      sharedContextSetId: resumeSharedCtxId,
      runtimeTeamSnapshot: resumeRuntimeTeamSnapshot || undefined,
      actionSource: resumeActionSource,
    };
    if (contextEngine && typeof contextEngine.prepareRouterContext === "function") {
      if (typeof contextEngine.setRuntime === "function") {
        contextEngine.setRuntime(runtime);
      }
      await contextEngine.onRunStart({
        jobId: pendingJobId,
        chatId: String(chatId || ""),
        threadId: resumeThreadId,
        runMeta: resumeRunMeta,
      }).catch(() => null);
      const resumeRouterCtx = await contextEngine.prepareRouterContext({
        jobId: pendingJobId,
        chatId: String(chatId || ""),
        threadId: resumeThreadId,
        agentId: "router",
        stepKind: "router",
        goal: resumeUserText,
        userMessageText: resumeUserText,
        budgetTokens: 900,
        runMeta: resumeRunMeta,
      }).catch(() => null);
      if (resumeRouterCtx?.contextText) {
        runtime.contextSummary = String(resumeRouterCtx.contextText || "").trim();
      }
      await contextEngine.recordMeta({
        jobId: pendingJobId,
        chatId: String(chatId || ""),
        threadId: resumeThreadId,
        agentId: "router",
        stepKind: "router",
        goal: resumeUserText,
        userMessageText: resumeUserText,
        runMeta: resumeRunMeta,
        meta: resumeRouterCtx?.meta && typeof resumeRouterCtx.meta === "object"
          ? resumeRouterCtx.meta
          : {},
      }).catch(() => {});
    }
    const resumePlan = {
      reason: `resume_after_approval:${approvalId}`,
      actions: resumedActions,
      runtime_team_snapshot: resumeRuntimeTeamSnapshot,
      action_source: resumeActionSource,
      final_response_style: runtime.jobConfig?.final_response_style || "concise",
    };
    if (resumeExecutionGraph) {
      await resumeExecutionGraph.startRun({
        userText: resumeUserText,
        metadata: {
          runtime_team_snapshot: resumeRuntimeTeamSnapshot,
          action_source: resumeActionSource,
        },
      });
      await resumeExecutionGraph.queueMainSteps(resumedActions, {
        metadata: {
          runtime_team_snapshot: resumeRuntimeTeamSnapshot,
          action_source: resumeActionSource,
        },
      });
    }
    const resumedExecution = await executeSupervisorActions({
      chatId,
      userId,
      jobId: pendingJobId,
      plan: resumePlan,
      originalUserText: resumeUserText,
      forceMode: resumeForceMode,
      jobConfig: runtime.jobConfig,
      agents: Array.isArray(runtime?.agentsCatalog) && runtime.agentsCatalog.length > 0
        ? runtime.agentsCatalog
        : runtime.agents,
      tools: runtime.tools,
      sessionStore: chatSessionStore,
      callbacks: buildSupervisorExecutionCallbacks({
        bot,
        chatId,
        userId,
        jobId: pendingJobId,
        runtime,
        controller,
        verbose: CHAT_VERBOSE,
        onAgentStatusChanged: async ({ agentId = "", state = "", goal = "", error = "" } = {}) => {
          await sendAgentStatusTransitionMessage(bot, chatId, {
            agentId,
            state,
            goal,
            error,
            replyToMessageId: getCurrentTurnReplyMessageId(chatId),
          });
        },
        executionGraph: resumeExecutionGraph,
        contextEngine,
      }),
    });

    const prevDone = pending.already_done && typeof pending.already_done === "object"
      ? pending.already_done
      : {};
    const mergedExecution = {
      ...resumedExecution,
      currentJobId: pendingJobId,
      results: [
        ...(Array.isArray(prevDone.results) ? prevDone.results : []),
        ...(Array.isArray(resumedExecution.results) ? resumedExecution.results : []),
      ],
      outputs: [
        ...(Array.isArray(prevDone.outputs) ? prevDone.outputs : []),
        ...(Array.isArray(resumedExecution.outputs) ? resumedExecution.outputs : []),
      ],
    };
    const resumeResultRows = Array.isArray(resumedExecution.results)
      ? resumedExecution.results
      : [];
    const resumeRemainingActions = Array.isArray(resumedExecution.remaining_actions)
      ? resumedExecution.remaining_actions
      : [];
    const interruptedDuringResume = wasInterruptedByReplan({
      results: resumeResultRows,
      remainingActions: resumeRemainingActions,
      pendingApproval: resumedExecution.pendingApproval,
    });
    if (interruptedDuringResume) {
      await markActionsSkipped(resumeExecutionGraph, resumeRemainingActions, {
        reason: "interrupted_by_replan",
      });
    }
    const rerouteKey = buildPostMutationRerouteKey({
      jobId: pendingJobId,
      userText: resumeUserText,
    });
    const membershipConfirmation = summarizeMembershipMutationConfirmation({
      actions: resumedActions,
      outputs: resumedExecution.outputs,
      results: resumedExecution.results,
    });
    const currentGuard = (
      session?.post_mutation_reroute_guard
      && typeof session.post_mutation_reroute_guard === "object"
      && String(session.post_mutation_reroute_guard.key || "") === rerouteKey
    )
      ? session.post_mutation_reroute_guard
      : { key: rerouteKey, count: 0 };
    const postMutationRerouteDecision = (!resumedExecution.pendingApproval && !interruptedDuringResume)
      ? shouldTriggerPostMutationReroute({
        resumedActions,
        originalUserText: resumeUserText,
        forceMode: resumeForceMode,
        workLikeHint: pending.work_like_hint === true,
        membershipConfirmation,
        rerouteGuard: currentGuard,
        rerouteLimit: 1,
      })
      : {
        should_reroute: false,
        reason: resumedExecution.pendingApproval ? "pending_followup_approval" : "interrupted",
        blocked_by_guard: false,
      };
    const membershipConfirmationFailed = postMutationRerouteDecision.reason === "membership_confirmation_failed";

    const summaryPlan = session.last_route && typeof session.last_route === "object"
      ? session.last_route
      : resumePlan;
    const finalReply = await synthesizeChatReply("승인된 액션 재개", summaryPlan, mergedExecution);
    const replyText = resumedExecution.pendingApproval
      ? `${finalReply}\n\n⚠️ 추가 승인 필요: ${resumedExecution.pendingApproval.reason}`
      : finalReply;
    resumeFinalAssistantText = replyText;
    await sendLong(bot, chatId, replyText);

    tracking.append(pendingJobId, "decisions.md", [
      "## /chat approval resumed",
      `- approval_id: ${approvalId}`,
      `- action_source: ${resumeActionSource}`,
      `- resumed_actions: ${resumedActions.map((row) => chatActionLabel(row)).join(" -> ")}`,
      `- pending_after_resume: ${resumedExecution.pendingApproval ? "yes" : "no"}`,
      `- interrupted_during_resume: ${interruptedDuringResume ? "yes" : "no"}`,
      `- membership_confirmation_required: ${membershipConfirmation.required_count}`,
      `- membership_confirmation_failed: ${membershipConfirmation.failed_count}`,
      membershipConfirmation.unresolved_keys.length > 0
        ? `- membership_unresolved_keys: ${membershipConfirmation.unresolved_keys.join(",")}`
        : "",
      `- post_mutation_reroute: ${postMutationRerouteDecision.should_reroute ? "yes" : "no"}`,
      `- reroute_reason: ${postMutationRerouteDecision.reason}`,
      `- approved_by: telegram:${userId}`,
    ].join("\n"));
    await bot.sendMessage(
      chatId,
      resumedExecution.pendingApproval
        ? "✅ 승인 적용 완료 (추가 승인 필요)"
        : (interruptedDuringResume
          ? "⚠️ 승인 적용 중 중단됨"
          : (membershipConfirmationFailed
            ? "⚠️ 승인 적용 완료 (팀 멤버십 확인 실패)"
            : "✅ 승인 적용 완료")),
      Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
        ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
        : undefined
    );

    if (postMutationRerouteDecision.should_reroute) {
      if (resumeExecutionGraph) {
        await resumeExecutionGraph.finishRun({
          status: "await_user",
          summary: "post mutation reroute to work execution",
        });
      }
      const nextGuardCount = Number.isFinite(Number(currentGuard.count))
        ? Math.max(1, Math.floor(Number(currentGuard.count)) + 1)
        : 1;
      chatSessionStore.upsert(chatId, (currentSession) => ({
        ...currentSession,
        jobId: pendingJobId,
        state: "idle",
        pending_approval: null,
        interrupt: null,
        post_mutation_reroute_guard: {
          key: rerouteKey,
          count: nextGuardCount,
          ts: new Date().toISOString(),
        },
        last_route: {
          ...(currentSession?.last_route && typeof currentSession.last_route === "object"
            ? currentSession.last_route
            : {}),
          post_mutation_reroute: true,
          reroute_reason: "mutation_only_plan_for_work_request",
        },
      }));
      await bot.sendMessage(
        chatId,
        "🔁 팀 구성 변경만 적용되어 실제 작업 실행 계획을 다시 생성합니다.",
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined
      );
      if (chatRunManager && typeof chatRunManager.handleIncoming === "function") {
        await chatRunManager.handleIncoming({
          chatId,
          userId,
          text: resumeUserText,
          telegramMessageId: msg?.message_id,
          kind: "normal",
          forceMode: "work",
          chatInfo: {
            chat_id: String(chatId || ""),
            title: String(msg?.chat?.title || msg?.chat?.username || "").trim(),
            type: String(msg?.chat?.type || "").trim(),
          },
        });
      } else {
        await bot.sendMessage(
          chatId,
          "다시 실행할 런타임 매니저를 찾지 못했습니다. 같은 요청을 한 번 더 보내주세요."
        );
      }
    } else if (resumedExecution.pendingApproval?.id) {
      if (resumeExecutionGraph) {
        await resumeExecutionGraph.finishRun({
          status: "await_user",
          summary: resumedExecution.pendingApproval.reason || "approval required",
        });
        const pendingRows = Array.isArray(resumedExecution.remaining_actions)
          ? resumedExecution.remaining_actions
          : [];
        await markActionsSkipped(resumeExecutionGraph, pendingRows, {
          reason: "awaiting_approval",
        });
      }
      chatSessionStore.upsert(chatId, {
        jobId: pendingJobId,
        state: "awaiting_approval",
        pending_approval: {
          ...resumedExecution.pendingApproval,
          action_source: resumeActionSource,
          runtime_team_snapshot: resumeRuntimeTeamSnapshot || undefined,
          blocked_index: Number.isFinite(Number(resumedExecution.blocked_index))
            ? Number(resumedExecution.blocked_index)
            : Number(resumedExecution.pendingApproval?.blocked_index ?? -1),
          remaining_actions: Array.isArray(resumedExecution.remaining_actions)
            ? resumedExecution.remaining_actions
            : (Array.isArray(resumedExecution.pendingApproval?.remaining_actions)
              ? resumedExecution.pendingApproval.remaining_actions
              : []),
        },
      });
      const prompt = buildPendingApprovalPrompt(resumedExecution.pendingApproval);
      await bot.sendMessage(
        chatId,
        prompt.text,
        {
          reply_to_message_id: Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? Number(getCurrentTurnReplyMessageId(chatId))
            : undefined,
          reply_markup: {
            inline_keyboard: prompt.keyboard,
          },
        }
      );
    } else if (interruptedDuringResume) {
      if (resumeExecutionGraph) {
        await resumeExecutionGraph.finishRun({
          status: "await_user",
          summary: "interrupted during resume",
        });
      }
      if (chatRunManager && typeof chatRunManager.clearInterruptState === "function") {
        chatRunManager.clearInterruptState(chatId, {
          jobId: pendingJobId,
          clearPending: true,
          clearApproval: false,
          state: "idle",
        });
      }
      chatSessionStore.upsert(chatId, {
        jobId: pendingJobId,
        state: "idle",
        pending_approval: null,
        interrupt: null,
      });
      await bot.sendMessage(
        chatId,
        "⚠️ 실행 중 새 지시/중단 요청이 감지되어 남은 작업을 멈췄어요. 계속 진행하려면 다시 /chat으로 지시해주세요.",
        Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
          ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
          : undefined
      );
    } else {
      if (membershipConfirmationFailed) {
        await markActionsSkipped(resumeExecutionGraph, resumeRemainingActions, {
          reason: "membership_confirmation_failed",
        });
      }
      if (resumeExecutionGraph) {
        await resumeExecutionGraph.finishRun({
          status: membershipConfirmationFailed ? "await_user" : "done",
          summary: membershipConfirmationFailed
            ? "membership confirmation failed"
            : clip(replyText, 900),
        });
      }
      chatSessionStore.upsert(chatId, (currentSession) => ({
        ...currentSession,
        jobId: pendingJobId,
        state: "idle",
        pending_approval: null,
        post_mutation_reroute_guard: null,
        membership_confirmation_fail_guard: membershipConfirmationFailed
          ? (() => {
            const unresolvedSignature = membershipConfirmation.unresolved_keys.join("|") || "unknown";
            const nextKey = `${rerouteKey}::${unresolvedSignature}`;
            const prevGuard = currentSession?.membership_confirmation_fail_guard
              && typeof currentSession.membership_confirmation_fail_guard === "object"
              ? currentSession.membership_confirmation_fail_guard
              : null;
            const prevCount = prevGuard && String(prevGuard.key || "") === nextKey
              ? Math.max(0, Math.floor(Number(prevGuard.count || 0)))
              : 0;
            return {
              key: nextKey,
              count: prevCount + 1,
              ts: new Date().toISOString(),
              unresolved: membershipConfirmation.unresolved_keys,
            };
          })()
          : null,
        last_route: {
          ...(currentSession?.last_route && typeof currentSession.last_route === "object"
            ? currentSession.last_route
            : {}),
          membership_confirmation_required: membershipConfirmation.required_count,
          membership_confirmation_failed: membershipConfirmation.failed_count,
          membership_unresolved_keys: membershipConfirmation.unresolved_keys,
        },
      }));
      if (membershipConfirmationFailed) {
        await bot.sendMessage(
          chatId,
          "⚠️ 팀 멤버십 변경을 readback으로 확인하지 못해 후속 작업 실행을 중단했습니다. /agents 와 /context 로 상태를 확인한 뒤 다시 요청해주세요.",
          Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
            : undefined
        );
      }
      if (postMutationRerouteDecision.blocked_by_guard) {
        await bot.sendMessage(
          chatId,
          "⚠️ 팀 설정 변경 액션만 반복되어 자동 재라우팅을 중단했습니다. 작업을 바로 수행하려면 구체 작업 지시를 다시 보내주세요.",
          Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
            ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
            : undefined
        );
      }
    }
    await maybeAutoSendOutputs(bot, chatId, pendingJobId, {
      when: "run_end",
      replyToMessageId: getCurrentTurnReplyMessageId(chatId),
    }).catch(() => null);
  } catch (e) {
    if (resumeExecutionGraph) {
      await resumeExecutionGraph.finishRun({
        status: "error",
        error: String(e?.message ?? e),
        summary: "approval resume failed",
      });
    }
    await bot.sendMessage(
      chatId,
      `❌ 승인 적용 실패: ${clip(String(e?.message ?? e), 240)}`,
      Number.isFinite(Number(getCurrentTurnReplyMessageId(chatId)))
        ? { reply_to_message_id: Number(getCurrentTurnReplyMessageId(chatId)) }
        : undefined
    );
    throw e;
  } finally {
    if (contextEngine && typeof contextEngine.onRunEnd === "function") {
      if (typeof contextEngine.setRuntime === "function") {
        contextEngine.setRuntime(runtime);
      }
      await contextEngine.onRunEnd({
        jobId: pendingJobId,
        chatId: String(chatId || ""),
        threadId: resumeThreadId,
        lastUserText: resumeUserText,
        lastAssistantText: resumeFinalAssistantText,
        runMeta: {
          runId: String(resumeExecutionGraph?.runId || "").trim() || undefined,
          threadId: resumeThreadId,
          sharedContextSetId: resumeSharedCtxId,
        },
      }).catch(() => null);
    }
    if (activeJobByChat.get(chatKey) === pendingJobId) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(pendingJobId);
  }

  return { handled: true };
}
