import {
  createRuntimeAgentInstance,
  normalizeAgentRegistryToTemplates,
  normalizeAgentTemplate,
} from "../domain/agent_templates.js";
import { defaultLensSpecForRole } from "../domain/lens.js";
import { normalizeTeamPlan } from "../domain/team_plan.js";
import { normalizeStringList } from "../shared/normalize.js";

const DEFAULT_ROLE_ORDER = [
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "verifier",
  "context_curator",
  "messenger",
];

const ROLE_CAPABILITY_HINTS = {
  planner: ["planning", "routing", "prioritization"],
  researcher: ["research", "analysis", "fact_check"],
  coder: ["implementation", "coding", "patch"],
  reviewer: ["review", "qa", "regression"],
  verifier: ["verification", "validation", "tests"],
  messenger: ["summary", "communication"],
  context_curator: ["context", "memory", "curation"],
};

function buildKeywordMatcher(text = "") {
  const src = String(text || "").toLowerCase();
  return (keywords = []) => keywords.some((keyword) => src.includes(keyword));
}

export function inferRuntimeRolesForGoal(goal = "", { routeContext = null } = {}) {
  const text = String(goal || "").trim();
  const has = buildKeywordMatcher(text);
  const roles = ["planner"];

  const needsResearch = has(["research", "조사", "분석", "리서치", "fact", "검증", "search", "web"]);
  const needsCoding = has(["code", "코드", "구현", "개발", "refactor", "fix", "bug", "patch", "ipynb", "노트북"]);
  const needsReview = has(["review", "리뷰", "검토", "qa", "test", "테스트", "verify", "검증"]);

  if (needsResearch || (!needsCoding && text.length > 0)) roles.push("researcher");
  if (needsCoding) roles.push("coder");
  if (needsReview || needsCoding) roles.push("reviewer");

  const routeActions = Array.isArray(routeContext?.actions) ? routeContext.actions : [];
  for (const action of routeActions) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type === "run_agent") {
      const target = String(action?.agent_id || action?.agent || "").trim().toLowerCase();
      if (["planner", "researcher", "coder", "reviewer", "verifier"].includes(target)) roles.push(target);
    }
  }

  roles.push("context_curator", "messenger");
  return normalizeStringList(roles, { max: 12, lower: true });
}

function scoreTemplateForRole(role = "", template = {}) {
  const cleanRole = String(role || "").trim().toLowerCase();
  const roleType = String(template?.role_type || "").trim().toLowerCase();
  const id = String(template?.id || "").trim().toLowerCase();
  const caps = new Set(normalizeStringList(template?.capability_tags || [], { max: 32, lower: true }));
  let score = 0;

  if (id === cleanRole) score += 100;
  if (roleType === cleanRole) score += 80;
  if (id.startsWith(`${cleanRole}_`) || id.endsWith(`_${cleanRole}`)) score += 40;
  if (String(template?.provider || "") === "codex" && cleanRole === "coder") score += 20;
  if (String(template?.provider || "") === "gemini" && cleanRole === "researcher") score += 12;
  if (String(template?.provider || "") === "chatgpt" && cleanRole === "planner") score += 8;

  const hints = ROLE_CAPABILITY_HINTS[cleanRole] || [];
  for (const hint of hints) {
    if (caps.has(hint)) score += 6;
  }

  return score;
}

function pickTemplateForRole(role = "", templates = [], usedTemplateIds = new Set()) {
  const cleanRole = String(role || "").trim().toLowerCase();
  let best = null;
  for (const template of templates) {
    const id = String(template?.id || "").trim().toLowerCase();
    if (!id || usedTemplateIds.has(id)) continue;
    const score = scoreTemplateForRole(cleanRole, template);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { template, score };
  }
  return best ? best.template : null;
}

function buildDependencies(roleIds = []) {
  const clean = normalizeStringList(roleIds, { max: 16, lower: true });
  const edges = [];
  const has = (role) => clean.includes(role);

  if (has("planner") && has("researcher")) edges.push({ from: "planner", to: "researcher" });
  if (has("planner") && has("coder")) edges.push({ from: "planner", to: "coder" });
  if (has("researcher") && has("coder")) edges.push({ from: "researcher", to: "coder" });
  if (has("coder") && has("reviewer")) edges.push({ from: "coder", to: "reviewer" });
  if (has("reviewer") && has("messenger")) edges.push({ from: "reviewer", to: "messenger" });
  if (has("context_curator") && has("messenger")) edges.push({ from: "context_curator", to: "messenger" });

  return edges;
}

export function buildTeamFromTemplates({
  goal = "",
  routeContext = null,
  templates = [],
  mode = "balanced",
  preferredRoles = [],
  maxAgents = 6,
} = {}) {
  const knownTemplates = (Array.isArray(templates) ? templates : [])
    .map((row) => normalizeAgentTemplate(row))
    .filter(Boolean);

  const inferredRoles = inferRuntimeRolesForGoal(goal, { routeContext });
  const requestedRoles = normalizeStringList(preferredRoles, { max: 12, lower: true });
  const roles = normalizeStringList([
    ...requestedRoles,
    ...DEFAULT_ROLE_ORDER.filter((role) => inferredRoles.includes(role)),
  ], { max: Math.max(1, Math.floor(Number(maxAgents) || 6)), lower: true });

  const usedTemplateIds = new Set();
  const runtimeAgents = [];
  const planRoles = [];
  const missingRoles = [];

  for (const role of roles) {
    const matched = pickTemplateForRole(role, knownTemplates, usedTemplateIds);
    if (matched) {
      usedTemplateIds.add(matched.id);
      const instance = createRuntimeAgentInstance({
        template: matched,
        roleLabel: role,
        assignedGoal: goal,
        capabilityTags: matched.capability_tags,
        provider: matched.provider,
        model: matched.model,
        lensSpec: defaultLensSpecForRole({ roleType: role, goal }),
        status: "ready",
      });
      runtimeAgents.push(instance);
      planRoles.push({
        id: role,
        role_type: role,
        role_label: role,
        assigned_goal: goal,
        capability_tags: matched.capability_tags,
        template_id: matched.id,
        provider: matched.provider,
        model: matched.model,
      });
      continue;
    }

    if (["messenger", "context_curator"].includes(role)) {
      const fallbackTemplate = pickTemplateForRole("planner", knownTemplates, usedTemplateIds)
        || pickTemplateForRole("researcher", knownTemplates, usedTemplateIds)
        || null;
      const instance = createRuntimeAgentInstance({
        template: fallbackTemplate,
        templateId: fallbackTemplate?.id || `${role}_ephemeral`,
        roleLabel: role,
        assignedGoal: goal,
        capabilityTags: [...(ROLE_CAPABILITY_HINTS[role] || []), ...(fallbackTemplate?.capability_tags || [])],
        provider: fallbackTemplate?.provider || "gemini",
        model: fallbackTemplate?.model || "gemini",
        lensSpec: defaultLensSpecForRole({ roleType: role, goal }),
        status: "ready",
      });
      runtimeAgents.push(instance);
      planRoles.push({
        id: role,
        role_type: role,
        role_label: role,
        assigned_goal: goal,
        capability_tags: instance.capability_tags,
        template_id: fallbackTemplate?.id || undefined,
        provider: instance.provider,
        model: instance.model,
      });
      continue;
    }

    missingRoles.push(role);
  }

  const teamPlan = normalizeTeamPlan({
    mode,
    roles: planRoles,
    dependencies: buildDependencies(planRoles.map((role) => role.id)),
    execution_order: planRoles.map((role) => role.id),
    reason: missingRoles.length > 0
      ? `matched=${runtimeAgents.length}, missing=${missingRoles.join(",")}`
      : `matched=${runtimeAgents.length}`,
    budget: {
      max_agents: Math.max(1, Math.floor(Number(maxAgents) || 6)),
      max_actions: 8,
      preferred_provider_mix: normalizeStringList(runtimeAgents.map((row) => row.provider), { max: 8, lower: true }),
    },
  });

  return {
    team_plan: teamPlan,
    runtime_agents: runtimeAgents,
    missing_roles: missingRoles,
    selected_template_ids: runtimeAgents.map((row) => row.template_id).filter(Boolean),
    reason: teamPlan.reason,
  };
}

export function buildTeamFromRegistry({
  goal = "",
  routeContext = null,
  registry = null,
  mode = "balanced",
  preferredRoles = [],
  maxAgents = 6,
} = {}) {
  const normalizedRegistry = normalizeAgentRegistryToTemplates(registry || {});
  return buildTeamFromTemplates({
    goal,
    routeContext,
    templates: normalizedRegistry.templates,
    mode,
    preferredRoles,
    maxAgents,
  });
}
