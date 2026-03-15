import { normalizeAgentRegistryToTemplates } from "../domain/agent_templates.js";
import { normalizeAgentPresetList } from "../domain/agent_presets.js";
import { normalizeRoleId } from "./legacy_roles.js";

function normalizeText(raw = "") {
  return String(raw || "").trim();
}

export function adaptLegacyAgentRegistry(raw = {}) {
  const templates = normalizeAgentRegistryToTemplates(raw);
  const presets = normalizeAgentPresetList(
    templates.templates.map((template) => ({
      preset_id: `legacy.${template.id}`,
      display_name: template.name,
      description: template.description,
      role_id: normalizeRoleId(template.role_type),
      default_skill_ids: [],
      optional_skill_ids: [],
      personality_profile: {},
      selection_features: {
        legacy_template_id: normalizeText(template.id),
        provider: normalizeText(template.provider),
        model: normalizeText(template.model),
      },
      retrieval_text: [
        template.name,
        template.description,
        ...(Array.isArray(template.capability_tags) ? template.capability_tags : []),
      ].filter(Boolean).join("\n"),
      source_dir: normalizeText(template.meta?.source_dir),
    }))
  );
  return {
    templates: templates.templates,
    templates_by_id: templates.byId,
    presets,
    presets_by_id: new Map(presets.map((preset) => [preset.preset_id, preset])),
  };
}
