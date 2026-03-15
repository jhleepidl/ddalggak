import fs from "node:fs";
import path from "node:path";
import {
  normalizeSkillPackage,
  normalizeSkillPackageList,
} from "../domain/skill_packages.js";
import { roleCompatibleWithList } from "../compatibility/legacy_roles.js";

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
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(skillsDir, entry.name))
      .filter((dir) => fs.existsSync(path.join(dir, "manifest.json")));
  } catch {
    return [];
  }
}

export class SkillRegistryV2 {
  constructor({
    skillsDir = path.resolve(process.cwd(), "skills"),
    logger = null,
  } = {}) {
    this.skillsDir = skillsDir;
    this.logger = typeof logger === "function" ? logger : null;
    this.skills = [];
    this.byId = new Map();
    this.bySlug = new Map();
    this.loadedAt = "";
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
    const key = String(skillId || "").trim().toLowerCase();
    if (!key) return null;
    return this.byId.get(key) || null;
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
    const allowedVisibility = new Set(
      asArray(visibilityAllow).map((entry) => String(entry || "").trim().toLowerCase()).filter(Boolean)
    );
    return this.skills.filter((skill) => {
      if (!includeDisabled && String(skill.status || "active").trim().toLowerCase() === "disabled") {
        return false;
      }
      if (allowedVisibility.size > 0 && !allowedVisibility.has(String(skill.visibility || "internal").toLowerCase())) {
        return false;
      }
      if (!roleType) return true;
      const compatibleRoles = asArray(skill.compatible_roles);
      if (compatibleRoles.length === 0) return true;
      return roleCompatibleWithList(roleType, compatibleRoles);
    });
  }

  resolveSkillFilePath(skill = {}, ref = "") {
    const baseDir = String(skill?.skill_dir || "").trim();
    const relative = String(ref || "").trim();
    if (!baseDir || !relative) return "";
    return path.resolve(baseDir, relative);
  }
}
