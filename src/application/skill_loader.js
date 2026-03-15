import fs from "node:fs";
import {
  SKILL_LOAD_LEVELS,
  upgradeSkillLoadLevel,
  normalizeSkillAttachmentList,
} from "../domain/skill_attachment.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function safeReadText(filePath = "", { maxChars = 0 } = {}) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!Number.isFinite(Number(maxChars)) || Number(maxChars) <= 0) return raw;
    return raw.slice(0, Math.max(0, Math.floor(Number(maxChars))));
  } catch {
    return "";
  }
}

function includesAny(text = "", needles = []) {
  const src = normalizeText(text).toLowerCase();
  if (!src) return false;
  return asArray(needles).some((entry) => src.includes(String(entry || "").trim().toLowerCase()));
}

function normalizeLoadLevel(raw = "", {
  fallback = "metadata_only",
} = {}) {
  const value = normalizeText(raw).toLowerCase();
  if (SKILL_LOAD_LEVELS.includes(value)) return value;
  return SKILL_LOAD_LEVELS.includes(fallback) ? fallback : "metadata_only";
}

function loadLevelRank(level = "") {
  const idx = SKILL_LOAD_LEVELS.indexOf(normalizeLoadLevel(level));
  return idx >= 0 ? idx : 0;
}

function includeInstructions(level = "") {
  return loadLevelRank(level) >= loadLevelRank("instructions");
}

function includeResources(level = "") {
  return loadLevelRank(level) >= loadLevelRank("resources");
}

export class SkillLoader {
  constructor({
    registry = null,
    maxInstructionChars = 12000,
    maxResourceChars = 8000,
  } = {}) {
    this.registry = registry || null;
    this.maxInstructionChars = Number.isFinite(Number(maxInstructionChars))
      ? Math.max(1000, Math.floor(Number(maxInstructionChars)))
      : 12000;
    this.maxResourceChars = Number.isFinite(Number(maxResourceChars))
      ? Math.max(500, Math.floor(Number(maxResourceChars)))
      : 8000;
  }

  _resolveSkill(skillId = "") {
    if (!this.registry || typeof this.registry.resolve !== "function") return null;
    return this.registry.resolve(skillId);
  }

  _resolveRefPath(skill = {}, ref = "") {
    if (!this.registry || typeof this.registry.resolveSkillFilePath !== "function") return "";
    return this.registry.resolveSkillFilePath(skill, ref);
  }

  resolveLoadLevelForExecution({
    currentLevel = "metadata_only",
    roleType = "",
    goal = "",
    actionPrompt = "",
    attachment = null,
    skillPackage = null,
  } = {}) {
    const role = normalizeText(roleType).toLowerCase();
    const goalText = `${normalizeText(goal)}\n${normalizeText(actionPrompt)}`.toLowerCase();
    let next = normalizeLoadLevel(
      attachment?.load_level || attachment?.loadLevel || currentLevel,
      { fallback: currentLevel }
    );

    const triggerTerms = asArray(skillPackage?.trigger_terms).map((row) => String(row || "").toLowerCase());
    const caps = asArray(skillPackage?.capability_tags).map((row) => String(row || "").toLowerCase());
    if (includesAny(goalText, [...triggerTerms, ...caps])) {
      next = upgradeSkillLoadLevel(next, "instructions");
    }

    const resourceNeedles = [
      "template",
      "checklist",
      "script",
      "audit",
      "trace",
      "debug",
      "증거",
      "근거",
      "검증",
      "진단",
    ];
    if (
      includesAny(goalText, resourceNeedles)
      || (["coder", "builder"].includes(role) && includesAny(goalText, ["python", "js", "script"]))
    ) {
      next = upgradeSkillLoadLevel(next, "resources");
    }

    return normalizeLoadLevel(next);
  }

  loadSkill(skillId = "", {
    loadLevel = "metadata_only",
  } = {}) {
    const skill = this._resolveSkill(skillId);
    if (!skill) return null;
    const level = normalizeLoadLevel(loadLevel);

    const payload = {
      skill_id: skill.id,
      load_level: level,
      metadata: {
        id: skill.id,
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
        category: skill.category,
        capability_tags: asArray(skill.capability_tags),
        trigger_terms: asArray(skill.trigger_terms),
        compatible_roles: asArray(skill.compatible_roles),
        input_contract: skill.input_contract || {},
        output_contract: skill.output_contract || {},
        instructions_ref: skill.instructions_ref || "SKILL.md",
        resource_refs: asArray(skill.resource_refs),
        utility_refs: asArray(skill.utility_refs),
      },
      instructions: null,
      resources: [],
      utilities: [],
    };

    if (includeInstructions(level)) {
      const ref = String(skill.instructions_ref || "SKILL.md").trim();
      const filePath = this._resolveRefPath(skill, ref);
      const text = safeReadText(filePath, { maxChars: this.maxInstructionChars });
      payload.instructions = {
        ref,
        file_path: filePath || undefined,
        loaded: !!text,
        text: text || undefined,
      };
    }

    if (includeResources(level)) {
      payload.resources = asArray(skill.resource_refs).map((refRaw) => {
        const ref = String(refRaw || "").trim();
        const filePath = this._resolveRefPath(skill, ref);
        const text = safeReadText(filePath, { maxChars: this.maxResourceChars });
        return {
          ref,
          file_path: filePath || undefined,
          loaded: !!text,
          text: text || undefined,
        };
      });
      payload.utilities = asArray(skill.utility_refs).map((refRaw) => {
        const ref = String(refRaw || "").trim();
        const filePath = this._resolveRefPath(skill, ref);
        const text = safeReadText(filePath, { maxChars: this.maxResourceChars });
        return {
          ref,
          file_path: filePath || undefined,
          loaded: !!text,
          text: text || undefined,
        };
      });
    }

    return payload;
  }

  loadForAttachments(attachedSkills = [], {
    roleType = "",
    goal = "",
    actionPrompt = "",
  } = {}) {
    return normalizeSkillAttachmentList(attachedSkills).map((attachment) => {
      const skill = this._resolveSkill(attachment.skill_id);
      const resolvedLevel = this.resolveLoadLevelForExecution({
        currentLevel: attachment.load_level,
        roleType,
        goal,
        actionPrompt,
        attachment,
        skillPackage: skill,
      });
      const loaded = this.loadSkill(attachment.skill_id, {
        loadLevel: resolvedLevel,
      });
      return {
        ...attachment,
        load_level: resolvedLevel,
        loaded_skill: loaded,
      };
    });
  }
}
