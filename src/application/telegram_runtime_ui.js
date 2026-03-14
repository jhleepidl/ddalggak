import {
  sendTextWithOptionalGocButton as sendTextWithOptionalGocButtonAdapter,
} from "../adapters/telegram/send.js";
import { isTelegramWebAppHttpsError } from "../adapters/telegram/context_links.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  formatAgentDisplayName,
} from "../shared/agent_labels.js";
import {
  agentRegistry,
  bindGocActor,
  buildChatStatusCard,
  buildContextInfo,
  loadSupervisorRuntime,
  memoryModeWithFallback,
  openAgentsUiInfo,
  refreshAgentRegistry,
  requireGocClient,
  resolveCurrentJobIdForChat,
  runConversationAgentTeamCommand,
  sendLong,
  summarizeSelectionState,
  recordMembershipMutationDiagnostic,
  composeCapabilitiesForRun,
} from "./telegram_runtime_ops.js";

async function sendTextWithOptionalGocButton(
  bot,
  chatId,
  text,
  {
    miniAppLink = "",
    browserLink = "",
    miniAppLabel = "Open GoC (Mini App)",
    browserLabel = "Open GoC (Browser)",
  } = {}
) {
  return sendTextWithOptionalGocButtonAdapter(bot, chatId, text, {
    miniAppLink,
    browserLink,
    miniAppLabel,
    browserLabel,
    isTelegramWebAppHttpsError,
  });
}

function buildAgentDisplayIndex(registry = null, runtime = null) {
  return buildAgentDisplayIndexShared(registry, runtime);
}

function formatAgentRef(agentId, agentIndex = new Map()) {
  return formatAgentDisplayName(agentId, agentIndex, {
    includeShortId: true,
  });
}

export async function sendChatStatus(bot, chatId, { telegramUserId = "" } = {}) {
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  let runtime = null;
  if (currentJobId) {
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || "") },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch {
      runtime = null;
    }
  }
  const card = buildChatStatusCard(chatId, runtime);
  await sendLong(bot, chatId, card.text);
}

export async function sendAgentOrToolListQuick(bot, chatId, kind = "agent", rawArgs = "", opts = {}) {
  const cleanKind = String(kind || "").trim().toLowerCase() === "tool" ? "tool" : "agent";
  const tokens = String(rawArgs || "").trim().split(/\s+/).filter(Boolean);
  const sub = String(tokens[0] || "").trim().toLowerCase();
  const targetAgentId = String(tokens[1] || "").trim().toLowerCase();
  const currentJobId = String(resolveCurrentJobIdForChat(chatId) || "").trim();
  const telegramUserId = String(opts?.telegramUserId || "").trim();
  const restoreActor = bindGocActor(telegramUserId);

  try {
    if (cleanKind === "agent" && (sub === "registry" || sub === "public")) {
      const authority = composeCapabilitiesForRun({ jobId: currentJobId || "" }).authority || {};
      const isGocAuthority = String(authority.mode || "").trim().toLowerCase() === "goc";
      if (sub === "public" && !isGocAuthority) {
        await bot.sendMessage(chatId, "❌ /agents public 는 GoC 모드에서만 지원됩니다.");
        return;
      }
      try {
        const scope = sub === "public" ? "public" : (isGocAuthority ? "my" : "local");
        const query = String(tokens.slice(1).join(" ") || "").trim().toLowerCase();
        const localRegistry = isGocAuthority ? null : await refreshAgentRegistry({ includeCompiled: true });
        const rows = isGocAuthority
          ? await requireGocClient().listAgents(scope === "local" ? "my" : scope)
          : (Array.isArray(localRegistry?.agents) ? localRegistry.agents : []);
        const filteredRows = query
          ? rows.filter((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const name = String(row?.name || "").trim().toLowerCase();
            const description = String(row?.description || "").trim().toLowerCase();
            return id.includes(query) || name.includes(query) || description.includes(query);
          })
          : rows;
        const lines = [
          sub === "public"
            ? "GoC Public Agent Catalog"
            : (isGocAuthority ? "GoC My Agent Catalog" : "Local Agent Catalog"),
          ...((Array.isArray(filteredRows) ? filteredRows : []).slice(0, 50).map((row) => {
            const id = String(row?.id || "").trim().toLowerCase();
            const provider = String(row?.provider || "gemini").trim().toLowerCase();
            const model = String(row?.model || provider || "gemini").trim();
            const published = row?.published === true ? "published" : "private";
            const name = String(row?.name || id || "unknown").trim();
            return `- ${name} [${id || "unknown"}] (${provider}/${model}, ${published})`;
          })),
        ];
        if (query) lines.push(`- filter: ${query}`);
        if ((Array.isArray(filteredRows) ? filteredRows : []).length === 0) lines.push("- (none)");
        await sendLong(bot, chatId, lines.join("\n"));
      } catch (error) {
        await bot.sendMessage(chatId, `❌ ${sub} 조회 실패: ${String(error?.message ?? error)}`);
      }
      return;
    }

    if (cleanKind === "agent" && ["add", "remove", "enable", "disable"].includes(sub)) {
      if (!targetAgentId) {
        await bot.sendMessage(chatId, "Usage: /agents add|remove|enable|disable <agent_ref>");
        return;
      }
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어 conversation agent를 변경할 수 없습니다.");
        return;
      }
      try {
        const runtime = await loadSupervisorRuntime(currentJobId, {
          chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
          includeContext: false,
          includeGlobal: false,
          telegramUserId,
        });
        const result = await runConversationAgentTeamCommand({
          command: sub,
          runtime,
          jobId: currentJobId,
          agentId: targetAgentId,
          source: "telegram_agents_command",
          agentRegistry,
          buildAgentDisplayIndex,
          formatAgentRef,
          refreshAgentRegistry,
          summarizeSelectionState,
          recordDiagnostic: recordMembershipMutationDiagnostic,
        });
        await sendLong(bot, chatId, result.message);
      } catch (error) {
        await bot.sendMessage(chatId, `❌ /agents ${sub} 실패: ${String(error?.message ?? error)}`);
      }
      return;
    }

    if (!currentJobId) {
      if (cleanKind === "agent") {
        const reg = await refreshAgentRegistry({ includeCompiled: true });
        const sampleRows = (Array.isArray(reg.agents) ? reg.agents : [])
          .filter((row) => String(row?.id || "").trim())
          .slice(0, 10);
        const agentIndex = buildAgentDisplayIndex(reg, null);
        const lines = [
          "현재 활성 job이 없습니다.",
          sampleRows.length > 0
            ? `등록된 agent(샘플): ${sampleRows.map((row) => formatAgentRef(row?.id, agentIndex)).join(", ")}`
            : "등록된 agent가 없습니다.",
          "작업 지시를 보내면 chat별 job이 생성됩니다.",
        ];
        let fallbackAgentsUi = null;
        if (memoryModeWithFallback() === "goc") {
          try {
            fallbackAgentsUi = await openAgentsUiInfo({ chatId, userId: telegramUserId });
          } catch {
            fallbackAgentsUi = null;
          }
        }
        await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
          miniAppLink: fallbackAgentsUi?.miniAppLink || "",
          browserLink: fallbackAgentsUi?.browserLink || fallbackAgentsUi?.link || "",
          miniAppLabel: "Open Agents Catalog",
          browserLabel: "Open Agents Catalog",
        });
        return;
      }
      await bot.sendMessage(chatId, "현재 활성 job이 없어 tool 목록을 확인할 수 없습니다.");
      return;
    }

    let runtime = null;
    try {
      runtime = await loadSupervisorRuntime(currentJobId, {
        chatMeta: { chat_id: String(chatId || ""), telegram_user_id: telegramUserId || undefined },
        includeContext: false,
        includeGlobal: false,
        telegramUserId,
      });
    } catch (error) {
      await bot.sendMessage(chatId, `❌ 목록 조회 실패: ${String(error?.message ?? error)}`);
      return;
    }

    if (cleanKind === "agent") {
      let threadTeamInfo = null;
      try {
        threadTeamInfo = await openAgentsUiInfo({ chatId, jobId: currentJobId, userId: telegramUserId });
      } catch {
        threadTeamInfo = null;
      }
      const result = await runConversationAgentTeamCommand({
        command: "list",
        runtime,
        jobId: currentJobId,
        source: "telegram_agents_command",
        agentRegistry,
        buildAgentDisplayIndex,
        formatAgentRef,
        refreshAgentRegistry,
        summarizeSelectionState,
        recordDiagnostic: recordMembershipMutationDiagnostic,
      });
      await sendTextWithOptionalGocButton(bot, chatId, result.message, {
        miniAppLink: threadTeamInfo?.miniAppLink || "",
        browserLink: threadTeamInfo?.browserLink || threadTeamInfo?.link || "",
        miniAppLabel: "Open Thread Team",
        browserLabel: "Open Thread Team",
      });
      return;
    }

    let info = null;
    try {
      info = await buildContextInfo(currentJobId, { chatId, userId: telegramUserId || undefined });
    } catch {
      info = null;
    }

    const enabled = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];
    const disabled = runtime?.toolSelection?.disabled_ids || [];
    const lines = [
      "현재 job tool 목록",
      `- job_id: ${currentJobId}`,
      enabled.length > 0
        ? `- enabled: ${enabled.slice(0, 10).join(", ")}`
        : "- enabled: (none)",
      disabled.length > 0
        ? `- disabled: ${disabled.slice(0, 10).join(", ")}`
        : "- disabled: (none)",
      "정밀 편집은 GoC UI에서 할 수 있습니다.",
    ];
    await sendTextWithOptionalGocButton(bot, chatId, lines.join("\n"), {
      miniAppLink: info?.miniAppLink || info?.link || "",
      browserLink: info?.browserLink || "",
    });
  } finally {
    restoreActor();
  }
}
