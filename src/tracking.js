import fs from "node:fs";
import path from "node:path";

import {
  LEGACY_SEMANTIC_DOC_NAMES,
  normalizeKnowledgeBaseProfile,
  renderKnowledgeBaseProfileMarkdown,
  resolveKnowledgeDocName,
} from "./knowledge_base/profile.js";
import {
  KNOWLEDGE_BASE_CONTRACT_FILE,
  renderKnowledgeBaseContractMarkdown,
} from "./knowledge_base/runtime.js";

const SAFE_DOC_RE = /^[a-zA-Z0-9._-]+\.md$/;
const PROFILE_FILE = "knowledge_base_profile.json";


function isBoilerplateDoc(text = '') {
  const src = String(text || '').trim();
  if (!src) return true;
  const stripped = src
    .replace(/^#\s+.*$/m, '')
    .replace(/^>\s*createdAt:.*$/m, '')
    .replace(/^>\s*migratedFrom:.*$/gm, '')
    .replace(/^>\s*migratedAt:.*$/gm, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}


export class Tracking {
  constructor(jobs, opts = {}) {
    this.jobs = jobs;
    this.appendHook = typeof opts.appendHook === "function" ? opts.appendHook : null;
  }

  setAppendHook(hook) {
    this.appendHook = typeof hook === "function" ? hook : null;
    return this.appendHook;
  }

  _sharedDir(jobId) {
    const dir = path.join(this.jobs.jobDir(jobId), "shared");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  _profilePath(jobId) {
    return path.join(this._sharedDir(jobId), PROFILE_FILE);
  }

  _validateName(name) {
    if (!SAFE_DOC_RE.test(name)) throw new Error(`Invalid doc name: ${name}`);
    return name;
  }

  loadProfile(jobId) {
    const filePath = this._profilePath(jobId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return normalizeKnowledgeBaseProfile(parsed || {});
    } catch {
      return null;
    }
  }

  saveProfile(jobId, profile = {}) {
    const normalized = normalizeKnowledgeBaseProfile(profile || {});
    const sharedDir = this._sharedDir(jobId);
    fs.writeFileSync(this._profilePath(jobId), JSON.stringify(normalized, null, 2), "utf8");
    fs.writeFileSync(
      path.join(sharedDir, KNOWLEDGE_BASE_CONTRACT_FILE),
      renderKnowledgeBaseContractMarkdown(normalized),
      "utf8",
    );
    return normalized;
  }

  reconcileProfile(jobId, profile = {}, { migrate = true } = {}) {
    const nextProfile = normalizeKnowledgeBaseProfile(profile || {});
    const currentProfile = this.loadProfile(jobId);
    const sharedDir = this._sharedDir(jobId);
    const oldDocsById = new Map((currentProfile?.docs || []).map((doc) => [String(doc.doc_id || '').trim().toLowerCase(), doc]));
    const migration = { changed: false, moved_slots: [], created_files: [], retained_files: [] };
    this.saveProfile(jobId, nextProfile);
    for (const entry of nextProfile.docs) {
      const filePath = path.join(sharedDir, this._validateName(entry.file_name));
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, `# ${entry.title || entry.doc_id}\n\n> createdAt: ${new Date().toISOString()}\n\n`, 'utf8');
        migration.created_files.push(entry.file_name);
        migration.changed = true;
      }
    }
    if (currentProfile && migrate) {
      for (const entry of nextProfile.docs) {
        const previous = oldDocsById.get(String(entry.doc_id || '').trim().toLowerCase());
        if (!previous) continue;
        const prevName = this._validateName(previous.file_name);
        const nextName = this._validateName(entry.file_name);
        const prevPath = path.join(sharedDir, prevName);
        const nextPath = path.join(sharedDir, nextName);
        if (!fs.existsSync(prevPath) || prevName === nextName) {
          if (prevName === nextName) migration.retained_files.push(nextName);
          continue;
        }
        const prevText = fs.readFileSync(prevPath, 'utf8');
        let nextText = '';
        try { nextText = fs.readFileSync(nextPath, 'utf8'); } catch {}
        if (!prevText.trim()) continue;
        if (!fs.existsSync(nextPath) || isBoilerplateDoc(nextText)) {
          const migrated = `${prevText.trim()}\n\n> migratedFrom: ${prevName}\n> migratedAt: ${new Date().toISOString()}\n`;
          fs.writeFileSync(nextPath, `${migrated}\n`, 'utf8');
          migration.moved_slots.push({ doc_id: entry.doc_id, from: prevName, to: nextName });
          migration.changed = true;
        }
      }
    }
    return { profile: nextProfile, currentProfile, migration };
  }

  resolveDocName(jobId, name) {
    const profile = this.loadProfile(jobId);
    const rawName = String(name || "").trim();
    const resolved = profile
      ? resolveKnowledgeDocName(profile, rawName)
      : (LEGACY_SEMANTIC_DOC_NAMES[rawName] || rawName);
    return this._validateName(resolved);
  }

  listDocs(jobId) {
    const profile = this.loadProfile(jobId);
    if (profile?.docs?.length) return profile.docs.map((entry) => ({ ...entry }));
    return Object.entries(LEGACY_SEMANTIC_DOC_NAMES).map(([slotId, name]) => ({
      doc_id: slotId,
      file_name: name,
      title: name.replace(/\.md$/i, ""),
      purpose: "",
      legacy_names: [name],
      read_priority: 0,
    }));
  }

  renderProfileMarkdown(jobId) {
    const profile = this.loadProfile(jobId);
    if (!profile) {
      return [
        "# Knowledge Base",
        "",
        "- profile: legacy/static",
        `- docs: ${Object.values(LEGACY_SEMANTIC_DOC_NAMES).join(', ')}`,
      ].join("\n");
    }
    return renderKnowledgeBaseProfileMarkdown(profile);
  }

  init(jobId, names = Object.values(LEGACY_SEMANTIC_DOC_NAMES)) {
    const dir = this._sharedDir(jobId);
    let targetNames = [];
    if (Array.isArray(names)) {
      targetNames = names.map((entry) => this.resolveDocName(jobId, entry)).filter(Boolean);
    } else if (names && typeof names === "object") {
      const profile = this.saveProfile(jobId, names);
      targetNames = profile.docs.map((entry) => this._validateName(entry.file_name));
    }
    for (const n of targetNames) {
      const p = path.join(dir, n);
      if (!fs.existsSync(p)) {
        const title = n.replace(/\.md$/, "");
        fs.writeFileSync(p, `# ${title}\n\n> createdAt: ${new Date().toISOString()}\n\n`, "utf8");
      }
    }
    return targetNames;
  }

  read(jobId, name) {
    name = this.resolveDocName(jobId, name);
    const p = path.join(this._sharedDir(jobId), name);
    if (!fs.existsSync(p)) throw new Error(`Doc not found: ${name}`);
    return fs.readFileSync(p, "utf8");
  }

  append(jobId, name, markdown, { timestamp = true } = {}) {
    name = this.resolveDocName(jobId, name);
    const p = path.join(this._sharedDir(jobId), name);
    if (!fs.existsSync(p)) throw new Error(`Doc not found: ${name}`);
    const prefix = timestamp ? `\n\n---\n\n**${new Date().toISOString()}**\n\n` : "\n\n";
    const chunk = prefix + markdown;
    fs.appendFileSync(p, chunk, "utf8");

    if (typeof this.appendHook === "function") {
      try {
        const maybePromise = this.appendHook({
          jobId: String(jobId),
          docName: name,
          markdown: String(markdown),
          chunk,
          timestamp,
        });
        if (maybePromise && typeof maybePromise.then === "function") {
          maybePromise.catch(() => {});
        }
      } catch {}
    }
  }
}
