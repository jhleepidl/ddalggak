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

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizePreferredRoles(preferredRoles = []) {
  return normalizeStringList(
    asArray(preferredRoles).map((role) => normalizeWorkerRoleId(role)).filter(Boolean),
    { max: 12, lower: true }
  );
}

export function inferRuntimeRolesForGoal(goal = "", { routeContext = null } = {}) {
  const interpreted = interpretTask({
    goal,
    routeContext,
  });
  const slots = Array.isArray(interpreted.candidate_capability_slots)
    ? interpreted.candidate_capability_slots
    : [];
  return normalizeStringList(
    slots.map((slot) => slot.role_id).filter(Boolean),
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
  if (String(template?.provider || "") === "gemini" && cleanRole === "reviewer") score += 8;

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

function buildLegacyDependencies(slots = []) {
  const clean = normalizeStringList(
    asArray(slots).map((slot) => slot?.role_id).filter(Boolean),
    { max: 32, lower: true }
  );
  const dependencies = [];
  const has = (role) => clean.includes(role);
  if (has("operator") && has("researcher")) dependencies.push({ from: "operator", to: "researcher" });
  if (has("researcher") && has("builder")) dependencies.push({ from: "researcher", to: "builder" });
  if (has("researcher") && has("reviewer")) dependencies.push({ from: "researcher", to: "reviewer" });
  if (has("builder") && has("reviewer")) dependencies.push({ from: "builder", to: "reviewer" });
  if (has("reviewer") && has("synthesizer")) dependencies.push({ from: "reviewer", to: "synthesizer" });
  if (!has("reviewer") && has("researcher") && has("synthesizer")) {
    dependencies.push({ from: "researcher", to: "synthesizer" });
  }
  if (!has("reviewer") && has("builder") && has("synthesizer")) {
    dependencies.push({ from: "builder", to: "synthesizer" });
  }
  return dependencies;
}

function buildExecutionEdges(slots = []) {
  const researchers = asArray(slots).filter((slot) => slot.role_id === "researcher");
  const builders = asArray(slots).filter((slot) => slot.role_id === "builder");
  const reviewers = asArray(slots).filter((slot) => slot.role_id === "reviewer");
  const synthesizers = asArray(slots).filter((slot) => slot.role_id === "synthesizer");
  const operators = asArray(slots).filter((slot) => slot.role_id === "operator");
  const edges = [];
  const addEdge = (fromSlot = null, toSlot = null) => {
    const fromSlotId = normalizeText(fromSlot?.slot_id);
    const toSlotId = normalizeText(toSlot?.slot_id);
    if (!fromSlotId || !toSlotId || fromSlotId === toSlotId) return;
    if (edges.some((edge) => edge.from_slot_id === fromSlotId && edge.to_slot_id === toSlotId)) return;
    edges.push({
      from_slot_id: fromSlotId,
      to_slot_id: toSlotId,
      from: fromSlot?.role_id,
      to: toSlot?.role_id,
      relation: "precedes",
    });
  };

  for (const operator of operators) {
    for (const downstream of [...researchers, ...builders, ...reviewers, ...synthesizers]) {
      addEdge(operator, downstream);
    }
  }
  for (const researcher of researchers) {
    for (const builder of builders) addEdge(researcher, builder);
    for (const reviewer of reviewers) addEdge(researcher, reviewer);
    if (reviewers.length === 0) {
      for (const synthesizer of synthesizers) addEdge(researcher, synthesizer);
    }
  }
  for (const builder of builders) {
    for (const reviewer of reviewers) addEdge(builder, reviewer);
    if (reviewers.length === 0) {
      for (const synthesizer of synthesizers) addEdge(builder, synthesizer);
    }
  }
  for (const reviewer of reviewers) {
    for (const synthesizer of synthesizers) addEdge(reviewer, synthesizer);
  }
  return edges;
}

function buildSlotSpec({
  slot = {},
  index = 0,
} = {}) {
  const roleId = normalizeWorkerRoleId(slot.role_id);
  return {
    slot_id: normalizeText(slot.slot_id || `slot_${roleId}_${index + 1}`) || `slot_${roleId}_${index + 1}`,
    purpose: normalizeText(slot.purpose || roleId) || roleId,
    role_id: roleId,
    required_skill_ids: normalizeStringList(slot.required_skill_ids || [], { max: 24, lower: true }),
    preferred_skill_ids: normalizeStringList(slot.preferred_skill_ids || [], { max: 24, lower: true }),
    forbidden_skill_ids: normalizeStringList(slot.forbidden_skill_ids || [], { max: 24, lower: true }),
    authority_profile_id: normalizeText(
      slot.authority_profile_id || pickDefaultAuthorityProfileId(roleId),
      { lower: true }
    ) || pickDefaultAuthorityProfileId(roleId),
    parallelizable: slot.parallelizable !== false,
    reviewer_required: slot.reviewer_required === true ? true : undefined,
    deliverable_type: normalizeText(slot.deliverable_type).toLowerCase() || undefined,
    selection_reason: normalizeText(slot.selection_reason || `candidate:${roleId}`) || `candidate:${roleId}`,
    required_context_types: normalizeStringList(slot.required_context_types || [], { max: 24, lower: true }),
    required_tool_ids: normalizeStringList(slot.required_tool_ids || [], { max: 24, lower: true }),
  };
}

function buildCandidateSlots(taskInterpretation = {}, {
  preferredRoles = [],
  maxAgents = 6,
} = {}) {
  const preferred = normalizePreferredRoles(preferredRoles);
  const suppressed = new Set(asArray(taskInterpretation?.suppressed_role_ids).map((entry) => normalizeWorkerRoleId(entry)).filter(Boolean));
  const candidateSlots = asArray(taskInterpretation?.candidate_capability_slots)
    .map((slot, index) => buildSlotSpec({ slot, index }))
    .filter((slot) => slot && !suppressed.has(slot.role_id));

  for (const roleId of preferred) {
    if (suppressed.has(roleId)) continue;
    if (candidateSlots.some((slot) => slot.role_id === roleId)) continue;
    candidateSlots.push(buildSlotSpec({
      slot: {
        role_id: roleId,
        purpose: `${taskInterpretation.task_summary || "task"} (${roleId})`,
        selection_reason: "preferred_role",
      },
      index: candidateSlots.length,
    }));
  }

  const ordered = DEFAULT_ROLE_ORDER.flatMap((roleId) =>
    candidateSlots.filter((slot) => slot.role_id === roleId)
  );
  return ordered.slice(0, Math.max(1, Math.floor(Number(maxAgents) || 6)));
}

function buildRuntimeAgentsFromSlots({
  slots = [],
  templates = [],
  goal = "",
} = {}) {
  const usedTemplateIds = new Set();
  const runtimeAgents = [];
  const missingRoles = [];
  const selectionExplanations = [];

  for (const slot of slots) {
    const matched = pickTemplateForRole(slot.role_id, templates, usedTemplateIds);
    if (matched) usedTemplateIds.add(matched.id);
    const transportAlias = getTransportRoleId(slot.role_id);
    const synthesized = !matched;
    const selectionReason = matched
      ? `matched_template:${matched.id}`
      : `synthesized_slot:${slot.role_id}`;
    if (!matched) missingRoles.push(slot.role_id);
    runtimeAgents.push(createRuntimeAgentInstance({
      slot_id: slot.slot_id,
      role_id: slot.role_id,
      role_label: slot.role_id,
      display_label: slot.role_id,
      preset_id: matched ? `legacy.${matched.id}` : null,
      synthesized,
      attached_skills: [],
      context_pack_id: undefined,
      authority_profile_id: slot.authority_profile_id,
      selection_reason: selectionReason,
      template_id: matched?.id || transportAlias || undefined,
      provider: matched?.provider || undefined,
      model: matched?.model || undefined,
      capability_tags: [
        ...(matched?.capability_tags || []),
        ...(ROLE_CAPABILITY_HINTS[slot.role_id] || []),
      ],
      assigned_goal: goal || slot.purpose,
      ephemeral: synthesized,
      fallback: synthesized,
      status: "ready",
    }));
    selectionExplanations.push({
      subject_id: slot.slot_id,
      reason: selectionReason,
    });
  }

  return {
    runtime_agents: runtimeAgents,
    missing_roles: normalizeStringList(missingRoles, { max: 16, lower: true }),
    selection_explanations: selectionExplanations,
  };
}

function buildExecutionGraph(slots = []) {
  const edges = buildExecutionEdges(slots);
  const order = slots.map((slot) => slot.slot_id);
  return {
    order,
    role_order: normalizeStringList(slots.map((slot) => slot.role_id), { max: 32, lower: true }),
    nodes: slots.map((slot) => ({
      slot_id: slot.slot_id,
      role_id: slot.role_id,
      parallelizable: slot.parallelizable === true,
    })),
    edges,
  };
}

export function buildTeamFromTemplates({
  goal = "",
  routeContext = null,
  templates = [],
  mode = "balanced",
  preferredRoles = [],
  maxAgents = 6,
  taskInterpretation = null,
} = {}) {
  const knownTemplates = asArray(templates)
    .map((row) => normalizeAgentTemplate(row))
    .filter(Boolean);
  const interpreted = taskInterpretation && typeof taskInterpretation === "object"
    ? taskInterpretation
    : interpretTask({
      goal,
      mode,
      preferredRoles,
      routeContext,
    });
  const slots = buildCandidateSlots(interpreted, {
    preferredRoles,
    maxAgents,
  });
  const dependencies = buildLegacyDependencies(slots);
  const provisional = buildRuntimeAgentsFromSlots({
    slots,
    templates: knownTemplates,
    goal,
  });
  const executionGraph = buildExecutionGraph(slots);
  const supervisorRuntime = createSupervisorRuntime({
    coordination_mode: interpreted.control_mode || mode,
    interaction_mode: interpreted.control_mode === "checkpointed"
      ? "checkpointed_supervised"
      : (interpreted.control_mode === "supervised" ? "manager_as_tool" : "passive_observer"),
    planner_requested: false,
    enabled: interpreted.control_mode !== "self_directed",
    user_visible: interpreted.control_mode === "supervised",
    max_parallel_workers: interpreted.parallelism_preference === "parallel" ? 4 : 2,
    selection_reason: interpreted.control_mode || "worker team build",
  });
  const collaborationCells = buildCollaborationCells({
    runtimeAgents: provisional.runtime_agents,
    supervisorRuntime,
  });
  const checkpoints = buildExecutionCheckpoints({
    slots,
    runtimeAgents: provisional.runtime_agents,
    supervisorRuntime,
    collaborationCells,
  });

  const teamPlan = normalizeTeamPlan({
    mode,
    reason: provisional.missing_roles.length > 0
      ? `slots=${slots.length}, synthesized=${provisional.missing_roles.join(",")}`
      : `slots=${slots.length}`,
    budget: {
      max_agents: Math.max(1, Math.floor(Number(maxAgents) || 6)),
      max_actions: 8,
      preferred_provider_mix: normalizeStringList(
        provisional.runtime_agents.map((row) => row.provider).filter(Boolean),
        { max: 8, lower: true }
      ),
    },
    task_interpretation: interpreted,
    supervisor_runtime: supervisorRuntime,
    slots,
    runtime_agents: provisional.runtime_agents,
    collaboration_cells: collaborationCells,
    authority_graph: slots.map((slot) => ({
      slot_id: slot.slot_id,
      authority_profile_id: slot.authority_profile_id,
    })),
    execution_graph: executionGraph,
    checkpoints,
    selection_explanations: provisional.selection_explanations,
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
    execution_order: executionGraph.role_order,
  });

  return {
    interpreted_task: interpreted,
    team_plan: teamPlan,
    runtime_agents: provisional.runtime_agents,
    missing_roles: provisional.missing_roles,
    selected_template_ids: provisional.runtime_agents.map((row) => row.template_id).filter(Boolean),
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
  taskInterpretation = null,
} = {}) {
  const normalizedRegistry = normalizeAgentRegistryToTemplates(registry || {});
  return buildTeamFromTemplates({
    goal,
    routeContext,
    templates: normalizedRegistry.templates,
    mode,
    preferredRoles,
    maxAgents,
    taskInterpretation,
  });
}
