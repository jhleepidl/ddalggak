import crypto from "node:crypto";
import { normalizeScopeHintCore as normalizeLensSpec } from "./scope_hint_core.js";
import { normalizeProviderName, normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "./skill_attachment.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";
import {
  createRuntimeAgentInstance as createNormalizedRuntimeAgentInstance,
} from "./runtime_agent.js";

const DEFAULT_ROLE_BY_ID = {
  researcher: "researcher",
  builder: "builder",
  coder: "builder",
  reviewer: "reviewer",
  verifier: "reviewer",
  synthesizer: "synthesizer",
  messenger: "synthesizer",
  operator: "operator",
  context_curator: "operator",
  planner: "planner",
  router: "planner",
};

const DEFAULT_CAPABILITY_TAGS = {
  researcher: ["research", "analysis", "risk_assessment"],
  builder: ["implementation", "coding", "refactoring"],
  reviewer: ["review", "qa", "verification"],
  synthesizer: ["communication", "summary", "handoff"],
  operator: ["context", "memory", "curation", "operations"],
  planner: ["planning", "routing", "prioritization"],
};

function inferRoleType(raw = {}) {
  const explicit = String(raw.role_type || raw.roleType || "").trim().toLowerCase();
  if (explicit) return explicit;
  const id = String(raw.id || raw.agent_id || raw.agentId || "").trim().toLowerCase();
  if (id && DEFAULT_ROLE_BY_ID[id]) return DEFAULT_ROLE_BY_ID[id];
  const systemKey = String(raw.system_key || raw.systemKey || "").trim().toLowerCase();
  if (systemKey && DEFAULT_ROLE_BY_ID[systemKey]) return DEFAULT_ROLE_BY_ID[systemKey];
  const provider = normalizeProviderName(raw.provider || raw.model || "codex");
  if (provider === "codex") return "builder";
  return "researcher";
}

function inferCapabilityTags(raw = {}, roleType = "") {
  const explicit = normalizeStringList(raw.capability_tags ?? raw.capabilityTags ?? [], {
    max: 32,
    lower: true,
  });
  if (explicit.length > 0) return explicit;

  const fromTools = normalizeStringList(raw.tools ?? raw.tool_ids ?? raw.toolIds ?? [], {
    max: 24,
    lower: true,
  });
  const base = DEFAULT_CAPABILITY_TAGS[roleType] || [];
  return normalizeStringList([...base, ...fromTools], { max: 32, lower: true });
}

export function normalizeAgentTemplate(raw = {}) {
  const row = raw && typeof raw === "object" ? raw : {};
  const id = String(row.id || row.agent_id || row.agentId || "").trim().toLowerCase();
  if (!id) return null;

  const provider = normalizeProviderName(row.provider || row.model || "codex");
  const model = String(row.model || provider).trim() || provider;
  const roleType = inferRoleType(row);
  const tools = normalizeStringList(row.tools ?? row.tool_ids ?? row.toolIds ?? [], {
    max: 32,
    lower: true,
  });

  const template = {
    id,
    name: String(row.name || row.title || id).trim() || id,
    role_type: roleType,
    description: String(row.description || "").trim(),
    capability_tags: inferCapabilityTags(row, roleType),
    provider,
    model,
    prompt: String(
      row.prompt
      || row.base_prompt
      || row.basePrompt
      || row.system_prompt
      || row.systemPrompt
      || row.instruction
      || ""
    ).trim(),
    tools,
    meta: row.meta && typeof row.meta === "object" ? row.meta : {},
  };

  if (!template.meta.legacy && (row.system_key || row.systemKey)) {
    template.meta = {
      ...template.meta,
      system_key: String(row.system_key || row.systemKey || "").trim().toLowerCase(),
    };
  }

  return template;
}

export function normalizeLegacyAgentToTemplate(raw = {}) {
  const template = normalizeAgentTemplate(raw);
  if (!template) return null;
  return {
    ...template,
    meta: {
      ...(template.meta || {}),
      legacy: true,
      legacy_id: String(raw.id || raw.agent_id || raw.agentId || "").trim().toLowerCase() || undefined,
    },
  };
}

export function normalizeAgentRegistryToTemplates(registry = {}) {
  const rows = Array.isArray(registry?.agents) ? registry.agents : [];
  const templates = [];
  const byId = new Map();
  for (const row of rows) {
    const template = normalizeLegacyAgentToTemplate(row);
    if (!template) continue;
    if (byId.has(template.id)) continue;
    byId.set(template.id, template);
    templates.push(template);
  }
  return {
    templates,
    byId,
  };
}

export function createRuntimeAgentInstance({
  template = null,
  templateId = "",
  runId = "",
  roleLabel = "",
  assignedGoal = "",
  lensSpec = null,
  status = "ready",
  capabilityTags = [],
  provider = "",
  model = "",
  attachedSkills = [],
  contextPackId = "",
  providerBinding = null,
  ephemeral = false,
  fallback = false,
  executionBudget = null,
} = {}) {
  const tpl = template && typeof template === "object" ? template : null;
  const cleanTemplateId = String(templateId || tpl?.id || "").trim().toLowerCase();
  const cleanProvider = String(provider || tpl?.provider || "codex").trim().toLowerCase() || "codex";
  const cleanModel = String(model || tpl?.model || cleanProvider).trim() || cleanProvider;
  const cleanRoleLabel = String(roleLabel || tpl?.role_type || tpl?.name || cleanTemplateId || "runtime_role").trim();
  const normalizedRoleId = normalizeRoleId(cleanRoleLabel || tpl?.role_type || cleanTemplateId);
  const cleanCapabilityTags = normalizeStringList(
    capabilityTags.length > 0 ? capabilityTags : (tpl?.capability_tags || []),
    { max: 32, lower: true }
  );

  const rawStatus = String(status || "ready").trim().toLowerCase();
  const instanceStatus = ["ready", "running", "done", "error", "disabled"].includes(rawStatus)
    ? rawStatus
    : "ready";

  return createNormalizedRuntimeAgentInstance({
    instance_id: `inst_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    run_id: String(runId || "").trim() || undefined,
    slot_id: undefined,
    role_id: normalizedRoleId || undefined,
    role_label: normalizedRoleId || cleanRoleLabel,
    display_label: normalizedRoleId || cleanRoleLabel,
    preset_id: cleanTemplateId || undefined,
    synthesized: false,
    template_id: cleanTemplateId,
    assigned_goal: String(assignedGoal || "").trim() || undefined,
    attached_skills: normalizeSkillAttachmentList(attachedSkills),
    context_pack_id: String(contextPackId || "").trim() || undefined,
    provider_binding: providerBinding && typeof providerBinding === "object"
      ? providerBinding
      : undefined,
    capability_tags: cleanCapabilityTags,
    provider: cleanProvider,
    model: cleanModel,
    lens_spec: normalizeLensSpec(lensSpec || {}),
    status: instanceStatus,
    ephemeral: ephemeral === true,
    fallback: fallback === true,
    execution_budget: executionBudget && typeof executionBudget === "object"
      ? executionBudget
      : undefined,
  });
}
