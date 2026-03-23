import {
  normalizeAgentRegistryToTemplates,
  normalizeAgentTemplate,
} from "../domain/agent_templates.js";
import { normalizeTeamPlan } from "../domain/team_plan.js";
import { createRuntimeAgentInstance } from "../domain/runtime_agent.js";
import { inferRuntimeDisplayLabel } from "../shared/runtime_agent_naming.js";
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
import { splitToolishIds, readLegacyParticipantToolIds } from "../shared/participant_schema.js";

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
    ...(() => { const split = splitToolishIds(readLegacyParticipantToolIds(slot, 'required')); return { runtime_capabilities_required: normalizeStringList(split.runtimeCapabilities, { max: 24, lower: true }), external_tool_requirements: normalizeStringList(split.externalTools, { max: 24, lower: true }) }; })(),
  };
}

function reviewerCategory(slot = {}) {
  const purposeText = normalizeText(slot?.purpose, { lower: true });
  const reasonText = normalizeText(slot?.selection_reason, { lower: true });
  const skillText = [
    ...(slot?.required_skill_ids || []),
    ...(slot?.preferred_skill_ids || []),
  ].map((entry) => normalizeText(entry, { lower: true })).filter(Boolean).join(" ");
  const text = [purposeText, reasonText, skillText].filter(Boolean).join(" ");
  const hasExplicitClaimAuditSignal = (
    text.includes("evidence")
    || text.includes("citation")
    || text.includes("fact check")
    || text.includes("fact-check")
    || text.includes("claim check")
    || text.includes("claim-check")
    || text.includes("claim audit")
    || text.includes("evidence audit")
    || (text.includes("claim") && (
      text.includes("audit")
      || text.includes("verify")
      || text.includes("validate")
      || text.includes("supporting evidence")
    ))
    || skillText.includes("claim_evidence")
    || skillText.includes("citation")
    || skillText.includes("fact_check")
  );

  if (text.includes("security") || text.includes("threat") || text.includes("vuln")) return "security";
  if (hasExplicitClaimAuditSignal) return "claim_evidence";
  if (text.includes("compliance") || text.includes("policy") || text.includes("regulatory")) return "compliance";
  if (text.includes("skeptical") || text.includes("adversarial") || text.includes("red-team") || text.includes("red team")) {
    return "adversarial";
  }
  return "generic";
}

function mergeStringLists(...lists) {
  return normalizeStringList(lists.flat(), { max: 24, lower: true });
}

function deduplicateReviewerSlots(slots = [], taskInterpretation = {}) {
  const reviewerSlots = asArray(slots).filter((slot) => slot.role_id === "reviewer");
  if (reviewerSlots.length <= 1) return asArray(slots);

  const nonReviewers = asArray(slots).filter((slot) => slot.role_id !== "reviewer");
  const mergedByCategory = new Map();
  for (const reviewer of reviewerSlots) {
    const category = reviewerCategory(reviewer);
    const allowSeparate = category !== "generic";
    if (!allowSeparate && mergedByCategory.has(category)) {
      const existing = mergedByCategory.get(category);
      mergedByCategory.set(category, {
        ...existing,
        purpose: normalizeText([existing.purpose, reviewer.purpose].filter(Boolean).join(" / ")) || existing.purpose,
        required_skill_ids: mergeStringLists(existing.required_skill_ids, reviewer.required_skill_ids),
        preferred_skill_ids: mergeStringLists(existing.preferred_skill_ids, reviewer.preferred_skill_ids),
        forbidden_skill_ids: mergeStringLists(existing.forbidden_skill_ids, reviewer.forbidden_skill_ids),
        required_context_types: mergeStringLists(existing.required_context_types, reviewer.required_context_types),
        runtime_capabilities_required: mergeStringLists(existing.runtime_capabilities_required, reviewer.runtime_capabilities_required),
        external_tool_requirements: mergeStringLists(existing.external_tool_requirements, reviewer.external_tool_requirements),
        parallelizable: false,
        selection_reason: normalizeText([existing.selection_reason, reviewer.selection_reason].filter(Boolean).join("; "))
          || existing.selection_reason,
      });
      continue;
    }
    mergedByCategory.set(allowSeparate ? `${category}:${normalizeText(reviewer.purpose, { lower: true })}` : category, reviewer);
  }

  const mergedReviewers = [...mergedByCategory.values()];
  if (taskInterpretation?.task_type === "code_change") {
    const genericReviewers = mergedReviewers.filter((slot) => reviewerCategory(slot) === "generic");
    if (genericReviewers.length > 1) {
      const [primary, ...rest] = genericReviewers;
      const combined = rest.reduce((acc, slot) => ({
        ...acc,
        purpose: normalizeText([acc.purpose, slot.purpose].filter(Boolean).join(" / ")) || acc.purpose,
        required_skill_ids: mergeStringLists(acc.required_skill_ids, slot.required_skill_ids),
        preferred_skill_ids: mergeStringLists(acc.preferred_skill_ids, slot.preferred_skill_ids),
        required_context_types: mergeStringLists(acc.required_context_types, slot.required_context_types),
        selection_reason: normalizeText([acc.selection_reason, slot.selection_reason].filter(Boolean).join("; "))
          || acc.selection_reason,
      }), primary);
      return [
        ...nonReviewers,
        combined,
        ...mergedReviewers.filter((slot) => reviewerCategory(slot) !== "generic"),
      ];
    }
  }

  return [...nonReviewers, ...mergedReviewers];
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

  const deduplicated = deduplicateReviewerSlots(candidateSlots, taskInterpretation);
  const ordered = DEFAULT_ROLE_ORDER.flatMap((roleId) =>
    deduplicated.filter((slot) => slot.role_id === roleId)
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
      display_label: inferRuntimeDisplayLabel({
        roleId: slot.role_id,
        currentLabel: slot.display_label || slot.role_id,
        purpose: slot.purpose,
        deliverableType: slot.deliverable_type,
        taskSummary: goal || slot.purpose,
        requiredSkillIds: slot.required_skill_ids || [],
        preferredSkillIds: slot.preferred_skill_ids || [],
        requiredContextTypes: slot.required_context_types || [],
      }),
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
      task_summary: goal || slot.purpose,
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

function distinctRuntimeAgentsByRole(runtimeAgents = [], roleId = "") {
  return asArray(runtimeAgents).filter((agent) => normalizeWorkerRoleId(agent?.role_id || agent?.role_label) === roleId);
}

function inferSkillCluster(runtimeAgent = {}) {
  const attachedSkillIds = normalizeStringList(runtimeAgent?.attached_skill_ids || [], { max: 24, lower: true });
  if (attachedSkillIds.length > 0) return attachedSkillIds.slice().sort().join("|");
  const presetHints = normalizeStringList(runtimeAgent?.selection_features?.domain_hints || [], { max: 12, lower: true });
  if (presetHints.length > 0) return presetHints.slice().sort().join("|");
  return normalizeWorkerRoleId(runtimeAgent?.role_id || runtimeAgent?.role_label) || "unknown";
}

export function rerankResolvedTeamComposition({
  teamPlan = null,
  runtimeAgents = [],
  taskInterpretation = {},
  scoredCandidatesBySlot = {},
} = {}) {
  const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
  const runtimeAgentList = asArray(runtimeAgents);
  const explanations = [];
  let score = 0;
  const researchers = distinctRuntimeAgentsByRole(runtimeAgentList, "researcher");
  const reviewers = distinctRuntimeAgentsByRole(runtimeAgentList, "reviewer");
  const synthesizers = distinctRuntimeAgentsByRole(runtimeAgentList, "synthesizer");
  const providers = normalizeStringList(
    runtimeAgentList.map((agent) => normalizeText(agent?.provider, { lower: true })).filter(Boolean),
    { max: 16, lower: true }
  );
  const upstreamSlots = asArray(plan.slots).filter((slot) => slot.role_id !== "synthesizer");
  const toolHints = runtimeAgentList.flatMap((agent) => normalizeStringList(
    agent?.selection_features?.tool_hints || [],
    { max: 8, lower: true }
  ));
  const duplicateToolHints = toolHints.length - new Set(toolHints).size;

  if ((taskInterpretation?.risk_level === "high" || taskInterpretation?.review_policy !== "optional") && reviewers.length === 0) {
    score -= 18;
    explanations.push({ subject_id: "team_plan", reason: "team_reranker:-18 missing reviewer for required review policy" });
  }
  if (upstreamSlots.length > 1 && synthesizers.length === 0) {
    score -= 12;
    explanations.push({ subject_id: "team_plan", reason: "team_reranker:-12 missing synthesizer for multiple upstream slots" });
  }
  if (reviewers.length > 0 && synthesizers.length > 0) {
    score += 10;
    explanations.push({ subject_id: "team_plan", reason: "team_reranker:+10 reviewer and synthesizer coverage present" });
  }
  if (researchers.length > 1) {
    const clusters = researchers.map((agent) => inferSkillCluster(agent));
    const uniqueClusters = new Set(clusters);
    if (uniqueClusters.size < clusters.length) {
      const penalty = (clusters.length - uniqueClusters.size) * 6;
      score -= penalty;
      explanations.push({ subject_id: "team_plan", reason: `team_reranker:-${penalty} duplicate researcher skill clusters` });
    }
    if (taskInterpretation?.parallelism_preference === "parallel" && uniqueClusters.size > 1) {
      score += 8;
      explanations.push({ subject_id: "team_plan", reason: "team_reranker:+8 diverse researcher clusters for multi-source task" });
    }
  }
  if (providers.length > 1) {
    score += 4;
    explanations.push({ subject_id: "team_plan", reason: "team_reranker:+4 provider diversity reduces concentration risk" });
  } else if (runtimeAgentList.length > 2 && providers.length === 1) {
    score -= 4;
    explanations.push({ subject_id: "team_plan", reason: "team_reranker:-4 concentrated provider footprint" });
  }
  if (duplicateToolHints > 1) {
    const penalty = duplicateToolHints * 2;
    score -= penalty;
    explanations.push({ subject_id: "team_plan", reason: `team_reranker:-${penalty} overlapping tool hints across runtime agents` });
  }

  for (const runtimeAgent of runtimeAgentList) {
    const slotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
    const scoredCandidates = Array.isArray(scoredCandidatesBySlot?.[slotId]) ? scoredCandidatesBySlot[slotId] : [];
    if (scoredCandidates.length === 0) continue;
    const selectedPresetId = normalizeText(runtimeAgent?.preset_id || runtimeAgent?.presetId, { lower: true });
    const topCandidate = scoredCandidates[0];
    if (selectedPresetId && selectedPresetId === normalizeText(topCandidate?.preset_id, { lower: true })) {
      score += 2;
      explanations.push({ subject_id: slotId, reason: `team_reranker:+2 top preset retained (${selectedPresetId})` });
    }
  }

  return {
    score,
    selection_explanations: explanations,
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
