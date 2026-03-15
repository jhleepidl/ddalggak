import { normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "../domain/skill_attachment.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function uniqueList(rows = []) {
  return normalizeStringList(rows, { max: 256, lower: true });
}

function keywordMatchCount(goalText = "", candidates = []) {
  const goal = normalizeText(goalText, { lower: true });
  if (!goal) return 0;
  let count = 0;
  for (const term of uniqueList(candidates)) {
    if (goal.includes(term)) count += 1;
  }
  return count;
}

function roleCompatibilityScore(role = "", compatibleRoles = []) {
  const cleanRole = normalizeRoleId(role);
  const compatible = uniqueList(
    asArray(compatibleRoles).map((entry) => normalizeRoleId(entry))
  );
  if (!cleanRole) return { score: 0, reason: "no_role" };
  if (compatible.length === 0) return { score: 8, reason: "role_agnostic" };
  if (compatible.includes(cleanRole)) return { score: 35, reason: `compatible_role:${cleanRole}` };
  return { score: -30, reason: `incompatible_role:${cleanRole}` };
}

function historicalScore(skill = {}) {
  const successRate = Number(skill?.ranking_metadata?.success_rate);
  const usageCount = Number(skill?.ranking_metadata?.usage_count);
  const score = (
    (Number.isFinite(successRate) ? Math.max(0, Math.min(1, successRate)) * 12 : 0)
    + (Number.isFinite(usageCount) ? Math.min(8, Math.log10(Math.max(1, usageCount + 1)) * 4) : 0)
  );
  return Math.round(score * 10) / 10;
}

function lowRiskPreference(skill = {}) {
  const risk = normalizeText(skill?.ranking_metadata?.risk || skill?.safety_policy?.risk_level, { lower: true });
  if (!risk) return 2;
  if (["low", "l1", "safe"].includes(risk)) return 5;
  if (["medium", "l2"].includes(risk)) return 2;
  return 0;
}

function collectSlotSkillIds(role = {}) {
  const required = asArray(role?.required_skill_ids);
  const preferred = asArray(role?.preferred_skill_ids);
  return uniqueList([...required, ...preferred]);
}

export function scoreSkillForTask({
  skill = {},
  goal = "",
  roleType = "",
  contextHints = [],
} = {}) {
  const goalText = [goal, ...asArray(contextHints)].join("\n");
  const triggerMatches = keywordMatchCount(goalText, skill.trigger_terms || []);
  const capabilityMatches = keywordMatchCount(goalText, [
    ...(skill.capability_tags || []),
    ...(skill.tags || []),
  ]);
  const titleMatches = keywordMatchCount(goalText, [
    skill.name,
    skill.title,
    skill.slug,
    skill.description,
  ].filter(Boolean));
  const roleScore = roleCompatibilityScore(roleType, skill.compatible_roles || []);
  const history = historicalScore(skill);
  const risk = lowRiskPreference(skill);

  const score = (
    roleScore.score
    + (triggerMatches * 12)
    + (capabilityMatches * 7)
    + (titleMatches * 4)
    + history
    + risk
  );
  const reasons = [
    roleScore.reason,
    triggerMatches > 0 ? `trigger_matches:${triggerMatches}` : "",
    capabilityMatches > 0 ? `capability_matches:${capabilityMatches}` : "",
    titleMatches > 0 ? `name_matches:${titleMatches}` : "",
    history > 0 ? `historical:${history}` : "",
    risk > 0 ? `risk_pref:${risk}` : "",
  ].filter(Boolean);
  return {
    score,
    reasons,
    detail: {
      trigger_matches: triggerMatches,
      capability_matches: capabilityMatches,
      title_matches: titleMatches,
      role_score: roleScore.score,
      historical_score: history,
      risk_preference: risk,
    },
  };
}

export class SkillResolver {
  constructor({
    registry = null,
    maxSkillsPerRole = 2,
    minScore = 18,
  } = {}) {
    this.registry = registry || null;
    this.maxSkillsPerRole = Number.isFinite(Number(maxSkillsPerRole))
      ? Math.max(0, Math.min(4, Math.floor(Number(maxSkillsPerRole))))
      : 2;
    this.minScore = Number.isFinite(Number(minScore))
      ? Math.max(0, Number(minScore))
      : 18;
  }

  _listSkills(roleType = "") {
    if (!this.registry || typeof this.registry.list !== "function") return [];
    return this.registry.list({
      roleType,
      includeDisabled: false,
      visibilityAllow: ["public", "internal"],
    });
  }

  resolveForRole({
    roleType = "",
    goal = "",
    contextHints = [],
    existingAttachments = [],
  } = {}) {
    const normalizedRole = normalizeRoleId(roleType);
    const candidates = this._listSkills(normalizedRole);
    const existing = normalizeSkillAttachmentList(existingAttachments);
    const selectedIds = new Set(existing.map((row) => row.skill_id));
    const scored = [];
    for (const skill of candidates) {
      if (selectedIds.has(skill.id)) continue;
      if (String(skill.status || "active").toLowerCase() === "disabled") continue;
      const score = scoreSkillForTask({
        skill,
        goal,
        roleType: normalizedRole,
        contextHints,
      });
      scored.push({
        skill,
        score: Number(score.score || 0),
        reasons: score.reasons,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const selected = [];
    for (const row of scored) {
      if (selected.length >= this.maxSkillsPerRole) break;
      if (row.score < this.minScore) continue;
      selected.push({
        skill_id: row.skill.id,
        selected_by: "skill_resolver",
        selection_reason: row.reasons.join(", "),
        load_level: "metadata_only",
        status: "selected",
      });
    }

    return {
      attachments: [...existing, ...selected].slice(0, this.maxSkillsPerRole),
      scored_candidates: scored.slice(0, 8).map((row) => ({
        skill_id: row.skill.id,
        score: row.score,
        reasons: row.reasons,
      })),
    };
  }

  resolveForTeam({
    goal = "",
    teamPlan = null,
    contextHints = [],
  } = {}) {
    const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
    const roles = Array.isArray(plan.roles) && plan.roles.length > 0
      ? plan.roles
      : (Array.isArray(plan.slots) ? plan.slots : []);
    const roleSkillMap = {};
    const selectionReasonSummary = {};
    for (const role of roles) {
      const roleType = normalizeRoleId(
        role?.role_type
        || role?.role_id
        || role?.id
        || role?.role_label
      );
      if (!roleType) continue;
      const seededAttachments = [
        ...normalizeSkillAttachmentList(role?.attached_skills || []),
        ...collectSlotSkillIds(role).map((skillId) => ({
          skill_id: skillId,
          selected_by: "team_plan",
          selection_reason: "slot skill preference",
          load_level: "metadata_only",
          status: "selected",
        })),
      ];
      const resolved = this.resolveForRole({
        roleType,
        goal,
        contextHints,
        existingAttachments: seededAttachments,
      });
      roleSkillMap[roleType] = resolved.attachments;
      if (resolved.attachments.length > 0) {
        selectionReasonSummary[roleType] = resolved.attachments
          .map((row) => `${row.skill_id}:${row.selection_reason || "selected"}`)
          .join("; ");
      }
    }

    return {
      role_skill_map: roleSkillMap,
      selection_reason_summary: selectionReasonSummary,
      selected_skill_ids: normalizeStringList(
        Object.values(roleSkillMap).flat().map((row) => row.skill_id),
        { max: 64, lower: true }
      ),
    };
  }
}
