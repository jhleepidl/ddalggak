import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Jobs {
  constructor(workspace) {
    const base = process.env.RUNS_DIR
      ? path.resolve(process.env.RUNS_DIR)
      : path.join(workspace.root, ".orchestrator");
    this.baseDir = base;
    this.runsDir = path.join(base, "runs");
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  createJob({ title, ownerUserId = null, ownerChatId = null }) {
    const jobId = crypto.randomUUID();
    const dir = path.join(this.runsDir, jobId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "shared"), { recursive: true });

    const meta = {
      jobId,
      title,
      ownerUserId: ownerUserId == null ? null : String(ownerUserId),
      ownerChatId: ownerChatId == null ? null : String(ownerChatId),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
    fs.writeFileSync(path.join(dir, "job.log"), `[${meta.createdAt}] Job created: ${title}\n`, "utf8");
    return { ...meta, dir };
  }

  jobDir(jobId) {
    const dir = path.join(this.runsDir, jobId);
    if (!fs.existsSync(dir)) throw new Error(`Unknown jobId: ${jobId}`);
    return dir;
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
