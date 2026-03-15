import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function buildRetrievalText(row = {}) {
  const parts = [
    row.display_name,
    row.description,
    ...(Array.isArray(row.examples) ? row.examples : []),
    ...(Array.isArray(row.domain_hints) ? row.domain_hints : []),
    ...(Array.isArray(row.method_hints) ? row.method_hints : []),
    ...(Array.isArray(row.tool_hints) ? row.tool_hints : []),
    ...(Array.isArray(row.policy_hints) ? row.policy_hints : []),
    normalizeText(row.prompt_text || row.promptText),
  ].filter(Boolean);
  return parts.join("\n").trim();
}

export function normalizeAgentPreset(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const presetId = normalizeText(row.preset_id || row.presetId || row.id).toLowerCase();
  if (!presetId) return null;
  const roleId = normalizeRoleId(row.role_id || row.roleId || row.role_hint || row.roleHint);
  return {
    preset_id: presetId,
    display_name: normalizeText(row.display_name || row.displayName || row.name || presetId) || presetId,
    description: normalizeText(row.description),
    examples: normalizeStringList(row.examples ?? [], { max: 24, lower: false }),
    role_id: roleId || undefined,
    default_skill_ids: normalizeStringList(
      row.default_skill_ids ?? row.defaultSkillIds ?? [],
      { max: 24, lower: true }
    ),
    optional_skill_ids: normalizeStringList(
      row.optional_skill_ids ?? row.optionalSkillIds ?? [],
      { max: 24, lower: true }
    ),
    personality_profile: asObject(row.personality_profile ?? row.personalityProfile),
    selection_features: asObject(row.selection_features ?? row.selectionFeatures),
    retrieval_text: normalizeText(row.retrieval_text || row.retrievalText || buildRetrievalText(row)),
    locale: normalizeText(row.locale),
    instructions_ref: normalizeText(row.instructions_ref || row.instructionsRef) || undefined,
    prompt_text: normalizeText(row.prompt_text || row.promptText) || undefined,
    collaboration_defaults: asObject(row.collaboration_defaults ?? row.collaborationDefaults),
    source_dir: normalizeText(row.source_dir || row.sourceDir) || undefined,
  };
}

export function normalizeAgentPresetList(list = []) {
  const seen = new Set();
  const out = [];
  for (const row of Array.isArray(list) ? list : []) {
    const normalized = normalizeAgentPreset(row);
    if (!normalized || seen.has(normalized.preset_id)) continue;
    seen.add(normalized.preset_id);
    out.push(normalized);
  }
  return out;
}
