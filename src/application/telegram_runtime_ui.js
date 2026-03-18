import fs from "node:fs";
import path from "node:path";

import {
  sendTextWithOptionalGocButton as sendTextWithOptionalGocButtonAdapter,
} from "../adapters/telegram/send.js";
import { isTelegramWebAppHttpsError } from "../adapters/telegram/context_links.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  buildPreviewAgentDisplayIndex,
  formatChatAgentDisplayName,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { clip } from "../textutil.js";
import {
  agentRegistry,
  bindGocActor,
  queue,
  jobAbortControllers,
  activeJobByChat,
  lastChatJobByChat,
  jobs,
  memory,
  MEMORY_MODE,
  gocInitError,
  memoryModeWithFallback,
  requireGocClient,
  resolveCurrentJobIdForChat,
  getAwait,
  chatSessionStore,
} from "./telegram_runtime_state.js";
import {
  buildContextInfo,
  sendLong,
} from "./telegram_runtime_io.js";
import {
  composeCapabilitiesForRun,
  loadSupervisorRuntime,
  openAgentsUiInfo,
  refreshAgentRegistry,
  summarizeSelectionState,
  recordMembershipMutationDiagnostic,
} from "./telegram_goc_runtime.js";
import { chatActionLabel } from "./telegram_route_planning.js";
import { runConversationAgentTeamCommand } from "./agent_team_commands.js";
import {
  buildRunAuthority,
  buildRunAuthorityPatch,
} from "./run_authority.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";

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
  return formatChatAgentDisplayName(agentId, agentIndex);
}

function uniqStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const clean = String(value || '').trim();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function summarizeAgentRuntimeRowsFromActions(actions = [], runtime = null, { limit = 8 } = {}) {
  const rows = [];
  const index = buildPreviewAgentDisplayIndex({ runtime, actions });
  const seen = new Set();
  for (const action of Array.isArray(actions) ? actions : []) {
    const normalizedType = String(action?.type || '').trim().toLowerCase();
    const candidates = normalizedType === 'spawn_parallel' || normalizedType === 'spawn_agents'
      ? (Array.isArray(action?.agents) ? action.agents : [])
      : ([action]);
    for (const child of candidates) {
      const childType = String(child?.type || normalizedType).trim().toLowerCase();
      if (!['run_agent', 'agent_run', 'synthesize_final'].includes(childType)) continue;
      const inputs = child?.inputs && typeof child.inputs === 'object' ? child.inputs : {};
      const instanceId = String(inputs.runtime_instance_id || inputs.runtimeInstanceId || child?.agent_id || child?.agent || '').trim();
      const dedupeKey = instanceId || JSON.stringify([child?.agent, child?.goal, inputs.slot_id, inputs.role_id]);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      const label = String(
        inputs.display_label
        || inputs.displayLabel
        || resolveActionAgentNameHint(child)
        || formatChatAgentDisplayName(instanceId || child?.agent_id || child?.agent || '', index, { fallbackLabel: 'Agent' })
      ).trim() || 'Agent';
      const roleId = String(inputs.role_id || inputs.roleId || inputs.role_label || inputs.roleLabel || child?.agent || '').trim().toLowerCase();
      const roleText = roleId ? ` [${roleId}]` : '';
      const model = [String(inputs.provider || '').trim(), String(inputs.model || '').trim()].filter(Boolean).join('/');
      const skillIds = uniqStrings([
        ...(Array.isArray(inputs.attached_skill_ids) ? inputs.attached_skill_ids : []),
        ...(Array.isArray(inputs.attachedSkillIds) ? inputs.attachedSkillIds : []),
      ]).slice(0, 4);
      const goal = clip(String(child?.goal || child?.prompt || child?.task || '').trim(), 120);
      const parts = [`${label}${roleText}`];
      if (model) parts.push(`model=${model}`);
      if (skillIds.length > 0) parts.push(`skills=${skillIds.join(', ')}`);
      if (goal) parts.push(`goal=${goal}`);
      rows.push(parts.join(' · '));
      if (rows.length >= Math.max(1, Number(limit) || 8)) return rows;
    }
  }
  return rows;
}

function summarizeAgentRoster(runtime = null, { actions = [], limit = 8 } = {}) {
  const snapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === 'object'
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === 'object' ? runtime.runtime_team_snapshot : null);
  const rows = Array.isArray(snapshot?.runtime_agents) ? snapshot.runtime_agents : [];
  if (rows.length > 0) return rows;
  const actionRows = summarizeAgentRuntimeRowsFromActions(actions, runtime, { limit });
  return actionRows.map((summary, index) => ({
    display_label: summary,
    role_label: '',
    attached_skill_ids: [],
    __summary_only: true,
    instance_id: `planned_${index}`
  }));
}

function formatRosterRow(row = {}) {
  if (row?.__summary_only) return String(row.display_label || '').trim();
  const roleId = String(row?.role_id || row?.roleId || row?.role_label || row?.roleLabel || '').trim().toLowerCase();
  const label = String(row?.display_label || row?.displayLabel || formatChatAgentDisplayName(row?.instance_id || row?.agent_id || roleId || '', new Map(), { fallbackLabel: 'Agent' })).trim() || 'Agent';
  const skillIds = uniqStrings([
    ...(Array.isArray(row?.attached_skill_ids) ? row.attached_skill_ids : []),
    ...(Array.isArray(row?.attachedSkillIds) ? row.attachedSkillIds : []),
    ...(Array.isArray(row?.attached_skills) ? row.attached_skills.map((entry) => entry?.skill_id || entry?.id || entry) : []),
    ...(Array.isArray(row?.attachedSkills) ? row.attachedSkills.map((entry) => entry?.skill_id || entry?.id || entry) : []),
  ]).slice(0, 5);
  const model = [String(row?.provider || '').trim(), String(row?.model || '').trim()].filter(Boolean).join('/');
  const personality = String(row?.personality_profile?.stance || row?.personalityProfile?.stance || '').trim();
  const parts = [label];
  if (roleId) parts.push(`[${roleId}]`);
  if (model) parts.push(`model=${model}`);
  if (skillIds.length > 0) parts.push(`skills=${skillIds.join(', ')}`);
  if (personality) parts.push(`tone=${personality}`);
  return parts.join(' · ');
}

export function formatMemorySummary() {
  const s = memory.getSummary();
  const role = memory.getAgentRoleSummary();
  return [
    "🧠 현재 메모리 기반 설정",
    `memory.mode=${MEMORY_MODE}`,
    `memory.effective=${memoryModeWithFallback()}`,
    ...(gocInitError ? [`memory.goc_error=${gocInitError}`] : []),
    `memory.file=${s.filePath}`,
    "",
    "Auto-Suggest Reflection Prompt (preview):",
    s.policyPreview || "(empty)",
    "",
    "Multi-Agent Router Prompt (preview):",
    s.routerPreview || "(empty)",
    "",
    "Agent Roles (preview):",
    `[Gemini]\n${role.geminiPreview}`,
    "",
    `[Codex]\n${role.codexPreview}`,
    "",
    `[ChatGPT]\n${role.chatgptPreview}`,
    "",
    `operator_notes=${s.noteCount}`,
    `recent_lessons=${s.lessonCount}`,
    "",
    "명령:",
    "/memory show",
    "/memory md",
    "/memory policy <자연어 프롬프트>",
    "/memory routing <자연어 프롬프트>",
    "/memory role <gemini|codex|chatgpt> <자연어 역할>",
    "/memory agents",
    "/memory note <메모>",
    "/memory lesson <교훈>",
    "/memory reset",
    "",
    "호환 alias:",
    "/settings ...  (=/memory ...)",
  ].join("\n");
}

export function formatRunningJobs(chatId) {
  const chatKey = String(chatId);
  const active = activeJobByChat.get(chatKey) || "";
  const awaitingJob = getAwait(chatId)?.jobId || "";
  const lastChatJob = lastChatJobByChat.get(chatKey) || "";
  const running = Array.from(jobAbortControllers.keys());
  const queued = queue
    .map((item) => String(item?.jobId || "").trim())
    .filter(Boolean);
  const dedup = (list) => Array.from(new Set(list.filter(Boolean)));

  const lines = [
    "🏃 Running jobs",
    `chat_active=${active || "(none)"}`,
    `chat_gptawait=${awaitingJob || "(none)"}`,
    `chat_last=${lastChatJob || "(none)"}`,
    `running_count=${running.length}`,
    ...dedup(running).map((id) => `- running: ${id}`),
    `queue_count=${queued.length}`,
    ...dedup(queued).map((id) => `- queued: ${id}`),
    "",
    "중단: /stop <jobId>",
  ];
  return lines.join("\n");
}

function listPendingManualApprovals(jobId) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  let approvalsDir = "";
  try {
    approvalsDir = path.join(jobs.jobDir(cleanJobId), "approvals");
  } catch {
    return [];
  }
  if (!approvalsDir || !fs.existsSync(approvalsDir)) return [];
  const files = fs.readdirSync(approvalsDir, { withFileTypes: true })
    .filter((row) => row.isFile() && row.name.endsWith(".json"))
    .map((row) => row.name)
    .slice(0, 40);
  const pending = [];
  for (const name of files) {
    try {
      const filePath = path.join(approvalsDir, name);
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (String(parsed?.status || "").trim().toLowerCase() !== "pending") continue;
      pending.push({
        token: String(parsed?.token || "").trim(),
        purpose: String(parsed?.purpose || "").trim(),
        summary: String(parsed?.summary || "").trim(),
      });
    } catch {}
  }
  return pending.slice(0, 5);
}

export function buildChatStatusCard(chatId, runtime = null) {
  const chatKey = String(chatId || "");
  const session = chatSessionStore.get(chatId);
  const activeJobId = activeJobByChat.get(chatKey) || "";
  const currentJobId = String(
    session.jobId
    || activeJobId
    || resolveCurrentJobIdForChat(chatId)
    || ""
  ).trim();
  const queueItems = queue.filter((item) => String(item?.jobId || "").trim() === currentJobId);
  const activeController = currentJobId ? jobAbortControllers.get(currentJobId) : null;
  const interrupt = session.interrupt && typeof session.interrupt === "object" ? session.interrupt : null;
  const pendingApproval = session.pending_approval && typeof session.pending_approval === "object"
    ? session.pending_approval
    : null;
  const pendingApprovalActionLabel = pendingApproval?.action
    ? (String(pendingApproval?.action_display_label || "").trim() || chatActionLabel(pendingApproval.action))
    : "";
  const lastRoute = session.last_route && typeof session.last_route === "object"
    ? session.last_route
    : null;
  const manualApprovals = listPendingManualApprovals(currentJobId);
  const teamConfig = session.team_config && typeof session.team_config === 'object' ? session.team_config : null;
  const activeTeam = teamConfig?.active_team && typeof teamConfig.active_team === 'object' ? teamConfig.active_team : null;
  const enabledAgents = runtime?.agentSelection?.enabled_ids || runtime?.enabledAgentIds || [];
  const enabledTools = runtime?.toolSelection?.enabled_ids || runtime?.enabledToolIds || [];
  const runtimeAuthority = buildRunAuthority(runtime);
  const agentIndex = buildAgentDisplayIndex(agentRegistry, runtime);
  const runtimeTeamSnapshot = runtime?.runtimeTeamSnapshot && typeof runtime.runtimeTeamSnapshot === "object"
    ? runtime.runtimeTeamSnapshot
    : (runtime?.runtime_team_snapshot && typeof runtime.runtime_team_snapshot === "object"
      ? runtime.runtime_team_snapshot
      : null);

  const lines = [
    "📋 현재 상태",
    `- state: ${session.state || "idle"}`,
    `- job_id: ${currentJobId || "(none)"}`,
    `- active_run_id: ${session.active_run_id || "(none)"}`,
    `- running: ${activeJobId ? "yes" : "no"}`,
    `- queue_for_job: ${queueItems.length}`,
    `- abort_signal: ${activeController ? (activeController.signal.aborted ? "aborted" : "active") : "none"}`,
    `- pending_interrupt: ${interrupt?.requested ? `${interrupt.mode}${interrupt.reason ? ` (${clip(interrupt.reason, 90)})` : ""}` : "none"}`,
    `- pending_approval: ${pendingApproval ? (pendingApproval.reason || "yes") : "none"}`,
    pendingApprovalActionLabel ? `- pending_approval_action: ${pendingApprovalActionLabel}` : "",
    lastRoute
      ? `- last_route: ${String(lastRoute.reason || "(none)")}, actions=${Array.isArray(lastRoute.actions) ? lastRoute.actions.length : 0}`
      : "",
    `- pending_user_messages: ${Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0}`,
    manualApprovals.length > 0 ? `- pending_manual_approvals: ${manualApprovals.length}` : "",
  ];
  if (manualApprovals.length > 0) {
    for (const row of manualApprovals) {
      lines.push(`  - ${row.purpose || "approval"}: ${clip(row.summary || row.token || "", 120)}`);
    }
  }
  if (Array.isArray(enabledAgents) && enabledAgents.length > 0) {
    lines.push(`- enabled_agents: ${enabledAgents.map((id) => formatAgentRef(id, agentIndex)).join(", ")}`);
  }
  if (Array.isArray(enabledTools) && enabledTools.length > 0) {
    lines.push(`- enabled_tools: ${enabledTools.join(", ")}`);
  }
  if (activeTeam) {
    lines.push(`- active_team: ${String(activeTeam.team_name || 'configured_team')}`);
    lines.push(`- team_mode: ${String(activeTeam.mode || 'scoped_context')}`);
    lines.push(`- team_agents: ${Array.isArray(activeTeam.agents) ? activeTeam.agents.length : 0}`);
    const interactionSpec = activeTeam.interaction_spec && typeof activeTeam.interaction_spec === 'object' ? activeTeam.interaction_spec : null;
    if (interactionSpec) {
      lines.push(`- team_execution_pattern: ${String(interactionSpec.execution_pattern || '(none)')}`);
      lines.push(`- final_answer_owner: ${String(interactionSpec.final_answer_owner || '(none)')}`);
    }
  }
  if (runtimeAuthority) {
    lines.push(`- mode: ${runtimeAuthority.mode}`);
    lines.push(`- plan_source: ${runtimeAuthority.plan_source}`);
    lines.push(`- context_source: ${runtimeAuthority.context_source}`);
    lines.push(`- agent_catalog_source: ${runtimeAuthority.agent_catalog_source}`);
    lines.push(`- conversation_team_source: ${runtimeAuthority.conversation_team_source}`);
    lines.push(`- skill_catalog_source: ${runtimeAuthority.skill_catalog_source}`);
    lines.push(`- degraded_mode: ${runtimeAuthority.degraded_mode ? "true" : "false"}`);
    if (runtimeAuthority.fallback_reason) {
      lines.push(`- fallback_reason: ${clip(runtimeAuthority.fallback_reason, 180)}`);
    }
  }
  if (runtimeTeamSnapshot) {
    const snapshotLines = summarizeRuntimeTeamSnapshotLines(runtimeTeamSnapshot, {
      actionSource: session?.last_route?.action_source || "",
    });
    for (const line of snapshotLines.slice(0, 7)) {
      lines.push(line);
    }
  }
  const plannedRosterRows = summarizeAgentRuntimeRowsFromActions(session?.last_route?.actions || [], runtime, { limit: 4 });
  if (plannedRosterRows.length > 0) {
    lines.push('- team_preview:');
    for (const row of plannedRosterRows) lines.push(`  • ${row}`);
  }
  if (runtime?.jobConfigDebugSummary) {
    lines.push(`- job_config(debug): ${clip(String(runtime.jobConfigDebugSummary || ""), 240)}`);
  }
  return {
    text: lines.join("\n"),
    status: {
      chat_id: chatKey,
      state: session.state || "idle",
      job_id: currentJobId || null,
      active_run_id: session.active_run_id || null,
      running: !!activeJobId,
      queue_for_job: queueItems.length,
      pending_interrupt: interrupt,
      pending_approval: pendingApproval,
      pending_user_messages: Array.isArray(session.pending_user_messages) ? session.pending_user_messages.length : 0,
      enabled_agents: Array.isArray(enabledAgents) ? enabledAgents : [],
      enabled_tools: Array.isArray(enabledTools) ? enabledTools : [],
      ...buildRunAuthorityPatch({ runtime_authority: runtimeAuthority }),
    },
  };
}

export function formatAgentMemorySummary() {
  const roles = memory.getAgentRoles();
  return [
    "🤖 Multi-Agent 역할 메모리",
    "",
    "Gemini",
    roles.gemini,
    "",
    "Codex",
    roles.codex,
    "",
    "ChatGPT",
    roles.chatgpt,
    "",
    "Router Prompt",
    memory.getRouterPrompt(),
  ].join("\n");
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
        await bot.sendMessage(chatId, "Usage: /agents add|remove|enable|disable <preset_or_role_ref>");
        return;
      }
      if (!currentJobId) {
        await bot.sendMessage(chatId, "현재 chat에 연결된 job이 없어 conversation preset/preferences 를 변경할 수 없습니다.");
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
          "팁: /team skills 로 기본 agent별 역할/스킬을 먼저 볼 수 있습니다.",
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

    if (cleanKind === "agent" && sub === "skills") {
      const rosterRows = summarizeAgentRoster(runtime, {
        actions: runtime?.chatSession?.last_route?.actions || runtime?.last_route?.actions || chatSessionStore.get(chatId)?.last_route?.actions || [],
        limit: 12,
      });
      const textLines = [
        '현재 agent roster',
        `- job_id: ${currentJobId}`,
      ];
      if (rosterRows.length === 0) {
        textLines.push('- 아직 계획된 runtime agent가 없습니다.')
      } else {
        textLines.push('- agents:')
        for (const row of rosterRows.slice(0, 12)) textLines.push(`  • ${formatRosterRow(row)}`)
      }
      await sendLong(bot, chatId, textLines.join('\n'));
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
