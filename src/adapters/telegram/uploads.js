import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_UPLOAD_MAX_BYTES = 20 * BYTES_PER_MB;

function replyToMessageOptions(msg = {}) {
  return Number.isFinite(Number(msg?.message_id))
    ? { reply_to_message_id: Number(msg.message_id) }
    : undefined;
}

export function sanitizeWorkspaceFileName(rawName = "", { fallback = "file" } = {}) {
  const source = String(rawName || "").trim();
  const base = source ? path.basename(source) : fallback;
  const safe = base
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 120);
  return safe || fallback;
}

export function formatByteSize(bytes = 0) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "0B";
  if (value < 1024) return `${Math.floor(value)}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)}MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function extensionFromMimeType(rawMime = "", fallbackExt = ".bin") {
  const mime = String(rawMime || "").trim().toLowerCase();
  if (!mime) return fallbackExt;
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("png")) return ".png";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("pdf")) return ".pdf";
  if (mime.includes("json")) return ".json";
  if (mime.includes("csv")) return ".csv";
  if (mime.includes("markdown")) return ".md";
  if (mime.includes("plain")) return ".txt";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("quicktime")) return ".mov";
  if (mime.includes("mpeg")) return ".mp3";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("wav")) return ".wav";
  return fallbackExt;
}

export function resolveTelegramUploadCandidate(msg = {}) {
  const messageId = Number.isFinite(Number(msg?.message_id)) ? Number(msg.message_id) : 0;
  const stamp = Date.now().toString(36);

  const document = msg?.document && typeof msg.document === "object" ? msg.document : null;
  if (document?.file_id) {
    const fallbackExt = extensionFromMimeType(document.mime_type, ".bin");
    const fallback = `document_${stamp}_${messageId}${fallbackExt}`;
    return {
      kind: "document",
      fileId: String(document.file_id || "").trim(),
      fileUniqueId: String(document.file_unique_id || "").trim(),
      fileSize: Number(document.file_size || 0),
      fileName: String(document.file_name || fallback).trim(),
    };
  }

  const photos = Array.isArray(msg?.photo) ? msg.photo.filter((row) => row?.file_id) : [];
  if (photos.length > 0) {
    const best = photos.reduce((acc, row) => {
      if (!acc) return row;
      const currentSize = Number(acc?.file_size || 0);
      const nextSize = Number(row?.file_size || 0);
      if (nextSize !== currentSize) return nextSize > currentSize ? row : acc;
      const currentPixels = Number(acc?.width || 0) * Number(acc?.height || 0);
      const nextPixels = Number(row?.width || 0) * Number(row?.height || 0);
      return nextPixels > currentPixels ? row : acc;
    }, photos[0] || null);
    if (best?.file_id) {
      return {
        kind: "photo",
        fileId: String(best.file_id || "").trim(),
        fileUniqueId: String(best.file_unique_id || "").trim(),
        fileSize: Number(best.file_size || 0),
        fileName: `photo_${stamp}_${messageId}.jpg`,
      };
    }
  }

  const video = msg?.video && typeof msg.video === "object" ? msg.video : null;
  if (video?.file_id) {
    const ext = path.extname(String(video.file_name || "").trim()) || extensionFromMimeType(video.mime_type, ".mp4");
    return {
      kind: "video",
      fileId: String(video.file_id || "").trim(),
      fileUniqueId: String(video.file_unique_id || "").trim(),
      fileSize: Number(video.file_size || 0),
      fileName: String(video.file_name || `video_${stamp}_${messageId}${ext}`).trim(),
    };
  }

  const audio = msg?.audio && typeof msg.audio === "object" ? msg.audio : null;
  if (audio?.file_id) {
    const ext = path.extname(String(audio.file_name || "").trim()) || extensionFromMimeType(audio.mime_type, ".mp3");
    return {
      kind: "audio",
      fileId: String(audio.file_id || "").trim(),
      fileUniqueId: String(audio.file_unique_id || "").trim(),
      fileSize: Number(audio.file_size || 0),
      fileName: String(audio.file_name || `audio_${stamp}_${messageId}${ext}`).trim(),
    };
  }

  const voice = msg?.voice && typeof msg.voice === "object" ? msg.voice : null;
  if (voice?.file_id) {
    return {
      kind: "voice",
      fileId: String(voice.file_id || "").trim(),
      fileUniqueId: String(voice.file_unique_id || "").trim(),
      fileSize: Number(voice.file_size || 0),
      fileName: `voice_${stamp}_${messageId}.ogg`,
    };
  }

  return null;
}

export function hasTelegramUploadAttachment(msg = {}) {
  return !!resolveTelegramUploadCandidate(msg);
}

export function createTelegramUploadService(deps = {}) {
  const {
    bot,
    maxBytes = DEFAULT_UPLOAD_MAX_BYTES,
    allowedExts = [],
    resolveLiveJobIdForChat,
    createJob,
    rememberLastChatJob,
    chatSessionStore,
    resolveWorkspacePath,
    runWorkspaceDir,
    jobs,
    tracking,
    appendWorkspaceUploadArtifactToGoc = async () => null,
  } = deps;
  const allowedExtSet = new Set(
    (Array.isArray(allowedExts) ? allowedExts : [])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
      .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`))
  );

  function isUploadExtAllowed(fileName = "") {
    if (allowedExtSet.size === 0) return true;
    const ext = String(path.extname(String(fileName || "")).trim().toLowerCase() || "");
    if (!ext) return false;
    return allowedExtSet.has(ext);
  }

  function uploadAllowedExtsText() {
    if (allowedExtSet.size === 0) return "(all)";
    return [...allowedExtSet].join(", ");
  }

  function computeFileSha256(filePath = "") {
    const cleanPath = String(filePath || "").trim();
    if (!cleanPath) return "";
    const hash = crypto.createHash("sha256");
    hash.update(fs.readFileSync(cleanPath));
    return hash.digest("hex");
  }

  async function saveMessageAttachment(msg, { chatId = "", userId = "" } = {}) {
    const candidate = resolveTelegramUploadCandidate(msg);
    if (!candidate) return null;

    const cleanKind = String(candidate.kind || "document").trim().toLowerCase() || "document";
    const cleanSize = Number(candidate.fileSize || 0);
    if (cleanSize > maxBytes) {
      await bot.sendMessage(
        chatId,
        [
          `❌ 파일이 20MB를 초과해 표준 Bot API로 다운로드할 수 없어요. (설정 한도: ${formatByteSize(maxBytes)})`,
          "대안: (1) 링크로 공유 (2) 외부 스토리지 업로드 (3) 로컬 Telegram Bot API 서버 사용",
        ].join("\n"),
        replyToMessageOptions(msg)
      );
      return {
        skipped: true,
        reason: "download_limit_exceeded",
      };
    }

    const cleanName = sanitizeWorkspaceFileName(candidate.fileName || `${cleanKind}.bin`, {
      fallback: `${cleanKind}.bin`,
    });
    if (!isUploadExtAllowed(cleanName)) {
      await bot.sendMessage(
        chatId,
        [
          "❌ 업로드 확장자가 허용 목록에 없습니다.",
          `- file: ${cleanName}`,
          `- allowed: ${uploadAllowedExtsText()}`,
        ].join("\n"),
        replyToMessageOptions(msg)
      );
      return {
        skipped: true,
        reason: "extension_not_allowed",
      };
    }

    let jobId = String(resolveLiveJobIdForChat(chatId) || "").trim();
    let createdJob = false;
    if (!jobId) {
      const seededJob = await createJob(`uploaded file: ${cleanName}`, {
        ownerUserId: userId,
        ownerChatId: chatId,
      });
      jobId = String(seededJob?.jobId || "").trim();
      createdJob = true;
      rememberLastChatJob(chatId, jobId);
      chatSessionStore.upsert(chatId, {
        jobId,
        state: "idle",
      });
    }
    if (!jobId) throw new Error("Failed to resolve jobId for file upload");

    const uploadsDir = resolveWorkspacePath(jobId, "uploads", { asDirectory: true });
    const downloadedPath = await bot.downloadFile(candidate.fileId, uploadsDir);
    const stamp = Date.now().toString(36);
    const messageId = Number.isFinite(Number(msg?.message_id)) ? Number(msg.message_id) : 0;
    const finalName = sanitizeWorkspaceFileName(`${stamp}_${messageId}_${cleanName}`, {
      fallback: `${cleanKind}_${stamp}.bin`,
    });
    const finalPath = resolveWorkspacePath(jobId, path.join("uploads", finalName));
    if (path.resolve(downloadedPath) !== path.resolve(finalPath)) {
      fs.renameSync(downloadedPath, finalPath);
    }

    const fileStat = fs.statSync(finalPath);
    const actualSize = Number(fileStat?.size || cleanSize || 0);
    const sha256 = computeFileSha256(finalPath);
    const manifestPath = resolveWorkspacePath(jobId, "uploads/manifest.jsonl");
    const workspaceRelPath = path.relative(runWorkspaceDir(jobId), finalPath).replace(/\\/g, "/");
    const record = {
      ts: new Date().toISOString(),
      kind: `telegram_${cleanKind}_upload`,
      upload_kind: cleanKind,
      job_id: jobId,
      chat_id: String(chatId || ""),
      user_id: String(userId || ""),
      message_id: messageId,
      file_id: candidate.fileId,
      file_unique_id: String(candidate.fileUniqueId || "").trim(),
      filename: cleanName,
      size: actualSize,
      sha256,
      local_path: finalPath,
      workspace_path: workspaceRelPath,
    };
    fs.appendFileSync(manifestPath, `${JSON.stringify(record)}\n`, "utf8");

    jobs.appendConversation(jobId, "user", `uploaded file: ${cleanName}`, {
      kind: `upload_${cleanKind}`,
      telegram_message_id: messageId || undefined,
      local_path: finalPath,
      sha256,
    });
    tracking.append(jobId, "progress.md", [
      "## upload",
      `- kind: ${cleanKind}`,
      `- filename: ${cleanName}`,
      `- size: ${actualSize}`,
      `- sha256: ${sha256}`,
      `- workspace_path: ${workspaceRelPath}`,
      `- file_id: ${candidate.fileId}`,
    ].join("\n"));
    await appendWorkspaceUploadArtifactToGoc(jobId, {
      fileName: cleanName,
      fileSize: actualSize,
      localPath: finalPath,
      uploadKind: cleanKind,
      sha256,
      telegramFileId: candidate.fileId,
      telegramMessageId: messageId,
      chatId,
      userId,
    }).catch(() => null);

    await bot.sendMessage(
      chatId,
      [
        "📎 파일 업로드 저장 완료",
        `- kind: ${cleanKind}`,
        `- job_id: ${jobId}`,
        `- workspace: ${runWorkspaceDir(jobId)}`,
        `- path: ${workspaceRelPath}`,
        `- size: ${formatByteSize(actualSize)}`,
        createdJob ? "- note: 새 job 생성됨" : "",
      ].filter(Boolean).join("\n"),
      replyToMessageOptions(msg)
    );

    return {
      skipped: false,
      kind: cleanKind,
      jobId,
      finalPath,
      relPath: workspaceRelPath,
      sha256,
      createdJob,
    };
  }

  return {
    hasAttachment: hasTelegramUploadAttachment,
    isUploadExtAllowed,
    uploadAllowedExtsText,
    resolveCandidate: resolveTelegramUploadCandidate,
    saveMessageAttachment,
  };
}
