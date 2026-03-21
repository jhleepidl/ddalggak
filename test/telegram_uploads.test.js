import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  resolveTelegramUploadCandidate,
  createTelegramUploadService,
} from "../src/adapters/telegram/uploads.js";

function createWorkspaceHarness() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-telegram-uploads-"));
  const state = {
    conversations: [],
    tracking: [],
    sentMessages: [],
    rememberedJobs: [],
    sessionUpdates: [],
    gocArtifacts: [],
    createdJobs: [],
  };

  const jobsBase = path.join(tmpRoot, "runs");
  fs.mkdirSync(jobsBase, { recursive: true });

  function workspaceRoot(jobId) {
    const dir = path.join(jobsBase, jobId, "workspace");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  return {
    tmpRoot,
    state,
    deps: {
      bot: {
        async sendMessage(chatId, text, options) {
          state.sentMessages.push({ chatId, text, options });
          return { message_id: 7001 };
        },
        async downloadFile(fileId, uploadsDir) {
          assert.equal(fileId, "doc-file-id");
          fs.mkdirSync(uploadsDir, { recursive: true });
          const downloadedPath = path.join(uploadsDir, "download.tmp");
          fs.writeFileSync(downloadedPath, "uploaded content", "utf8");
          return downloadedPath;
        },
      },
      maxBytes: 2 * 1024 * 1024,
      allowedExts: [".txt", ".md"],
      resolveLiveJobIdForChat() {
        return "";
      },
      async createJob(goal, meta) {
        state.createdJobs.push({ goal, meta });
        workspaceRoot("job_upload_1");
        return { jobId: "job_upload_1" };
      },
      rememberLastChatJob(chatId, jobId) {
        state.rememberedJobs.push({ chatId, jobId });
      },
      chatSessionStore: {
        upsert(chatId, session) {
          state.sessionUpdates.push({ chatId, session });
        },
      },
      resolveWorkspacePath(jobId, userPath = ".", { asDirectory = false } = {}) {
        const root = workspaceRoot(jobId);
        const abs = path.join(root, userPath);
        if (asDirectory) {
          fs.mkdirSync(abs, { recursive: true });
          return abs;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        return abs;
      },
      runWorkspaceDir(jobId) {
        return workspaceRoot(jobId);
      },
      jobs: {
        appendConversation(jobId, role, text, meta) {
          state.conversations.push({ jobId, role, text, meta });
        },
      },
      tracking: {
        append(jobId, docName, text) {
          state.tracking.push({ jobId, docName, text });
        },
      },
      async appendWorkspaceUploadArtifactToGoc(jobId, payload) {
        state.gocArtifacts.push({ jobId, payload });
      },
    },
  };
}

test("resolveTelegramUploadCandidate prefers the largest photo variant", () => {
  const candidate = resolveTelegramUploadCandidate({
    message_id: 15,
    photo: [
      { file_id: "small", file_unique_id: "u1", file_size: 100, width: 20, height: 20 },
      { file_id: "large", file_unique_id: "u2", file_size: 500, width: 100, height: 80 },
    ],
  });

  assert.equal(candidate.kind, "photo");
  assert.equal(candidate.fileId, "large");
  assert.equal(candidate.fileUniqueId, "u2");
  assert.match(candidate.fileName, /^photo_/);
});

test("createTelegramUploadService stores Telegram uploads in the workspace and records artifacts", async () => {
  const harness = createWorkspaceHarness();
  const service = createTelegramUploadService(harness.deps);

  const result = await service.saveMessageAttachment({
    message_id: 33,
    document: {
      file_id: "doc-file-id",
      file_unique_id: "unique-doc",
      file_name: "notes.txt",
      file_size: 16,
    },
  }, {
    chatId: 9001,
    userId: 42,
    uploadNote: "spec v2 입력 샘플",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.createdJob, true);
  assert.equal(result.jobId, "job_upload_1");
  assert.equal(harness.state.createdJobs.length, 1);
  assert.deepEqual(harness.state.rememberedJobs, [{ chatId: 9001, jobId: "job_upload_1" }]);
  assert.equal(harness.state.sessionUpdates.length, 1);
  assert.equal(harness.state.conversations.length, 1);
  assert.equal(harness.state.tracking.length, 2);
  assert.deepEqual(harness.state.tracking.map((row) => row.docName), ["progress", "artifacts"]);
  assert.equal(harness.state.gocArtifacts.length, 1);
  assert.match(harness.state.sentMessages[0].text, /파일 업로드 저장 완료/);

  const manifestPath = path.join(harness.tmpRoot, "runs", "job_upload_1", "workspace", "uploads", "manifest.jsonl");
  const manifestLines = fs.readFileSync(manifestPath, "utf8").trim().split("\n");
  assert.equal(manifestLines.length, 1);
  const manifest = JSON.parse(manifestLines[0]);
  assert.equal(manifest.job_id, "job_upload_1");
  assert.equal(manifest.file_id, "doc-file-id");
  assert.equal(manifest.upload_note, "spec v2 입력 샘플");
  assert.match(manifest.workspace_path, /^uploads\//);
  assert.match(harness.state.sentMessages[0].text, /upload note: spec v2 입력 샘플/);
});

test("createTelegramUploadService rejects files outside the allowed extension list", async () => {
  const harness = createWorkspaceHarness();
  const service = createTelegramUploadService(harness.deps);

  const result = await service.saveMessageAttachment({
    message_id: 44,
    document: {
      file_id: "doc-file-id",
      file_unique_id: "unique-doc",
      file_name: "payload.exe",
      file_size: 16,
    },
  }, {
    chatId: 9001,
    userId: 42,
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, "extension_not_allowed");
  assert.equal(harness.state.createdJobs.length, 0);
  assert.match(harness.state.sentMessages[0].text, /허용 목록/);
});
