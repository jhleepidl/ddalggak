import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
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

const ARTIFACT_INDEX_FILE = "artifact_index.json";
const WORKSPACE_FILE_SKIP_DIRS = new Set(["uploads", "outputs", ".git", "node_modules", ".codex", ".gemini"]);

function listWorkspaceFilesRecursive(rootDir, { skipDirNames = null, includeHiddenFiles = false } = {}) {
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
      if (!includeHiddenFiles && name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        if (skipDirNames && skipDirNames.has(name)) continue;
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
  if (scope === "uploads" || scope === "workspace" || scope === "all") return scope;
  if (scope === "artifacts" || scope === "outputs") return "workspace";
  return "all";
}

function collectWorkspaceFileEntries(jobId, { scope = "all" } = {}) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return [];
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const normalizedScope = normalizeWorkspaceScope(scope);
  const targets = [];
  if (normalizedScope === "all" || normalizedScope === "uploads") {
    targets.push({
      bucket: "uploads",
      dir: resolveWorkspacePath(cleanJobId, "uploads", { asDirectory: true }),
      skipDirNames: null,
      includeHiddenFiles: false,
    });
  }
  if (normalizedScope === "all" || normalizedScope === "workspace") {
    targets.push({
      bucket: "workspace",
      dir: workspaceRoot,
      skipDirNames: WORKSPACE_FILE_SKIP_DIRS,
      includeHiddenFiles: false,
    });
  }

  const out = [];
  for (const target of targets) {
    const files = listWorkspaceFilesRecursive(target.dir, {
      skipDirNames: target.skipDirNames,
      includeHiddenFiles: target.includeHiddenFiles,
    });
    for (const abs of files) {
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) continue;
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) continue;
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
  const workspaceFiles = collectWorkspaceFileEntries(jobId, { scope: "workspace" }).slice(0, limit);
  const render = (rows) => (
    rows.length > 0
      ? rows.map((row) => `- ${row.rel} (${formatByteSize(row.size)})`).join("\n")
      : "- (none)"
  );
  return [
    "workspace 파일 목록(최근):",
    "uploads:",
    render(uploads),
    "workspace artifacts:",
    render(workspaceFiles),
    "지시:",
    "- 필요하면 uploads/ 경로의 파일 내용을 참고해라.",
    "- 최종 산출물은 원래 workspace 경로에 유지된다. outputs/ 복사본을 만들지 마라.",
    "- 매우 큰 파일은 목록만 참고하고 필요한 부분만 선택해 사용해라.",
  ].join("\n");
}

function artifactIndexPath(jobId) {
  return path.join(runDir(jobId), ARTIFACT_INDEX_FILE);
}

function loadArtifactIndex(jobId) {
  const cleanJobId = String(jobId || "").trim();
  if (!cleanJobId) return { job_id: "", updated_at: new Date().toISOString(), artifacts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactIndexPath(cleanJobId), 'utf8'));
    const artifacts = Array.isArray(parsed?.artifacts)
      ? parsed.artifacts.map((row) => ({
        id: String(row?.id || '').trim(),
        path: String(row?.path || '').trim(),
        label: String(row?.label || '').trim(),
        kind: String(row?.kind || '').trim(),
        source: String(row?.source || '').trim(),
        size: Number(row?.size || 0),
        mtime_ms: Number(row?.mtime_ms || row?.mtimeMs || 0),
        sendable: row?.sendable !== false,
        final: row?.final !== false,
      })).filter((row) => row.path)
      : [];
    return {
      job_id: String(parsed?.job_id || cleanJobId).trim() || cleanJobId,
      updated_at: String(parsed?.updated_at || new Date().toISOString()),
      artifacts,
    };
  } catch {
    return { job_id: cleanJobId, updated_at: new Date().toISOString(), artifacts: [] };
  }
}

function inferArtifactKind(relPath = "") {
  const ext = path.extname(String(relPath || '').trim()).toLowerCase();
  if ([".md", ".txt", ".pdf", ".doc", ".docx"].includes(ext)) return 'document';
  if ([".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".rb", ".php", ".c", ".cpp", ".h", ".hpp", ".json", ".yaml", ".yml", ".toml", ".ini", ".sh", ".sql"].includes(ext)) return 'code';
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].includes(ext)) return 'image';
  if ([".csv", ".tsv", ".xlsx", ".parquet", ".ipynb"].includes(ext)) return 'data';
  if ([".zip", ".tar", ".gz", ".tgz"].includes(ext)) return 'archive';
  return 'file';
}

function collectExecutionArtifactPathCandidates(execution = null) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(execution?.outputs) ? execution.outputs : []) {
    const item = row && typeof row === 'object' ? row : {};
    const rel = String(item.relativePath || item.relative_path || item.path || item.artifact_path || item.artifactPath || '').trim();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= 16) break;
  }
  return out;
}

function buildArtifactIndexEntries(jobId, { execution = null, maxFiles = 12 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const executionRefs = collectExecutionArtifactPathCandidates(execution);
  const workspaceFiles = collectWorkspaceFileEntries(cleanJobId, { scope: 'workspace' });
  const fileMetaByRel = new Map(workspaceFiles.map((row) => [row.rel, row]));
  const out = [];
  const seen = new Set();

  const pushEntry = (rel, source = 'workspace_recent', final = false) => {
    const cleanRel = String(rel || '').trim().replace(/\\/g, '/').replace(/^workspace\//i, '').replace(/^\.\//, '');
    if (!cleanRel || cleanRel.startsWith('uploads/') || cleanRel.startsWith('outputs/')) return;
    if (seen.has(cleanRel)) return;
    let meta = fileMetaByRel.get(cleanRel) || null;
    if (!meta) {
      let abs = null;
      try {
        abs = jobs.resolveWorkspacePath(cleanJobId, cleanRel);
      } catch {
        abs = null;
      }
      if (!abs) return;
      let stat = null;
      try { stat = fs.statSync(abs); } catch { stat = null; }
      if (!stat || !stat.isFile()) return;
      meta = {
        abs,
        rel: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      };
    }
    if (!meta.rel || meta.rel.startsWith('.') || meta.rel.includes('/.')) return;
    seen.add(meta.rel);
    out.push({
      id: `artifact_${out.length + 1}`,
      path: meta.rel,
      label: path.basename(meta.rel),
      kind: inferArtifactKind(meta.rel),
      source,
      size: Number(meta.size || 0),
      mtime_ms: Number(meta.mtimeMs || 0),
      sendable: Number(meta.size || 0) <= TELEGRAM_SEND_MAX_BYTES,
      final,
    });
  };

  for (const rel of executionRefs) pushEntry(rel, 'execution_ref', true);
  for (const row of workspaceFiles) pushEntry(row.rel, 'workspace_recent', out.length < 3);

  return out.slice(0, Math.max(1, Math.min(24, Math.floor(Number(maxFiles) || 12))));
}

function refreshArtifactIndex(jobId, { execution = null, maxFiles = 12 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return { job_id: '', updated_at: new Date().toISOString(), artifacts: [] };
  const artifactIndex = {
    job_id: cleanJobId,
    updated_at: new Date().toISOString(),
    artifacts: buildArtifactIndexEntries(cleanJobId, { execution, maxFiles }),
  };
  try {
    fs.writeFileSync(artifactIndexPath(cleanJobId), `${JSON.stringify(artifactIndex, null, 2)}\n`, 'utf8');
  } catch {}
  return artifactIndex;
}

function formatArtifactIndexText(jobId, artifactIndex = null, { limit = 8 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const normalized = artifactIndex && typeof artifactIndex === 'object'
    ? artifactIndex
    : loadArtifactIndex(cleanJobId);
  const rows = Array.isArray(normalized?.artifacts) ? normalized.artifacts.slice(0, Math.max(1, Math.min(24, Math.floor(Number(limit) || 8)))) : [];
  const lines = [
    `job_id=${cleanJobId}`,
    `count=${rows.length}`,
    `updated_at=${String(normalized?.updated_at || '')}`,
  ];
  if (rows.length === 0) {
    lines.push('- (artifacts not detected yet)');
    return lines.join('\n');
  }
  rows.forEach((row, index) => {
    const flags = [];
    if (row.final) flags.push('final');
    if (!row.sendable) flags.push('too_large');
    if (row.kind) flags.push(row.kind);
    lines.push(`${index + 1}. ${row.path} (${formatByteSize(row.size || 0)}${flags.length > 0 ? `, ${flags.join(', ')}` : ''})`);
  });
  return lines.join('\n');
}

async function maybeSendArtifactSummary(bot, chatId, jobId, { execution = null, replyToMessageId = null, maxFiles = 5 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return null;
  const artifactIndex = refreshArtifactIndex(cleanJobId, { execution, maxFiles: Math.max(3, maxFiles) });
  const rows = Array.isArray(artifactIndex.artifacts) ? artifactIndex.artifacts.slice(0, Math.max(1, Math.min(8, Math.floor(Number(maxFiles) || 5)))) : [];
  if (rows.length === 0) return artifactIndex;
  const lines = [
    '📎 주요 산출물 후보',
    `job_id=${cleanJobId}`,
    ...rows.map((row, index) => `${index + 1}. ${row.path} (${formatByteSize(row.size || 0)}${row.sendable ? '' : ', too_large'})`),
    '',
    `예: /send 1 또는 /send ${rows[0]?.path || 'path/to/file'}`,
    '여러 파일은 /send bundle 1,2,3 처럼 zip으로 받을 수 있어요.',
    '파일을 받으려면 /send <번호|path> 또는 /send bundle <번호,번호|path,...> 를 사용하세요.',
  ];
  await bot.sendMessage(
    chatId,
    lines.join('\n'),
    Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
      ? { reply_to_message_id: Number(replyToMessageId) }
      : undefined
  );
  return artifactIndex;
}

async function maybeAutoSendOutputs() {
  return null;
}

async function sendWorkspaceFileByRelativePath(bot, chatId, jobId, relativePath, { replyToMessageId = null } = {}) {
  const cleanJobId = String(jobId || "").trim();
  const requested = String(relativePath || "").trim().replace(/^workspace\//i, '').replace(/^\.\//, '');
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
  if (rel.startsWith('.') || rel.includes('/.telegram_')) {
    throw new Error('internal workspace metadata cannot be sent');
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


function parseArtifactBundleSelection(rawSelection = "") {
  const raw = String(rawSelection || '').trim();
  if (!raw) return null;
  const bundleMatch = raw.match(/^bundle(?:\s+|:)(.+)$/i);
  if (!bundleMatch) return null;
  const body = String(bundleMatch[1] || '').trim();
  if (!body) return { mode: 'bundle', items: [] };
  const items = body
    .split(/[\s,]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return { mode: 'bundle', items };
}

function findPythonForBundling() {
  const candidates = [process.env.DDALGGAK_PYTHON_BIN, process.env.PYTHON, 'python3', 'python']
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && Number(probe.status || 0) === 0) return candidate;
  }
  return '';
}

function buildBundleFileName(jobId = '', entries = []) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const cleanJobId = String(jobId || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'job';
  const rootName = String(entries?.[0]?.arc || 'bundle').split('/').filter(Boolean).pop() || 'bundle';
  const stem = rootName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'bundle';
  return `artifact_bundle_${cleanJobId}_${stem}_${stamp}.zip`;
}

function createArtifactBundle(jobId, selections, { artifactIndex = null } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const items = Array.isArray(selections) ? selections.map((row) => String(row || '').trim()).filter(Boolean) : [];
  if (!cleanJobId) throw new Error('jobId is required');
  if (items.length === 0) throw new Error('bundle selection is empty');
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const seen = new Set();
  const entries = [];
  for (const selection of items) {
    const rel = resolveArtifactSelection(cleanJobId, selection, { artifactIndex });
    const abs = jobs.resolveWorkspacePath(cleanJobId, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) throw new Error(`file not found: ${rel}`);
    const normalizedRel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
    if (!normalizedRel || normalizedRel.startsWith('..')) throw new Error('Path outside workspace');
    if (normalizedRel.startsWith('.') || normalizedRel.includes('/.telegram_')) throw new Error('internal workspace metadata cannot be bundled');
    if (seen.has(normalizedRel)) continue;
    seen.add(normalizedRel);
    entries.push({ src: abs, arc: normalizedRel, size: Number(stat.size || 0) });
  }
  if (entries.length === 0) throw new Error('bundle selection is empty');
  const pythonBin = findPythonForBundling();
  if (!pythonBin) throw new Error('python runtime not found for zip bundle creation');
  const bundleDir = path.join(os.tmpdir(), 'ddalggak-telegram-bundles');
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, buildBundleFileName(cleanJobId, entries));
  const payload = JSON.stringify(entries.map((entry) => ({ src: entry.src, arc: entry.arc })));
  const script = 'import json,sys,zipfile; out=sys.argv[1]; entries=json.loads(sys.argv[2]); z=zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED); [z.write(e["src"], e["arc"]) for e in entries]; z.close()';
  const result = spawnSync(pythonBin, ['-c', script, bundlePath, payload], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error || Number(result.status || 0) !== 0) {
    const details = String(result.error?.message || result.stderr || result.stdout || '').trim();
    throw new Error(`bundle creation failed${details ? `: ${details}` : ''}`);
  }
  const stat = fs.statSync(bundlePath);
  return {
    bundlePath,
    fileName: path.basename(bundlePath),
    size: Number(stat.size || 0),
    entries,
  };
}

async function sendArtifactBundle(bot, chatId, jobId, selections, { replyToMessageId = null, artifactIndex = null } = {}) {
  const bundle = createArtifactBundle(jobId, selections, { artifactIndex });
  if (bundle.size > TELEGRAM_SEND_MAX_BYTES) {
    throw new Error(`bundle is too large for sendDocument (limit=${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}, size=${formatByteSize(bundle.size)})`);
  }
  await bot.sendDocument(chatId, bundle.bundlePath, {
    caption: `📦 artifact bundle\njob_id=${String(jobId || '').trim()}\nfiles=${bundle.entries.length}\nname=${bundle.fileName}`,
    filename: bundle.fileName,
    reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0 ? Number(replyToMessageId) : undefined,
  });
  return bundle;
}

function resolveArtifactSelection(jobId, selection, { artifactIndex = null } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const requested = String(selection || '').trim().replace(/^workspace\//i, '').replace(/^\.\//, '');
  if (!cleanJobId || !requested) throw new Error('jobId and selection are required');
  if (/^\d+$/.test(requested)) {
    const index = artifactIndex && typeof artifactIndex === 'object' ? artifactIndex : loadArtifactIndex(cleanJobId);
    const rows = Array.isArray(index?.artifacts) ? index.artifacts : [];
    const artifact = rows[Number(requested) - 1];
    if (!artifact?.path) throw new Error(`artifact index ${requested} not found`);
    return artifact.path;
  }
  return requested;
}

async function sendArtifactBySelection(bot, chatId, jobId, selection, { replyToMessageId = null, artifactIndex = null } = {}) {
  const rel = resolveArtifactSelection(jobId, selection, { artifactIndex });
  const sent = await sendWorkspaceFileByRelativePath(bot, chatId, jobId, rel, { replyToMessageId });
  return { ...sent, requested: String(selection || '').trim() };
}

async function deliverWorkspaceOutputs(bot, chatId, jobId, { replyToMessageId = null, maxFiles = 4 } = {}) {
  const artifactIndex = refreshArtifactIndex(jobId, { maxFiles });
  const rows = Array.isArray(artifactIndex.artifacts) ? artifactIndex.artifacts.slice(0, Math.max(1, Math.min(10, Math.floor(Number(maxFiles) || 4)))) : [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index]?.sendable) continue;
    await sendArtifactBySelection(bot, chatId, jobId, String(index + 1), { replyToMessageId, artifactIndex });
  }
  return artifactIndex;
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
  maybeSendArtifactSummary,
  loadArtifactIndex,
  refreshArtifactIndex,
  formatArtifactIndexText,
  sendArtifactBySelection,
  sendArtifactBundle,
  sendWorkspaceFileByRelativePath,
  deliverWorkspaceOutputs,
  parseArtifactBundleSelection,
  convoToText,
  sendLong,
  ensureCommandOk,
};

