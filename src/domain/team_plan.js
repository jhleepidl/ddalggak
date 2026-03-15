import { normalizeStringList } from "../shared/normalize.js";
import { normalizeSkillAttachmentList } from "./skill_attachment.js";
import { normalizeTaskInterpretation } from "./task_interpretation.js";
import { normalizeCollaborationCellList } from "./collaboration_cell.js";
import { normalizeExecutionCheckpointList } from "./execution_checkpoint.js";
import { normalizeRuntimeAgentList } from "./runtime_agent.js";
import {
  CANONICAL_WORKER_ROLE_IDS,
  normalizeRoleId,
  normalizeWorkerRoleId,
} from "../compatibility/legacy_roles.js";
import { AuthorityRegistry, pickDefaultAuthorityProfileId } from "../catalog/authority_registry.js";

export const DEFAULT_RUNTIME_ROLES = [...CANONICAL_WORKER_ROLE_IDS];

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

function normalizeRoleStatus(raw = "") {
  const value = normalizeText(raw, { lower: true });
  if (["ready", "running", "done", "error", "disabled", "planned"].includes(value)) return value;
  return "ready";
}

function normalizeBoolean(raw, fallback = false) {
  if (raw === true) return true;
  if (raw === false) return false;
  return fallback;
}

function normalizeBudget(raw = {}) {
  const row = asObject(raw);
  const maxAgents = Number(row.max_agents ?? row.maxAgents);
  const maxActions = Number(row.max_actions ?? row.maxActions);
  return {
    max_agents: Number.isFinite(maxAgents)
      ? Math.max(1, Math.min(12, Math.floor(maxAgents)))
      : undefined,
    max_actions: Number.isFinite(maxActions)
      ? Math.max(1, Math.min(32, Math.floor(maxActions)))
      : undefined,
    preferred_provider_mix: normalizeStringList(
      row.preferred_provider_mix ?? row.preferredProviderMix ?? [],
      { max: 8, lower: true }
    ),
  };
}

function normalizeSupervisorRuntime(row = {}, {
  mode = "balanced",
  plannerRequested = false,
  reason = "",
} = {}) {
  const src = asObject(row);
  const interactionMode = normalizeText(
    src.interaction_mode
    || src.interactionMode
    || src.coordination_mode
    || src.coordinationMode
    || (mode === "run" ? "manager_as_tool" : "passive_observer"),
    { lower: true }
  );
  return {
    enabled: src.enabled !== false,
    runtime_id: normalizeText(src.runtime_id || src.runtimeId || "local_control_plane") || "local_control_plane",
    instance_id: normalizeText(
      src.instance_id || src.instanceId || src.runtime_id || src.runtimeId || "supervisor_runtime"
    ) || "supervisor_runtime",
    coordination_mode: normalizeText(src.coordination_mode || src.coordinationMode || mode || "centralized")
      || "centralized",
    interaction_mode: ["manager_as_tool", "checkpointed_supervised", "passive_observer"].includes(interactionMode)
      ? interactionMode
      : "manager_as_tool",
    planner_requested: src.planner_requested === true || src.plannerRequested === true || plannerRequested === true,
    max_parallel_workers: Number.isFinite(Number(src.max_parallel_workers ?? src.maxParallelWorkers))
      ? Math.max(1, Math.min(8, Math.floor(Number(src.max_parallel_workers ?? src.maxParallelWorkers))))
      : 3,
    authority_profile_id: normalizeText(
      src.authority_profile_id || src.authorityProfileId || "supervisor_controlled"
    ).toLowerCase() || "supervisor_controlled",
    user_visible: src.user_visible === true || src.userVisible === true,
    control_actions: normalizeStringList(
      src.control_actions ?? src.controlActions ?? [
        "launch_children",
        "receive_reports",
        "request_human_approval",
        "pause_children",
        "cancel_child",
        "reroute_child",
        "emit_intermediate_summaries",
      ],
      { max: 16, lower: true }
    ),
    selection_reason: normalizeText(src.selection_reason || src.selectionReason || reason) || undefined,
  };
}

function normalizeCapabilityTags(raw = []) {
  return normalizeStringList(raw, { max: 32, lower: true });
}

export function normalizeRuntimeTeamRole(raw = {}) {
  const row = asObject(raw);
  const roleId = normalizeWorkerRoleId(
    row.role_id
    || row.roleId
    || row.role_type
    || row.roleType
    || row.id
    || row.role
    || row.role_label
    || row.roleLabel
  );
  if (!roleId) return null;
  return {
    id: roleId,
    role_id: roleId,
    role_type: roleId,
    role_label: normalizeText(row.role_label || row.roleLabel || roleId, { lower: true }) || roleId,
    assigned_goal: normalizeText(row.assigned_goal || row.assignedGoal || row.goal) || undefined,
    capability_tags: normalizeCapabilityTags(row.capability_tags ?? row.capabilityTags ?? []),
    template_id: normalizeText(row.template_id || row.templateId, { lower: true }) || undefined,
    provider: normalizeText(row.provider, { lower: true }) || undefined,
    model: normalizeText(row.model) || undefined,
    attached_skills: normalizeSkillAttachmentList(row.attached_skills ?? row.attachedSkills ?? []),
    attached_skill_ids: normalizeStringList(
      [
        ...(Array.isArray(row.attached_skill_ids) ? row.attached_skill_ids : []),
        ...(Array.isArray(row.attachedSkillIds) ? row.attachedSkillIds : []),
        ...normalizeSkillAttachmentList(row.attached_skills ?? row.attachedSkills ?? []).map((entry) => entry.skill_id),
      ],
      { max: 64, lower: true }
    ),
    depends_on: normalizeStringList(row.depends_on ?? row.dependsOn ?? [], { max: 16, lower: true }),
    context_policy: row.context_policy && typeof row.context_policy === "object"
      ? row.context_policy
      : (row.contextPolicy && typeof row.contextPolicy === "object" ? row.contextPolicy : {}),
    ephemeral: row.ephemeral === true,
    fallback: row.fallback === true,
    status: normalizeRoleStatus(row.status),
    required: row.required !== false,
    optional: row.required === false || row.optional === true,
    slot_id: normalizeText(row.slot_id || row.slotId) || undefined,
    authority_profile_id: normalizeText(
      row.authority_profile_id || row.authorityProfileId
    ).toLowerCase() || undefined,
    selection_reason: normalizeText(row.selection_reason || row.selectionReason) || undefined,
  };
}

export function normalizeDependencyEdge(raw = {}) {
  const row = asObject(raw);
  const from = normalizeWorkerRoleId(row.from || row.depends_on || row.dependsOn);
  const to = normalizeWorkerRoleId(row.to || row.target);
  if (!from || !to || from === to) return null;
  return { from, to };
}

export function normalizeCapabilitySlotSpec(raw = {}, {
  index = 0,
  fallbackGoal = "",
} = {}) {
  const row = asObject(raw);
  const roleId = normalizeWorkerRoleId(
    row.role_id
    || row.roleId
    || row.role_type
    || row.roleType
    || row.id
    || row.role
    || row.role_label
    || row.roleLabel
  );
  if (!roleId) return null;
  const attachedSkills = normalizeSkillAttachmentList(row.attached_skills ?? row.attachedSkills ?? []);
  return {
    slot_id: normalizeText(row.slot_id || row.slotId || `slot_${roleId}_${index + 1}`) || `slot_${roleId}_${index + 1}`,
    purpose: normalizeText(row.purpose || row.assigned_goal || row.assignedGoal || fallbackGoal || roleId) || roleId,
    role_id: roleId,
    required_skill_ids: normalizeStringList(
      row.required_skill_ids ?? row.requiredSkillIds ?? [],
      { max: 32, lower: true }
    ),
    preferred_skill_ids: normalizeStringList(
      [
        ...(Array.isArray(row.preferred_skill_ids) ? row.preferred_skill_ids : []),
        ...(Array.isArray(row.preferredSkillIds) ? row.preferredSkillIds : []),
        ...attachedSkills.map((entry) => entry.skill_id),
      ],
      { max: 32, lower: true }
    ),
    forbidden_skill_ids: normalizeStringList(
      row.forbidden_skill_ids ?? row.forbiddenSkillIds ?? [],
      { max: 32, lower: true }
    ),
    authority_profile_id: normalizeText(
      row.authority_profile_id
      || row.authorityProfileId
      || pickDefaultAuthorityProfileId(roleId)
    ).toLowerCase() || pickDefaultAuthorityProfileId(roleId),
    parallelizable: normalizeBoolean(row.parallelizable, roleId !== "reviewer"),
    reviewer_required: Object.prototype.hasOwnProperty.call(row, "reviewer_required")
      || Object.prototype.hasOwnProperty.call(row, "reviewerRequired")
      ? normalizeBoolean(row.reviewer_required ?? row.reviewerRequired, false)
      : undefined,
    deliverable_type: normalizeText(row.deliverable_type || row.deliverableType) || undefined,
    selection_reason: normalizeText(row.selection_reason || row.selectionReason || `slot:${roleId}`) || `slot:${roleId}`,
    attached_skills: attachedSkills,
    capability_tags: normalizeCapabilityTags(row.capability_tags ?? row.capabilityTags ?? []),
    context_policy: row.context_policy && typeof row.context_policy === "object"
      ? row.context_policy
      : (row.contextPolicy && typeof row.contextPolicy === "object" ? row.contextPolicy : {}),
    template_id: normalizeText(row.template_id || row.templateId, { lower: true }) || undefined,
    provider: normalizeText(row.provider, { lower: true }) || undefined,
    model: normalizeText(row.model) || undefined,
    status: normalizeRoleStatus(row.status),
  };
}

function normalizeAuthorityGraph(raw = [], slots = [], runtimeAgents = []) {
  const registry = new AuthorityRegistry();
  const slotIds = new Set(slots.map((slot) => slot.slot_id));
  const runtimeAgentsBySlot = new Map(
    runtimeAgents
      .map((agent) => [normalizeText(agent?.slot_id || agent?.slotId), agent])
      .filter(([slotId]) => slotId)
  );
  const normalized = asArray(raw).map((entry) => {
    const row = asObject(entry);
    const slotId = normalizeText(row.slot_id || row.slotId);
    const authorityProfileId = normalizeText(
      row.authority_profile_id || row.authorityProfileId
    ).toLowerCase();
    if (!slotId || !authorityProfileId || !slotIds.has(slotId)) return null;
    const profile = registry.resolve(authorityProfileId);
    const runtimeAgent = runtimeAgentsBySlot.get(slotId);
    const roleId = normalizeWorkerRoleId(
      row.role_id || row.roleId || row.role_label || row.roleLabel || runtimeAgent?.role_id || runtimeAgent?.role_label
    );
    return {
      slot_id: slotId,
      authority_profile_id: authorityProfileId,
      instance_id: normalizeText(
        row.instance_id || row.instanceId || runtimeAgent?.instance_id || runtimeAgent?.instanceId
      ) || undefined,
      role_id: roleId || undefined,
      allowed_actions: normalizeStringList(
        row.allowed_actions ?? row.allowedActions ?? profile?.allowed_actions ?? [],
        { max: 32, lower: true }
      ),
      denied_actions: normalizeStringList(
        row.denied_actions ?? row.deniedActions ?? profile?.denied_actions ?? [],
        { max: 32, lower: true }
      ),
      approval_required_for: normalizeStringList(
        row.approval_required_for ?? row.approvalRequiredFor ?? profile?.approval_required_for ?? [],
        { max: 32, lower: true }
      ),
      tool_allowlist: normalizeStringList(
        row.tool_allowlist ?? row.toolAllowlist ?? profile?.tool_allowlist ?? [],
        { max: 32, lower: true }
      ),
      max_parallel_children: Number.isFinite(Number(
        row.max_parallel_children ?? row.maxParallelChildren ?? profile?.max_parallel_children
      ))
        ? Math.max(0, Math.min(16, Math.floor(Number(
          row.max_parallel_children ?? row.maxParallelChildren ?? profile?.max_parallel_children
        ))))
        : 0,
    };
  }).filter(Boolean);
  if (normalized.length > 0) return normalized;
  return slots.map((slot) => {
    const runtimeAgent = runtimeAgentsBySlot.get(slot.slot_id);
    const profile = registry.resolve(slot.authority_profile_id);
    return {
      slot_id: slot.slot_id,
      authority_profile_id: slot.authority_profile_id,
      instance_id: normalizeText(runtimeAgent?.instance_id || runtimeAgent?.instanceId) || undefined,
      role_id: slot.role_id,
      allowed_actions: normalizeStringList(profile?.allowed_actions ?? [], { max: 32, lower: true }),
      denied_actions: normalizeStringList(profile?.denied_actions ?? [], { max: 32, lower: true }),
      approval_required_for: normalizeStringList(profile?.approval_required_for ?? [], { max: 32, lower: true }),
      tool_allowlist: normalizeStringList(profile?.tool_allowlist ?? [], { max: 32, lower: true }),
      max_parallel_children: Number.isFinite(Number(profile?.max_parallel_children))
        ? Math.max(0, Math.min(16, Math.floor(Number(profile.max_parallel_children))))
        : 0,
    };
  });
}

function normalizeExecutionGraph(raw = {}, {
  slots = [],
  dependencies = [],
  executionOrder = [],
  runtimeAgents = [],
  supervisorRuntime = null,
  collaborationCells = [],
  checkpoints = [],
} = {}) {
  const row = asObject(raw);
  const slotIds = normalizeStringList(slots.map((slot) => slot.slot_id), { max: 64, lower: false });
  const slotsById = new Map(slots.map((slot) => [slot.slot_id, slot]));
  const slotsByRole = new Map();
  for (const slot of slots) {
    const list = slotsByRole.get(slot.role_id) || [];
    list.push(slot);
    slotsByRole.set(slot.role_id, list);
  }

  const resolveSlotIds = (rawRef = "", { fallbackRole = "" } = {}) => {
    const slotRef = normalizeText(rawRef);
    if (slotRef && slotsById.has(slotRef)) return [slotRef];
    const roleRef = normalizeWorkerRoleId(rawRef || fallbackRole);
    if (!roleRef) return [];
    return asArray(slotsByRole.get(roleRef)).map((slot) => slot.slot_id);
  };

  const normalizedOrder = (() => {
    const rawOrder = asArray(row.order ?? []);
    const orderedSlotIds = [];
    const seen = new Set();
    for (const entry of rawOrder) {
      for (const slotId of resolveSlotIds(entry)) {
        if (seen.has(slotId)) continue;
        seen.add(slotId);
        orderedSlotIds.push(slotId);
      }
    }
    if (orderedSlotIds.length > 0) {
      for (const slotId of slotIds) {
        if (seen.has(slotId)) continue;
        seen.add(slotId);
        orderedSlotIds.push(slotId);
      }
      return orderedSlotIds;
    }
    return slotIds;
  })();

  const explicitEdges = [];
  for (const entry of asArray(row.edges)) {
    const edge = asObject(entry);
    const fromSlotIds = resolveSlotIds(edge.from_slot_id || edge.fromSlotId || edge.from);
    const toSlotIds = resolveSlotIds(edge.to_slot_id || edge.toSlotId || edge.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) {
        if (!fromSlotId || !toSlotId || fromSlotId === toSlotId) continue;
        const fromSlot = slotsById.get(fromSlotId);
        const toSlot = slotsById.get(toSlotId);
        if (!fromSlot || !toSlot) continue;
        if (explicitEdges.some((existing) => existing.from_slot_id === fromSlotId && existing.to_slot_id === toSlotId)) {
          continue;
        }
        explicitEdges.push({
          from_slot_id: fromSlotId,
          to_slot_id: toSlotId,
          from: fromSlot.role_id,
          to: toSlot.role_id,
          relation: normalizeText(edge.relation || "precedes", { lower: true }) || "precedes",
        });
      }
    }
  }

  const fallbackEdges = [];
  for (const edge of dependencies) {
    const fromSlotIds = resolveSlotIds(edge.from);
    const toSlotIds = resolveSlotIds(edge.to);
    for (const fromSlotId of fromSlotIds) {
      for (const toSlotId of toSlotIds) {
        if (!fromSlotId || !toSlotId || fromSlotId === toSlotId) continue;
        const fromSlot = slotsById.get(fromSlotId);
        const toSlot = slotsById.get(toSlotId);
        if (!fromSlot || !toSlot) continue;
        if (fallbackEdges.some((existing) => existing.from_slot_id === fromSlotId && existing.to_slot_id === toSlotId)) {
          continue;
        }
        fallbackEdges.push({
          from_slot_id: fromSlotId,
          to_slot_id: toSlotId,
          from: fromSlot.role_id,
          to: toSlot.role_id,
          relation: "precedes",
        });
      }
    }
  }

  return {
    nodes: slots.map((slot) => ({
      slot_id: slot.slot_id,
      role_id: slot.role_id,
      parallelizable: slot.parallelizable === true,
    })),
    edges: explicitEdges.length > 0 ? explicitEdges : fallbackEdges,
    order: normalizedOrder,
    role_order: normalizeStringList(
      asArray(row.role_order ?? row.roleOrder ?? executionOrder ?? []).map((entry) => normalizeWorkerRoleId(entry)).filter(Boolean),
      { max: 32, lower: true }
    ),
    parallel_groups: (() => {
      const explicitGroups = asArray(row.parallel_groups ?? row.parallelGroups).map((group, index) => {
        const groupRow = asObject(group);
        const slotGroup = normalizeStringList(
          groupRow.slot_ids ?? groupRow.slotIds ?? [],
          { max: 16, lower: false }
        );
        if (slotGroup.length === 0) return null;
        return {
          parallel_group_id: normalizeText(
            groupRow.parallel_group_id || groupRow.parallelGroupId || `parallel_group_${index + 1}`
          ) || `parallel_group_${index + 1}`,
          slot_ids: slotGroup.filter((slotId) => slotIds.includes(slotId)),
          role_ids: normalizeStringList(
            groupRow.role_ids ?? groupRow.roleIds ?? slotGroup.map((slotId) => slotsById.get(slotId)?.role_id).filter(Boolean),
            { max: 16, lower: true }
          ),
        };
      }).filter((group) => group && group.slot_ids.length > 1);
      if (explicitGroups.length > 0) return explicitGroups;
      const layers = normalizedOrder
        .map((slotId) => slotsById.get(slotId))
        .filter(Boolean)
        .reduce((groups, slot) => {
          if (slot.parallelizable !== true) return groups;
          const last = groups[groups.length - 1];
          const hasDependencyTarget = (explicitEdges.length > 0 ? explicitEdges : fallbackEdges)
            .some((edge) => edge.to_slot_id === slot.slot_id || edge.from_slot_id === slot.slot_id);
          if (!last || hasDependencyTarget) {
            groups.push([slot]);
            return groups;
          }
          last.push(slot);
          return groups;
        }, []);
      return layers
        .filter((group) => group.length > 1)
        .map((group, index) => ({
          parallel_group_id: `parallel_group_${index + 1}`,
          slot_ids: group.map((slot) => slot.slot_id),
          role_ids: normalizeStringList(group.map((slot) => slot.role_id), { max: 16, lower: true }),
        }));
    })(),
    supervisor_edges: (() => {
      const explicit = asArray(row.supervisor_edges ?? row.supervisorEdges).map((edge) => {
        const edgeRow = asObject(edge);
        const slotIdsForEdge = normalizeStringList(
          edgeRow.target_slot_ids ?? edgeRow.targetSlotIds ?? [],
          { max: 16, lower: false }
        ).filter((slotId) => slotIds.includes(slotId));
        if (slotIdsForEdge.length === 0) return null;
        return {
          supervisor_instance_id: normalizeText(
            edgeRow.supervisor_instance_id || edgeRow.supervisorInstanceId || supervisorRuntime?.instance_id
          ) || undefined,
          target_slot_ids: slotIdsForEdge,
          relation: normalizeText(edgeRow.relation || "manages", { lower: true }) || "manages",
          report_back: edgeRow.report_back !== false,
        };
      }).filter(Boolean);
      if (explicit.length > 0) return explicit;
      if (supervisorRuntime?.enabled !== true) return [];
      return slots.map((slot) => ({
        supervisor_instance_id: supervisorRuntime.instance_id,
        target_slot_ids: [slot.slot_id],
        relation: "manages",
        report_back: true,
      }));
    })(),
    collaboration_cells: normalizeCollaborationCellList(collaborationCells),
    checkpoints: normalizeExecutionCheckpointList(checkpoints),
    interrupt_ready: row.interrupt_ready === true
      || row.interruptReady === true
      || normalizeExecutionCheckpointList(checkpoints).some((checkpoint) => checkpoint.human_interrupt_allowed === true),
  };
}

function normalizeSelectionExplanations(raw = [], {
  plannerRequested = false,
} = {}) {
  const items = [];
  for (const entry of asArray(raw)) {
    if (typeof entry === "string") {
      const reason = normalizeText(entry);
      if (!reason) continue;
      items.push({ subject_id: "team_plan", reason });
      continue;
    }
    const row = asObject(entry);
    const reason = normalizeText(row.reason || row.selection_reason || row.selectionReason);
    if (!reason) continue;
    items.push({
      subject_id: normalizeText(row.subject_id || row.subjectId || "team_plan") || "team_plan",
      reason,
    });
  }
  if (plannerRequested) {
    items.push({
      subject_id: "supervisor_runtime",
      reason: "legacy planner role normalized into supervisor runtime control-plane metadata",
    });
  }
  return items;
}

function buildLegacyRoles({
  slots = [],
  runtimeAgents = [],
  dependencies = [],
  taskGoal = "",
} = {}) {
  return slots.map((slot) => {
    const matchingAgent = runtimeAgents.find((agent) =>
      normalizeText(agent.slot_id || "") === normalizeText(slot.slot_id)
      || normalizeText(agent.role_id || "") === normalizeText(slot.role_id)
    );
    const dependsOn = dependencies
      .filter((edge) => edge.to === slot.role_id)
      .map((edge) => edge.from);
    return normalizeRuntimeTeamRole({
      id: slot.role_id,
      role_id: slot.role_id,
      role_type: slot.role_id,
      role_label: slot.role_id,
      assigned_goal: taskGoal || slot.purpose,
      capability_tags: slot.capability_tags || matchingAgent?.capability_tags || [],
      template_id: matchingAgent?.template_id || slot.template_id,
      provider: matchingAgent?.provider || slot.provider,
      model: matchingAgent?.model || slot.model,
      attached_skills: matchingAgent?.attached_skills || slot.attached_skills || [],
      depends_on: dependsOn,
      context_policy: slot.context_policy || {},
      ephemeral: matchingAgent?.ephemeral === true,
      fallback: matchingAgent?.fallback === true,
      status: matchingAgent?.status || slot.status || "ready",
      required: true,
      optional: false,
      slot_id: slot.slot_id,
      authority_profile_id: slot.authority_profile_id,
      selection_reason: matchingAgent?.selection_reason || slot.selection_reason,
    });
  }).filter(Boolean);
}

function normalizeConversationPreferences(raw = undefined) {
  if (!raw || typeof raw !== "object") return undefined;
  return raw;
}

function collectLegacySlotsFromRoles(roles = [], fallbackGoal = "") {
  return asArray(roles)
    .map((role, index) => normalizeCapabilitySlotSpec(role, {
      index,
      fallbackGoal,
    }))
    .filter(Boolean);
}

export function normalizeTeamPlan(raw = {}) {
  const row = asObject(raw);
  const mode = normalizeText(row.mode || "balanced", { lower: true }) || "balanced";
  const reason = normalizeText(row.reason || "team plan") || "team plan";
  const taskInterpretation = normalizeTaskInterpretation(
    row.task_interpretation ?? row.taskInterpretation ?? {},
    {
      fallbackGoal: normalizeText(row.goal || ""),
      fallbackMode: mode,
    }
  );
  const plannerRequested = (
    asArray(row.roles).some((entry) => normalizeRoleId(
      entry?.role_id
      || entry?.role_type
      || entry?.id
      || entry?.role_label
    ) === "deprecated_control_plane_only")
    || asArray(row.runtime_agents ?? row.runtimeAgents).some((entry) => normalizeRoleId(
      entry?.role_id
      || entry?.role_type
      || entry?.role_label
    ) === "deprecated_control_plane_only")
    || row.planner_requested === true
    || row.plannerRequested === true
  );

  const slots = asArray(row.slots).length > 0
    ? asArray(row.slots).map((slot, index) => normalizeCapabilitySlotSpec(slot, {
      index,
      fallbackGoal: taskInterpretation.goal,
    })).filter(Boolean)
    : collectLegacySlotsFromRoles(row.roles, taskInterpretation.goal);
  const runtimeAgents = normalizeRuntimeAgentList(
    row.runtime_agents ?? row.runtimeAgents ?? []
  ).filter((agent) => agent.role_id !== "deprecated_control_plane_only");
  const roleIds = new Set(slots.map((slot) => slot.role_id));
  const dependencies = asArray(row.dependencies)
    .map(normalizeDependencyEdge)
    .filter((edge) => edge && roleIds.has(edge.from) && roleIds.has(edge.to));
  const givenOrder = normalizeStringList(
    asArray(row.execution_order ?? row.executionOrder ?? []).map((entry) => normalizeWorkerRoleId(entry)).filter(Boolean),
    { max: 32, lower: true }
  );
  const executionOrder = givenOrder.length > 0
    ? givenOrder.filter((id) => roleIds.has(id))
    : normalizeStringList(slots.map((slot) => slot.role_id), { max: 32, lower: true });
  const supervisorRuntime = normalizeSupervisorRuntime(
    row.supervisor_runtime ?? row.supervisorRuntime,
    {
      mode,
      plannerRequested,
      reason,
    }
  );
  const collaborationCells = normalizeCollaborationCellList(
    row.collaboration_cells ?? row.collaborationCells ?? []
  );
  const authorityGraph = normalizeAuthorityGraph(
    row.authority_graph ?? row.authorityGraph ?? [],
    slots,
    runtimeAgents
  );
  if (supervisorRuntime?.enabled === true) {
    const registry = new AuthorityRegistry();
    const profile = registry.resolve(supervisorRuntime.authority_profile_id);
    authorityGraph.push({
      slot_id: undefined,
      authority_profile_id: supervisorRuntime.authority_profile_id,
      instance_id: supervisorRuntime.instance_id,
      role_id: "supervisor_runtime",
      allowed_actions: normalizeStringList(profile?.allowed_actions ?? [], { max: 32, lower: true }),
      denied_actions: normalizeStringList(profile?.denied_actions ?? [], { max: 32, lower: true }),
      approval_required_for: normalizeStringList(profile?.approval_required_for ?? [], { max: 32, lower: true }),
      tool_allowlist: normalizeStringList(profile?.tool_allowlist ?? [], { max: 32, lower: true }),
      max_parallel_children: Number.isFinite(Number(profile?.max_parallel_children))
        ? Math.max(0, Math.min(16, Math.floor(Number(profile.max_parallel_children))))
        : 0,
    });
  }
  const executionGraph = normalizeExecutionGraph(
    row.execution_graph ?? row.executionGraph ?? {},
    {
      slots,
      dependencies,
      executionOrder,
      runtimeAgents,
      supervisorRuntime,
      collaborationCells,
      checkpoints: row.checkpoints ?? [],
    }
  );
  const checkpoints = normalizeExecutionCheckpointList(
    row.checkpoints ?? []
  );
  const selectionExplanations = normalizeSelectionExplanations(
    row.selection_explanations ?? row.selectionExplanations ?? [],
    { plannerRequested }
  );
  const legacyRoles = buildLegacyRoles({
    slots,
    runtimeAgents,
    dependencies,
    taskGoal: taskInterpretation.goal,
  });
  const budget = normalizeBudget(row.budget);

  return {
    team_plan_id: normalizeText(row.team_plan_id || row.teamPlanId || row.id || "team_plan").toLowerCase()
      || "team_plan",
    task_interpretation: taskInterpretation,
    supervisor_runtime: supervisorRuntime,
    slots,
    runtime_agents: runtimeAgents,
    collaboration_cells: collaborationCells,
    authority_graph: authorityGraph,
    execution_graph: executionGraph,
    checkpoints,
    selection_explanations: selectionExplanations,
    conversation_preferences: normalizeConversationPreferences(
      row.conversation_preferences ?? row.conversationPreferences
    ),
    mode,
    roles: legacyRoles,
    dependencies,
    execution_order: executionOrder,
    reason,
    budget,
  };
}

export function validateTeamPlan(raw = {}) {
  const plan = normalizeTeamPlan(raw);
  const errors = [];
  if (!Array.isArray(plan.slots) || plan.slots.length === 0) errors.push("slots_required");
  if (!Array.isArray(plan.execution_order) || plan.execution_order.length === 0) errors.push("execution_order_required");
  if (plan.runtime_agents.some((agent) => agent.role_id === "deprecated_control_plane_only")) {
    errors.push("planner_not_allowed_as_runtime_worker");
  }
  return {
    ok: errors.length === 0,
    errors,
    team_plan: plan,
  };
}
