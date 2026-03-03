import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { resolveInside } from "./paths.js";

const WORKSPACE_SUBDIRS = ["uploads", "outputs", "tmp", ".gemini"];

function isInsideRoot(rootAbs, fullAbs) {
  const rootWithSep = rootAbs.endsWith(path.sep) ? rootAbs : `${rootAbs}${path.sep}`;
  return fullAbs === rootAbs || fullAbs.startsWith(rootWithSep);
}

export class Jobs {
  constructor() {
    const base = process.env.RUNS_DIR
      ? path.resolve(process.env.RUNS_DIR)
      : path.resolve("runs");
    this.baseDir = base;
    this.runsDir = base;
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  _workspaceDirByJobDir(jobDir) {
    return path.join(jobDir, "workspace");
  }

  _workspaceTaskPathByJobDir(jobDir) {
    return path.join(this._workspaceDirByJobDir(jobDir), "TASK.md");
  }

  _ensureWorkspaceTreeByJobDir(jobDir) {
    const workspaceDir = this._workspaceDirByJobDir(jobDir);
    fs.mkdirSync(workspaceDir, { recursive: true });
    for (const name of WORKSPACE_SUBDIRS) {
      fs.mkdirSync(path.join(workspaceDir, name), { recursive: true });
    }
    const taskPath = this._workspaceTaskPathByJobDir(jobDir);
    if (!fs.existsSync(taskPath)) {
      fs.writeFileSync(taskPath, [
        "# TASK",
        "",
        "- workspace-root only",
        "- use `uploads/`, `outputs/`, `tmp/`",
      ].join("\n") + "\n", "utf8");
    }
    return workspaceDir;
  }

  _assertNoSymlinkAlong(rootAbs, fullAbs) {
    const rel = path.relative(rootAbs, fullAbs);
    const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
    let current = rootAbs;
    if (fs.existsSync(current)) {
      const rootStat = fs.lstatSync(current);
      if (rootStat.isSymbolicLink()) {
        throw new Error("Workspace root symlink is not allowed");
      }
    }
    for (const part of parts) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) break;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlink path is not allowed: ${current}`);
      }
    }
  }

  _ensureDirNoSymlink(rootAbs, dirAbs) {
    if (!isInsideRoot(rootAbs, dirAbs)) {
      throw new Error(`Path escapes workspace: ${dirAbs}`);
    }
    const rel = path.relative(rootAbs, dirAbs);
    const parts = rel ? rel.split(path.sep).filter(Boolean) : [];
    let current = rootAbs;
    for (const part of parts) {
      current = path.join(current, part);
      if (fs.existsSync(current)) {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          throw new Error(`Symlink path is not allowed: ${current}`);
        }
        if (!stat.isDirectory()) {
          throw new Error(`Expected directory but found file: ${current}`);
        }
        continue;
      }
      fs.mkdirSync(current);
    }
  }

  createJob({ title, ownerUserId = null, ownerChatId = null }) {
    const jobId = crypto.randomUUID();
    const dir = path.join(this.runsDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });
    const workspaceDir = this._ensureWorkspaceTreeByJobDir(dir);

    const meta = {
      jobId,
      title,
      ownerUserId: ownerUserId == null ? null : String(ownerUserId),
      ownerChatId: ownerChatId == null ? null : String(ownerChatId),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "job.log"), `[${meta.createdAt}] Job created: ${title}\n`, "utf8");
    return { ...meta, dir, workspaceDir };
  }

  jobDir(jobId) {
    const dir = path.join(this.runsDir, jobId);
    if (!fs.existsSync(dir)) throw new Error(`Unknown jobId: ${jobId}`);
    this._ensureWorkspaceTreeByJobDir(dir);
    return dir;
  }

  workspaceDir(jobId) {
    const dir = this.jobDir(jobId);
    return this._ensureWorkspaceTreeByJobDir(dir);
  }

  workspaceUploadsDir(jobId) {
    const dir = path.join(this.workspaceDir(jobId), "uploads");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  workspaceOutputsDir(jobId) {
    const dir = path.join(this.workspaceDir(jobId), "outputs");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  resolveWorkspacePath(jobId, userPath = ".") {
    const root = this.workspaceDir(jobId);
    const rootAbs = path.resolve(root);
    const full = resolveInside(rootAbs, String(userPath || "."));
    this._assertNoSymlinkAlong(rootAbs, full);
    return full;
  }

  ensureWorkspacePath(jobId, userPath = ".", { asDirectory = false } = {}) {
    const full = this.resolveWorkspacePath(jobId, userPath);
    const rootAbs = path.resolve(this.workspaceDir(jobId));
    const dir = asDirectory
      ? full
      : (full === rootAbs ? rootAbs : path.dirname(full));
    this._ensureDirNoSymlink(rootAbs, dir);
    return full;
  }

  log(jobId, line) {
    const p = path.join(this.jobDir(jobId), "job.log");
    fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  }

  appendConversation(jobId, role, text, meta = {}) {
    const p = path.join(this.jobDir(jobId), "conversation.jsonl");
    const rec = { ts: new Date().toISOString(), role, text, ...meta };
    fs.appendFileSync(p, JSON.stringify(rec) + "\n", "utf8");
  }

  tailConversation(jobId, maxLines = 60) {
    const p = path.join(this.jobDir(jobId), "conversation.jsonl");
    if (!fs.existsSync(p)) return [];
    const lines = fs.readFileSync(p, "utf8").trim().split("\n").filter(Boolean);
    return lines.slice(Math.max(0, lines.length - maxLines)).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  }
}
