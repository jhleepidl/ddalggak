import { normalizeStringList } from "../shared/normalize.js";
import { normalizeAgentPreset } from "../domain/agent_presets.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";
import { isKrEquityRequest } from "../shared/skill_relevance.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function tokenizeHints(raw = []) {
  return normalizeStringList(raw, { max: 32, lower: true });
}

function inferSkillIds(spec = {}) {
  const source = [
    spec.preset_id,
    spec.display_name,
    spec.description,
    ...(Array.isArray(spec.domain_hints) ? spec.domain_hints : []),
    ...(Array.isArray(spec.method_hints) ? spec.method_hints : []),
    ...(Array.isArray(spec.tool_hints) ? spec.tool_hints : []),
    ...(Array.isArray(spec.policy_hints) ? spec.policy_hints : []),
    ...(Array.isArray(spec.examples) ? spec.examples : []),
    spec.prompt_text,
  ].join("\n").toLowerCase();
  const defaults = [];
  const optional = [];

  if (source.includes("claim") || source.includes("evidence") || source.includes("skeptical")) {
    defaults.push("skill.claim_evidence_audit.v1");
  }
  if (isKrEquityRequest(source)) {
    defaults.push("skill.kr_equity_analysis.v1");
  }
  if (source.includes("telegram") || source.includes("brief")) {
    optional.push("skill.telegram_briefing.v1");
  }
  if (source.includes("context")) {
    optional.push("skill.context_selection_policy.v1");
  }
  if (source.includes("membership") || source.includes("reconciliation")) {
    optional.push("skill.thread_team_reconciliation.v1");
  }

  return {
    default_skill_ids: normalizeStringList(defaults, { max: 12, lower: true }),
    optional_skill_ids: normalizeStringList(optional, { max: 12, lower: true }),
  };
}

export function compilePresetSpec(spec = {}) {
  const row = spec && typeof spec === "object" ? spec : {};
  const inferredSkills = inferSkillIds(row);
  const roleId = normalizeRoleId(row.role_hint || row.roleHint || row.role_id || row.roleId);
  const personality = normalizeText(row.personality);
  const selectionFeatures = {
    domain_hints: tokenizeHints(row.domain_hints ?? row.domainHints ?? []),
    method_hints: tokenizeHints(row.method_hints ?? row.methodHints ?? []),
    tool_hints: tokenizeHints(row.tool_hints ?? row.toolHints ?? []),
    policy_hints: tokenizeHints(row.policy_hints ?? row.policyHints ?? []),
    locale: normalizeText(row.locale),
    collaboration_defaults: row.collaboration_defaults && typeof row.collaboration_defaults === "object"
      ? row.collaboration_defaults
      : (row.collaborationDefaults && typeof row.collaborationDefaults === "object" ? row.collaborationDefaults : {}),
  };
  return normalizeAgentPreset({
    preset_id: row.preset_id,
    display_name: row.display_name || row.displayName,
    description: row.description,
    examples: row.examples,
    role_id: roleId,
    default_skill_ids: [
      ...inferredSkills.default_skill_ids,
      ...(Array.isArray(row.default_skill_ids) ? row.default_skill_ids : []),
      ...(Array.isArray(row.defaultSkillIds) ? row.defaultSkillIds : []),
    ],
    optional_skill_ids: [
      ...inferredSkills.optional_skill_ids,
      ...(Array.isArray(row.optional_skill_ids) ? row.optional_skill_ids : []),
      ...(Array.isArray(row.optionalSkillIds) ? row.optionalSkillIds : []),
    ],
    personality_profile: {
      summary: personality,
      style_tags: tokenizeHints(personality.split(/[^a-z0-9가-힣_-]+/g)),
    },
    selection_features: selectionFeatures,
    retrieval_text: [
      normalizeText(row.display_name || row.displayName),
      normalizeText(row.description),
      ...(Array.isArray(row.examples) ? row.examples : []),
      normalizeText(row.prompt_text || row.promptText),
    ].filter(Boolean).join("\n"),
    locale: row.locale,
    instructions_ref: row.instructions_ref || row.instructionsRef,
    prompt_text: row.prompt_text || row.promptText,
    collaboration_defaults: selectionFeatures.collaboration_defaults,
    source_dir: row.source_dir || row.sourceDir,
  });
}

export function compilePresetSpecList(list = []) {
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const compiled = compilePresetSpec(row);
    if (!compiled) continue;
    out.push(compiled);
  }
  return out;
}
