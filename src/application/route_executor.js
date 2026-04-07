import { createRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { summarizeRunAuthorityLines } from "./run_authority.js";
import { resolveExecutionBlueprintSummary, formatExecutionBlueprintSummaryLines } from "./team_blueprint.js";

export async function executeRunCommand({
  bot,
  chatId,
  userId,
  goal,
  createJob,
  resetJobAbortController,
  activeJobByChat,
  jobAbortControllers,
  runWorkspaceDir,
  loadSupervisorRuntime,
  decideRunRoute,
  tracking,
  actionLabel,
  executeRoutedPlan,
  suggestNextPrompt,
  isCancelledError,
} = {}) {
  await bot.sendMessage(chatId, "🚀 시작합니다…");
  try {
    const job = await createJob(goal, { ownerUserId: userId, ownerChatId: chatId });
    const jobId = String(job.jobId);
    const controller = resetJobAbortController(jobId);
    const chatKey = String(chatId);
    activeJobByChat.set(chatKey, jobId);
    await bot.sendMessage(chatId, `✅ Job created: ${job.jobId}\ngoal: ${goal}\nworkspace: ${runWorkspaceDir(jobId)}\n복잡하면: /gptprompt ${job.jobId} <질문>`);

    try {
      let runtimeForRoute = null;
      try {
        runtimeForRoute = await loadSupervisorRuntime(jobId, {
          chatMeta: {
            chat_id: String(chatId || ""),
            telegram_user_id: String(userId || "").trim() || undefined,
          },
          includeContext: false,
          includeGlobal: false,
          telegramUserId: String(userId || "").trim(),
        });
      } catch {
        runtimeForRoute = null;
      }

      const route = await decideRunRoute(jobId, {
        mode: "run",
        goal,
        seedInstruction: goal,
        signal: controller.signal,
      });
      const executionBlueprint = resolveExecutionBlueprintSummary({
        team: runtimeForRoute?.activeTeamConfig || null,
        goal,
        taskInterpretation: route?.task_interpretation || null,
        runtimeTeamSnapshot: route?.runtime_team_snapshot || route?.runtimeTeamSnapshot || null,
        runtime: runtimeForRoute,
      });
      const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
        runtime_team_snapshot: route?.runtime_team_snapshot || route?.runtimeTeamSnapshot || null,
        teamPlan: route?.team_plan || null,
        runtimeAgents: route?.runtime_agents || [],
        blueprintSummary: executionBlueprint,
        source: "team_builder",
      });
      const executionBlueprintLines = formatExecutionBlueprintSummaryLines(executionBlueprint);
      tracking.append(jobId, "decisions", [
        "## Multi-Agent routing",
        "- mode: run",
        `- reason: ${route.reason}`,
        ...executionBlueprintLines,
        ...summarizeRunAuthorityLines(runtimeForRoute, route, {
          includeMode: false,
        }),
        ...summarizeRuntimeTeamSnapshotLines(runtimeTeamSnapshot, {
          actionSource: String(route.action_source || "unknown"),
        }),
        `- actions: ${route.actions.map((a) => actionLabel(a)).join(" -> ")}`,
      ].join("\n"), { source: 'team_builder', purpose: 'final', eventType: 'routing_decision', actorKind: 'planner', pipelineStage: 'routing', semanticKind: 'decisions' });
      if (executionBlueprintLines.length > 0) {
        await bot.sendMessage(chatId, `🧩 선택된 팀 템플릿\n${executionBlueprintLines.join("\n")}`);
      }
      await bot.sendMessage(chatId, `🧭 Multi-Agent 라우팅\n${route.actions.map((a) => `- ${actionLabel(a)}`).join("\n")}`);

      const routed = await executeRoutedPlan(bot, chatId, jobId, {
        ...route,
        runtime_team_snapshot: runtimeTeamSnapshot,
      }, controller.signal, {
        telegramUserId: userId,
        runtime: runtimeForRoute,
        runtimeTeamSnapshot,
      });
      if (!routed.askedChatGPT) {
        await suggestNextPrompt(bot, chatId, jobId, "현재 상태에서 다음 단계를 action plan(JSON)으로 제안해줘.", "run", controller.signal);
      }
    } finally {
      if (activeJobByChat.get(chatKey) === jobId) activeJobByChat.delete(chatKey);
      jobAbortControllers.delete(jobId);
    }
  } catch (e) {
    if (isCancelledError(e)) {
      await bot.sendMessage(chatId, "⏹️ 작업이 중단되었습니다.");
    } else {
      await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
    }
  }
}

export async function executeContinueCommand({
  bot,
  chatId,
  userId,
  jobId,
  resetJobAbortController,
  activeJobByChat,
  jobAbortControllers,
  runWorkspaceDir,
  tracking,
  extractCodexInstruction,
  loadSupervisorRuntime,
  getGoalFromResearch,
  decideRunRoute,
  actionLabel,
  executeRoutedPlan,
  suggestNextPrompt,
  isCancelledError,
} = {}) {
  const jobKey = String(jobId);
  const controller = resetJobAbortController(jobKey);
  const chatKey = String(chatId);
  activeJobByChat.set(chatKey, jobKey);
  await bot.sendMessage(chatId, `▶️ Continue job ${jobId}\nworkspace: ${runWorkspaceDir(jobKey)}`);

  const planDocName = tracking.resolveDocName(jobKey, "plan");
  const researchDocName = tracking.resolveDocName(jobKey, "research");
  let instruction = `run/shared의 ${planDocName}와 ${researchDocName}를 반영해 CODEX_WORKSPACE_ROOT 코드 변경을 진행해라.`;
  try {
    const planText = tracking.read(jobId, "plan");
    const extracted = extractCodexInstruction(planText);
    if (extracted) instruction = extracted;
  } catch {}

  try {
    let runtimeForRoute = null;
    try {
      runtimeForRoute = await loadSupervisorRuntime(jobKey, {
        chatMeta: {
          chat_id: String(chatId || ""),
          telegram_user_id: String(userId || "").trim() || undefined,
        },
        includeContext: false,
        includeGlobal: false,
        telegramUserId: String(userId || "").trim(),
      });
    } catch {
      runtimeForRoute = null;
    }

    const goal = getGoalFromResearch(jobKey);
    const route = await decideRunRoute(jobKey, {
      mode: "continue",
      goal,
      seedInstruction: instruction,
      signal: controller.signal,
    });
    const executionBlueprint = resolveExecutionBlueprintSummary({
      team: runtimeForRoute?.activeTeamConfig || null,
      goal,
      taskInterpretation: route?.task_interpretation || null,
      runtimeTeamSnapshot: route?.runtime_team_snapshot || route?.runtimeTeamSnapshot || null,
      runtime: runtimeForRoute,
    });
    const runtimeTeamSnapshot = createRuntimeTeamSnapshot({
      runtime_team_snapshot: route?.runtime_team_snapshot || route?.runtimeTeamSnapshot || null,
      teamPlan: route?.team_plan || null,
      runtimeAgents: route?.runtime_agents || [],
      blueprintSummary: executionBlueprint,
      source: "team_builder",
    });
    const executionBlueprintLines = formatExecutionBlueprintSummaryLines(executionBlueprint);
    tracking.append(jobKey, "decisions", [
      "## Multi-Agent routing",
      "- mode: continue",
      `- reason: ${route.reason}`,
      ...executionBlueprintLines,
      ...summarizeRunAuthorityLines(runtimeForRoute, route, {
        includeMode: false,
      }),
      ...summarizeRuntimeTeamSnapshotLines(runtimeTeamSnapshot, {
        actionSource: String(route.action_source || "unknown"),
      }),
      `- actions: ${route.actions.map((a) => actionLabel(a)).join(" -> ")}`,
    ].join("\n"), { source: 'team_builder', purpose: 'final', eventType: 'routing_decision', actorKind: 'planner', pipelineStage: 'routing', semanticKind: 'decisions' });
    if (executionBlueprintLines.length > 0) {
      await bot.sendMessage(chatId, `🧩 선택된 팀 템플릿\n${executionBlueprintLines.join("\n")}`);
    }
    await bot.sendMessage(chatId, `🧭 Multi-Agent 라우팅\n${route.actions.map((a) => `- ${actionLabel(a)}`).join("\n")}`);

    const routed = await executeRoutedPlan(bot, chatId, jobKey, {
      ...route,
      runtime_team_snapshot: runtimeTeamSnapshot,
    }, controller.signal, {
      telegramUserId: userId,
      runtime: runtimeForRoute,
      runtimeTeamSnapshot,
    });
    if (!routed.askedChatGPT) {
      await suggestNextPrompt(bot, chatId, jobKey, "현재 변경 결과를 바탕으로 다음 action plan(JSON)을 제안해줘.", "continue", controller.signal);
    }
  } catch (e) {
    if (isCancelledError(e)) {
      await bot.sendMessage(chatId, `⏹️ 작업이 중단되었습니다. (jobId=${jobKey})`);
    } else {
      await bot.sendMessage(chatId, `❌ 실패: ${String(e?.message ?? e)}`);
    }
  } finally {
    if (activeJobByChat.get(chatKey) === jobKey) activeJobByChat.delete(chatKey);
    jobAbortControllers.delete(jobKey);
  }
}
