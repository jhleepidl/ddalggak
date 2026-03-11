import { normalizeStringList } from "../shared/normalize.js";

export const SKILL_LOAD_LEVELS = Object.freeze([
  "metadata_only",
  "instructions",
  "resources",
]);

export const SKILL_ATTACHMENT_STATUS = Object.freeze([
  "selected",
  "active",
  "disabled",
  "skipped",
  "error",
]);

function normalizeLoadLevel(raw = "", {
  fallback = "metadata_only",
} = {}) {
  const value = String(raw || "").trim().toLowerCase();
  if (SKILL_LOAD_LEVELS.includes(value)) return value;
  return SKILL_LOAD_LEVELS.includes(fallback) ? fallback : "metadata_only";
}

function normalizeStatus(raw = "", {
  fallback = "selected",
} = {}) {
  const value = String(raw || "").trim().toLowerCase();
  if (SKILL_ATTACHMENT_STATUS.includes(value)) return value;
  return SKILL_ATTACHMENT_STATUS.includes(fallback) ? fallback : "selected";
}

function normalizeSkillId(raw = "") {
  return String(raw || "").trim().toLowerCase();
}

export function normalizeSkillAttachment(raw = {}, {
  defaultSelectedBy = "skill_resolver",
  defaultLoadLevel = "metadata_only",
  defaultStatus = "selected",
} = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const skillId = normalizeSkillId(row.skill_id || row.skillId || row.id);
  if (!skillId) return null;
  return {
    skill_id: skillId,
    selected_by: String(row.selected_by || row.selectedBy || defaultSelectedBy).trim() || defaultSelectedBy,
    selection_reason: String(row.selection_reason || row.selectionReason || "").trim() || undefined,
    load_level: normalizeLoadLevel(row.load_level || row.loadLevel, {
      fallback: defaultLoadLevel,
    }),
    status: normalizeStatus(row.status, {
      fallback: defaultStatus,
    }),
  };
}

export function normalizeSkillAttachmentList(list = [], options = {}) {
  return (Array.isArray(list) ? list : [])
    .map((row) => normalizeSkillAttachment(row, options))
    .filter(Boolean);
}

export function mergeSkillAttachmentList(base = [], patch = []) {
  const merged = new Map();
  for (const row of normalizeSkillAttachmentList(base)) {
    merged.set(row.skill_id, row);
  }
  for (const row of normalizeSkillAttachmentList(patch)) {
    merged.set(row.skill_id, {
      ...(merged.get(row.skill_id) || {}),
      ...row,
    });
  }
  return [...merged.values()];
}

export function upgradeSkillLoadLevel(current = "", requested = "") {
  const now = normalizeLoadLevel(current);
  const next = normalizeLoadLevel(requested, { fallback: now });
  const nowIdx = SKILL_LOAD_LEVELS.indexOf(now);
  const nextIdx = SKILL_LOAD_LEVELS.indexOf(next);
  return SKILL_LOAD_LEVELS[Math.max(nowIdx, nextIdx, 0)] || "metadata_only";
}

export function summarizeSkillLoadLevels(attachedSkills = []) {
  const list = normalizeSkillAttachmentList(attachedSkills);
  const summary = {};
  for (const row of list) {
    summary[row.skill_id] = row.load_level;
  }
  return summary;
}

export function summarizeSelectedSkillIds(attachedSkills = []) {
  return normalizeStringList(
    normalizeSkillAttachmentList(attachedSkills).map((row) => row.skill_id),
    { max: 16, lower: true }
  );
}

