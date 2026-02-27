import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export class Approvals {
  constructor(jobs) {
    this.jobs = jobs;
  }

  _dir(jobId) {
    const dir = path.join(this.jobs.jobDir(jobId), "approvals");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  request(jobId, { purpose, summary, dangerLevel = "medium", payload = null }) {
    const token = crypto.randomUUID();
    const rec = { token, jobId, purpose, summary, dangerLevel, payload, status: "pending", createdAt: new Date().toISOString() };
    const file = path.join(this._dir(jobId), `${token}.json`);
    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return rec;
  }

  decide(jobId, token, decision, note = null) {
    const file = path.join(this._dir(jobId), `${token}.json`);
    if (!fs.existsSync(file)) throw new Error(`Unknown approval token: ${token}`);
    const rec = JSON.parse(fs.readFileSync(file, "utf8"));
    if (rec.status !== "pending") return rec;

    rec.status = decision === "approve" ? "approved" : "denied";
    rec.decidedAt = new Date().toISOString();
    rec.note = note;

    fs.writeFileSync(file, JSON.stringify(rec, null, 2), "utf8");
    return rec;
  }
}
