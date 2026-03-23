import {
  isActionApprovalCallbackData,
  handleActionApprovalCallback,
} from "../../application/approval_flow.js";
import { applyPendingTeam, getSessionTeamState, storePendingTeam, buildTeamListMessage, formatTeamProposalMessage, buildTeamTransitionGuardrails, formatTeamTransitionGuardrailLines } from '../../application/team_configuration.js';
import crypto from 'node:crypto';
import { getPendingInstallProposal, archivePendingInstallProposal, buildInstallProposalPrompt } from '../../application/install_proposal_state.js';
import { handleTelegramInstallProposalCallback } from './install_proposal_callbacks.js';
import { buildChatStatusCard } from '../../application/telegram_runtime_ui.js';
import { loadArtifactIndex, formatArtifactIndexText, resolveArtifactDeliveryContract, formatArtifactDeliveryContractLines } from '../../application/telegram_runtime_io.js';
import { buildPreviewAgentIndex, buildQueuedAgentStatusFromActions, buildRoutedDashboardText } from './preview_formatting.js';


async function sendChunkedStatusCard(bot, chatId, card = {}, sendLong) {
  const text = String(card?.text || '').trim() || '(empty)';
  const replyMarkup = card?.reply_markup && typeof card.reply_markup === 'object' ? card.reply_markup : null;
  const TELEGRAM_TEXT_LIMIT = 3900;
  if (!replyMarkup || text.length <= TELEGRAM_TEXT_LIMIT) {
    if (replyMarkup) {
      await bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
    } else {
      await sendLong(bot, chatId, text);
    }
    return;
  }
  const parts = [];
  let remaining = text;
  while (remaining.length > TELEGRAM_TEXT_LIMIT) {
    let cut = remaining.lastIndexOf('\n', TELEGRAM_TEXT_LIMIT);
    if (cut < 1200) cut = TELEGRAM_TEXT_LIMIT;
    parts.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) parts.push(remaining);
  for (const part of parts.slice(0, -1)) {
    await bot.sendMessage(chatId, part);
  }
  await bot.sendMessage(chatId, parts[parts.length - 1], { reply_markup: replyMarkup });
}


export function createTelegramCallbackQueryHandler(deps = {}) {
  const telegramUi = deps.telegramUi || {};
  const runtimeOps = deps.runtimeOps || {};
  const jobOps = deps.jobOps || {};
  const sessionOps = deps.sessionOps || {};
  const fileOps = deps.fileOps || {};
  const teamOps = deps.teamOps || {};

  const bot = telegramUi.bot || deps.bot;
  const clip = telegramUi.clip || deps.clip;
  const FENCE = telegramUi.FENCE || deps.FENCE;
  const sendLong = telegramUi.sendLong || deps.sendLong;

  const isAllowedChat = teamOps.isAllowedChat || deps.isAllowedChat;
  const isAllowedUser = teamOps.isAllowedUser || deps.isAllowedUser;
  const setGocActingTelegramUser = teamOps.setGocActingTelegramUser || deps.setGocActingTelegramUser;
  const bindGocActor = teamOps.bindGocActor || deps.bindGocActor;
  const openAgentsUiInfo = teamOps.openAgentsUiInfo || deps.openAgentsUiInfo;
  const findDraftByNodeId = teamOps.findDraftByNodeId || deps.findDraftByNodeId;
  const findLatestDraftByAgentId = teamOps.findLatestDraftByAgentId || deps.findLatestDraftByAgentId;
  const buildAgentProfileFromProposal = teamOps.buildAgentProfileFromProposal || deps.buildAgentProfileFromProposal;
  const createAgentProfile = teamOps.createAgentProfile || deps.createAgentProfile;
  const appendParticipantToJobConfig = teamOps.appendParticipantToJobConfig || deps.appendParticipantToJobConfig;
  const refreshAgentRegistry = teamOps.refreshAgentRegistry || deps.refreshAgentRegistry;

  const memoryModeWithFallback = runtimeOps.memoryModeWithFallback || deps.memoryModeWithFallback;
  const requireGocClient = runtimeOps.requireGocClient || deps.requireGocClient;
  const resolveCurrentJobIdForChat = runtimeOps.resolveCurrentJobIdForChat || deps.resolveCurrentJobIdForChat;
  const suggestNextPrompt = runtimeOps.suggestNextPrompt || deps.suggestNextPrompt;
  const runSupervisorChat = runtimeOps.runSupervisorChat || deps.runSupervisorChat;
  const normalizeForceMode = runtimeOps.normalizeForceMode || deps.normalizeForceMode || ((value) => value || 'normal');
  const loadSupervisorRuntime = runtimeOps.loadSupervisorRuntime || deps.loadSupervisorRuntime;
  const handleActionApproval = runtimeOps.handleActionApproval || deps.handleActionApproval;
  const actionApprovalDeps = runtimeOps.actionApprovalDeps || deps.actionApprovalDeps || {};

  const jobs = jobOps.jobs || deps.jobs;
  const tracking = jobOps.tracking || deps.tracking;
  const approvals = jobOps.approvals || deps.approvals;
  const runCommand = jobOps.runCommand || deps.runCommand;

  const setAwait = sessionOps.setAwait || deps.setAwait;
  const rememberLastChatJob = sessionOps.rememberLastChatJob || deps.rememberLastChatJob;
  const chatSessionStore = sessionOps.chatSessionStore || deps.chatSessionStore;

  const runWorkspaceDir = fileOps.runWorkspaceDir || deps.runWorkspaceDir;

  return async function onCallbackQuery(q) {
    try {
      const msg = q.message;
      if (!msg) return;
      const chatId = msg.chat.id;
      const userId = q.from?.id;
      if (!isAllowedChat(chatId) || !isAllowedUser(userId)) return;
      setGocActingTelegramUser(userId);
      const restoreActor = bindGocActor(userId);
      try {
        const data = String(q.data || "").trim();

        if (isActionApprovalCallbackData(data)) {
          await (handleActionApproval || handleActionApprovalCallback)({
            q,
            msg,
            data,
            bot,
            chatId,
            userId,
            deps: actionApprovalDeps,
          });
          return;
        }

        const handledInstallProposal = await handleTelegramInstallProposalCallback({
          q,
          bot,
          chatId,
          userId,
          data,
          deps: {
            chatSessionStore,
            resolveCurrentJobIdForChat,
            loadSupervisorRuntime,
            runSupervisorChat,
            normalizeForceMode,
            jobs,
          },
        });
        if (handledInstallProposal) {
          return;
        }

        if (data === 'plan_preview:details') {
          const session = chatSessionStore.get(chatId) || {};
          const actions = Array.isArray(session?.last_route?.actions) ? session.last_route.actions : [];
          let runtime = null;
          try {
            const currentJobId = resolveCurrentJobIdForChat?.(chatId);
            if (currentJobId && typeof loadSupervisorRuntime === 'function') {
              runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
            }
          } catch {}
          const agentStatus = session?.agent_status && typeof session.agent_status === 'object'
            ? session.agent_status
            : buildQueuedAgentStatusFromActions(actions);
          const detailText = buildRoutedDashboardText({
            actions,
            agentStatus,
            agentIndex: buildPreviewAgentIndex({ actions, runtime }),
          });
          await bot.answerCallbackQuery(q.id, { text: actions.length > 0 ? 'plan details' : 'no planned actions' });
          await sendLong(bot, chatId, detailText || '현재 계획된 action이 없습니다.');
          return;
        }

        if (data === 'chat_status:summary' || data === 'chat_status:full' || data === 'chat_status:recent' || data === 'chat_status:prompt' || data === 'chat_status:artifacts') {
          const currentJobId = resolveCurrentJobIdForChat?.(chatId);
          let runtime = null;
          if (currentJobId && typeof loadSupervisorRuntime === 'function') {
            try {
              runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
            } catch {}
          }
          if (data === 'chat_status:artifacts') {
            await bot.answerCallbackQuery(q.id, { text: currentJobId ? 'artifacts' : 'no job' });
            if (!currentJobId) {
              await bot.sendMessage(chatId, '현재 활성 job이 없어 산출물을 보여줄 수 없습니다.');
              return;
            }
            const artifactIndex = loadArtifactIndex(currentJobId);
            const contract = resolveArtifactDeliveryContract(currentJobId, runtime);
            const sections = [`📎 artifacts
${formatArtifactIndexText(currentJobId, artifactIndex, { limit: 8 })}`];
            const contractLines = formatArtifactDeliveryContractLines(contract);
            if (contractLines.length > 0) sections.push(`publish contract
${contractLines.join('\n')}`);
            await sendLong(bot, chatId, sections.join('\n\n'));
            return;
          }
          const detail = data === 'chat_status:full' ? 'full' : (data === 'chat_status:recent' ? 'recent' : (data === 'chat_status:prompt' ? 'prompt' : 'compact'));
          const card = buildChatStatusCard(chatId, runtime, { detail });
          await bot.answerCallbackQuery(q.id, { text: detail === 'full' ? 'full status' : (detail === 'recent' ? 'recent activity' : (detail === 'prompt' ? 'prompt status' : 'status')) });
          await sendChunkedStatusCard(bot, chatId, card, sendLong);
          return;
        }

        if (data === 'team_state:apply_pending' || data === 'team_state:show_pending' || data === 'team_state:show_active') {
          const teamState = getSessionTeamState(chatSessionStore, chatId);
          let runtime = null;
          try {
            const currentJobId = resolveCurrentJobIdForChat?.(chatId);
            if (currentJobId && typeof loadSupervisorRuntime === 'function') {
              runtime = await loadSupervisorRuntime(currentJobId, { telegramUserId: userId, includeContext: false, includeGlobal: false });
            }
          } catch {}
          if (data === 'team_state:show_pending') {
            await bot.answerCallbackQuery(q.id, { text: teamState?.pending_team ? 'pending team' : 'no pending team' });
            if (!teamState?.pending_team) {
              await bot.sendMessage(chatId, '현재 pending team이 없습니다.');
              return;
            }
            await sendLong(bot, chatId, formatTeamProposalMessage(teamState.pending_team, { runtime }));
            return;
          }
          if (data === 'team_state:show_active') {
            await bot.answerCallbackQuery(q.id, { text: teamState?.active_team ? 'active team' : 'no active team' });
            await sendLong(bot, chatId, buildTeamListMessage(teamState, { runtime }));
            return;
          }
          await bot.answerCallbackQuery(q.id, { text: teamState?.pending_team ? 'apply pending' : 'no pending team' });
          if (!teamState?.pending_team) {
            await bot.sendMessage(chatId, '적용할 pending team이 없습니다.');
            return;
          }
          const transitionGuardrails = buildTeamTransitionGuardrails(teamState?.active_team, teamState?.pending_team);
          const confirmationKey = crypto.createHash('sha1').update(JSON.stringify({
            team_name: teamState?.pending_team?.team_name || '',
            warnings: transitionGuardrails?.warnings || [],
            risk_level: transitionGuardrails?.risk_level || 'low',
          })).digest('hex');
          const sessionRow = chatSessionStore?.get?.(chatId) || {};
          const confirmationState = sessionRow.pending_team_apply_confirmation && typeof sessionRow.pending_team_apply_confirmation === 'object'
            ? sessionRow.pending_team_apply_confirmation
            : null;
          const confirmationValid = confirmationState
            && String(confirmationState.key || '').trim() === confirmationKey
            && Date.parse(String(confirmationState.expires_at || '')) > Date.now();
          if (transitionGuardrails?.destructive_changes_present && !confirmationValid) {
            chatSessionStore?.upsert?.(chatId, (session) => ({
              ...session,
              pending_team_apply_confirmation: {
                key: confirmationKey,
                expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
                warning_count: Number(transitionGuardrails.warning_count || 0),
              },
            }));
            await sendLong(bot, chatId, [
              '⚠️ pending team 적용 전에 확인이 필요합니다.',
              '이 변경은 현재 active team의 일부 역할/에이전트/도구 구성을 줄일 수 있습니다.',
              ...formatTeamTransitionGuardrailLines(transitionGuardrails, { maxWarnings: 5 }),
              '',
              '같은 버튼을 한 번 더 누르면 적용합니다. 다른 변경을 하면 확인은 초기화됩니다.',
            ].join('\n'));
            return;
          }
          const applied = await applyPendingTeam({ sessionStore: chatSessionStore, chatId, runtime });
          const appliedGuardrails = applied?.__apply_guardrails && typeof applied.__apply_guardrails === 'object'
            ? applied.__apply_guardrails
            : transitionGuardrails;
          await sendLong(bot, chatId, [
            '✅ pending team을 active team으로 반영했습니다.',
            appliedGuardrails?.warning_count > 0 ? `- 적용 주의사항 ${Number(appliedGuardrails.warning_count || 0)}개` : '',
            ...(appliedGuardrails?.warning_count > 0 ? formatTeamTransitionGuardrailLines(appliedGuardrails, { maxWarnings: 4 }) : []),
            '',
            buildTeamListMessage({ active_team: applied }, { runtime })
          ].filter(Boolean).join('\n'));
          return;
        }

        if (data === "open_agents_ui" || data.startsWith("open_agents_ui:")) {
          const parsedJobId = data.startsWith("open_agents_ui:")
            ? String(data.slice("open_agents_ui:".length) || "").trim()
            : "";
          try {
            const info = await openAgentsUiInfo({ chatId, jobId: parsedJobId, userId });
            await bot.answerCallbackQuery(q.id, { text: info.scope === "job" ? "thread team" : "agents catalog" });
            await bot.sendMessage(chatId, info.lines.join("\n"), {
              reply_markup: {
                inline_keyboard: [[
                  { text: info.scope === "job" ? "Open Thread Team" : "Open Agents Catalog", url: info.browserLink || info.link },
                ]],
              },
            });
          } catch (e) {
            await bot.answerCallbackQuery(q.id, { text: "failed" });
            await bot.sendMessage(chatId, `❌ agents ui 열기 실패: ${String(e?.message ?? e)}`);
          }
          return;
        }

        if (
          data.startsWith("approve_draft:")
          || data.startsWith("reject_draft:")
          || data.startsWith("approve_agent:")
          || data.startsWith("reject_agent:")
        ) {
          const isApprove = data.startsWith("approve_draft:") || data.startsWith("approve_agent:");
          const usesDraftNode = data.startsWith("approve_draft:") || data.startsWith("reject_draft:");
          const parsedId = String(data.split(":")[1] || "").trim();
          const draftNodeId = usesDraftNode ? parsedId : "";
          const legacyAgentId = usesDraftNode ? "" : parsedId.toLowerCase();
          if (!parsedId) {
            await bot.answerCallbackQuery(q.id, { text: usesDraftNode ? "draft_node 누락" : "agent_id 누락" });
            return;
          }
          if (memoryModeWithFallback() !== "goc") {
            await bot.answerCallbackQuery(q.id, { text: "MEMORY_MODE=goc 필요" });
            await bot.sendMessage(chatId, "❌ agent draft 승인/거절은 MEMORY_MODE=goc에서만 동작합니다.");
            return;
          }

          const client = requireGocClient();
          const found = draftNodeId
            ? await findDraftByNodeId(client, draftNodeId)
            : await findLatestDraftByAgentId(client, legacyAgentId);
          if (!found?.resource) {
            await bot.answerCallbackQuery(q.id, { text: "draft lookup failed" });
            const slotDebug = found?.slot
              ? `\nslot_thread=${String(found.slot.threadId || "")}\nslot_ctx=${String(found.slot.ctxId || "")}`
              : "";
            const reasonDebug = found?.lookupError ? `\nreason=${String(found.lookupError || "")}` : "";
            await bot.sendMessage(
              chatId,
              draftNodeId
                ? `draft lookup failed (nodeId exists?)\ndraft_node=${draftNodeId}${reasonDebug}${slotDebug}`
                : `draft lookup failed (agent_id)\nagent_id=${legacyAgentId}${reasonDebug}${slotDebug}`
            );
            return;
          }
          const rawDraft = (
            found.draft && typeof found.draft === "object"
              ? found.draft
              : (found.payload?.agent_profile_draft && typeof found.payload.agent_profile_draft === "object"
                ? found.payload.agent_profile_draft
                : {})
          );
          const fallbackAgentId = String(
            rawDraft?.agent_id
            || rawDraft?.id
            || found.payload?.agent_id
            || legacyAgentId
            || ""
          ).trim().toLowerCase();
          const draftProfile = buildAgentProfileFromProposal({
            ...rawDraft,
            agent_id: fallbackAgentId,
          }) || (fallbackAgentId
            ? {
              id: fallbackAgentId,
              name: fallbackAgentId,
              description: "",
              provider: "gemini",
              model: "gemini",
              prompt: "",
              meta: {},
            }
            : null);
          if (!draftProfile?.id) {
            await bot.answerCallbackQuery(q.id, { text: "draft parse 실패" });
            await bot.sendMessage(chatId, `draft를 파싱하지 못했습니다. draft_node=${String(found.resource?.id || draftNodeId || "unknown")}`);
            return;
          }
          const agentId = String(draftProfile.id || "").trim().toLowerCase();
          const providerModel = `${String(draftProfile.provider || "gemini").trim() || "gemini"}/${String(draftProfile.model || draftProfile.provider || "gemini").trim() || "gemini"}`;
          const namePreview = clip(String(draftProfile.name || agentId), 120);
          const descriptionPreview = clip(
            String(draftProfile.description || "")
              .split(/\r?\n/)
              .map((line) => String(line || "").trim())
              .filter(Boolean)
              .slice(0, 2)
              .join(" / "),
            220
          ) || "(none)";
          const promptPreview = clip(
            String(draftProfile.prompt || "")
              .split(/\r?\n/)
              .map((line) => String(line || "").trim())
              .filter(Boolean)
              .join(" "),
            360
          ) || "(none)";
          const draftJobId = String(found.payload?.job_id || resolveCurrentJobIdForChat(chatId) || "").trim();
          const draftNode = String(found.resource?.id || draftNodeId || "").trim() || "unknown";
          const approvalEffect = draftJobId
            ? `승인하면 registry에 agent_profile 생성 + job_id=${draftJobId} participants에 추가됩니다.`
            : "승인하면 registry에 agent_profile 생성됩니다. (job_id 미확인: participants 반영 생략)";

          if (isApprove) {
            await bot.answerCallbackQuery(q.id, { text: `approve ${agentId}` });
            await bot.sendMessage(chatId, [
              "✅ 승인 반영 중…",
              `agent_id=${agentId}`,
              `name=${namePreview}`,
              `provider/model=${providerModel}`,
              `description=${descriptionPreview}`,
              `prompt_preview=${promptPreview}`,
              approvalEffect,
            ].join("\n"));
            const created = await createAgentProfile(client, {
              baseDir: jobs.baseDir,
              profile: draftProfile,
              format: "json",
              actor: `telegram:${userId}`,
            });
            const createdAgentId = String(
              created?.agent?.id
              || created?.created?.id
              || ""
            ).trim().toLowerCase();
            const effectiveAgentId = createdAgentId || agentId;
            try {
              await client.deactivateNodes(found.slot.ctxId, [found.resource.id]);
            } catch {}

            let participantsApplied = false;
            let conversationTeamApplied = false;
            if (draftJobId) {
              try {
                await appendParticipantToJobConfig(client, {
                  jobId: draftJobId,
                  agentId: effectiveAgentId,
                  actor: `telegram:${userId}`,
                });
                participantsApplied = true;
                conversationTeamApplied = true;
                tracking.append(draftJobId, "decisions", [
                  "## /chat approve_agent",
                  `- agent_id: ${effectiveAgentId}`,
                  `- draft_node: ${draftNode}`,
                  `- activated_node: ${created?.created?.id || "unknown"}`,
                  `- approved_by: telegram:${userId}`,
                ].join("\n"));
              } catch (e) {
                if (draftJobId) {
                  tracking.append(draftJobId, "decisions", [
                    "## /chat approve_agent (participant update failed)",
                    `- agent_id: ${effectiveAgentId}`,
                    `- error: ${String(e?.message ?? e)}`,
                  ].join("\n"));
                }
              }
            }

            await refreshAgentRegistry({ includeCompiled: true });
            await bot.sendMessage(chatId, [
              `✅ approve_agent 완료`,
              `agent_id=${effectiveAgentId}`,
              `name=${namePreview}`,
              `provider/model=${providerModel}`,
              `description=${descriptionPreview}`,
              `prompt_preview=${promptPreview}`,
              `draft_node=${draftNode}`,
              `agent_profile_node=${created?.created?.id || "unknown"}`,
              approvalEffect,
              draftJobId
                ? `job_id=${draftJobId} conversation_team 반영=${conversationTeamApplied ? "yes" : "failed"}`
                : "job_id 정보를 찾지 못해 conversation team 반영은 생략",
              draftJobId
                ? `job_id=${draftJobId} participants 반영=${participantsApplied ? "yes" : "failed"}`
                : "job_id 정보를 찾지 못해 participants 반영은 생략",
            ].join("\n"));
          } else {
            await bot.answerCallbackQuery(q.id, { text: `reject ${agentId}` });
            try {
              await client.deactivateNodes(found.slot.ctxId, [found.resource.id]);
            } catch {}
            if (draftJobId) {
              tracking.append(draftJobId, "decisions", [
                "## /chat reject_agent",
                `- agent_id: ${agentId}`,
                `- draft_node: ${draftNode}`,
                `- rejected_by: telegram:${userId}`,
              ].join("\n"));
            }
            await bot.sendMessage(chatId, [
              "🛑 reject_agent 완료",
              `agent_id=${agentId}`,
              `name=${namePreview}`,
              `provider/model=${providerModel}`,
              `draft_node=${draftNode}`,
            ].join("\n"));
          }
          return;
        }

        if (data.startsWith("gptapply:")) {
          const targetJobId = String(data.slice("gptapply:".length) || "").trim() || resolveCurrentJobIdForChat(chatId);
          if (!targetJobId) {
            await bot.answerCallbackQuery(q.id, { text: "jobId를 찾지 못했습니다." });
            await bot.sendMessage(chatId, "붙여넣기 모드를 시작할 jobId를 찾지 못했어요.\nUsage: /gptapply [jobId]");
            return;
          }
          setAwait(chatId, targetJobId, userId);
          rememberLastChatJob(chatId, targetJobId);
          await bot.answerCallbackQuery(q.id, { text: `paste mode: ${targetJobId}` });
          await bot.sendMessage(chatId, "🟣 이제 답변을 그대로 붙여넣어 주세요. (20분 내)\nJSON 액션 플랜이 있으면 자동 실행됩니다.\n종료: /gptdone");
          return;
        }

        const [action, jobId, token] = data.split(":");
        if (!["approve", "deny"].includes(action) || !jobId || !token) return;
        const decision = action === "approve" ? "approve" : "deny";
        const rec = approvals.decide(jobId, token, decision, "via telegram button");
        await bot.answerCallbackQuery(q.id, { text: `OK: ${rec.status}` });
        await bot.sendMessage(chatId, `🔐 ${rec.status.toUpperCase()}: ${token}`);

        if (rec.status === "approved" && rec.payload?.action === "git_commit") {
          const msg2 = rec.payload.message ?? "commit";
          const commitCwd = runWorkspaceDir(jobId);
          const add = await runCommand("git", ["add", "-A"], { cwd: commitCwd });
          if (!add.ok && /not a git repository/i.test(String(add.stderr || ""))) {
            await sendLong(bot, chatId, `⚠️ commit skipped: workspace is not a git repo\ncwd=${commitCwd}`);
            return;
          }
          const commit = await runCommand("git", ["commit", "-m", msg2], { cwd: commitCwd });
          tracking.append(jobId, "progress", `## git commit\n\n${FENCE}\n${add.stdout || add.stderr}\n${commit.stdout || commit.stderr}\n${FENCE}\n`);
          await sendLong(bot, chatId, `✅ 커밋 완료\n${clip(commit.stdout || commit.stderr, 3500)}`);
          await suggestNextPrompt(bot, chatId, jobId, "커밋 이후 다음 단계(테스트/PR/배포 등)를 결정해줘.", "commit");
        }
      } finally {
        restoreActor();
      }
    } catch (e) {
      const fallbackChatId = q?.message?.chat?.id;
      try {
        await bot.answerCallbackQuery(q.id, { text: "실패" });
      } catch {}
      if (fallbackChatId) {
        try {
          await bot.sendMessage(fallbackChatId, `❌ callback 처리 실패: ${clip(String(e?.message ?? e), 240)}`);
        } catch {}
      }
    }
  };
}
