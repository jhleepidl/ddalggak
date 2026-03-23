import { normalizeAnswerCapsules } from "../application/answer_capsules.js";
import { normalizeInstallProposalState } from "../application/install_proposal_state.js";
import { normalizeCredentialBindingState } from "../application/credential_binding.js";
import { normalizePatternConflictState, normalizeTemporaryExecutionOverride, normalizePatternRecoveryState } from "../application/pattern_conflict_detector.js";
import { compactInputRequest } from "../shared/input_request_schema.js";
import { normalizeParticipantExecutionSchema, getParticipantLegacyRequiredToolIds, getParticipantLegacyOptionalToolIds, getParticipantLegacyRecommendedToolIds } from "../shared/participant_schema.js";
import fs from "node:fs";
import path from "node:path";

function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRuntimeCheckpointRef(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const row = { ...raw };
  return {
    checkpoint_id: String(row.checkpoint_id || row.id || "").trim() || undefined,
    json_file: String(row.json_file || "").trim() || undefined,
    markdown_file: String(row.markdown_file || "").trim() || undefined,
    directory: String(row.directory || "").trim() || undefined,
    summary: String(row.summary || "").trim() || undefined,
  };
}

function normalizePendingApproval(raw) {
  if (!raw || typeof raw !== "object") return null;
  const row = { ...raw };
  const previewLines = Array.isArray(row.preview_lines)
    ? row.preview_lines.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  const actionsSummary = Array.isArray(row.actions_summary)
    ? row.actions_summary.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  const runtimePolicySummary = Array.isArray(row.runtime_policy_summary || row.runtimePolicySummary)
    ? (row.runtime_policy_summary || row.runtimePolicySummary).map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
    : [];
  return {
    ...row,
    id: String(row.id || "").trim(),
    chat_id: String(row.chat_id || "").trim(),
    job_id: String(row.job_id || "").trim(),
    reason: String(row.reason || "").trim(),
    ts: String(row.ts || nowIso()),
    original_user_text: String(row.original_user_text || "").trim(),
    force_mode: String(row.force_mode || "").trim().toLowerCase() === "work" ? "work" : "normal",
    gate_type: String(row.gate_type || "").trim() || undefined,
    mode_choice_required: row.mode_choice_required === true,
    preview_reason: String(row.preview_reason || row.reason || "").trim() || undefined,
    actions_summary: actionsSummary,
    action_source: String(row.action_source || row.actionSource || "").trim() || undefined,
    checkpoint_id: String(row.checkpoint_id || "").trim() || undefined,
    checkpoint_ids: Array.isArray(row.checkpoint_ids)
      ? row.checkpoint_ids.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 16)
      : [],
    checkpoint_status: String(row.checkpoint_status || "").trim() || undefined,
    supervisor_runtime: row.supervisor_runtime && typeof row.supervisor_runtime === "object"
      ? row.supervisor_runtime
      : (row.supervisorRuntime && typeof row.supervisorRuntime === "object" ? row.supervisorRuntime : undefined),
    runtime_team_snapshot: row.runtime_team_snapshot && typeof row.runtime_team_snapshot === "object"
      ? row.runtime_team_snapshot
      : (row.runtimeTeamSnapshot && typeof row.runtimeTeamSnapshot === "object" ? row.runtimeTeamSnapshot : undefined),
    cancel_impact: String(row.cancel_impact || "").trim() || undefined,
    preview_lines: previewLines,
    runtime_policy_summary: runtimePolicySummary,
    runtime_checkpoint: normalizeRuntimeCheckpointRef(row.runtime_checkpoint || row.runtimeCheckpoint),
  };
}

function normalizePublicSearchCache(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const blueprintId = String(row.blueprint_id || row.blueprintId || "").trim();
    const publicNodeId = String(row.public_node_id || row.publicNodeId || row.node_id || "").trim();
    const agentId = String(row.agent_id || row.agentId || "").trim().toLowerCase();
    if (!blueprintId && !publicNodeId && !agentId) continue;
    out.push({
      blueprint_id: blueprintId,
      public_node_id: publicNodeId,
      agent_id: agentId,
      title: String(row.title || "").trim(),
      tags: Array.isArray(row.tags)
        ? row.tags.map((v) => String(v || "").trim()).filter(Boolean).slice(0, 16)
        : [],
      updated_at: String(row.updated_at || nowIso()),
    });
    if (out.length >= 20) break;
  }
  return out;
}


function clipSessionText(value = "", max = 5000) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function normalizeRecentAgentTurns(raw) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const agentId = String(row.agent_id || row.agentId || row.id || "").trim().toLowerCase();
    if (!agentId) continue;
    out.push({
      agent_id: agentId,
      agent_name: String(row.agent_name || row.agentName || row.name || "").trim(),
      role: String(row.role || row.role_id || row.roleId || "").trim().toLowerCase(),
      provider: String(row.provider || "").trim().toLowerCase(),
      model: String(row.model || "").trim(),
      goal: clipSessionText(row.goal, 1200),
      output: clipSessionText(row.output, 5000),
      runtime_instance_id: String(row.runtime_instance_id || row.runtimeInstanceId || "").trim() || undefined,
      slot_id: String(row.slot_id || row.slotId || "").trim() || undefined,
      scope_id: String(row.scope_id || row.scopeId || "").trim() || undefined,
      ts: String(row.ts || nowIso()),
      job_id: String(row.job_id || row.jobId || "").trim() || undefined,
    });
    if (out.length >= 8) break;
  }
  return out;
}

function normalizeAgentStatusMap(raw) {
  const row = raw && typeof raw === "object" ? raw : {};
  const out = {};
  for (const [agentIdRaw, statusRaw] of Object.entries(row)) {
    const agentId = String(agentIdRaw || "").trim().toLowerCase();
    if (!agentId) continue;
    const status = statusRaw && typeof statusRaw === "object" ? statusRaw : {};
    const state = String(status.state || "").trim().toLowerCase();
    const normalizedState = ["queued", "running", "done", "error"].includes(state)
      ? state
      : "queued";
    out[agentId] = {
      state: normalizedState,
      goal: clipSessionText(status.goal || '', 320),
      provider: String(status.provider || '').trim().toLowerCase() || undefined,
      model: String(status.model || '').trim() || undefined,
      execution_channel: String(status.execution_channel || status.executionChannel || '').trim().toLowerCase() || undefined,
      interaction_capabilities: status.interaction_capabilities && typeof status.interaction_capabilities === 'object'
        ? status.interaction_capabilities
        : (status.interactionCapabilities && typeof status.interactionCapabilities === 'object'
          ? status.interactionCapabilities
          : undefined),
      started_at: String(status.started_at || status.startedAt || "").trim() || undefined,
      ended_at: String(status.ended_at || status.endedAt || "").trim() || undefined,
    };
  }
  return out;
}


function clipSessionList(values = [], { max = 8, maxText = 160, lower = false } = {}) {
  const rows = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const value of rows) {
    const text = clipSessionText(value, maxText);
    if (!text) continue;
    const key = lower ? text.toLowerCase() : text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function compactAgentDescriptor(raw = {}) {
  const row = asObject(raw);
  const execution = normalizeParticipantExecutionSchema(row);
  const out = {
    agent_id: String(row.agent_id || row.agentId || row.id || '').trim() || undefined,
    name: clipSessionText(row.name || row.display_label || row.displayLabel || '', 80) || undefined,
    role: String(row.role || row.role_id || row.roleId || '').trim().toLowerCase() || undefined,
    model: String(row.model || '').trim() || undefined,
    provider: String(row.provider || '').trim().toLowerCase() || undefined,
    purpose: clipSessionText(row.purpose || row.assigned_goal || row.assignedGoal || '', 160) || undefined,
    attached_skill_ids: clipSessionList(row.attached_skill_ids || row.attachedSkillIds || row.attached_skills || [], { max: 8, maxText: 80, lower: true }),
    runtime_capabilities_required: clipSessionList(execution.runtime_capabilities_required || [], { max: 8, maxText: 40, lower: true }),
    runtime_capabilities_optional: clipSessionList(execution.runtime_capabilities_optional || [], { max: 8, maxText: 40, lower: true }),
    external_tool_requirements: clipSessionList(execution.external_tool_requirements || [], { max: 8, maxText: 40, lower: true }),
    external_tool_preferences: clipSessionList(execution.external_tool_preferences || [], { max: 8, maxText: 40, lower: true }),
    runtime_capabilities_required_legacy: clipSessionList(getParticipantLegacyRequiredToolIds(execution), { max: 8, maxText: 40, lower: true }),
    runtime_capabilities_optional_legacy: clipSessionList(getParticipantLegacyOptionalToolIds(execution), { max: 8, maxText: 40, lower: true }),
    runtime_capability_preferences_legacy: clipSessionList(getParticipantLegacyRecommendedToolIds(execution), { max: 8, maxText: 40, lower: true }),
    context_policy: row.context_policy && typeof row.context_policy === 'object' ? row.context_policy : undefined,
    agency_overlay_id: String(row.agency_overlay_id || row.agencyOverlayId || '').trim() || undefined,
    agency_overlay: row.agency_overlay && typeof row.agency_overlay === 'object' ? row.agency_overlay : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)));
}

function compactStructureV2ForSession(raw = {}) {
  const row = asObject(raw);
  if (Object.keys(row).length === 0) return undefined;
  const participants = Array.isArray(row.participants)
    ? row.participants.slice(0, 12).map((entry) => {
        const agent = asObject(entry);
        return Object.fromEntries(Object.entries({
          participant_id: String(agent.participant_id || agent.participantId || '').trim() || undefined,
          kind: String(agent.kind || '').trim() || undefined,
          role: String(agent.role || agent.role_id || agent.roleId || '').trim().toLowerCase() || undefined,
          role_id: String(agent.role_id || agent.roleId || agent.role || '').trim().toLowerCase() || undefined,
          label: clipSessionText(agent.label || agent.name || agent.display_label || '', 80) || undefined,
          provider: String(agent.provider || '').trim().toLowerCase() || undefined,
          model: String(agent.model || '').trim() || undefined,
          purpose: clipSessionText(agent.purpose || agent.goal || '', 160) || undefined,
          runtime_capabilities_required: clipSessionList(normalizeParticipantExecutionSchema(agent).runtime_capabilities_required || [], { max: 6, maxText: 40, lower: true }),
          runtime_capabilities_optional: clipSessionList(normalizeParticipantExecutionSchema(agent).runtime_capabilities_optional || [], { max: 6, maxText: 40, lower: true }),
          external_tool_requirements: clipSessionList(normalizeParticipantExecutionSchema(agent).external_tool_requirements || [], { max: 6, maxText: 40, lower: true }),
          external_tool_preferences: clipSessionList(normalizeParticipantExecutionSchema(agent).external_tool_preferences || [], { max: 6, maxText: 40, lower: true }),
          runtime_capabilities_required_legacy: clipSessionList(getParticipantLegacyRequiredToolIds(normalizeParticipantExecutionSchema(agent)), { max: 6, maxText: 40, lower: true }),
          runtime_capabilities_optional_legacy: clipSessionList(getParticipantLegacyOptionalToolIds(normalizeParticipantExecutionSchema(agent)), { max: 6, maxText: 40, lower: true }),
          runtime_capability_preferences_legacy: clipSessionList(getParticipantLegacyRecommendedToolIds(normalizeParticipantExecutionSchema(agent)), { max: 6, maxText: 40, lower: true }),
          context_policy: agent.context_policy && typeof agent.context_policy === 'object' ? agent.context_policy : undefined,
        }).filter(([, value]) => value !== undefined && !(Array.isArray(value) && value.length === 0)));
      })
    : [];
  const topology = asObject(row.topology);
  const interactionPolicy = asObject(row.interaction_policy || row.interactionPolicy);
  const controlPolicy = asObject(row.control_policy || row.controlPolicy);
  const execution = normalizeParticipantExecutionSchema(row);
  const out = {
    metadata: asObject(row.metadata),
    intent: {
      task_brief: clipSessionText(asObject(row.intent).task_brief || asObject(row.intent).taskBrief || '', 240) || undefined,
      task_archetype: String(asObject(row.intent).task_archetype || asObject(row.intent).taskArchetype || '').trim().toLowerCase() || undefined,
    },
    participants,
    topology: Object.fromEntries(Object.entries({
      pattern: String(topology.pattern || '').trim().toLowerCase() || undefined,
      execution_pattern: String(topology.execution_pattern || topology.executionPattern || '').trim().toLowerCase() || undefined,
      final_participant_id: String(topology.final_participant_id || topology.finalParticipantId || '').trim().toLowerCase() || undefined,
      nodes: Array.isArray(topology.nodes) ? topology.nodes.slice(0, 12) : undefined,
      edges: Array.isArray(topology.edges) ? topology.edges.slice(0, 16) : undefined,
    }).filter(([, value]) => value !== undefined)),
    interaction_policy: Object.fromEntries(Object.entries({
      execution_pattern: String(interactionPolicy.execution_pattern || interactionPolicy.executionPattern || '').trim().toLowerCase() || undefined,
      handoff_policy: asObject(interactionPolicy.handoff_policy || interactionPolicy.handoffPolicy),
      followup_policy: asObject(interactionPolicy.followup_policy || interactionPolicy.followupPolicy),
      visibility: asObject(interactionPolicy.visibility),
      debate_policy: asObject(interactionPolicy.debate_policy || interactionPolicy.debatePolicy),
      consensus_policy: asObject(interactionPolicy.consensus_policy || interactionPolicy.consensusPolicy),
    }).filter(([, value]) => value !== undefined && (!(value && typeof value === 'object') || Object.keys(value).length > 0))),
    control_policy: Object.fromEntries(Object.entries({
      final_answer_owner_participant_id: String(controlPolicy.final_answer_owner_participant_id || controlPolicy.finalAnswerOwnerParticipantId || '').trim().toLowerCase() || undefined,
      runtime_execution: asObject(controlPolicy.runtime_execution || controlPolicy.runtimeExecution),
    }).filter(([, value]) => value !== undefined && (!(value && typeof value === 'object') || Object.keys(value).length > 0))),
    requirements: row.requirements && typeof row.requirements === 'object' ? row.requirements : undefined,
    memory_plan: row.memory_plan && typeof row.memory_plan === 'object' ? row.memory_plan : undefined,
    validation: row.validation && typeof row.validation === 'object' ? row.validation : undefined,
  };
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0) && (!(value && typeof value === 'object') || Object.keys(value).length > 0)));
}

function compactSessionTeam(raw = null) {
  const row = raw && typeof raw === 'object' ? raw : null;
  if (!row) return null;
  const agents = Array.isArray(row.agents) ? row.agents.slice(0, 12).map(compactAgentDescriptor) : [];
  const plannerMetadata = row.planner_metadata && typeof row.planner_metadata === 'object'
    ? {
        planner_type: String(row.planner_metadata.planner_type || row.planner_metadata.plannerType || '').trim() || undefined,
        planner_model: String(row.planner_metadata.planner_model || row.planner_metadata.plannerModel || '').trim() || undefined,
        planning_source: String(row.planner_metadata.planning_source || row.planner_metadata.planningSource || '').trim() || undefined,
        reasoning_summary: clipSessionList(row.planner_metadata.reasoning_summary || row.planner_metadata.reasoningSummary || [], { max: 6, maxText: 160, lower: false }),
        selection_reasons: clipSessionList(row.planner_metadata.selection_reasons || row.planner_metadata.selectionReasons || [], { max: 8, maxText: 160, lower: false }),
      }
    : undefined;
  const compact = {
    team_name: clipSessionText(row.team_name || row.teamName || '', 120) || undefined,
    composition_mode: String(row.composition_mode || row.compositionMode || '').trim().toLowerCase() || undefined,
    proposal_mode: String(row.proposal_mode || row.proposalMode || '').trim().toLowerCase() || undefined,
    task_brief: clipSessionText(row.task_brief || row.taskBrief || '', 320) || undefined,
    design_prompt: clipSessionText(row.design_prompt || row.designPrompt || '', 320) || undefined,
    planner_metadata: plannerMetadata,
    agents,
    interaction_spec: row.interaction_spec && typeof row.interaction_spec === 'object' ? row.interaction_spec : undefined,
    shortcut_policy: row.shortcut_policy && typeof row.shortcut_policy === 'object' ? row.shortcut_policy : undefined,
    requirements: row.requirements && typeof row.requirements === 'object' ? row.requirements : undefined,
    runtime_execution: row.runtime_execution && typeof row.runtime_execution === 'object' ? row.runtime_execution : undefined,
    status: String(row.status || '').trim().toLowerCase() || undefined,
    mode: String(row.mode || '').trim().toLowerCase() || undefined,
    task_archetype: String(row.task_archetype || row.taskArchetype || row.archetype || '').trim().toLowerCase() || undefined,
    lock_after_apply: row.lock_after_apply === false ? false : undefined,
    interaction_notes: clipSessionList(row.interaction_notes || row.interactionNotes || [], { max: 10, maxText: 160, lower: false }),
    good_for: clipSessionList(row.good_for || row.goodFor || [], { max: 8, maxText: 80, lower: false }),
    bad_for: clipSessionList(row.bad_for || row.badFor || [], { max: 8, maxText: 80, lower: false }),
    catalog_tags: clipSessionList(row.catalog_tags || row.catalogTags || [], { max: 8, maxText: 40, lower: true }),
    capability_gaps: Array.isArray(row.capability_gaps) ? row.capability_gaps.slice(0, 12) : undefined,
    created_at: String(row.created_at || '').trim() || undefined,
    updated_at: String(row.updated_at || '').trim() || undefined,
    primary_schema: String(row.primary_schema || row.primarySchema || '').trim() || undefined,
    structure_v2: compactStructureV2ForSession(row.structure_v2 || row.structureV2),
    install_proposal_state: row.install_proposal_state && typeof row.install_proposal_state === 'object' ? row.install_proposal_state : undefined,
    credential_binding_state: row.credential_binding_state && typeof row.credential_binding_state === 'object' ? row.credential_binding_state : undefined,
  };
  return Object.fromEntries(Object.entries(compact).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0) && (!(value && typeof value === 'object') || Object.keys(value).length > 0)));
}

function compactRouteAction(raw = {}) {
  const row = asObject(raw);
  return Object.fromEntries(Object.entries({
    type: String(row.type || '').trim().toLowerCase() || undefined,
    agent_id: String(row.agent_id || row.agent || '').trim().toLowerCase() || undefined,
    display_label: clipSessionText(row.display_label || row.inputs?.display_label || row.inputs?.agent_name || '', 80) || undefined,
    goal: clipSessionText(row.goal || row.prompt || row.task || '', 220) || undefined,
    risk: String(row.risk || '').trim().toUpperCase() || undefined,
    scope: row.scope && typeof row.scope === 'object' ? { mode: String(row.scope.mode || '').trim().toLowerCase() || undefined } : undefined,
    inputs: row.inputs && typeof row.inputs === 'object'
      ? Object.fromEntries(Object.entries({
          role_id: String(row.inputs.role_id || row.inputs.roleId || '').trim().toLowerCase() || undefined,
          provider: String(row.inputs.provider || '').trim().toLowerCase() || undefined,
          model: String(row.inputs.model || '').trim() || undefined,
          final_synthesis: row.inputs.final_synthesis === true ? true : undefined,
        }).filter(([, value]) => value !== undefined))
      : undefined,
  }).filter(([, value]) => value !== undefined && (!(value && typeof value === 'object') || Object.keys(value).length > 0)));
}

function compactTaskInterpretation(raw = {}) {
  const row = asObject(raw);
  return Object.fromEntries(Object.entries({
    task_type: String(row.task_type || row.taskType || '').trim().toLowerCase() || undefined,
    deliverable_type: String(row.deliverable_type || row.deliverableType || '').trim().toLowerCase() || undefined,
    risk_level: String(row.risk_level || row.riskLevel || '').trim().toLowerCase() || undefined,
    parallelism_preference: String(row.parallelism_preference || row.parallelismPreference || '').trim().toLowerCase() || undefined,
    task_summary: clipSessionText(row.task_summary || row.summary || row.goal || '', 240) || undefined,
    preferred_roles: clipSessionList(row.preferred_roles || row.preferredRoles || row.preferred_role_ids || row.preferredRoleIds || [], { max: 8, maxText: 40, lower: true }),
    suppressed_role_ids: clipSessionList(row.suppressed_role_ids || row.suppressedRoleIds || [], { max: 8, maxText: 40, lower: true }),
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0)));
}

function compactRuntimeTeamSnapshot(raw = null) {
  const row = raw && typeof raw === 'object' ? raw : null;
  if (!row) return null;
  const executionGraph = asObject(row.execution_graph || row.executionGraph);
  const teamPlanGraph = asObject(asObject(row.team_plan || row.teamPlan).execution_graph || asObject(asObject(row.team_plan || row.teamPlan).executionGraph));
  const activeGraph = Object.keys(executionGraph).length > 0 ? executionGraph : teamPlanGraph;
  return Object.fromEntries(Object.entries({
    task_interpretation: compactTaskInterpretation(row.task_interpretation || row.taskInterpretation || asObject(row.team_plan || row.teamPlan).task_interpretation || asObject(row.team_plan || row.teamPlan).taskInterpretation),
    runtime_agents: Array.isArray(row.runtime_agents || row.runtimeAgents)
      ? (row.runtime_agents || row.runtimeAgents).slice(0, 8).map(compactAgentDescriptor)
      : undefined,
    execution_graph: Object.keys(activeGraph).length > 0 ? Object.fromEntries(Object.entries({
      pattern: String(activeGraph.pattern || '').trim().toLowerCase() || undefined,
      execution_pattern: String(activeGraph.execution_pattern || activeGraph.executionPattern || '').trim().toLowerCase() || undefined,
      final_participant_id: String(activeGraph.final_participant_id || activeGraph.finalParticipantId || '').trim().toLowerCase() || undefined,
      order: clipSessionList(activeGraph.order || activeGraph.execution_order || [], { max: 8, maxText: 60, lower: true }),
      validation: activeGraph.validation && typeof activeGraph.validation === 'object'
        ? {
            warnings: clipSessionList(activeGraph.validation.warnings || [], { max: 4, maxText: 120, lower: false }),
            errors: clipSessionList(activeGraph.validation.errors || [], { max: 4, maxText: 120, lower: false }),
            pattern_ready: activeGraph.validation.pattern_ready === true,
          }
        : undefined,
    }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0) && (!(value && typeof value === 'object') || Object.keys(value).length > 0))) : undefined,
    execution_insights: row.execution_insights && typeof row.execution_insights === 'object' ? row.execution_insights : undefined,
    execution_feedback: row.execution_feedback && typeof row.execution_feedback === 'object' ? row.execution_feedback : undefined,
    blueprint_summary: row.blueprint_summary && typeof row.blueprint_summary === 'object' ? row.blueprint_summary : undefined,
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0) && (!(value && typeof value === 'object') || Object.keys(value).length > 0)));
}

function compactLastRoute(raw = null) {
  const row = raw && typeof raw === 'object' ? raw : null;
  if (!row) return null;
  return Object.fromEntries(Object.entries({
    reason: clipSessionText(row.reason || '', 160) || undefined,
    action_source: String(row.action_source || row.actionSource || '').trim() || undefined,
    plan_source: String(row.plan_source || row.planSource || '').trim() || undefined,
    actions: Array.isArray(row.actions) ? row.actions.slice(0, 8).map(compactRouteAction) : undefined,
    runtime_team_snapshot: compactRuntimeTeamSnapshot(row.runtime_team_snapshot || row.runtimeTeamSnapshot),
    execution_insights: row.execution_insights && typeof row.execution_insights === 'object' ? row.execution_insights : undefined,
    execution_feedback: row.execution_feedback && typeof row.execution_feedback === 'object' ? row.execution_feedback : undefined,
    runtime_authority: row.runtime_authority && typeof row.runtime_authority === 'object'
      ? Object.fromEntries(Object.entries({
          plan_source: String(row.runtime_authority.plan_source || '').trim() || undefined,
          supervisor_engaged: row.runtime_authority.supervisor_engaged === true ? true : undefined,
          team_locked: row.runtime_authority.team_locked === true ? true : undefined,
        }).filter(([, value]) => value !== undefined))
      : undefined,
    done: row.done === true ? true : undefined,
    await_user: row.await_user === true ? true : undefined,
    deliverables: clipSessionList(row.deliverables || [], { max: 8, maxText: 100, lower: false }),
    completed_deliverables: clipSessionList(row.completed_deliverables || row.completedDeliverables || [], { max: 8, maxText: 100, lower: false }),
    followup_hint: clipSessionText(row.followup_hint || row.followupHint || '', 160) || undefined,
    turn: Number.isFinite(Number(row.turn)) ? Math.max(0, Math.floor(Number(row.turn))) : undefined,
    total_actions: Number.isFinite(Number(row.total_actions || row.totalActions)) ? Math.max(0, Math.floor(Number(row.total_actions || row.totalActions))) : undefined,
    final_response_style: String(row.final_response_style || row.finalResponseStyle || '').trim().toLowerCase() || undefined,
  }).filter(([, value]) => value !== undefined && (!(Array.isArray(value)) || value.length > 0) && (!(value && typeof value === 'object') || Object.keys(value).length > 0)));
}

function compactPendingUserRequest(raw = null) {
  const row = raw && typeof raw === 'object' ? raw : null;
  if (!row) return null;
  return compactInputRequest(row);
}

function normalizeSessionTeamConfig(raw) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const activeTeam = row.active_team && typeof row.active_team === 'object' ? row.active_team : null;
  const pendingTeam = row.pending_team && typeof row.pending_team === 'object' ? row.pending_team : null;
  return {
    status: String(row.status || (activeTeam ? 'active' : pendingTeam ? 'suggested' : 'none')).trim().toLowerCase() || 'none',
    active_team: compactSessionTeam(activeTeam),
    pending_team: compactSessionTeam(pendingTeam),
    updated_at: String(row.updated_at || nowIso()),
  };
}

function normalizeSession(chatId, raw = {}) {
  const row = asObject(raw);
  const budgetRaw = asObject(row.budget);
  const pendingMessagesRaw = Array.isArray(row.pending_user_messages)
    ? row.pending_user_messages
    : [];
  const pendingUserMessages = [];
  for (const entry of pendingMessagesRaw) {
    if (!entry || typeof entry !== "object") continue;
    const text = String(entry.text || "").trim();
    if (!text) continue;
    pendingUserMessages.push({
      ts: String(entry.ts || nowIso()),
      user_id: String(entry.user_id || entry.userId || "").trim(),
      text,
      force_mode: String(entry.force_mode || entry.forceMode || "").trim().toLowerCase() === "work" ? "work" : "normal",
      telegram_message_id: Number.isFinite(Number(entry.telegram_message_id))
        ? Number(entry.telegram_message_id)
        : (Number.isFinite(Number(entry.telegramMessageId))
          ? Number(entry.telegramMessageId)
          : null),
    });
    if (pendingUserMessages.length >= 50) break;
  }
  const interruptRaw = row.interrupt && typeof row.interrupt === "object" ? row.interrupt : null;
  const interruptMode = String(interruptRaw?.mode || "").trim().toLowerCase();
  const interrupt = interruptRaw
    ? {
      requested: interruptRaw.requested !== false,
      mode: interruptMode === "cancel" ? "cancel" : "replan",
      reason: String(interruptRaw.reason || "").trim(),
      ts: String(interruptRaw.ts || nowIso()),
    }
    : null;
  const dashboardRaw = row.dashboard && typeof row.dashboard === "object" ? row.dashboard : null;
  const dashboardMessageId = Number.isFinite(Number(dashboardRaw?.message_id))
    ? Number(dashboardRaw.message_id)
    : (Number.isFinite(Number(dashboardRaw?.messageId))
      ? Number(dashboardRaw.messageId)
      : null);
  const currentTurnAckMessageId = Number.isFinite(Number(row.current_turn_ack_message_id))
    ? Number(row.current_turn_ack_message_id)
    : (Number.isFinite(Number(row.currentTurnAckMessageId))
      ? Number(row.currentTurnAckMessageId)
      : null);
  const currentTurnPlanMessageId = Number.isFinite(Number(row.current_turn_plan_message_id))
    ? Number(row.current_turn_plan_message_id)
    : (Number.isFinite(Number(row.currentTurnPlanMessageId))
      ? Number(row.currentTurnPlanMessageId)
      : null);
  return {
    chat_id: String(chatId || row.chat_id || "").trim(),
    jobId: String(row.jobId || "").trim(),
    state: String(row.state || "idle").trim() || "idle",
    active_run_id: String(row.active_run_id || row.activeRunId || "").trim() || null,
    budget: {
      max_actions: Number.isFinite(Number(budgetRaw.max_actions)) ? Math.max(1, Math.floor(Number(budgetRaw.max_actions))) : 4,
      used_actions: Number.isFinite(Number(budgetRaw.used_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.used_actions))) : 0,
      blocked_actions: Number.isFinite(Number(budgetRaw.blocked_actions)) ? Math.max(0, Math.floor(Number(budgetRaw.blocked_actions))) : 0,
    },
    pending_approval: normalizePendingApproval(row.pending_approval),
    pending_user_request: compactPendingUserRequest(row.pending_user_request),
    pending_user_messages: pendingUserMessages,
    interrupt,
    pending_interrupt_strategy: row.pending_interrupt_strategy && typeof row.pending_interrupt_strategy === 'object'
      ? row.pending_interrupt_strategy
      : (row.pendingInterruptStrategy && typeof row.pendingInterruptStrategy === 'object' ? row.pendingInterruptStrategy : null),
    dashboard: dashboardMessageId ? { message_id: dashboardMessageId } : null,
    current_turn_ack_message_id: currentTurnAckMessageId,
    current_turn_plan_message_id: currentTurnPlanMessageId,
    agent_status: normalizeAgentStatusMap(row.agent_status),
    recent_agent_turns: normalizeRecentAgentTurns(row.recent_agent_turns || row.recentAgentTurns),
    answer_capsules: normalizeAnswerCapsules(row.answer_capsules || row.answerCapsules),
    last_route: compactLastRoute(row.last_route),
    public_search_cache: normalizePublicSearchCache(row.public_search_cache),
    team_config: normalizeSessionTeamConfig(row.team_config),
    awaiting_install_approval: row.awaiting_install_approval === true,
    pending_install_proposal: normalizeInstallProposalState(row.pending_install_proposal || row.pendingInstallProposal),
    last_install_proposal: normalizeInstallProposalState(row.last_install_proposal || row.lastInstallProposal),
    credential_binding_state: normalizeCredentialBindingState(row.credential_binding_state || row.credentialBindingState || {}),
    pattern_conflict: normalizePatternConflictState(row.pattern_conflict || row.patternConflict),
    temporary_execution_override: normalizeTemporaryExecutionOverride(row.temporary_execution_override || row.temporaryExecutionOverride),
    pattern_recovery: normalizePatternRecoveryState(row.pattern_recovery || row.patternRecovery),
    updated_at: String(row.updated_at || nowIso()),
  };
}

function normalizeStore(raw = {}) {
  const row = asObject(raw);
  const sessionsRaw = asObject(row.sessions);
  const sessions = {};
  for (const [chatId, session] of Object.entries(sessionsRaw)) {
    const key = String(chatId || "").trim();
    if (!key) continue;
    sessions[key] = normalizeSession(key, session);
  }
  return {
    version: 1,
    updated_at: String(row.updated_at || nowIso()),
    sessions,
  };
}

export class ChatSessionStore {
  constructor({ baseDir } = {}) {
    const dir = path.resolve(baseDir || process.cwd());
    this.filePath = path.join(dir, "chat_sessions.json");
    this.state = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      return normalizeStore(parsed);
    } catch {
      return normalizeStore({});
    }
  }

  _save(next) {
    const normalized = normalizeStore(next);
    normalized.updated_at = nowIso();
    fs.writeFileSync(this.filePath, JSON.stringify(normalized, null, 2), "utf8");
    this.state = normalized;
    return normalized;
  }

  get(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return normalizeSession("", {});
    const found = this.state.sessions[key];
    return normalizeSession(key, found || {});
  }

  upsert(chatId, patchOrUpdater = {}) {
    const key = String(chatId || "").trim();
    if (!key) throw new Error("ChatSessionStore.upsert requires chatId");
    const current = this.get(key);
    const patch = typeof patchOrUpdater === "function"
      ? asObject(patchOrUpdater(current))
      : asObject(patchOrUpdater);
    const next = normalizeSession(key, {
      ...current,
      ...patch,
      budget: {
        ...current.budget,
        ...(patch.budget && typeof patch.budget === "object" ? patch.budget : {}),
      },
      updated_at: nowIso(),
    });
    this._save({
      ...this.state,
      sessions: {
        ...this.state.sessions,
        [key]: next,
      },
    });
    return next;
  }

  clear(chatId) {
    const key = String(chatId || "").trim();
    if (!key) return;
    const nextSessions = { ...this.state.sessions };
    delete nextSessions[key];
    this._save({
      ...this.state,
      sessions: nextSessions,
    });
  }
}
