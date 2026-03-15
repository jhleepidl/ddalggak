import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleList } from "../compatibility/legacy_roles.js";

const VISIBILITY_VALUES = ["public", "internal", "private"];
const STATUS_VALUES = ["active", "experimental", "deprecated", "disabled"];
const KIND_VALUES = ["domain", "method", "tool", "policy"];

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function asObject(raw) {
  return raw && typeof raw === "object" ? raw : {};
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function normalizeVersion(raw = "") {
  const value = normalizeText(raw);
  if (!value) return "1.0.0";
  return value;
}

function normalizeRef(raw = "") {
  return normalizeText(raw);
}

function normalizeRefList(raw = []) {
  return normalizeStringList(asArray(raw).map(normalizeRef), {
    max: 64,
    lower: false,
  });
}

function normalizeVisibility(raw = "") {
  const value = normalizeText(raw, { lower: true });
  return VISIBILITY_VALUES.includes(value) ? value : "internal";
}

function normalizeStatus(raw = "") {
  const value = normalizeText(raw, { lower: true });
  return STATUS_VALUES.includes(value) ? value : "active";
}

function normalizeSkillId(raw = "") {
  return normalizeText(raw, { lower: true });
}

function normalizeSlug(raw = "") {
  return normalizeText(raw, { lower: true })
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function inferSkillId({
  id = "",
  slug = "",
  version = "",
} = {}) {
  const cleanId = normalizeSkillId(id);
  if (cleanId) return cleanId;
  const cleanSlug = normalizeSlug(slug || "skill");
  const major = String(normalizeVersion(version).split(".")[0] || "1").replace(/[^0-9]/g, "") || "1";
  return `skill.${cleanSlug}.v${major}`;
}

function normalizeRankingMetadata(raw = {}) {
  const row = asObject(raw);
  const successRate = Number(row.success_rate ?? row.successRate);
  const usageCount = Number(row.usage_count ?? row.usageCount);
  const risk = normalizeText(row.risk || row.risk_level, { lower: true }) || undefined;
  return {
    success_rate: Number.isFinite(successRate) ? Math.max(0, Math.min(1, successRate)) : undefined,
    usage_count: Number.isFinite(usageCount) ? Math.max(0, Math.floor(usageCount)) : undefined,
    risk,
  };
}

function normalizeKind(raw = "", category = "") {
  const value = normalizeText(raw, { lower: true });
  if (KIND_VALUES.includes(value)) return value;
  const categoryKey = normalizeText(category, { lower: true });
  if (["policy", "safety"].includes(categoryKey)) return "policy";
  if (["tool", "tools", "utility"].includes(categoryKey)) return "tool";
  if (["finance", "equity", "research", "domain"].includes(categoryKey)) return "domain";
  return "method";
}

function normalizeWeight(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(10, value));
}

function normalizeTagList(raw = []) {
  return normalizeStringList(raw, { max: 64, lower: true });
}

export function normalizeSkillPackage(raw = {}, {
  manifestPath = "",
  skillDir = "",
} = {}) {
  const row = asObject(raw);
  const slug = normalizeSlug(row.slug || row.name || row.id);
  if (!slug) return null;

  const version = normalizeVersion(row.version);
  const id = inferSkillId({
    id: row.id || row.skill_id || row.skillId,
    slug,
    version,
  });
  const capabilityTags = normalizeTagList(row.capability_tags ?? row.capabilityTags ?? []);
  const tags = normalizeTagList([...(row.tags || []), ...capabilityTags]);
  const compatibleRoles = normalizeRoleList(
    row.compatible_roles ?? row.compatibleRoles ?? [],
    { allowDeprecatedControlPlane: true, max: 24 }
  );

  return {
    id,
    skill_id: id,
    slug,
    name: normalizeText(row.name || row.title || slug) || slug,
    title: normalizeText(row.title || row.name || slug) || slug,
    version,
    description: normalizeText(row.description),
    category: normalizeText(row.category, { lower: true }) || "general",
    kind: normalizeKind(row.kind, row.category),
    tags,
    required_tools: normalizeTagList(row.required_tools ?? row.requiredTools ?? []),
    required_context_types: normalizeTagList(
      row.required_context_types ?? row.requiredContextTypes ?? []
    ),
    compatible_roles: compatibleRoles,
    conflicts_with: normalizeTagList(row.conflicts_with ?? row.conflictsWith ?? []),
    cost_weight: normalizeWeight(row.cost_weight ?? row.costWeight, 1),
    quality_weight: normalizeWeight(row.quality_weight ?? row.qualityWeight, 1),
    capability_tags: capabilityTags,
    trigger_terms: normalizeTagList(row.trigger_terms ?? row.triggerTerms ?? []),
    input_contract: asObject(row.input_contract ?? row.inputContract),
    output_contract: asObject(row.output_contract ?? row.outputContract),
    instructions_ref: normalizeRef(row.instructions_ref ?? row.instructionsRef ?? "SKILL.md"),
    resource_refs: normalizeRefList(row.resource_refs ?? row.resourceRefs ?? []),
    utility_refs: normalizeRefList(row.utility_refs ?? row.utilityRefs ?? []),
    default_context_policy: asObject(row.default_context_policy ?? row.defaultContextPolicy),
    validation_policy: asObject(row.validation_policy ?? row.validationPolicy),
    safety_policy: asObject(row.safety_policy ?? row.safetyPolicy),
    ranking_metadata: normalizeRankingMetadata(row.ranking_metadata ?? row.rankingMetadata),
    visibility: normalizeVisibility(row.visibility),
    status: normalizeStatus(row.status),
    manifest_path: normalizeRef(manifestPath) || undefined,
    skill_dir: normalizeRef(skillDir) || undefined,
  };
}

export function normalizeSkillPackageList(list = [], options = {}) {
  const byId = new Map();
  for (const row of asArray(list)) {
    const normalized = normalizeSkillPackage(row, options);
    if (!normalized) continue;
    if (byId.has(normalized.id)) continue;
    byId.set(normalized.id, normalized);
  }
  return [...byId.values()];
}

export function validateSkillPackage(raw = {}) {
  const skill = normalizeSkillPackage(raw);
  const errors = [];
  if (!skill) errors.push("invalid_skill_package");
  if (skill && !skill.instructions_ref) errors.push("instructions_ref_required");
  return {
    ok: errors.length === 0,
    errors,
    skill_package: skill,
  };
}
