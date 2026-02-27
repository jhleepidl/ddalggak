import fs from "node:fs";
import path from "node:path";

const SAFE_DOC_RE = /^[a-zA-Z0-9._-]+\.md$/;

export class Tracking {
  constructor(jobs) {
    this.jobs = jobs;
  }

  _sharedDir(jobId) {
    const dir = path.join(this.jobs.jobDir(jobId), "shared");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _validateName(name) {
    if (!SAFE_DOC_RE.test(name)) throw new Error(`Invalid doc name: ${name}`);
    return name;
  }

  init(jobId, names = ["plan.md", "research.md", "progress.md", "decisions.md"]) {
    const dir = this._sharedDir(jobId);
    for (const n of names) {
      const name = this._validateName(n);
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) {
        const title = name.replace(/\.md$/, "");
        fs.writeFileSync(p, `# ${title}\n\n> createdAt: ${new Date().toISOString()}\n\n`, "utf8");
      }
    }
    return names;
  }

  read(jobId, name) {
    name = this._validateName(name);
    const p = path.join(this._sharedDir(jobId), name);
    if (!fs.existsSync(p)) throw new Error(`Doc not found: ${name}`);
    return fs.readFileSync(p, "utf8");
  }

  append(jobId, name, markdown, { timestamp = true } = {}) {
    name = this._validateName(name);
    const p = path.join(this._sharedDir(jobId), name);
    if (!fs.existsSync(p)) throw new Error(`Doc not found: ${name}`);
    const prefix = timestamp ? `\n\n---\n\n**${new Date().toISOString()}**\n\n` : "\n\n";
    fs.appendFileSync(p, prefix + markdown, "utf8");
  }
}
