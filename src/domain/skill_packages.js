import fs from "node:fs";
import path from "node:path";
import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleList } from "../compatibility/legacy_roles.js";

const VISIBILITY_VALUES = ["public", "internal", "private"];
const STATUS_VALUES = ["active", "experimental", "deprecated", "disabled"];
const KIND_VALUES = ["domain", "method", "tool", "policy"];
const ADAPTER_KIND_VALUES = ["prompt_only", "http_proxy", "python_cli", "local_mcp", "browser_rpa", "shell_command"];
const TRUST_LEVEL_VALUES = ["trusted", "reviewed", "experimental"];
const SIDE_EFFECT_LEVEL_VALUES = ["none", "read_only", "external_write", "transactional"];

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

function readFileWordCount(filePath = "") {
  const target = normalizeRef(filePath);
  if (!target) return 0;
  try {
    const text = fs.readFileSync(target, "utf8");
    return (String(text || "").match(/[\p{L}\p{N}_-]+/gu) || []).length;
  } catch {
    return 0;
  }
}

function inferDocumentationProfile({ skillDir = "", instructionsRef = "", resourceRefs = [] } = {}) {
  const instructionPath = skillDir && instructionsRef ? path.resolve(skillDir, instructionsRef) : "";
  const instructionWordCount = readFileWordCount(instructionPath);
  const resourceWordCount = asArray(resourceRefs).reduce((sum, ref) => {
    if (!skillDir || !ref) return sum;
    return sum + readFileWordCount(path.resolve(skillDir, ref));
  }, 0);
  const totalWordCount = instructionWordCount + resourceWordCount;
  const resourceCount = asArray(resourceRefs).length;
  let complexityBand = "compact";
  if (totalWordCount >= 2200 || resourceCount >= 4) complexityBand = "comprehensive";
  else if (totalWordCount >= 1200 || resourceCount >= 2) complexityBand = "detailed";
  else if (totalWordCount >= 450) complexityBand = "standard";
  return {
    instruction_word_count: instructionWordCount,
    resource_word_count: resourceWordCount,
    total_word_count: totalWordCount,
    resource_count: resourceCount,
    complexity_band: complexityBand,
  };
}

function normalizeWeight(raw, fallback = 1) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(10, value));
}

function normalizeStructuredList(raw = [], { max = 32 } = {}) {
  return asArray(raw).slice(0, max).filter((item) => item && typeof item === "object");
}

function normalizeAdapterKind(raw = "") {
  const value = normalizeText(raw, { lower: true });
  return ADAPTER_KIND_VALUES.includes(value) ? value : "prompt_only";
}

function normalizeTrustLevel(raw = "") {
  const value = normalizeText(raw, { lower: true });
  return TRUST_LEVEL_VALUES.includes(value) ? value : "reviewed";
}

function normalizeSideEffectLevel(raw = "") {
  const value = normalizeText(raw, { lower: true });
  return SIDE_EFFECT_LEVEL_VALUES.includes(value) ? value : "none";
}

function normalizeExecutionAdapter(raw = {}) {
  const row = asObject(raw);
  const runtimeCapabilitiesRequired = normalizeTagList(row.runtime_capabilities_required ?? row.runtimeCapabilitiesRequired ?? row.required_runtime_capabilities ?? []);
  const externalToolRequirements = normalizeTagList(row.external_tool_requirements ?? row.externalToolRequirements ?? row.required_external_tools ?? []);
  const adapter = {
    kind: normalizeAdapterKind(row.kind || row.adapter || row.type || row.mode),
    transport: normalizeText(row.transport || row.channel || row.protocol, { lower: true }) || undefined,
    entrypoint: normalizeRef(row.entrypoint || row.command || row.path || row.endpoint) || undefined,
    endpoint: normalizeRef(row.endpoint || row.url) || undefined,
    endpoint_env: normalizeText(row.endpoint_env || row.endpointEnv || row.url_env || row.urlEnv, { lower: false }) || undefined,
    working_directory: normalizeRef(row.working_directory || row.workingDirectory || row.cwd) || undefined,
    runtime_capabilities_required: runtimeCapabilitiesRequired,
    external_tool_requirements: externalToolRequirements,
    install_hint: normalizeText(row.install_hint || row.installHint) || undefined,
  };
  if (!adapter.entrypoint && !adapter.endpoint && adapter.kind === 'prompt_only') return { kind: 'prompt_only' };
  return adapter;
}

function normalizeCredentialRequirements(raw = []) {
  const out = [];
  const seen = new Set();
  for (const entry of normalizeStructuredList(raw, { max: 32 })) {
    const key = normalizeText(entry.key || entry.credential_key || entry.credentialKey || entry.env, { lower: false }).toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      key,
      kind: normalizeText(entry.kind || entry.type, { lower: true }) || 'api_key',
      required: entry.required !== false,
      delivery: normalizeText(entry.delivery || entry.delivery_method || entry.deliveryMethod, { lower: true }) || 'job_env',
      scope: normalizeText(entry.scope) || undefined,
      provider: normalizeText(entry.provider) || undefined,
      env_fallback: normalizeText(entry.env_fallback || entry.envFallback || entry.env, { lower: false }) || undefined,
      prompt: normalizeText(entry.prompt || entry.description) || undefined,
    });
  }
  return out;
}

function normalizeInstallRecipe(raw = {}) {
  const row = asObject(raw);
  return {
    setup_steps: normalizeRefList(row.setup_steps ?? row.setupSteps ?? []).slice(0, 64),
    python_packages: normalizeRefList(row.python_packages ?? row.pythonPackages ?? []).slice(0, 32),
    npm_packages: normalizeRefList(row.npm_packages ?? row.npmPackages ?? []).slice(0, 32),
    system_packages: normalizeRefList(row.system_packages ?? row.systemPackages ?? []).slice(0, 32),
    verify_commands: normalizeRefList(row.verify_commands ?? row.verifyCommands ?? []).slice(0, 32),
  };
}

function normalizeSourcePackage(raw = {}) {
  const row = asObject(raw);
  return {
    type: normalizeText(row.type || row.source_type || row.sourceType, { lower: true }) || 'catalog',
    repo_url: normalizeRef(row.repo_url || row.repoUrl || row.repository) || undefined,
    repo_path: normalizeRef(row.repo_path || row.repoPath || row.path) || undefined,
    homepage: normalizeRef(row.homepage) || undefined,
    license: normalizeText(row.license) || undefined,
  };
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
  const instructionsRef = normalizeRef(row.instructions_ref ?? row.instructionsRef ?? "SKILL.md");
  const resourceRefs = normalizeRefList(row.resource_refs ?? row.resourceRefs ?? []);
  const documentationProfile = inferDocumentationProfile({
    skillDir,
    instructionsRef,
    resourceRefs,
  });

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
    required_tools: normalizeTagList([
      ...(row.required_tools ?? row.requiredTools ?? []),
      ...(row.execution_adapter?.runtime_capabilities_required ?? row.executionAdapter?.runtimeCapabilitiesRequired ?? []),
      ...(row.execution_adapter?.external_tool_requirements ?? row.executionAdapter?.externalToolRequirements ?? []),
    ]),
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
    instructions_ref: instructionsRef,
    resource_refs: resourceRefs,
    utility_refs: normalizeRefList(row.utility_refs ?? row.utilityRefs ?? []),
    default_context_policy: asObject(row.default_context_policy ?? row.defaultContextPolicy),
    validation_policy: asObject(row.validation_policy ?? row.validationPolicy),
    safety_policy: asObject(row.safety_policy ?? row.safetyPolicy),
    execution_adapter: normalizeExecutionAdapter(row.execution_adapter ?? row.executionAdapter),
    credential_requirements: normalizeCredentialRequirements(row.credential_requirements ?? row.credentialRequirements ?? []),
    install_recipe: normalizeInstallRecipe(row.install_recipe ?? row.installRecipe),
    source_package: normalizeSourcePackage(row.source_package ?? row.sourcePackage),
    ranking_metadata: normalizeRankingMetadata(row.ranking_metadata ?? row.rankingMetadata),
    trust_level: normalizeTrustLevel(row.trust_level ?? row.trustLevel),
    side_effect_level: normalizeSideEffectLevel(row.side_effect_level ?? row.sideEffectLevel),
    visibility: normalizeVisibility(row.visibility),
    status: normalizeStatus(row.status),
    manifest_path: normalizeRef(manifestPath) || undefined,
    skill_dir: normalizeRef(skillDir) || undefined,
    documentation_profile: documentationProfile,
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
