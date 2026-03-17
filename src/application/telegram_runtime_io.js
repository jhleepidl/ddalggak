import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { Jobs } from "../jobs.js";
import { Tracking } from "../tracking.js";
import { Approvals } from "../approvals.js";
import { runCommand } from "../proc.js";
import { runCodexExec } from "../codex.js";
import { runGeminiPrompt } from "../gemini.js";
import { OrchestratorMemory } from "../settings.js";
import { orchestratorNotes, buildChatGPTNextStepPrompt } from "../prompts.js";
import { clip, extractCodexInstruction, extractJsonPlan } from "../textutil.js";
import { loadAgents, getAgent } from "../agents.js";
import {
  parseAutoSuggestDecision as parseAutoSuggestDecisionShared,
  parseJsonObjectFromText as parseJsonObjectFromTextShared,
} from "../shared/json_extract.js";
import {
  parseRouterPlan as parseRouterPlanDomain,
  sanitizeSupervisorRoutePlan as sanitizeSupervisorRoutePlanDomain,
  normalizeForceMode as normalizeForceModeDomain,
} from "../domain/route_plan.js";
import {
  normalizeScopeHintCore as normalizeLensSpecDomain,
  defaultScopeHintForAgent as defaultLensSpecForAgentDomain,
  resolveEffectiveScopeHint as resolveEffectiveLensSpecDomain,
  dedupeScopeNodeIds as dedupeLensNodeIds,
} from "../domain/scope_hint_core.js";
import { createDefaultRunRoute } from "./orchestrator.js";
import { sendLong as sendLongAdapter } from "../adapters/telegram/send.js";
import {
  buildPendingApprovalPrompt as buildPendingApprovalPromptAdapter,
  formatChatSummary as formatChatSummaryAdapter,
} from "../adapters/telegram/formatting.js";
import {
  buildContextLinks,
  buildContextLinkButtons,
  isTelegramWebAppHttpsError,
} from "../adapters/telegram/context_links.js";
import {
  getActionGoal as getActionGoalShared,
  formatActionAgentLabel as formatActionAgentLabelShared,
  formatChatActionLabel as chatActionLabelShared,
  buildPlanPreviewLines as buildPlanPreviewLinesShared,
  buildQueuedAgentStatusFromActions as buildQueuedAgentStatusFromActionsShared,
  buildRoutedDashboardText as buildRoutedDashboardTextShared,
  inferApprovalPreviewReason as inferApprovalPreviewReasonShared,
  buildApprovalActionSummaryLines as buildApprovalActionSummaryLinesShared,
  buildAutopilotProgressSummary as buildAutopilotProgressSummaryShared,
  buildAutopilotFollowupMessage as buildAutopilotFollowupMessageShared,
  updateCompletedDeliverablesFromOutputs as updateCompletedDeliverablesFromOutputsShared,
  summarizeSpecialChatOutputs as summarizeSpecialChatOutputsShared,
  buildChatSynthesisFallback as buildChatSynthesisFallbackShared,
} from "../adapters/telegram/preview_formatting.js";
import {
  buildGeminiRetryNoticeText as buildGeminiRetryNoticeTextShared,
  buildGeminiModelSwitchNoticeText as buildGeminiModelSwitchNoticeTextShared,
  buildGeminiGiveUpNoticeText as buildGeminiGiveUpNoticeTextShared,
} from "../adapters/telegram/status_messages.js";
import { formatByteSize } from "../adapters/telegram/uploads.js";
import {
  createJobRuntimeState,
  makeCancelledError as makeCancelledErrorDomain,
  isCancelledError as isCancelledErrorDomain,
} from "./job_runtime.js";
import { summarizeRuntimeTeamSnapshotLines } from "./runtime_snapshot_display.js";
import { createRuntimeTeamSnapshot } from "./runtime_metadata.js";
import { markActionsSkipped, wasInterruptedByReplan } from "./run_status_cleanup.js";
import {
  applyRunAuthority,
  buildRunAuthority,
  buildRunAuthorityPatch,
  normalizeRunAuthority,
  summarizeRunAuthorityLines,
} from "./run_authority.js";
import {
  createRuntimeComposer,
  invokeRuntimePlanner,
} from "./runtime_composer.js";
import { createSupervisorRuntimeLoader } from "./supervisor_runtime_loader.js";
import {
  isExplicitTeamConfigurationIntentMessage,
} from "./team_intent.js";
import { buildExplicitTeamReconfigurationActions } from "./team_config_diff.js";
import {
  verifyConversationMembershipMutation,
  createMembershipConfirmationError,
} from "./membership_confirmation.js";
import {
  resolveConversationMembershipTarget,
  summarizeMembershipTarget,
} from "./membership_target.js";
import {
  applyConversationAgentMutation,
  runConversationAgentTeamCommand,
  summarizeMembershipMutationResponse,
  syncRuntimeConversationTeamState,
} from "./agent_team_commands.js";
import {
  createAgentProfile,
  updateAgentProfile,
  listPublicBlueprints,
  installBlueprint,
} from "../agent_registry.js";
import { GocClient } from "../goc_client.js";
import {
  ensureJobThread,
  ensureAgentsThread,
  ensureToolsThread,
  ensureGlobalThread,
  normalizeJobConfig as normalizeSupervisorJobConfig,
  appendTrackingChunkToGoc,
} from "../goc_mapping.js";
import { ChatSessionStore } from "../chat/session.js";
import { routeWithSupervisor } from "../chat/supervisor_router.js";
import { executeSupervisorActions, isMutatingAction } from "../chat/executor.js";
import {
  buildAgentDisplayIndex as buildAgentDisplayIndexShared,
  formatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from "../shared/agent_labels.js";
import { normalizeActionPlan } from "../chat/actions.js";
import { expandDetailContext } from "../chat/unfold.js";
import { ChatRunManager } from "../chat/run_manager.js";
import { GocExecutionGraphRecorder } from "../chat/goc_execution_graph.js";

import * as runtimeState from "./telegram_runtime_state.js";
import { createJob } from "./telegram_goc_runtime.js";

const {
  MEMORY_MODE,
  GOC_UI_TOKEN_TTL_SEC,
  GOC_UI_BROWSER_TOKEN_TTL_SEC,
  GOC_UI_LINK_MODE,
  TELEGRAM_SEND_MAX_BYTES,
  OUTPUT_AUTO_SEND,
  OUTPUT_AUTO_SEND_MAX_FILES,
  OUTPUT_AUTO_SEND_ON,
  jobs,
  chatSessionStore,
  gocFallbackByJob,
  runDir,
  runWorkspaceDir,
  resolveWorkspacePath,
  resolveCurrentJobIdForChat,
  runSharedDir,
  loadLocalContextDocs,
  rememberLastChatJob,
  memoryModeWithFallback,
  requireGocClient,
  bindGocActor,
} = runtimeState;

async function buildContextInfo(
  target,
  {
    chatId = null,
    userId = null,
    createIfMissing = false,
  } = {}
) {
  if (memoryModeWithFallback() !== "goc") {
    throw new Error(`GoC disabled (mode=${MEMORY_MODE}, effective=${memoryModeWithFallback()})`);
  }

  const restoreActor = bindGocActor(userId);
  try {
    const client = requireGocClient();
    const targetRaw = String(target || "").trim();
    let resolved = targetRaw || (chatId == null ? "" : resolveCurrentJobIdForChat(chatId));

    if (!resolved) {
      if (!createIfMissing || chatId == null) {
        throw new Error("Usage: /context <jobId|global>  (jobId omitted uses current running job)");
      }
      const seeded = await createJob("Open GoC context link", {
        ownerUserId: userId,
        ownerChatId: chatId,
      });
      resolved = String(seeded?.jobId || "").trim();
      if (!resolved) throw new Error("Failed to create context job");
      rememberLastChatJob(chatId, resolved);
      chatSessionStore.upsert(chatId, {
        jobId: resolved,
        state: "idle",
      });
    }

    if (resolved.toLowerCase() === "global") {
      const g = await ensureGlobalThread(client, {
        baseDir: jobs.baseDir,
        title: "global:shared",
      });
      const links = await buildContextLinks(client, {
        threadId: g.threadId,
        ctxId: g.ctxId,
        linkMode: GOC_UI_LINK_MODE,
        uiTokenTtlSec: GOC_UI_TOKEN_TTL_SEC,
        browserTokenTtlSec: GOC_UI_BROWSER_TOKEN_TTL_SEC,
      });
      const miniAppNotice = links.miniAppSupported
        ? ""
        : "Mini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.";
      return {
        scope: "global",
        threadId: g.threadId,
        ctxId: g.ctxId,
        link: links.miniAppLink,
        miniAppLink: links.miniAppLink,
        browserLink: links.browserLink,
        miniAppSupported: links.miniAppSupported,
        miniAppTokenExp: links.miniAppTokenExp,
        browserTokenExp: links.browserTokenExp,
        lines: [
          "global context",
          `thread=${g.threadId}`,
          `ctx=${g.ctxId}`,
          links.miniAppTokenExp ? `miniapp_token_exp=${links.miniAppTokenExp}` : "",
          links.browserTokenExp ? `browser_token_exp=${links.browserTokenExp}` : "",
          `miniapp_link=${links.miniAppLink}`,
          `browser_link=${links.browserLink}`,
          miniAppNotice,
          "",
          "UI에서 편집/활성 토글/삭제하면 다음 스텝 호출부터 반영됩니다.",
        ].filter(Boolean),
      };
    }

    const jobId = String(resolved).trim();
    const map = await ensureJobThread(client, {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
      telegram: chatId == null ? null : { chat_id: String(chatId || "") },
    });
    const links = await buildContextLinks(client, {
      threadId: map.threadId,
      ctxId: map.ctxSharedId,
      linkMode: GOC_UI_LINK_MODE,
      uiTokenTtlSec: GOC_UI_TOKEN_TTL_SEC,
      browserTokenTtlSec: GOC_UI_BROWSER_TOKEN_TTL_SEC,
    });
    const miniAppNotice = links.miniAppSupported
      ? ""
      : "Mini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.";
    return {
      scope: "job",
      jobId,
      threadId: map.threadId,
      ctxId: map.ctxSharedId,
      link: links.miniAppLink,
      miniAppLink: links.miniAppLink,
      browserLink: links.browserLink,
      miniAppSupported: links.miniAppSupported,
      miniAppTokenExp: links.miniAppTokenExp,
      browserTokenExp: links.browserTokenExp,
      lines: [
        `jobId=${jobId}`,
        `thread=${map.threadId}`,
        `ctx=${map.ctxSharedId}`,
        links.miniAppTokenExp ? `miniapp_token_exp=${links.miniAppTokenExp}` : "",
        links.browserTokenExp ? `browser_token_exp=${links.browserTokenExp}` : "",
        `miniapp_link=${links.miniAppLink}`,
        `browser_link=${links.browserLink}`,
        miniAppNotice,
        "",
        "UI에서 편집/활성 토글/삭제하면 다음 스텝 호출부터 반영됩니다.",
      ].filter(Boolean),
    };
  } finally {
    restoreActor();
  }
}

async function sendContextInfo(bot, chatId, target, { userId = null, createIfMissing = true } = {}) {
  const info = await buildContextInfo(target, { chatId, userId, createIfMissing });
  const text = info.lines.join("\n");
  const {
    hasMiniApp,
    buttons,
  } = buildContextLinkButtons({
    miniAppLink: info.miniAppLink,
    browserLink: info.browserLink,
  });

  if (buttons.length === 0) {
    await sendLong(bot, chatId, text);
    return info;
  }
  try {
    await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [buttons] } });
  } catch (e) {
    if (hasMiniApp && isTelegramWebAppHttpsError(e)) {
      const fallbackText = `${text}\n\nMini App 버튼은 HTTPS만 지원합니다. 지금은 브라우저 링크를 사용하세요.`;
      const browserOnly = info.browserLink
        ? [{ text: "Open GoC (Browser)", url: info.browserLink }]
        : [];
      if (browserOnly.length > 0) {
        await bot.sendMessage(chatId, fallbackText, { reply_markup: { inline_keyboard: [browserOnly] } });
      } else {
        await sendLong(bot, chatId, fallbackText);
      }
      return info;
    }
    throw e;
  }
  return info;
}

async function loadContextDocs(jobId, docNames, maxCharsPerDoc = 3500) {
  const local = loadLocalContextDocs(jobId, docNames, maxCharsPerDoc);
  if (memoryModeWithFallback() !== "goc") return local;

  try {
    const map = await ensureJobThread(requireGocClient(), {
      jobId,
      jobDir: runDir(jobId),
      title: `job:${jobId}`,
    });
    const compiled = await requireGocClient().getCompiledContext(map.ctxSharedId);
    const latest = String(compiled || "").trim();
    if (!latest) {
      gocFallbackByJob.set(String(jobId), "empty compiled_text");
      return local;
    }
    gocFallbackByJob.delete(String(jobId));
    return [
      "### GOC ACTIVE CONTEXT",
      clip(latest, 12000),
      "",
      "### LOCAL TRACKING SNAPSHOT",
      local,
    ].join("\n\n");
  } catch (e) {
    const reason = String(e?.message ?? e);
    gocFallbackByJob.set(String(jobId), reason);
    jobs.log(jobId, `GoC compiled context failed; fallback to local: ${reason}`);
    return local;
  }
}

async function appendChatMessageToGoc(jobId, {
  role = "user",
  text = "",
  kind = "chat_message",
  chatId = "",
  userId = "",
  replyTo = "",
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanText = String(text || "").trim();
  if (!cleanJobId || !cleanText) return null;
  if (memoryModeWithFallback() !== "goc") return null;
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId: cleanJobId,
      jobDir: runDir(cleanJobId),
      title: `job:${cleanJobId}`,
    });
    return await client.addMessage(map.threadId, {
      role: String(role || "").trim().toLowerCase() || "user",
      text: cleanText,
      reply_to: String(replyTo || "").trim() || undefined,
      meta_json: {
        kind: String(kind || "chat_message").trim().toLowerCase(),
        job_id: cleanJobId,
        chat_id: String(chatId || "").trim() || undefined,
        user_id: String(userId || "").trim() || undefined,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    jobs.log(cleanJobId, `GoC message append skipped: ${String(e?.message ?? e)}`);
    return null;
  }
}

async function appendWorkspaceUploadArtifactToGoc(jobId, {
  fileName = "",
  fileSize = 0,
  localPath = "",
  uploadKind = "document",
  sha256 = "",
  telegramFileId = "",
  telegramMessageId = null,
  chatId = "",
  userId = "",
} = {}) {
  const cleanJobId = String(jobId || "").trim();
  const cleanPath = String(localPath || "").trim();
  if (!cleanJobId || !cleanPath) return null;
  if (memoryModeWithFallback() !== "goc") return null;
  try {
    const client = requireGocClient();
    const map = await ensureJobThread(client, {
      jobId: cleanJobId,
      jobDir: runDir(cleanJobId),
      title: `job:${cleanJobId}`,
    });
    const relPath = path.relative(runWorkspaceDir(cleanJobId), cleanPath);
    const safeRelPath = relPath && !relPath.startsWith("..") ? relPath : path.basename(cleanPath);
    return await client.createResource(map.threadId, {
      name: `upload:${String(fileName || "file").slice(0, 80)}@${new Date().toISOString()}`,
      summary: `telegram upload ${fileName || path.basename(cleanPath)}`,
      text_mode: "plain",
      raw_text: [
        "telegram upload",
        `job_id: ${cleanJobId}`,
        `kind: ${String(uploadKind || "document")}`,
        `filename: ${fileName || path.basename(cleanPath)}`,
        `size: ${Number(fileSize || 0)}`,
        `sha256: ${String(sha256 || "")}`,
        `local_path: ${cleanPath}`,
      ].join("\n") + "\n",
      resource_kind: "artifact",
      uri: `ddalggak://jobs/${cleanJobId}/workspace/${safeRelPath}`,
      context_set_id: map.ctxSharedId,
      auto_activate: false,
      payload_json: {
        kind: "telegram_upload",
        job_id: cleanJobId,
        upload_kind: String(uploadKind || "document"),
        file_name: fileName || path.basename(cleanPath),
        file_size: Number(fileSize || 0),
        sha256: String(sha256 || "").trim() || undefined,
        local_path: cleanPath,
        local_workspace_path: safeRelPath,
        telegram_file_id: String(telegramFileId || "").trim() || undefined,
        telegram_message_id: Number.isFinite(Number(telegramMessageId)) ? Number(telegramMessageId) : undefined,
        chat_id: String(chatId || "").trim() || undefined,
        user_id: String(userId || "").trim() || undefined,
        ts: new Date().toISOString(),
      },
    });
  } catch (e) {
    jobs.log(cleanJobId, `GoC upload artifact append skipped: ${String(e?.message ?? e)}`);
    return null;
  }
}

function listWorkspaceFilesRecursive(rootDir) {
  const out = [];
  const stack = [String(rootDir || "")];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry?.name || "").trim();
      if (!name || name === "." || name === "..") continue;
      if (name.startsWith(".telegram_")) continue;
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

function normalizeWorkspaceScope(raw = "") {
  const scope = String(raw || "").trim().toLowerCase();
  if (scope === "uploads" || scope === "outputs" || scope === "all") return scope;
  return "all";
}

function collectWorkspaceFileEntries(jobId, { scope = "all" } = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const normalizedScope = normalizeWorkspaceScope(scope);
  const targets = [];
  if (normalizedScope === "all" || normalizedScope === "uploads") {
    targets.push({ bucket: "uploads", dir: resolveWorkspacePath(cleanJobId, "uploads", { asDirectory: true }) });
  }
  if (normalizedScope === "all" || normalizedScope === "outputs") {
    targets.push({ bucket: "outputs", dir: resolveWorkspacePath(cleanJobId, "outputs", { asDirectory: true }) });
  }

  const out = [];
  for (const target of targets) {
    const files = listWorkspaceFilesRecursive(target.dir);
    for (const abs of files) {
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) continue;
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
      out.push({
        bucket: target.bucket,
        abs,
        rel,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    }
  }
  out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  return out;
}

function formatWorkspaceFileListText(jobId, entries = [], { scope = "all", limit = 20 } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const normalizedScope = normalizeWorkspaceScope(scope);
  const lines = [
    `job_id=${cleanJobId}`,
    `scope=${normalizedScope}`,
    `limit=${limit}`,
  ];
  if (!Array.isArray(entries) || entries.length === 0) {
    lines.push("- (no files)");
    return lines.join("\n");
  }
  for (const row of entries) {
    lines.push(`- ${row.rel} (${formatByteSize(row.size)}, mtime=${formatFileMtime(row.mtimeMs)})`);
  }
  return lines.join("\n");
}

function buildWorkspaceFilesPromptSection(jobId, { limitPerBucket = 5 } = {}) {
  const limit = Number.isFinite(Number(limitPerBucket))
    ? Math.max(1, Math.min(20, Math.floor(Number(limitPerBucket))))
    : 5;
  const uploads = collectWorkspaceFileEntries(jobId, { scope: "uploads" }).slice(0, limit);
  const outputs = collectWorkspaceFileEntries(jobId, { scope: "outputs" }).slice(0, limit);
  const render = (rows) => (
    rows.length > 0
      ? rows.map((row) => `- ${row.rel} (${formatByteSize(row.size)})`).join("\n")
      : "- (none)"
  );
  return [
    "workspace 파일 목록(최근):",
    "uploads:",
    render(uploads),
    "outputs:",
    render(outputs),
    "지시:",
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "- 매우 큰 파일은 목록만 참고하고 필요한 부분만 선택해 사용해라.",
  ].join("\n");
}

async function maybeAutoSendOutputs(bot, chatId, jobId, {
  when = "step",
  replyToMessageId = null,
} = {}) {
  if (!OUTPUT_AUTO_SEND) return;
  if (String(when || "").trim().toLowerCase() !== OUTPUT_AUTO_SEND_ON) return;
  await deliverWorkspaceOutputs(bot, chatId, jobId, {
    replyToMessageId,
    maxFiles: OUTPUT_AUTO_SEND_MAX_FILES,
  }).catch(() => null);
}

async function sendWorkspaceFileByRelativePath(bot, chatId, jobId, relativePath, { replyToMessageId = null } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const requested = String(relativePath || "").trim();
  if (!cleanJobId || !requested) {
    throw new Error("jobId and relative path are required");
  }
  const abs = jobs.resolveWorkspacePath(cleanJobId, requested);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw new Error(`file not found: ${requested}`);
  }
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
  if (!rel || rel.startsWith("..")) {
    throw new Error("Path outside workspace");
  }
  if (!(rel.startsWith("uploads/") || rel.startsWith("outputs/"))) {
    throw new Error("only uploads/ or outputs/ paths are allowed");
  }
  if (Number(stat.size || 0) > TELEGRAM_SEND_MAX_BYTES) {
    throw new Error(
      `file is too large for sendDocument (limit=${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}, size=${formatByteSize(stat.size)})`
    );
  }
  await bot.sendDocument(
    chatId,
    abs,
    {
      caption: `📄 file\njob_id=${cleanJobId}\npath=${rel}`,
      reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
        ? Number(replyToMessageId)
        : undefined,
    }
  );
  return {
    abs,
    rel,
    size: Number(stat.size || 0),
  };
}

async function deliverWorkspaceOutputs(bot, chatId, jobId, { replyToMessageId = null, maxFiles = 4 } = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return;
  const sentIndexPath = resolveWorkspacePath(cleanJobId, "outputs/.telegram_sent.json");
  let sent = {};
  try {
    sent = JSON.parse(fs.readFileSync(sentIndexPath, "utf8"));
  } catch {
    sent = {};
  }

  const candidates = collectWorkspaceFileEntries(cleanJobId, { scope: "outputs" })
    .map((row) => ({
      ...row,
      key: `${row.rel}:${row.size}:${row.mtimeMs}`,
    }));

  const limit = Number.isFinite(Number(maxFiles))
    ? Math.max(1, Math.min(10, Math.floor(Number(maxFiles))))
    : 4;
  let sentCount = 0;
  for (const file of candidates) {
    if (sentCount >= limit) break;
    if (sent[file.key]) continue;
    if (Number(file.size || 0) <= 0) continue;
    if (Number(file.size || 0) > TELEGRAM_SEND_MAX_BYTES) {
      await bot.sendMessage(
        chatId,
        `📦 output 생성됨(sendDocument 한도 초과로 전송 생략)\njob_id=${cleanJobId}\npath=${file.rel}\nsize=${file.size}`,
        Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
          ? { reply_to_message_id: Number(replyToMessageId) }
          : undefined
      );
      sent[file.key] = { ts: new Date().toISOString(), path: file.rel, skipped: "too_large" };
      sentCount += 1;
      continue;
    }
    await bot.sendDocument(
      chatId,
      file.abs,
      {
        caption: `📦 output file\njob_id=${cleanJobId}\npath=${file.rel}`,
        reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
          ? Number(replyToMessageId)
          : undefined,
      }
    );
    sent[file.key] = { ts: new Date().toISOString(), path: file.rel, sent: true };
    sentCount += 1;
  }
  try {
    fs.writeFileSync(sentIndexPath, `${JSON.stringify(sent, null, 2)}\n`, "utf8");
  } catch {}
}

function convoToText(convo) {
  if (!convo || convo.length === 0) return "(none)";
  return convo.map(r => `- ${r.role}: ${r.text}`).join("\n");
}

async function sendLong(bot, chatId, text) {
  return sendLongAdapter(bot, chatId, text);
}

function ensureCommandOk(name, result) {
  if (result?.ok) return;
  const exitCode = Number.isInteger(result?.exitCode) ? result.exitCode : -1;
  const details = clip(String(result?.stderr || result?.stdout || "(no output)"), 1500);
  throw new Error(`${name} failed (exit=${exitCode})\n${details}`);
}

export {
  buildContextInfo,
  sendContextInfo,
  loadContextDocs,
  appendChatMessageToGoc,
  appendWorkspaceUploadArtifactToGoc,
  collectWorkspaceFileEntries,
  formatWorkspaceFileListText,
  buildWorkspaceFilesPromptSection,
  maybeAutoSendOutputs,
  sendWorkspaceFileByRelativePath,
  deliverWorkspaceOutputs,
  convoToText,
  sendLong,
  ensureCommandOk,
};

