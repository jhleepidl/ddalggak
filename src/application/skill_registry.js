import fs from "node:fs";
import path from "node:path";
import {
  normalizeSkillPackage,
  normalizeSkillPackageList,
} from "../domain/skill_packages.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function safeReadJson(filePath = "") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function listSkillDirs(skillsDir = "") {
  if (!skillsDir || !fs.existsSync(skillsDir)) return [];
  try {
    const rows = fs.readdirSync(skillsDir, { withFileTypes: true });
    return rows
      .filter((row) => row?.isDirectory?.())
      .map((row) => path.join(skillsDir, row.name))
      .filter((row) => fs.existsSync(path.join(row, "manifest.json")));
  } catch {
    return [];
  }
}

function normalizeLog(logger = null) {
  return typeof logger === "function" ? logger : null;
}

export class SkillRegistry {
  constructor({
    skillsDir = path.resolve(process.cwd(), "skills"),
    logger = null,
  } = {}) {
    this.skillsDir = String(skillsDir || "").trim() || path.resolve(process.cwd(), "skills");
    this.logger = normalizeLog(logger);
    this.loadedAt = "";
    this.skills = [];
    this.byId = new Map();
    this.bySlug = new Map();
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  load({ refresh = false } = {}) {
    if (!refresh && this.skills.length > 0) {
      return {
        skills: [...this.skills],
        loaded_at: this.loadedAt,
        skills_dir: this.skillsDir,
      };
    }

    const manifests = [];
    for (const skillDir of listSkillDirs(this.skillsDir)) {
      const manifestPath = path.join(skillDir, "manifest.json");
      const parsed = safeReadJson(manifestPath);
      if (!parsed || typeof parsed !== "object") continue;
      manifests.push(normalizeSkillPackage(parsed, {
        manifestPath,
        skillDir,
      }));
    }

    const normalized = normalizeSkillPackageList(asArray(manifests));
    this.skills = normalized;
    this.byId = new Map(normalized.map((skill) => [skill.id, skill]));
    this.bySlug = new Map(normalized.map((skill) => [skill.slug, skill]));
    this.loadedAt = new Date().toISOString();
    this._log(`[skill-registry] loaded=${normalized.length} dir=${this.skillsDir}`);
    return {
      skills: [...this.skills],
      loaded_at: this.loadedAt,
      skills_dir: this.skillsDir,
    };
  }

  ensureLoaded() {
    if (this.skills.length === 0) this.load();
    return this;
  }

  getById(skillId = "") {
    this.ensureLoaded();
    const id = String(skillId || "").trim().toLowerCase();
    if (!id) return null;
    return this.byId.get(id) || null;
  }

  getBySlug(slug = "") {
    this.ensureLoaded();
    const key = String(slug || "").trim().toLowerCase();
    if (!key) return null;
    return this.bySlug.get(key) || null;
  }

  resolve(skillIdOrSlug = "") {
    return this.getById(skillIdOrSlug) || this.getBySlug(skillIdOrSlug) || null;
  }

  list({
    roleType = "",
    includeDisabled = false,
    visibilityAllow = ["public", "internal"],
  } = {}) {
    this.ensureLoaded();
    const role = String(roleType || "").trim().toLowerCase();
    const visibilitySet = new Set(
      asArray(visibilityAllow).map((row) => String(row || "").trim().toLowerCase()).filter(Boolean)
    );
    return this.skills.filter((skill) => {
      if (!includeDisabled && String(skill.status || "active").toLowerCase() === "disabled") return false;
      if (visibilitySet.size > 0 && !visibilitySet.has(String(skill.visibility || "internal").toLowerCase())) return false;
      if (!role) return true;
      const compatible = asArray(skill.compatible_roles).map((row) => String(row || "").trim().toLowerCase()).filter(Boolean);
      if (compatible.length === 0) return true;
      return compatible.includes(role);
    });
  }

  resolveSkillFilePath(skill = {}, ref = "") {
    const baseDir = String(skill?.skill_dir || "").trim();
    const relative = String(ref || "").trim();
    if (!baseDir || !relative) return "";
    return path.resolve(baseDir, relative);
  }
}

