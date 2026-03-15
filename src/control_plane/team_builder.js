import {
  normalizeAgentRegistryToTemplates,
  normalizeAgentTemplate,
} from "../domain/agent_templates.js";
import { normalizeTeamPlan } from "../domain/team_plan.js";
import { createRuntimeAgentInstance } from "../domain/runtime_agent.js";
import { normalizeStringList } from "../shared/normalize.js";
import {
  getTransportRoleId,
  normalizeRoleId,
  normalizeWorkerRoleId,
} from "../compatibility/legacy_roles.js";
import { pickDefaultAuthorityProfileId } from "../catalog/authority_registry.js";
import { interpretTask } from "./task_interpreter.js";
import { createSupervisorRuntime } from "./supervisor_runtime.js";
import { buildCollaborationCells } from "./collaboration_policy.js";
import { buildExecutionCheckpoints } from "./checkpoint_policy.js";

const DEFAULT_ROLE_ORDER = [
  "operator",
  "researcher",
  "builder",
  "reviewer",
  "synthesizer",
];

const ROLE_CAPABILITY_HINTS = {
  researcher: ["research", "analysis", "fact_check"],
  builder: ["implementation", "coding", "patch"],
  reviewer: ["review", "qa", "regression"],
  synthesizer: ["summary", "briefing", "handoff"],
  operator: ["operations", "context", "runtime"],
};

function buildKeywordMatcher(text = "") {
  const src = String(text || "").toLowerCase();
  return (keywords = []) => keywords.some((keyword) => src.includes(keyword));
}

function normalizePreferredRoles(preferredRoles = []) {
  return normalizeStringList(
    (Array.isArray(preferredRoles) ? preferredRoles : [])
      .map((role) => normalizeWorkerRoleId(role))
      .filter(Boolean),
    { max: 12, lower: true }
  );
}

export function inferRuntimeRolesForGoal(goal = "", { routeContext = null } = {}) {
  const text = String(goal || "").trim();
  const has = buildKeywordMatcher(text);
  const roles = [];

  const needsResearch = has(["research", "조사", "분석", "리서치", "fact", "검증", "search", "web"]);
  const needsBuild = has(["code", "코드", "구현", "개발", "refactor", "fix", "bug", "patch", "ipynb", "노트북"]);
  const needsReview = has(["review", "리뷰", "검토", "qa", "test", "테스트", "verify", "검증"]);
  const needsSynthesis = has(["summary", "brief", "telegram", "요약", "정리", "보고", "handoff"]);
  const needsOperations = has(["membership", "context", "operator", "runtime", "lifecycle", "polling", "shutdown", "trace", "debug", "upload"]);

  if (needsOperations) roles.push("operator");
  if (needsResearch || (!needsBuild && !needsSynthesis && text.length > 0)) roles.push("researcher");
  if (needsBuild) roles.push("builder");
  if (needsReview || needsBuild) roles.push("reviewer");
  if (needsSynthesis) roles.push("synthesizer");

  const routeActions = Array.isArray(routeContext?.actions) ? routeContext.actions : [];
  for (const action of routeActions) {
    const type = String(action?.type || "").trim().toLowerCase();
    if (type !== "run_agent" && type !== "agent_run") continue;
    const target = normalizeWorkerRoleId(
      action?.agent_id
      || action?.agent
      || action?.role
      || action?.role_id
    );
    if (target) roles.push(target);
  }

  if (roles.length === 0) roles.push("researcher");
  return normalizeStringList(
    DEFAULT_ROLE_ORDER.filter((role) => roles.includes(role)),
    { max: 12, lower: true }
  );
}

function scoreTemplateForRole(role = "", template = {}) {
  const cleanRole = normalizeWorkerRoleId(role);
  const roleType = normalizeRoleId(template?.role_type || template?.roleType || template?.id);
  const id = String(template?.id || "").trim().toLowerCase();
  const transportAlias = getTransportRoleId(cleanRole);
  const caps = new Set(normalizeStringList(template?.capability_tags || [], { max: 32, lower: true }));
  let score = 0;

  if (roleType === cleanRole) score += 100;
  if (id === cleanRole) score += 60;
  if (transportAlias && id === transportAlias) score += 80;
  if (String(template?.provider || "") === "codex" && cleanRole === "builder") score += 20;
  if (String(template?.provider || "") === "gemini" && cleanRole === "researcher") score += 12;

  const hints = ROLE_CAPABILITY_HINTS[cleanRole] || [];
  for (const hint of hints) {
    if (caps.has(hint)) score += 6;
  }

  return score;
}

function pickTemplateForRole(role = "", templates = [], usedTemplateIds = new Set()) {
  let best = null;
  for (const template of templates) {
    const id = String(template?.id || "").trim().toLowerCase();
    if (!id || usedTemplateIds.has(id)) continue;
    const score = scoreTemplateForRole(role, template);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { template, score };
  }
  return best ? best.template : null;
}

function buildDependencies(roleIds = []) {
  const clean = normalizeStringList(roleIds, { max: 16, lower: true });
  const edges = [];
  const has = (role) => clean.includes(role);

  if (has("operator") && has("researcher")) edges.push({ from: "operator", to: "researcher" });
  if (has("researcher") && has("builder")) edges.push({ from: "researcher", to: "builder" });
  if (has("researcher") && has("reviewer")) edges.push({ from: "researcher", to: "reviewer" });
  if (has("builder") && has("reviewer")) edges.push({ from: "builder", to: "reviewer" });
  if (has("reviewer") && has("synthesizer")) edges.push({ from: "reviewer", to: "synthesizer" });

  return edges;
}

function buildSlotSpec({
  slotId = "",
  roleId = "",
  goal = "",
  selectionReason = "",
} = {}) {
  return {
    slot_id: slotId,
    purpose: goal || roleId,
    role_id: roleId,
    required_skill_ids: [],
    preferred_skill_ids: [],
    forbidden_skill_ids: [],
    authority_profile_id: pickDefaultAuthorityProfileId(roleId),
    parallelizable: roleId !== "reviewer",
    reviewer_required: roleId === "builder" ? true : undefined,
    deliverable_type: roleId === "builder"
      ? "artifact"
      : (roleId === "synthesizer" ? "brief" : undefined),
    selection_reason: selectionReason || `selected:${roleId}`,
  };
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
  const requestedRoles = normalizePreferredRoles(preferredRoles);
  const roles = normalizeStringList([
    ...requestedRoles,
    ...DEFAULT_ROLE_ORDER.filter((role) => inferredRoles.includes(role)),
  ], {
    max: Math.max(1, Math.floor(Number(maxAgents) || 6)),
    lower: true,
  });

  const usedTemplateIds = new Set();
  const runtimeAgents = [];
  const slots = [];
  const missingRoles = [];
  const selectionExplanations = [];

  for (const role of roles) {
    const slotId = `slot_${role}_${slots.length + 1}`;
    const matched = pickTemplateForRole(role, knownTemplates, usedTemplateIds);
    const selectionReason = matched
      ? `matched_template:${matched.id}`
      : `synthesized_slot:${role}`;
    if (matched) usedTemplateIds.add(matched.id);

    const runtimeAgent = createRuntimeAgentInstance({
      slot_id: slotId,
      role_id: role,
      role_label: role,
      display_label: role,
      preset_id: matched?.id || role,
      synthesized: !matched,
      attached_skills: [],
      context_pack_id: undefined,
      authority_profile_id: pickDefaultAuthorityProfileId(role),
      selection_reason: selectionReason,
      template_id: matched?.id || undefined,
      provider: matched?.provider,
      model: matched?.model,
      capability_tags: [
        ...(matched?.capability_tags || []),
        ...(ROLE_CAPABILITY_HINTS[role] || []),
      ],
      assigned_goal: goal,
      ephemeral: !matched,
      fallback: !matched,
      status: "ready",
    });
    runtimeAgents.push(runtimeAgent);
    slots.push(buildSlotSpec({
      slotId,
      roleId: role,
      goal,
      selectionReason,
    }));
    selectionExplanations.push({
      subject_id: slotId,
      reason: selectionReason,
    });

    if (!matched) missingRoles.push(role);
  }

  const collaborationCells = buildCollaborationCells({
    runtimeAgents,
  });
  const checkpoints = buildExecutionCheckpoints({
    slots,
  });
  const roleOrder = roles;
  const dependencies = buildDependencies(roleOrder);
  const executionGraph = {
    order: [...roleOrder],
    edges: dependencies.map((edge) => ({
      from: edge.from,
      to: edge.to,
      relation: "precedes",
    })),
  };

  const teamPlan = normalizeTeamPlan({
    mode,
    reason: missingRoles.length > 0
      ? `matched=${runtimeAgents.length - missingRoles.length}, missing=${missingRoles.join(",")}`
      : `matched=${runtimeAgents.length}`,
    budget: {
      max_agents: Math.max(1, Math.floor(Number(maxAgents) || 6)),
      max_actions: 8,
      preferred_provider_mix: normalizeStringList(
        runtimeAgents.map((row) => row.provider).filter(Boolean),
        { max: 8, lower: true }
      ),
    },
    task_interpretation: interpretTask({
      goal,
      mode,
      preferredRoles: roles,
      routeContext,
    }),
    supervisor_runtime: createSupervisorRuntime({
      coordination_mode: mode,
      planner_requested: false,
      selection_reason: "worker team build",
    }),
    slots,
    runtime_agents: runtimeAgents,
    collaboration_cells: collaborationCells,
    authority_graph: slots.map((slot) => ({
      slot_id: slot.slot_id,
      authority_profile_id: slot.authority_profile_id,
    })),
    execution_graph: executionGraph,
    checkpoints,
    selection_explanations: selectionExplanations,
    roles: slots.map((slot) => ({
      id: slot.role_id,
      role_id: slot.role_id,
      role_type: slot.role_id,
      role_label: slot.role_id,
      slot_id: slot.slot_id,
      authority_profile_id: slot.authority_profile_id,
      attached_skills: [],
      selection_reason: slot.selection_reason,
    })),
    dependencies,
    execution_order: roleOrder,
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
