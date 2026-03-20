import { normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "../domain/skill_attachment.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";
import { hasExplicitSkillDomainMatch, requiresExplicitDomainMatch } from "../shared/skill_relevance.js";

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
  const compatible = uniqueList(asArray(compatibleRoles).map((entry) => normalizeRoleId(entry)));
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

function documentationProfileScore(skill = {}) {
  const profile = skill?.documentation_profile && typeof skill.documentation_profile === "object"
    ? skill.documentation_profile
    : {};
  const band = normalizeText(profile?.complexity_band, { lower: true });
  if (band === "compact") return 8;
  if (band === "detailed") return 6;
  if (band === "standard") return 3;
  if (band === "comprehensive") return -8;
  return 0;
}

function lowRiskPreference(skill = {}) {
  const risk = normalizeText(skill?.ranking_metadata?.risk || skill?.safety_policy?.risk_level, { lower: true });
  if (!risk) return 2;
  if (["low", "l1", "safe"].includes(risk)) return 5;
  if (["medium", "l2"].includes(risk)) return 2;
  return 0;
}

function hasRequiredTools(skill = {}, availableToolIds = []) {
  const required = new Set(asArray(skill.required_tools).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  if (required.size === 0) return true;
  const available = new Set(normalizeStringList(availableToolIds, { max: 32, lower: true }));
  for (const toolId of required) {
    if (!available.has(toolId)) return false;
  }
  return true;
}

function hasRequiredContextTypes(skill = {}, availableContextTypes = []) {
  const required = new Set(asArray(skill.required_context_types).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  if (required.size === 0) return true;
  const available = new Set(normalizeStringList(availableContextTypes, { max: 32, lower: true }));
  for (const contextType of required) {
    if (!available.has(contextType)) return false;
  }
  return true;
}

function collectRequestedSkillIds(slot = {}) {
  return {
    required: uniqueList(asArray(slot.required_skill_ids)),
    preferred: uniqueList(asArray(slot.preferred_skill_ids)),
    forbidden: uniqueList(asArray(slot.forbidden_skill_ids)),
  };
}

function pruneConflicts(selectedRows = [], registry = null) {
  if (!registry || typeof registry.resolve !== "function") return selectedRows;
  const requiredRows = [];
  const optionalRows = [];
  for (const row of selectedRows) {
    if (row.required === true) requiredRows.push(row);
    else optionalRows.push(row);
  }
  const kept = [...requiredRows];
  const selectedIds = new Set(requiredRows.map((row) => row.attachment.skill_id));
  for (const row of optionalRows.sort((a, b) => b.score - a.score)) {
    const skill = registry.resolve(row.attachment.skill_id);
    const conflicts = new Set(asArray(skill?.conflicts_with).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
    let blocked = false;
    for (const selectedId of selectedIds) {
      if (conflicts.has(selectedId)) {
        blocked = true;
        break;
      }
      const selectedSkill = registry.resolve(selectedId);
      const reverse = new Set(asArray(selectedSkill?.conflicts_with).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
      if (reverse.has(row.attachment.skill_id)) {
        blocked = true;
        break;
      }
    }
    if (blocked) continue;
    kept.push(row);
    selectedIds.add(row.attachment.skill_id);
  }
  return kept;
}

export function scoreSkillForTask({
  skill = {},
  goal = "",
  roleType = "",
  contextHints = [],
  taskInterpretation = {},
  slot = {},
} = {}) {
  const goalText = [
    goal,
    ...asArray(contextHints),
    taskInterpretation?.task_summary,
    slot?.purpose,
    ...(taskInterpretation?.domain_hints || []),
  ].filter(Boolean).join("\n");
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
  const docs = documentationProfileScore(skill);
  const requested = collectRequestedSkillIds(slot);
  const requiredBoost = requested.required.includes(skill.id) ? 60 : 0;
  const preferredBoost = requested.preferred.includes(skill.id) ? 20 : 0;
  const contextBoost = hasRequiredContextTypes(skill, slot.required_context_types || []) ? 6 : -20;

  const score = (
    roleScore.score
    + requiredBoost
    + preferredBoost
    + contextBoost
    + (triggerMatches * 12)
    + (capabilityMatches * 7)
    + (titleMatches * 4)
    + history
    + risk
    + docs
  );
  const reasons = [
    roleScore.reason,
    requiredBoost > 0 ? "required_skill" : "",
    preferredBoost > 0 ? "preferred_skill" : "",
    triggerMatches > 0 ? `trigger_matches:${triggerMatches}` : "",
    capabilityMatches > 0 ? `capability_matches:${capabilityMatches}` : "",
    titleMatches > 0 ? `name_matches:${titleMatches}` : "",
    history > 0 ? `historical:${history}` : "",
    risk > 0 ? `risk_pref:${risk}` : "",
    docs !== 0 ? `doc_profile:${docs}` : "",
  ].filter(Boolean);
  return {
    score,
    reasons,
  };
}

export class SkillResolver {
  constructor({
    registry = null,
    maxSkillsPerRole = 3,
    minScore = 18,
  } = {}) {
    this.registry = registry || null;
    this.maxSkillsPerRole = Number.isFinite(Number(maxSkillsPerRole))
      ? Math.max(0, Math.min(6, Math.floor(Number(maxSkillsPerRole))))
      : 3;
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
    taskInterpretation = {},
    slot = {},
    availableToolIds = [],
  } = {}) {
    const normalizedRole = normalizeRoleId(roleType);
    const candidates = this._listSkills(normalizedRole);
    const existing = normalizeSkillAttachmentList(existingAttachments);
    const requested = collectRequestedSkillIds(slot);
    const selectedIds = new Set(existing.map((row) => row.skill_id));
    const scored = [];
    for (const skill of candidates) {
      if (selectedIds.has(skill.id)) continue;
      if (String(skill.status || "active").toLowerCase() === "disabled") continue;
      if (requested.forbidden.includes(skill.id)) continue;
      if (!hasRequiredTools(skill, availableToolIds)) continue;
      if (!hasRequiredContextTypes(skill, slot.required_context_types || [])) continue;
      if (requiresExplicitDomainMatch(skill) && !requested.required.includes(skill.id) && !hasExplicitSkillDomainMatch({
        skill,
        text: [goal, ...asArray(contextHints), taskInterpretation?.task_summary, slot?.purpose].filter(Boolean).join('\n'),
        taskInterpretation,
      })) continue;
      const score = scoreSkillForTask({
        skill,
        goal,
        roleType: normalizedRole,
        contextHints,
        taskInterpretation,
        slot,
      });
      scored.push({
        skill,
        score: Number(score.score || 0),
        reasons: score.reasons,
      });
    }
    scored.sort((a, b) => b.score - a.score);

    const selectedRows = existing.map((attachment) => ({
      attachment,
      required: requested.required.includes(attachment.skill_id),
      score: 999,
    }));

    for (const skillId of requested.required) {
      if (selectedRows.some((row) => row.attachment.skill_id === skillId)) continue;
      selectedRows.push({
        attachment: {
          skill_id: skillId,
          selected_by: "team_plan",
          selection_reason: "required slot skill",
          load_level: "metadata_only",
          status: "selected",
        },
        required: true,
        score: 500,
      });
    }

    const softSkillBudget = Math.min(this.maxSkillsPerRole, 2);
    for (const row of scored) {
      if (selectedRows.length >= this.maxSkillsPerRole) break;
      if (row.score < this.minScore && !requested.preferred.includes(row.skill.id)) continue;
      if (selectedRows.length >= softSkillBudget && !requested.required.includes(row.skill.id) && !requested.preferred.includes(row.skill.id)) continue;
      selectedRows.push({
        attachment: {
          skill_id: row.skill.id,
          selected_by: "skill_resolver",
          selection_reason: row.reasons.join(", "),
          load_level: "metadata_only",
          status: "selected",
        },
        required: requested.required.includes(row.skill.id),
        score: row.score,
      });
    }

    const pruned = pruneConflicts(selectedRows, this.registry).slice(0, this.maxSkillsPerRole);
    return {
      attachments: normalizeSkillAttachmentList(pruned.map((row) => row.attachment)),
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
    runtimeAgents = [],
    contextHints = [],
    taskInterpretation = {},
    availableToolIds = [],
  } = {}) {
    const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
    const slots = Array.isArray(plan.slots) ? plan.slots : [];
    const roleSkillMap = {};
    const slotSkillMap = {};
    const selectionReasonSummary = {};
    const runtimeAgentAttachments = {};

    for (const slot of slots) {
      const roleType = normalizeRoleId(slot?.role_id || slot?.role_type || slot?.id || slot?.role_label);
      if (!roleType) continue;
      const runtimeAgent = asArray(runtimeAgents).find((agent) =>
        normalizeText(agent?.slot_id) === normalizeText(slot?.slot_id)
        || normalizeRoleId(agent?.role_id || agent?.role_label) === roleType
      );
      const seededAttachments = normalizeSkillAttachmentList([
        ...(slot?.attached_skills || []),
        ...(runtimeAgent?.attached_skills || []),
      ]);
      const resolved = this.resolveForRole({
        roleType,
        goal,
        contextHints,
        existingAttachments: seededAttachments,
        taskInterpretation,
        slot,
        availableToolIds,
      });
      slotSkillMap[String(slot.slot_id || roleType)] = resolved.attachments;
      roleSkillMap[roleType] = resolved.attachments;
      if (runtimeAgent?.instance_id) {
        runtimeAgentAttachments[runtimeAgent.instance_id] = resolved.attachments;
      }
      if (resolved.attachments.length > 0) {
        selectionReasonSummary[String(slot.slot_id || roleType)] = resolved.attachments
          .map((row) => `${row.skill_id}:${row.selection_reason || "selected"}`)
          .join("; ");
        if (!selectionReasonSummary[roleType]) {
          selectionReasonSummary[roleType] = selectionReasonSummary[String(slot.slot_id || roleType)];
        }
      }
    }

    return {
      slot_skill_map: slotSkillMap,
      role_skill_map: roleSkillMap,
      runtime_agent_skill_map: runtimeAgentAttachments,
      selection_reason_summary: selectionReasonSummary,
      selected_skill_ids: normalizeStringList(
        Object.values(slotSkillMap).flat().map((row) => row.skill_id),
        { max: 64, lower: true }
      ),
    };
  }
}
