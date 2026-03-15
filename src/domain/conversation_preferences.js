import { normalizeStringList } from "../shared/normalize.js";
import { normalizeWorkerRoleId } from "../compatibility/legacy_roles.js";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function normalizeText(value = "") {
  return String(value || "").trim();
}

function normalizeMode(value = "") {
  return normalizeText(value).toLowerCase();
}

function normalizeRoleList(value = []) {
  return normalizeStringList(
    (Array.isArray(value) ? value : [])
      .map((entry) => normalizeWorkerRoleId(entry))
      .filter(Boolean),
    { max: 16, lower: true }
  );
}

function normalizeCount(value, { min = 0, max = 8, fallback = 0 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

export const DEFAULT_CONVERSATION_PREFERENCES = Object.freeze({
  pinned_preset_ids: [],
  banned_preset_ids: [],
  preferred_domains: [],
  preferred_locales: [],
  suppressed_role_ids: [],
  suppressed_skill_ids: [],
  default_control_mode: "",
  reviewer_policy: "",
  max_parallel_slots: 0,
});

export function normalizeConversationPreferences(raw = {}, { fallback = null } = {}) {
  const row = asObject(raw);
  const base = fallback && typeof fallback === "object"
    ? normalizeConversationPreferences(fallback)
    : DEFAULT_CONVERSATION_PREFERENCES;

  return {
    pinned_preset_ids: normalizeStringList(
      row.pinned_preset_ids ?? row.pinnedPresetIds ?? base.pinned_preset_ids,
      { max: 32, lower: true }
    ),
    banned_preset_ids: normalizeStringList(
      row.banned_preset_ids ?? row.bannedPresetIds ?? base.banned_preset_ids,
      { max: 32, lower: true }
    ),
    preferred_domains: normalizeStringList(
      row.preferred_domains ?? row.preferredDomains ?? base.preferred_domains,
      { max: 24, lower: true }
    ),
    preferred_locales: normalizeStringList(
      row.preferred_locales ?? row.preferredLocales ?? base.preferred_locales,
      { max: 12, lower: true }
    ),
    suppressed_role_ids: normalizeRoleList(
      row.suppressed_role_ids ?? row.suppressedRoleIds ?? base.suppressed_role_ids
    ),
    suppressed_skill_ids: normalizeStringList(
      row.suppressed_skill_ids ?? row.suppressedSkillIds ?? base.suppressed_skill_ids,
      { max: 32, lower: true }
    ),
    default_control_mode: normalizeMode(
      row.default_control_mode ?? row.defaultControlMode ?? base.default_control_mode
    ),
    reviewer_policy: normalizeMode(
      row.reviewer_policy ?? row.reviewerPolicy ?? base.reviewer_policy
    ),
    max_parallel_slots: normalizeCount(
      row.max_parallel_slots ?? row.maxParallelSlots ?? base.max_parallel_slots,
      { min: 0, max: 8, fallback: 0 }
    ),
  };
}
