import { normalizeStringList } from "../shared/normalize.js";
import { createRuntimeAgentInstance, normalizeRuntimeAgentInstance } from "../domain/runtime_agent.js";
import { getTransportRoleId, normalizeRoleId } from "../compatibility/legacy_roles.js";
import { adaptLegacyAgentRegistry } from "../compatibility/legacy_agent_registry_adapter.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function tokenize(text = "") {
  return normalizeStringList(
    normalizeText(text, { lower: true }).split(/[^a-z0-9가-힣._-]+/g),
    { max: 256, lower: true }
  );
}

function semanticOverlap(a = "", b = "") {
  const left = new Set(tokenize(a));
  const right = tokenize(b);
  let score = 0;
  for (const token of right) {
    if (left.has(token)) score += 1;
  }
  return score;
}

function normalizeLocaleList(raw = []) {
  return normalizeStringList(raw, { max: 8, lower: false });
}

function requiredSkillCoverage(slot = {}, preset = {}) {
  const required = new Set(asArray(slot.required_skill_ids).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  if (required.size === 0) return { ok: true, count: 0 };
  const supported = new Set([
    ...asArray(preset.default_skill_ids),
    ...asArray(preset.optional_skill_ids),
  ].map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  let count = 0;
  for (const skillId of required) {
    if (supported.has(skillId)) count += 1;
  }
  return {
    ok: count === required.size,
    count,
  };
}

function preferredSkillCoverage(slot = {}, preset = {}) {
  const preferred = new Set(asArray(slot.preferred_skill_ids).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  if (preferred.size === 0) return 0;
  const supported = new Set([
    ...asArray(preset.default_skill_ids),
    ...asArray(preset.optional_skill_ids),
  ].map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  let count = 0;
  for (const skillId of preferred) {
    if (supported.has(skillId)) count += 1;
  }
  return count;
}

function toolAvailabilityOk(slot = {}, preset = {}, availableToolIds = []) {
  const requiredToolIds = new Set(asArray(slot.required_tool_ids).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  if (requiredToolIds.size === 0) return true;
  const available = new Set(normalizeStringList(availableToolIds, { max: 32, lower: true }));
  const hinted = new Set(normalizeStringList(
    preset.selection_features?.tool_hints || preset.tool_hints || [],
    { max: 16, lower: true }
  ));
  for (const toolId of requiredToolIds) {
    if (!available.has(toolId) && !hinted.has(toolId)) return false;
  }
  return true;
}

function localeFit(taskInterpretation = {}, preset = {}) {
  const preferredLocales = normalizeLocaleList(taskInterpretation?.preferred_locales || []);
  if (preferredLocales.length === 0) return { ok: true, score: 0 };
  const presetLocale = normalizeText(preset.locale);
  if (!presetLocale) return { ok: true, score: 0 };
  if (preferredLocales.includes(presetLocale)) return { ok: true, score: 8 };
  return { ok: false, score: -6 };
}

function policyCompatibility(taskInterpretation = {}, preset = {}) {
  const reviewPolicy = normalizeText(taskInterpretation?.review_policy, { lower: true });
  const profileText = [
    preset.description,
    preset.retrieval_text,
    ...asArray(preset.selection_features?.policy_hints),
  ].filter(Boolean).join("\n").toLowerCase();
  if (reviewPolicy === "claim_heavy" && !profileText.includes("claim") && !profileText.includes("evidence")) {
    return false;
  }
  return true;
}

function domainFit(taskInterpretation = {}, preset = {}) {
  const preferred = new Set(asArray(taskInterpretation?.preferred_domains).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  const presetDomains = new Set(asArray(preset.selection_features?.domain_hints).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));
  let count = 0;
  for (const domain of preferred) {
    if (presetDomains.has(domain)) count += 1;
  }
  return count;
}

function costPenalty(preset = {}) {
  const provider = normalizeText(
    preset.selection_features?.provider || preset.selection_features?.model,
    { lower: true }
  );
  if (provider.includes("codex")) return 4;
  return 1;
}

function buildCandidateList({
  presetRegistry = null,
  registry = null,
  roleId = "",
} = {}) {
  const candidates = [];
  if (presetRegistry && typeof presetRegistry.list === "function") {
    candidates.push(...presetRegistry.list({ roleId }));
  }
  if (registry && typeof registry === "object") {
    const legacy = adaptLegacyAgentRegistry(registry);
    candidates.push(...legacy.presets.filter((preset) => normalizeRoleId(preset.role_id) === normalizeRoleId(roleId)));
  }
  const byId = new Map();
  for (const preset of candidates) {
    const key = normalizeText(preset?.preset_id, { lower: true });
    if (!key || byId.has(key)) continue;
    byId.set(key, preset);
  }
  return [...byId.values()];
}

export function scorePresetForTask({
  preset = {},
  slot = {},
  taskInterpretation = {},
  goal = "",
  reusePresetIds = [],
} = {}) {
  const requiredCoverage = requiredSkillCoverage(slot, preset);
  const preferredCoverage = preferredSkillCoverage(slot, preset);
  const semanticScore = semanticOverlap(
    [
      goal,
      taskInterpretation?.task_summary,
      taskInterpretation?.goal,
      slot?.purpose,
      ...(taskInterpretation?.domain_hints || []),
    ].filter(Boolean).join("\n"),
    [
      preset.description,
      preset.retrieval_text,
      ...(preset.examples || []),
    ].filter(Boolean).join("\n")
  );
  const domainScore = domainFit(taskInterpretation, preset) * 6;
  const locale = localeFit(taskInterpretation, preset);
  const reuseBonus = asArray(reusePresetIds).includes(preset.preset_id)
    || asArray(taskInterpretation?.pinned_preset_ids).includes(preset.preset_id)
    ? 15
    : 0;
  const score = (
    (requiredCoverage.count * 30)
    + (preferredCoverage * 10)
    + Math.min(24, semanticScore * 2)
    + domainScore
    + locale.score
    + reuseBonus
    - costPenalty(preset)
  );
  return {
    score,
    required_coverage: requiredCoverage.count,
    preferred_coverage: preferredCoverage,
    semantic_score: semanticScore,
    domain_score: domainScore,
    locale_score: locale.score,
    reuse_bonus: reuseBonus,
  };
}

function presetPassesFilters({
  preset = {},
  slot = {},
  taskInterpretation = {},
  availableToolIds = [],
} = {}) {
  if (normalizeRoleId(preset.role_id) !== normalizeRoleId(slot.role_id)) return false;
  if (!requiredSkillCoverage(slot, preset).ok) return false;
  if (!toolAvailabilityOk(slot, preset, availableToolIds)) return false;
  if (!localeFit(taskInterpretation, preset).ok) return false;
  if (!policyCompatibility(taskInterpretation, preset)) return false;
  return true;
}

export class PresetResolver {
  constructor({
    presetRegistry = null,
    registry = null,
    threshold = 35,
  } = {}) {
    this.presetRegistry = presetRegistry || null;
    this.registry = registry || null;
    this.threshold = Number.isFinite(Number(threshold)) ? Number(threshold) : 35;
  }

  resolveForSlot({
    slot = {},
    taskInterpretation = {},
    goal = "",
    registry = null,
    availableToolIds = [],
    reusePresetIds = [],
  } = {}) {
    const candidates = buildCandidateList({
      presetRegistry: this.presetRegistry,
      registry: registry || this.registry,
      roleId: slot.role_id,
    }).filter((preset) => !asArray(taskInterpretation?.banned_preset_ids).includes(preset.preset_id));
    const filtered = candidates.filter((preset) => presetPassesFilters({
      preset,
      slot,
      taskInterpretation,
      availableToolIds,
    }));
    const scored = filtered.map((preset) => ({
      preset,
      ...scorePresetForTask({
        preset,
        slot,
        taskInterpretation,
        goal,
        reusePresetIds,
      }),
    })).sort((a, b) => b.score - a.score);
    const best = scored[0] || null;
    return {
      preset: best && best.score >= this.threshold ? best.preset : null,
      scored_candidates: scored,
    };
  }

  resolveForTeam({
    teamPlan = null,
    taskInterpretation = {},
    goal = "",
    registry = null,
    availableToolIds = [],
  } = {}) {
    const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
    const slots = asArray(plan.slots);
    const runtimeAgents = [];
    const selectionExplanations = [];
    const missingRoles = [];
    const slotPresetMap = {};
    const scoredCandidatesBySlot = {};

    for (const slot of slots) {
      const resolved = this.resolveForSlot({
        slot,
        taskInterpretation,
        goal,
        registry,
        availableToolIds,
        reusePresetIds: taskInterpretation?.pinned_preset_ids || [],
      });
      const selectedPreset = resolved.preset;
      const selectionReason = selectedPreset
        ? `preset_match:${selectedPreset.preset_id}`
        : `preset_synthesized:${slot.role_id}`;
      scoredCandidatesBySlot[slot.slot_id] = resolved.scored_candidates.map((entry) => ({
        preset_id: entry.preset.preset_id,
        score: entry.score,
      }));
      slotPresetMap[slot.slot_id] = selectedPreset ? selectedPreset.preset_id : null;
      if (!selectedPreset) missingRoles.push(slot.role_id);
      runtimeAgents.push(createRuntimeAgentInstance({
        slot_id: slot.slot_id,
        role_id: slot.role_id,
        role_label: slot.role_id,
        display_label: selectedPreset?.display_name || slot.role_id,
        preset_id: selectedPreset?.preset_id ?? null,
        synthesized: !selectedPreset,
        attached_skills: [],
        attached_skill_ids: [],
        context_pack_id: undefined,
        authority_profile_id: slot.authority_profile_id,
        selection_reason: selectionReason,
        template_id: normalizeText(
          selectedPreset?.selection_features?.legacy_template_id
          || selectedPreset?.selection_features?.template_id
          || (selectedPreset?.preset_id?.startsWith("legacy.") ? selectedPreset.preset_id.slice("legacy.".length) : "")
          || getTransportRoleId(slot.role_id),
          { lower: true }
        ) || undefined,
        provider: normalizeText(selectedPreset?.selection_features?.provider, { lower: true }) || undefined,
        model: normalizeText(selectedPreset?.selection_features?.model) || undefined,
        assigned_goal: goal || slot.purpose,
        ephemeral: selectedPreset == null,
        fallback: selectedPreset == null,
        status: "ready",
      }));
      selectionExplanations.push({
        subject_id: slot.slot_id,
        reason: selectionReason,
      });
    }

    return {
      runtime_agents: runtimeAgents.map((agent) => normalizeRuntimeAgentInstance(agent)),
      selection_explanations: selectionExplanations,
      slot_preset_map: slotPresetMap,
      scored_candidates_by_slot: scoredCandidatesBySlot,
      missing_roles: normalizeStringList(missingRoles, { max: 16, lower: true }),
    };
  }
}
