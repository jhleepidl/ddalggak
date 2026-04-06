import { EXECUTION_ROLE_OPTIONS, STRUCTURE_PARTICIPANT_KIND_OPTIONS, STRUCTURE_PATTERN_OPTIONS } from './team_schema_catalog.js';
import { deriveKnowledgeBaseDesign } from '../knowledge_base/profile.js';
import { normalizeRuntimeExecutionPolicy } from '../application/runtime_execution_policy.js';
import { normalizeParticipantExecutionSchema, getParticipantLegacyRequiredToolIds, getParticipantLegacyOptionalToolIds, getParticipantLegacyRecommendedToolIds } from './participant_schema.js';
import { inferExecutionRoleFromText } from './work_intent.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase(); }
function uniqStrings(values = [], { limit = 24, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = clean(raw);
    if (!text) continue;
    const value = lower ? text.toLowerCase() : text;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

const ALLOWED_PATTERNS = new Set(STRUCTURE_PATTERN_OPTIONS.map((row) => cleanId(row.id)).filter(Boolean));
const ALLOWED_PARTICIPANT_KINDS = new Set(STRUCTURE_PARTICIPANT_KIND_OPTIONS.map((row) => cleanId(row.id)).filter(Boolean));
const EXECUTION_COMPATIBLE_ROLES = new Set(EXECUTION_ROLE_OPTIONS.map((row) => cleanId(row.id)).filter(Boolean));

function isExecutableParticipantKind(kind = '', role = '') {
  const normalizedKind = cleanId(kind);
  if (normalizedKind === 'agent' || normalizedKind === 'judge') return true;
  if (normalizedKind === 'workflow_step') return true;
  return normalizedKind === 'tool_proxy' && EXECUTION_COMPATIBLE_ROLES.has(cleanId(role));
}

export function normalizePattern(raw = '', executionPattern = '', participantCount = 0) {
  const direct = cleanId(raw);
  if (ALLOWED_PATTERNS.has(direct)) return direct;
  const pattern = cleanId(executionPattern);
  if (pattern === 'single_specialist') return participantCount <= 1 ? 'single' : 'sequential';
  if (pattern === 'sequential_pipeline') return 'sequential';
  if (pattern === 'parallel_research_then_review_then_synthesize') return 'parallel';
  if (pattern === 'multi_research_adjudication') return 'debate';
  if (pattern === 'builder_reviewer_loop' || pattern === 'operator_gated_workflow') return 'workflow';
  return participantCount <= 1 ? 'single' : 'hybrid';
}

function inferParticipantRole(raw = {}) {
  const row = asObject(raw);
  const explicit = cleanId(row.role || row.role_id || row.roleId || row.role_label || row.roleLabel || '');
  if (explicit && explicit !== 'specialist' && explicit !== 'agent' && explicit !== 'participant' && explicit !== 'worker') return explicit;
  const inferred = inferExecutionRoleFromText([
    row.role,
    row.role_id,
    row.roleId,
    row.role_label,
    row.roleLabel,
    row.name,
    row.label,
    row.display_name,
    row.displayName,
    row.participant_id,
    row.participantId,
    row.agent_id,
    row.agentId,
    row.id,
    row.purpose,
    row.description,
  ].filter(Boolean).join(' '), { fallback: explicit || 'specialist' });
  return inferred || explicit || 'specialist';
}

function normalizeParticipant(raw = {}, index = 0) {
  const row = asObject(raw);
  const participantId = cleanId(row.participant_id || row.participantId || row.id || row.agent_id || row.agentId || row.name || `participant_${index + 1}`);
  if (!participantId) return null;
  const role = inferParticipantRole(row);
  const requestedKind = cleanId(row.kind || (role === 'approval' ? 'gate' : 'agent')) || 'agent';
  const kind = ALLOWED_PARTICIPANT_KINDS.has(requestedKind) ? requestedKind : 'agent';
  const metadata = {
    ...asObject(row.metadata),
  };
  if (row.agency_overlay || row.agencyOverlay) metadata.agency_overlay = asObject(row.agency_overlay || row.agencyOverlay);
  if (clean(row.agency_overlay_id || row.agencyOverlayId)) metadata.agency_overlay_id = clean(row.agency_overlay_id || row.agencyOverlayId);
  const execution = normalizeParticipantExecutionSchema(row);
  return {
    participant_id: participantId,
    kind,
    name: clean(row.name || row.label || row.display_name || row.displayName || participantId) || participantId,
    role,
    purpose: clean(row.purpose || row.description || ''),
    model: clean(row.model || execution.provider_spec?.model || ''),
    provider: cleanId(row.provider || row.transport || execution.provider_spec?.provider || ''),
    capabilities: uniqStrings(row.capabilities || row.skills || [], { limit: 8 }),
    attached_skill_ids: uniqStrings(row.attached_skill_ids || row.attachedSkillIds || execution.skill_package?.skill_ids || [], { limit: 8 }),
    runtime_capabilities_required: uniqStrings(execution.runtime_capabilities_required || [], { limit: 8 }),
    runtime_capabilities_optional: uniqStrings(execution.runtime_capabilities_optional || [], { limit: 8 }),
    external_tool_requirements: uniqStrings(execution.external_tool_requirements || [], { limit: 8 }),
    external_tool_preferences: uniqStrings(execution.external_tool_preferences || [], { limit: 8 }),
    required_tool_ids: uniqStrings(getParticipantLegacyRequiredToolIds(row), { limit: 8 }),
    optional_tool_ids: uniqStrings(getParticipantLegacyOptionalToolIds(row), { limit: 8 }),
    recommended_tool_ids: uniqStrings(getParticipantLegacyRecommendedToolIds(row), { limit: 8 }),
    generated_skill_briefs: asArray(row.generated_skill_briefs || row.generatedSkillBriefs || execution.skill_package?.generated_skill_briefs || []).slice(0, 8),
    context_policy: asObject(row.context_policy || row.contextPolicy),
    provider_spec: asObject(execution.provider_spec),
    provider_runtime_config: asObject(execution.provider_runtime_config),
    role_profile: asObject(execution.role_profile),
    skill_package: asObject(execution.skill_package),
    memory_contract: asObject(execution.memory_contract),
    metadata,
  };
}

function buildParticipantsFromAgents(agents = []) {
  return asArray(agents)
    .map((agent, index) => normalizeParticipant({
      participant_id: agent?.agent_id || agent?.agentId,
      kind: 'agent',
      name: agent?.name,
      role: agent?.role,
      purpose: agent?.purpose,
      model: agent?.model,
      provider: agent?.provider,
      capabilities: agent?.capabilities || agent?.skills,
      attached_skill_ids: agent?.attached_skill_ids || agent?.attachedSkillIds,
      runtime_capabilities_required: agent?.runtime_capabilities_required || agent?.runtimeCapabilitiesRequired,
      runtime_capabilities_optional: agent?.runtime_capabilities_optional || agent?.runtimeCapabilitiesOptional,
      external_tool_requirements: agent?.external_tool_requirements || agent?.externalToolRequirements,
      external_tool_preferences: agent?.external_tool_preferences || agent?.externalToolPreferences,
      generated_skill_briefs: agent?.generated_skill_briefs || agent?.generatedSkillBriefs,
      context_policy: agent?.context_policy || agent?.contextPolicy,
      metadata: agent?.metadata,
      agency_overlay: agent?.agency_overlay || agent?.agencyOverlay,
      agency_overlay_id: agent?.agency_overlay_id || agent?.agencyOverlayId,
    }, index))
    .filter(Boolean);
}

function resolveParticipantIdByLabel(participants = [], raw = '') {
  const target = clean(raw);
  if (!target) return '';
  const idMatch = participants.find((row) => cleanId(row.participant_id) === cleanId(target));
  if (idMatch) return idMatch.participant_id;
  const nameMatch = participants.find((row) => cleanId(row.name) === cleanId(target));
  if (nameMatch) return nameMatch.participant_id;
  const roleMatch = participants.find((row) => cleanId(row.role) === cleanId(target));
  return roleMatch?.participant_id || '';
}

function buildTopologyNodes(participants = []) {
  return participants.map((participant, index) => ({
    node_id: cleanId(`node_${participant.participant_id}`) || `node_${index + 1}`,
    participant_id: participant.participant_id,
    kind: participant.kind === 'gate' ? 'gate' : (participant.kind === 'tool_proxy' ? 'tool' : 'task'),
    label: participant.name,
  }));
}

function buildSequentialEdges(participants = [], payload = 'summary_only') {
  const out = [];
  for (let index = 0; index < participants.length - 1; index += 1) {
    out.push({
      edge_id: cleanId(`${participants[index].participant_id}_to_${participants[index + 1].participant_id}_${payload}`),
      from: participants[index].participant_id,
      to: participants[index + 1].participant_id,
      kind: 'implied_sequence',
      payload,
    });
  }
  return out;
}

function buildDefaultEdgesForPattern(participants = [], pattern = 'hybrid', finalParticipantId = '') {
  if (participants.length <= 1) return [];
  const finalId = cleanId(finalParticipantId) || participants[participants.length - 1]?.participant_id || '';
  if (pattern === 'parallel') {
    const upstream = participants.filter((row) => row.participant_id !== finalId);
    if (upstream.length >= 1 && finalId) {
      return upstream.map((row) => ({
        edge_id: cleanId(`${row.participant_id}_to_${finalId}_parallel_result`),
        from: row.participant_id,
        to: finalId,
        kind: 'parallel_result',
        payload: 'summary_plus_key_evidence',
      }));
    }
  }
  if (pattern === 'debate') {
    const judgeId = finalId || participants[participants.length - 1]?.participant_id || '';
    const debaters = participants.filter((row) => row.participant_id !== judgeId);
    const out = [];
    for (let index = 0; index < debaters.length - 1; index += 1) {
      out.push({
        edge_id: cleanId(`${debaters[index].participant_id}_to_${debaters[index + 1].participant_id}_rebuttal`),
        from: debaters[index].participant_id,
        to: debaters[index + 1].participant_id,
        kind: 'rebuttal',
        payload: 'claim_plus_supporting_evidence',
      });
    }
    for (const row of debaters) {
      if (!judgeId || row.participant_id === judgeId) continue;
      out.push({
        edge_id: cleanId(`${row.participant_id}_to_${judgeId}_adjudication_input`),
        from: row.participant_id,
        to: judgeId,
        kind: 'adjudication_input',
        payload: 'summary_plus_key_evidence',
      });
    }
    return out;
  }
  if (pattern === 'committee') {
    const chairId = finalId || participants[0]?.participant_id || '';
    const out = participants
      .filter((row) => row.participant_id !== chairId)
      .map((row) => ({
        edge_id: cleanId(`${row.participant_id}_to_${chairId}_committee_vote`),
        from: row.participant_id,
        to: chairId,
        kind: 'committee_vote',
        payload: 'summary_plus_key_evidence',
      }));
    return out.length > 0 ? out : buildSequentialEdges(participants);
  }
  return buildSequentialEdges(participants);
}

function buildTopologyEdges(participants = [], interactionSpec = {}, pattern = 'hybrid', finalParticipantId = '') {
  const row = asObject(interactionSpec);
  const out = [];
  for (const handoff of asArray(row.handoffs)) {
    const fromId = resolveParticipantIdByLabel(participants, handoff?.from);
    const toId = resolveParticipantIdByLabel(participants, handoff?.to);
    if (!fromId || !toId) continue;
    out.push({
      edge_id: cleanId(`${fromId}_to_${toId}_${handoff?.payload || 'summary_only'}`),
      from: fromId,
      to: toId,
      kind: cleanId(handoff?.kind || 'handoff') || 'handoff',
      payload: cleanId(handoff?.payload || 'summary_only') || 'summary_only',
    });
  }
  if (out.length === 0) return buildDefaultEdgesForPattern(participants, pattern, finalParticipantId).slice(0, 32);
  return out.slice(0, 32);
}

function normalizeDebatePolicy(raw = {}, participants = [], finalParticipantId = '') {
  const row = asObject(raw);
  return {
    rounds: Number.isFinite(Number(row.rounds)) ? Math.max(1, Math.min(6, Math.floor(Number(row.rounds)))) : 1,
    rebuttal_required: row.rebuttal_required !== false && row.rebuttalRequired !== false,
    adjudicator_participant_id: resolveParticipantIdByLabel(participants, row.adjudicator_participant_id || row.adjudicatorParticipantId || row.judge || finalParticipantId),
  };
}

function normalizeConsensusPolicy(raw = {}, participants = []) {
  const row = asObject(raw);
  return {
    mode: cleanId(row.mode || row.policy || 'majority') || 'majority',
    quorum: Number.isFinite(Number(row.quorum)) ? Math.max(1, Math.min(Math.max(participants.length, 1), Math.floor(Number(row.quorum)))) : Math.max(1, Math.ceil(participants.length / 2)),
  };
}

function dedupeNodes(nodes = [], participants = []) {
  const seen = new Set();
  const participantSet = new Set(participants.map((row) => row.participant_id));
  const out = [];
  for (const raw of asArray(nodes)) {
    const row = asObject(raw);
    const nodeId = cleanId(row.node_id || row.nodeId || row.id || `node_${out.length + 1}`) || `node_${out.length + 1}`;
    const participantId = resolveParticipantIdByLabel(participants, row.participant_id || row.participantId || row.participant);
    if (!participantId || !participantSet.has(participantId) || seen.has(nodeId)) continue;
    seen.add(nodeId);
    out.push({
      node_id: nodeId,
      participant_id: participantId,
      kind: cleanId(row.kind || 'task') || 'task',
      label: clean(row.label || row.name || ''),
    });
  }
  for (const participant of participants) {
    const exists = out.some((row) => row.participant_id === participant.participant_id);
    if (!exists) out.push({
      node_id: cleanId(`node_${participant.participant_id}`) || `node_${out.length + 1}`,
      participant_id: participant.participant_id,
      kind: participant.kind === 'gate' ? 'gate' : (participant.kind === 'tool_proxy' ? 'tool' : 'task'),
      label: participant.name,
    });
  }
  return out.slice(0, 48);
}

function dedupeEdges(edges = [], participants = []) {
  const allowed = new Set(participants.map((row) => row.participant_id));
  const seen = new Set();
  const out = [];
  for (const raw of asArray(edges)) {
    const row = asObject(raw);
    const from = resolveParticipantIdByLabel(participants, row.from);
    const to = resolveParticipantIdByLabel(participants, row.to);
    if (!from || !to || !allowed.has(from) || !allowed.has(to)) continue;
    const edgeId = cleanId(row.edge_id || row.edgeId || row.id || `${from}_to_${to}_${row.kind || 'handoff'}`) || `edge_${out.length + 1}`;
    if (seen.has(edgeId)) continue;
    seen.add(edgeId);
    out.push({
      edge_id: edgeId,
      from,
      to,
      kind: cleanId(row.kind || 'handoff') || 'handoff',
      payload: cleanId(row.payload || 'summary_only') || 'summary_only',
      condition: clean(row.condition || ''),
    });
  }
  return out.slice(0, 64);
}


function orderedParticipantIds(participants = [], allowed = null) {
  const allowedSet = allowed instanceof Set ? allowed : (Array.isArray(allowed) ? new Set(allowed.map((entry) => cleanId(entry))) : null);
  const out = [];
  for (const participant of asArray(participants)) {
    const participantId = cleanId(participant?.participant_id);
    if (!participantId) continue;
    if (allowedSet && !allowedSet.has(participantId)) continue;
    out.push(participantId);
  }
  return out;
}

function topologicalLevelsForParticipants(participants = [], edges = [], allowed = null) {
  const ids = orderedParticipantIds(participants, allowed);
  const idSet = new Set(ids);
  const incoming = new Map(ids.map((id) => [id, 0]));
  const outgoing = new Map(ids.map((id) => [id, []]));
  for (const edge of asArray(edges)) {
    const from = cleanId(edge?.from);
    const to = cleanId(edge?.to);
    if (!from || !to || from === to || !idSet.has(from) || !idSet.has(to)) continue;
    outgoing.get(from)?.push(to);
    incoming.set(to, (incoming.get(to) || 0) + 1);
  }
  const remaining = new Set(ids);
  const levels = [];
  while (remaining.size > 0) {
    const ready = ids.filter((id) => remaining.has(id) && (incoming.get(id) || 0) === 0);
    if (ready.length === 0) {
      return { levels: [Array.from(remaining)], cyclic: true };
    }
    levels.push(ready);
    for (const id of ready) {
      remaining.delete(id);
      for (const child of outgoing.get(id) || []) {
        incoming.set(child, Math.max(0, (incoming.get(child) || 0) - 1));
      }
    }
  }
  return { levels, cyclic: false };
}

function deriveStructureExecutionGraph(structure = {}, executableParticipants = [], nonExecutableParticipants = []) {
  const participants = asArray(structure.participants);
  const participantById = new Map(participants.map((entry) => [cleanId(entry?.participant_id), entry]));
  const executableIdSet = new Set(asArray(executableParticipants).map((entry) => cleanId(entry?.participant_id)).filter(Boolean));
  const { levels: executableLevels, cyclic } = topologicalLevelsForParticipants(participants, asArray(structure?.topology?.edges), executableIdSet);
  const executableOrder = executableLevels.flat();
  const stageByParticipantId = new Map();
  const parallelGroupByParticipantId = new Map();
  const stages = executableLevels.map((group, index) => ({
    stage_id: `stage_${index + 1}`,
    participant_ids: group,
    mode: group.length > 1 ? 'parallel' : 'serial',
  }));
  for (const [index, stage] of stages.entries()) {
    for (const participantId of stage.participant_ids) stageByParticipantId.set(cleanId(participantId), index);
  }
  const parallelGroups = stages
    .filter((stage) => stage.participant_ids.length > 1)
    .map((stage, index) => {
      const roleIds = stage.participant_ids
        .map((participantId) => cleanId(participantById.get(cleanId(participantId))?.role))
        .filter(Boolean);
      const group = {
        parallel_group_id: `structure_parallel_group_${index + 1}`,
        participant_ids: stage.participant_ids,
        slot_ids: stage.participant_ids,
        role_ids: roleIds,
      };
      for (const participantId of stage.participant_ids) parallelGroupByParticipantId.set(cleanId(participantId), group.parallel_group_id);
      return group;
    });
  const barrierParticipantIds = [];
  for (let index = 1; index < stages.length; index += 1) {
    if (stages[index - 1].participant_ids.length > 1) barrierParticipantIds.push(...stages[index].participant_ids);
  }
  const finalParticipantId = cleanId(structure?.topology?.final_participant_id || structure?.control_policy?.final_answer_owner_participant_id || '') || undefined;
  const pattern = cleanId(structure?.topology?.pattern || 'hybrid') || 'hybrid';
  const debatePolicy = asObject(structure?.interaction_policy?.debate_policy);
  const consensusPolicy = asObject(structure?.interaction_policy?.consensus_policy);
  const debateDescriptor = pattern === 'debate'
    ? {
        rounds: Number.isFinite(Number(debatePolicy.rounds)) ? Math.max(1, Math.floor(Number(debatePolicy.rounds))) : 1,
        adjudicator_participant_id: cleanId(debatePolicy.adjudicator_participant_id || finalParticipantId || '') || undefined,
        debater_participant_ids: executableOrder.filter((participantId) => participantId !== cleanId(debatePolicy.adjudicator_participant_id || finalParticipantId || '')),
        rebuttal_required: debatePolicy.rebuttal_required !== false,
      }
    : undefined;
  const committeeDescriptor = pattern === 'committee'
    ? {
        mode: cleanId(consensusPolicy.mode || 'majority') || 'majority',
        quorum: Number.isFinite(Number(consensusPolicy.quorum)) ? Math.max(1, Math.floor(Number(consensusPolicy.quorum))) : undefined,
        chair_participant_id: finalParticipantId,
        member_participant_ids: executableOrder.filter((participantId) => participantId !== finalParticipantId),
      }
    : undefined;
  const validation = asObject(structure?.validation);
  return {
    pattern,
    execution_pattern: cleanId(structure?.topology?.execution_pattern || '') || undefined,
    nodes: asArray(structure?.topology?.nodes).map((node) => ({
      ...node,
      slot_id: cleanId(node?.participant_id || node?.slot_id || node?.slotId || ''),
      role_id: cleanId(participantById.get(cleanId(node?.participant_id || node?.slot_id || node?.slotId || ''))?.role || node?.role_id || node?.roleId || ''),
    })),
    edges: asArray(structure?.topology?.edges).map((edge) => ({
      ...edge,
      from_slot_id: cleanId(edge?.from_slot_id || edge?.fromSlotId || edge?.from || ''),
      to_slot_id: cleanId(edge?.to_slot_id || edge?.toSlotId || edge?.to || ''),
      relation: cleanId(edge?.kind || edge?.relation || 'precedes') || 'precedes',
    })),
    final_participant_id: finalParticipantId,
    order: executableOrder,
    stages,
    stage_by_participant_id: Object.fromEntries(stageByParticipantId.entries()),
    parallel_groups: parallelGroups,
    barrier_participant_ids: uniqStrings(barrierParticipantIds, { limit: 24, lower: true }),
    non_executable_participants: asArray(nonExecutableParticipants).map((entry) => ({ participant_id: entry.participant_id, kind: entry.kind, name: entry.name })),
    debate_policy: debatePolicy,
    debate: debateDescriptor,
    consensus_policy: consensusPolicy,
    committee: committeeDescriptor,
    cyclic_topology: cyclic === true,
    native_runtime_ready: validation.errors?.length === 0,
    execution_mode: cyclic === true ? 'compatibility_fallback' : (pattern === 'single' ? 'single_native' : (pattern === 'sequential' ? 'topology_sequential' : (pattern === 'parallel' ? 'topology_parallel_partial' : (pattern === 'debate' ? 'topology_debate_partial' : (pattern === 'graph' ? 'topology_graph_partial' : 'topology_hybrid'))))),
    validation,
  };
}

function validatePatternConstraints(structure = {}) {
  const participants = asArray(structure.participants);
  const topology = asObject(structure.topology);
  const pattern = cleanId(topology.pattern || 'hybrid') || 'hybrid';
  const edges = asArray(topology.edges);
  const warnings = [];
  const errors = [];
  const repairs = [];
  const executableParticipants = participants.filter((entry) => isExecutableParticipantKind(entry?.kind, entry?.role));
  const executableIds = new Set(executableParticipants.map((entry) => cleanId(entry.participant_id)).filter(Boolean));
  const finalParticipantId = cleanId(topology.final_participant_id || structure.control_policy?.final_answer_owner_participant_id || '');
  const finalParticipant = participants.find((entry) => cleanId(entry?.participant_id) === finalParticipantId) || null;
  const { levels: executableLevels, cyclic } = topologicalLevelsForParticipants(participants, edges, executableIds);
  const incomingExecutableCounts = new Map();
  for (const edge of edges) {
    const from = cleanId(edge?.from);
    const to = cleanId(edge?.to);
    if (!from || !to || !executableIds.has(from) || !executableIds.has(to)) continue;
    incomingExecutableCounts.set(to, (incomingExecutableCounts.get(to) || 0) + 1);
  }
  if (participants.length === 0) errors.push('structure_v2 must include at least one participant');
  if (executableParticipants.length === 0) errors.push('structure_v2 must include at least one executable participant');
  if (cyclic === true && pattern === 'graph') errors.push(`${pattern} pattern contains a cycle in executable topology`);
  if (cyclic === true && pattern === 'workflow') warnings.push('workflow pattern contains a review/build cycle; runtime will execute with workflow-aware compatibility ordering');
  if (pattern === 'single' && participants.length > 1) warnings.push('single pattern currently has multiple participants; runtime will degrade to a compatibility pipeline');
  if (pattern === 'parallel') {
    if (executableParticipants.length < 2) errors.push('parallel pattern requires at least two executable participants');
    if (!finalParticipantId && executableParticipants.length > 2) warnings.push('parallel pattern should set an explicit final/merge participant');
    if (edges.length === 0) warnings.push('parallel pattern had no explicit edges; default fan-out/fan-in edges were synthesized');
    const mergeCandidateCount = Array.from(incomingExecutableCounts.values()).filter((count) => count > 1).length;
    if (edges.length > 0 && executableParticipants.length > 2 && mergeCandidateCount === 0) warnings.push('parallel pattern has no explicit merge barrier; runtime will flatten to stage-based fan-in');
  }
  if (pattern === 'debate') {
    const adjudicatorId = cleanId(structure?.interaction_policy?.debate_policy?.adjudicator_participant_id || finalParticipantId || '');
    const debaterCount = executableParticipants.filter((entry) => cleanId(entry.participant_id) !== adjudicatorId).length;
    if (debaterCount < 2) warnings.push('debate pattern works best with at least two debaters plus one judge/synthesizer');
    if (!adjudicatorId) warnings.push('debate pattern has no explicit adjudicator/final participant');
    const hasRebuttal = edges.some((edge) => cleanId(edge.kind) === 'rebuttal');
    if (!hasRebuttal && edges.length > 0 && structure?.interaction_policy?.debate_policy?.rebuttal_required !== false) warnings.push('debate pattern has no explicit rebuttal edge');
  }
  if (pattern === 'committee') {
    const quorum = Number(structure?.interaction_policy?.consensus_policy?.quorum || 0);
    if (participants.length < 3) warnings.push('committee pattern usually needs at least three participants');
    if (!finalParticipantId) warnings.push('committee pattern should set an explicit chair/final participant');
    if (edges.length === 0) warnings.push('committee pattern had no explicit consensus edges; default vote edges were synthesized');
    if (Number.isFinite(quorum) && quorum > executableParticipants.length && executableParticipants.length > 0) errors.push('committee quorum cannot exceed executable participant count');
  }
  if (pattern === 'graph') {
    if (asArray(topology.nodes).length === 0) errors.push('graph pattern requires explicit nodes');
    if (edges.length === 0) errors.push('graph pattern requires explicit edges');
    const isolatedExecutable = executableParticipants.filter((entry) => {
      const participantId = cleanId(entry.participant_id);
      return !edges.some((edge) => cleanId(edge.from) === participantId || cleanId(edge.to) === participantId);
    });
    if (isolatedExecutable.length > 0 && executableParticipants.length > 1) warnings.push(`graph pattern has isolated executable participants: ${isolatedExecutable.map((entry) => entry.participant_id).join(', ')}`);
    if (finalParticipantId && !edges.some((edge) => cleanId(edge.to) === finalParticipantId) && executableParticipants.length > 1) warnings.push('graph final participant has no inbound edge; final synthesis may degrade to compatibility order');
  }
  if (pattern === 'workflow' && edges.length === 0 && participants.length > 1) warnings.push('workflow pattern had no explicit transitions; sequential compatibility edges were synthesized');
  if (participants.length > 1 && !finalParticipantId) {
    warnings.push('final participant was not set; compatibility layer will use the last participant');
  }
  if (finalParticipantId && !finalParticipant) {
    errors.push('final participant references a missing participant');
  } else if (finalParticipant && executableParticipants.length > 0 && !executableIds.has(finalParticipantId) && (pattern === 'parallel' || pattern === 'debate' || pattern === 'committee' || pattern === 'workflow')) {
    errors.push(`${pattern} pattern requires the final participant to be executable`);
  }
  if (executableLevels.length > 4 && pattern !== 'graph' && pattern !== 'workflow') warnings.push('topology spans many sequential stages; consider graph/workflow pattern for clearer execution semantics');
  return {
    warnings,
    errors,
    repairs,
    pattern_ready: errors.length === 0,
    strict_pattern_ready: errors.length === 0 && warnings.length === 0,
  };
}

export function buildTeamStructureV2(team = {}, { applyState = 'pending', installProposalState = null, credentialBindingState = null } = {}) {
  const row = asObject(team);
  const participants = buildParticipantsFromAgents(row.agents || []);
  const interactionSpec = asObject(row.interaction_spec || row.interactionSpec);
  const interactionPolicies = asObject(interactionSpec.policies);
  const shortcut = asObject(row.shortcut_policy || row.shortcutPolicy);
  const installState = asObject(installProposalState || row.install_proposal_state || row.installProposalState);
  const bindingState = asObject(credentialBindingState || row.credential_binding_state || row.credentialBindingState);
  const finalOwnerId = resolveParticipantIdByLabel(participants, interactionSpec.final_answer_owner || interactionSpec.finalAnswerOwner || interactionSpec.final_owner || interactionSpec.finalOwner);
  const pattern = normalizePattern(row?.structure_v2?.topology?.pattern, interactionSpec.execution_pattern, participants.length);
  const baseStructure = {
    kind: 'team_structure_v2',
    version: 2,
    metadata: {
      team_name: clean(row.team_name || row.teamName || 'configured_team') || 'configured_team',
      composition_mode: cleanId(row.composition_mode || row.compositionMode || 'structured') || 'structured',
      proposal_mode: cleanId(row.proposal_mode || row.proposalMode || 'suggest') || 'suggest',
      status: cleanId(row.status || 'draft') || 'draft',
      planner_metadata: asObject(row.planner_metadata || row.plannerMetadata),
    },
    intent: {
      task_brief: clean(row.task_brief || row.taskBrief || row.task || row.design_prompt || row.designPrompt || ''),
      design_prompt: clean(row.design_prompt || row.designPrompt || row.task_brief || row.taskBrief || ''),
      success_criteria: uniqStrings(row.success_criteria || row.successCriteria || [], { limit: 8 }),
      risk_profile: cleanId(row.risk_profile || row.riskProfile || 'medium') || 'medium',
    },
    participants,
    topology: {
      pattern,
      execution_pattern: cleanId(interactionSpec.execution_pattern || interactionSpec.executionPattern || ''),
      nodes: buildTopologyNodes(participants),
      edges: buildTopologyEdges(participants, interactionSpec, pattern, finalOwnerId),
      final_participant_id: finalOwnerId || undefined,
    },
    interaction_policy: {
      visibility: {
        reviewer_visibility: cleanId(interactionPolicies.reviewer_visibility || 'summaries_plus_selected_evidence') || 'summaries_plus_selected_evidence',
        synthesizer_visibility: cleanId(interactionPolicies.synthesizer_visibility || 'upstream_outputs_only') || 'upstream_outputs_only',
      },
      handoff_policy: {
        direct_response_enabled: interactionPolicies.builder_direct_response === true,
        followup_shortcuts_enabled: shortcut.enabled !== false,
        max_recent_turns: Number.isFinite(Number(shortcut.max_recent_turns)) ? Math.max(1, Math.min(12, Math.floor(Number(shortcut.max_recent_turns)))) : 6,
      },
      followup_policy: {
        only_for_followups: shortcut.only_for_followups !== false,
        disallow_when_pending_approval: shortcut.disallow_when_pending_approval !== false,
      },
      debate_policy: normalizeDebatePolicy(row?.structure_v2?.interaction_policy?.debate_policy || row?.structure_v2?.interactionPolicy?.debatePolicy || {}, participants, finalOwnerId),
      consensus_policy: normalizeConsensusPolicy(row?.structure_v2?.interaction_policy?.consensus_policy || row?.structure_v2?.interactionPolicy?.consensusPolicy || {}, participants),
    },
    control_policy: {
      final_answer_owner_participant_id: finalOwnerId || undefined,
      require_reviewer_before_final: interactionPolicies.require_reviewer_before_final !== false,
      approval_mode: row.lock_after_apply === false ? 'unlocked' : 'apply_then_lock',
      resume_supported: true,
      runtime_execution: normalizeRuntimeExecutionPolicy(row?.structure_v2?.control_policy?.runtime_execution || row?.structure_v2?.control_policy?.runtimeExecution || row?.control_policy?.runtime_execution || row?.control_policy?.runtimeExecution || row?.runtime_execution || row?.runtimeExecution || {}),
    },
    artifacts: {
      expected_outputs: uniqStrings(row.expected_outputs || row.expectedOutputs || [], { limit: 8 }),
      artifact_contracts: asArray(row.artifact_contracts || row.artifactContracts || []).slice(0, 12),
    },
    requirements: asObject(row.requirements),
    runtime_state: {
      apply_state: String(applyState || 'pending').trim().toLowerCase() === 'active' ? 'active' : 'pending',
      install_proposal_status: cleanId(installState.status || '') || undefined,
      bound_credential_keys: uniqStrings(bindingState.bound_keys || [], { limit: 16, lower: true }),
    },
  };
  const knowledgeDesign = deriveKnowledgeBaseDesign({
    goal: baseStructure.intent.task_brief || '',
    teamConfig: {
      ...row,
      task_brief: baseStructure.intent.task_brief,
      structure_v2: {
        ...baseStructure,
        metadata: { ...baseStructure.metadata },
        intent: { ...baseStructure.intent },
      },
    },
  });
  const structure = {
    ...baseStructure,
    knowledge_surface: knowledgeDesign.knowledge_surface,
    memory_policy: knowledgeDesign.memory_policy,
    memory_plan: knowledgeDesign.memory_plan,
  };
  const validation = validatePatternConstraints(structure);
  return {
    ...structure,
    validation,
  };
}

export function normalizeTeamStructureV2(raw = {}) {
  const row = asObject(raw);
  const participants = asArray(row.participants).map((entry, index) => normalizeParticipant(entry, index)).filter(Boolean);
  const topology = asObject(row.topology);
  const normalizedPattern = normalizePattern(topology.pattern, topology.execution_pattern || topology.executionPattern, participants.length);
  const finalParticipantId = resolveParticipantIdByLabel(participants, topology.final_participant_id || topology.finalParticipantId || row?.control_policy?.final_answer_owner_participant_id || row?.control_policy?.finalAnswerOwnerParticipantId);
  const nodes = dedupeNodes(topology.nodes, participants);
  let edges = dedupeEdges(topology.edges, participants);
  if (edges.length === 0) edges = buildDefaultEdgesForPattern(participants, normalizedPattern, finalParticipantId);
  const baseStructure = {
    kind: 'team_structure_v2',
    version: 2,
    metadata: {
      team_name: clean(row?.metadata?.team_name || row?.metadata?.teamName || 'configured_team') || 'configured_team',
      composition_mode: cleanId(row?.metadata?.composition_mode || row?.metadata?.compositionMode || 'structured') || 'structured',
      proposal_mode: cleanId(row?.metadata?.proposal_mode || row?.metadata?.proposalMode || 'suggest') || 'suggest',
      status: cleanId(row?.metadata?.status || 'draft') || 'draft',
      planner_metadata: asObject(row?.metadata?.planner_metadata || row?.metadata?.plannerMetadata),
    },
    intent: {
      task_brief: clean(row?.intent?.task_brief || row?.intent?.taskBrief || ''),
      design_prompt: clean(row?.intent?.design_prompt || row?.intent?.designPrompt || row?.intent?.task_brief || row?.intent?.taskBrief || ''),
      success_criteria: uniqStrings(row?.intent?.success_criteria || row?.intent?.successCriteria || [], { limit: 8 }),
      risk_profile: cleanId(row?.intent?.risk_profile || row?.intent?.riskProfile || 'medium') || 'medium',
    },
    participants,
    topology: {
      pattern: normalizedPattern,
      execution_pattern: cleanId(topology.execution_pattern || topology.executionPattern || ''),
      nodes,
      edges,
      final_participant_id: finalParticipantId || undefined,
    },
    interaction_policy: {
      visibility: {
        reviewer_visibility: cleanId(row?.interaction_policy?.visibility?.reviewer_visibility || row?.interaction_policy?.visibility?.reviewerVisibility || 'summaries_plus_selected_evidence') || 'summaries_plus_selected_evidence',
        synthesizer_visibility: cleanId(row?.interaction_policy?.visibility?.synthesizer_visibility || row?.interaction_policy?.visibility?.synthesizerVisibility || 'upstream_outputs_only') || 'upstream_outputs_only',
      },
      handoff_policy: {
        direct_response_enabled: row?.interaction_policy?.handoff_policy?.direct_response_enabled === true || row?.interaction_policy?.handoff_policy?.directResponseEnabled === true,
        followup_shortcuts_enabled: row?.interaction_policy?.handoff_policy?.followup_shortcuts_enabled !== false && row?.interaction_policy?.handoff_policy?.followupShortcutsEnabled !== false,
        max_recent_turns: Number.isFinite(Number(row?.interaction_policy?.handoff_policy?.max_recent_turns ?? row?.interaction_policy?.handoff_policy?.maxRecentTurns))
          ? Math.max(1, Math.min(12, Math.floor(Number(row?.interaction_policy?.handoff_policy?.max_recent_turns ?? row?.interaction_policy?.handoff_policy?.maxRecentTurns))))
          : 6,
      },
      followup_policy: {
        only_for_followups: row?.interaction_policy?.followup_policy?.only_for_followups !== false && row?.interaction_policy?.followup_policy?.onlyForFollowups !== false,
        disallow_when_pending_approval: row?.interaction_policy?.followup_policy?.disallow_when_pending_approval !== false && row?.interaction_policy?.followup_policy?.disallowWhenPendingApproval !== false,
      },
      debate_policy: normalizeDebatePolicy(row?.interaction_policy?.debate_policy || row?.interaction_policy?.debatePolicy || {}, participants, finalParticipantId),
      consensus_policy: normalizeConsensusPolicy(row?.interaction_policy?.consensus_policy || row?.interaction_policy?.consensusPolicy || {}, participants),
    },
    control_policy: {
      final_answer_owner_participant_id: resolveParticipantIdByLabel(participants, row?.control_policy?.final_answer_owner_participant_id || row?.control_policy?.finalAnswerOwnerParticipantId || finalParticipantId),
      require_reviewer_before_final: row?.control_policy?.require_reviewer_before_final !== false && row?.control_policy?.requireReviewerBeforeFinal !== false,
      approval_mode: cleanId(row?.control_policy?.approval_mode || row?.control_policy?.approvalMode || 'apply_then_lock') || 'apply_then_lock',
      resume_supported: row?.control_policy?.resume_supported !== false && row?.control_policy?.resumeSupported !== false,
      runtime_execution: normalizeRuntimeExecutionPolicy(row?.control_policy?.runtime_execution || row?.control_policy?.runtimeExecution || row?.runtime_execution || row?.runtimeExecution || {}),
    },
    artifacts: {
      expected_outputs: uniqStrings(row?.artifacts?.expected_outputs || row?.artifacts?.expectedOutputs || [], { limit: 8 }),
      artifact_contracts: asArray(row?.artifacts?.artifact_contracts || row?.artifacts?.artifactContracts || []).slice(0, 12),
    },
    requirements: asObject(row.requirements),
    runtime_state: {
      apply_state: cleanId(row?.runtime_state?.apply_state || row?.runtime_state?.applyState || 'pending') === 'active' ? 'active' : 'pending',
      install_proposal_status: cleanId(row?.runtime_state?.install_proposal_status || row?.runtime_state?.installProposalStatus || '') || undefined,
      bound_credential_keys: uniqStrings(row?.runtime_state?.bound_credential_keys || row?.runtime_state?.boundCredentialKeys || [], { limit: 16, lower: true }),
    },
  };
  const knowledgeDesign = deriveKnowledgeBaseDesign({
    goal: baseStructure.intent.task_brief || '',
    teamConfig: {
      task_brief: baseStructure.intent.task_brief,
      memory_plan: asObject(row?.memory_plan || row?.memoryPlan),
      structure_v2: {
        ...baseStructure,
        knowledge_surface: asObject(row?.knowledge_surface || row?.knowledgeSurface),
        memory_policy: asObject(row?.memory_policy || row?.memoryPolicy),
        memory_plan: asObject(row?.memory_plan || row?.memoryPlan),
      },
    },
  });
  const structure = {
    ...baseStructure,
    knowledge_surface: knowledgeDesign.knowledge_surface,
    memory_policy: knowledgeDesign.memory_policy,
    memory_plan: knowledgeDesign.memory_plan,
  };
  return {
    ...structure,
    validation: validatePatternConstraints(structure),
  };
}

export function validateTeamStructureV2(raw = {}) {
  const structure = normalizeTeamStructureV2(raw);
  return {
    ok: asArray(structure.validation?.errors).length === 0,
    errors: asArray(structure.validation?.errors),
    warnings: asArray(structure.validation?.warnings),
    structure,
  };
}

function buildParticipantLocalInteractionContract(structure = {}, participant = {}) {
  const row = normalizeTeamStructureV2(structure);
  const participantId = cleanId(participant?.participant_id || participant?.participantId || participant?.id);
  const incoming = asArray(row?.topology?.edges).filter((edge) => cleanId(edge?.to) === participantId);
  const outgoing = asArray(row?.topology?.edges).filter((edge) => cleanId(edge?.from) === participantId);
  const finalOwnerId = cleanId(row?.control_policy?.final_answer_owner_participant_id || row?.topology?.final_participant_id || '');
  return {
    pattern: cleanId(row?.topology?.pattern || 'hybrid') || 'hybrid',
    execution_pattern: cleanId(row?.topology?.execution_pattern || '') || '',
    final_answer_owner_participant_id: finalOwnerId || undefined,
    can_answer_user_directly: row?.interaction_policy?.handoff_policy?.direct_response_enabled === true || (finalOwnerId ? finalOwnerId === participantId : true),
    require_reviewer_before_final: row?.control_policy?.require_reviewer_before_final !== false,
    incoming_edges: incoming,
    outgoing_edges: outgoing,
    reviewer_visibility: row?.interaction_policy?.visibility?.reviewer_visibility || 'summaries_plus_selected_evidence',
    synthesizer_visibility: row?.interaction_policy?.visibility?.synthesizer_visibility || 'upstream_outputs_only',
    builder_direct_response: row?.interaction_policy?.handoff_policy?.direct_response_enabled === true,
    debate_policy: asObject(row?.interaction_policy?.debate_policy),
    consensus_policy: asObject(row?.interaction_policy?.consensus_policy),
  };
}

export function buildRuntimeExecutionProfileFromStructureV2(raw = {}, {
  taskBrief = '',
  compositionMode = 'structured',
  proposalMode = 'suggest',
} = {}) {
  const structure = normalizeTeamStructureV2(raw);
  const derivedTeam = deriveTeamConfigFromStructureV2(structure);
  const executableParticipants = structure.participants.filter((entry) => isExecutableParticipantKind(entry?.kind, entry?.role));
  const nonExecutableParticipants = structure.participants.filter((entry) => !isExecutableParticipantKind(entry?.kind, entry?.role));
  const executionGraph = deriveStructureExecutionGraph(structure, executableParticipants, nonExecutableParticipants);
  const orderIndexByParticipantId = new Map(asArray(executionGraph.order).map((participantId, index) => [cleanId(participantId), index]));
  const stageIndexByParticipantId = new Map(Object.entries(asObject(executionGraph.stage_by_participant_id)).map(([participantId, stageIndex]) => [cleanId(participantId), stageIndex]));
  const parallelGroupByParticipantId = new Map();
  for (const group of asArray(executionGraph.parallel_groups)) {
    for (const participantId of asArray(group?.participant_ids)) parallelGroupByParticipantId.set(cleanId(participantId), group.parallel_group_id);
  }
  const orderedExecutableParticipants = [...executableParticipants].sort((left, right) => {
    const leftRank = orderIndexByParticipantId.has(cleanId(left?.participant_id)) ? orderIndexByParticipantId.get(cleanId(left?.participant_id)) : Number.MAX_SAFE_INTEGER;
    const rightRank = orderIndexByParticipantId.has(cleanId(right?.participant_id)) ? orderIndexByParticipantId.get(cleanId(right?.participant_id)) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank;
  });
  const runtimeParticipants = structure.participants.map((entry) => ({
    participant_id: entry.participant_id,
    kind: entry.kind,
    executable: isExecutableParticipantKind(entry?.kind, entry?.role),
    name: entry.name,
    role: entry.role,
    model: entry.model || '',
    provider: cleanId(entry.provider || ''),
    attached_skill_ids: uniqStrings(entry.attached_skill_ids || [], { limit: 8, lower: true }),
    runtime_capabilities_required: uniqStrings(entry.runtime_capabilities_required || [], { limit: 8, lower: true }),
    runtime_capabilities_optional: uniqStrings(entry.runtime_capabilities_optional || [], { limit: 8, lower: true }),
    external_tool_requirements: uniqStrings(entry.external_tool_requirements || [], { limit: 8, lower: true }),
    external_tool_preferences: uniqStrings(entry.external_tool_preferences || [], { limit: 8, lower: true }),
    required_tool_ids: uniqStrings(entry.required_tool_ids || [], { limit: 8, lower: true }),
    optional_tool_ids: uniqStrings(entry.optional_tool_ids || entry.recommended_tool_ids || [], { limit: 8, lower: true }),
    recommended_tool_ids: uniqStrings(entry.recommended_tool_ids || [...asArray(entry.required_tool_ids || []), ...asArray(entry.optional_tool_ids || [])], { limit: 8, lower: true }),
    order_index: orderIndexByParticipantId.get(cleanId(entry.participant_id)),
    stage_index: stageIndexByParticipantId.get(cleanId(entry.participant_id)),
    parallel_group_id: parallelGroupByParticipantId.get(cleanId(entry.participant_id)) || undefined,
    metadata: asObject(entry.metadata),
    agency_overlay_id: clean(entry?.metadata?.agency_overlay_id || ''),
    agency_overlay: asObject(entry?.metadata?.agency_overlay),
  }));
  const configured_agents = orderedExecutableParticipants.map((entry) => ({
    agent_id: entry.participant_id,
    slot_id: entry.participant_id,
    name: entry.name || entry.participant_id,
    role: EXECUTION_COMPATIBLE_ROLES.has(cleanId(entry.role)) ? cleanId(entry.role) : (entry.kind === 'judge' ? 'reviewer' : 'researcher'),
    purpose: entry.purpose || '',
    model: entry.model || '',
    provider: cleanId(entry.provider || ''),
    capabilities: uniqStrings(entry.capabilities || [], { limit: 8 }),
    skills: uniqStrings(entry.capabilities || [], { limit: 8 }),
    attached_skill_ids: uniqStrings(entry.attached_skill_ids || [], { limit: 8, lower: true }),
    generated_skill_briefs: asArray(entry.generated_skill_briefs || []).slice(0, 8),
    runtime_capabilities_required: uniqStrings(entry.runtime_capabilities_required || [], { limit: 8, lower: true }),
    runtime_capabilities_optional: uniqStrings(entry.runtime_capabilities_optional || [], { limit: 8, lower: true }),
    external_tool_requirements: uniqStrings(entry.external_tool_requirements || [], { limit: 8, lower: true }),
    external_tool_preferences: uniqStrings(entry.external_tool_preferences || [], { limit: 8, lower: true }),
    required_tool_ids: uniqStrings(entry.required_tool_ids || [], { limit: 8, lower: true }),
    optional_tool_ids: uniqStrings(entry.optional_tool_ids || entry.recommended_tool_ids || [], { limit: 8, lower: true }),
    recommended_tool_ids: uniqStrings(entry.recommended_tool_ids || [...asArray(entry.required_tool_ids || []), ...asArray(entry.optional_tool_ids || [])], { limit: 8, lower: true }),
    context_policy: asObject(entry.context_policy),
    metadata: asObject(entry.metadata),
    agency_overlay_id: clean(entry?.metadata?.agency_overlay_id || ''),
    agency_overlay: asObject(entry?.metadata?.agency_overlay),
    interaction_contract: {
      ...buildParticipantLocalInteractionContract(structure, entry),
      order_index: orderIndexByParticipantId.get(cleanId(entry.participant_id)),
      stage_index: stageIndexByParticipantId.get(cleanId(entry.participant_id)),
      parallel_group_id: parallelGroupByParticipantId.get(cleanId(entry.participant_id)) || undefined,
      native_runtime_ready: executionGraph.native_runtime_ready === true,
    },
  }));
  return {
    structure,
    interaction_spec: derivedTeam.interaction_spec,
    shortcut_policy: derivedTeam.shortcut_policy,
    configured_agents,
    executable_participants: orderedExecutableParticipants,
    non_executable_participants: nonExecutableParticipants,
    enabled_agent_ids: configured_agents.map((entry) => cleanId(entry.agent_id)).filter(Boolean),
    runtime_participants: runtimeParticipants,
    execution_graph: {
      ...executionGraph,
      task_brief: clean(taskBrief || structure?.intent?.task_brief || ''),
      composition_mode: cleanId(compositionMode || structure?.metadata?.composition_mode || 'structured') || 'structured',
      proposal_mode: cleanId(proposalMode || structure?.metadata?.proposal_mode || 'suggest') || 'suggest',
    },
  };
}

export function deriveTeamConfigFromStructureV2(raw = {}) {
  const structure = normalizeTeamStructureV2(raw);
  const participantById = new Map(structure.participants.map((entry) => [entry.participant_id, entry]));
  const agents = structure.participants
    .filter((entry) => isExecutableParticipantKind(entry?.kind, entry?.role))
    .map((entry) => ({
      agent_id: entry.participant_id,
      name: entry.name || entry.participant_id,
      role: entry.role || 'specialist',
      purpose: entry.purpose || '',
      model: entry.model || '',
      provider: cleanId(entry.provider || ''),
      capabilities: uniqStrings(entry.capabilities || [], { limit: 8 }),
      skills: uniqStrings(entry.capabilities || [], { limit: 8 }),
      attached_skill_ids: uniqStrings(entry.attached_skill_ids || [], { limit: 8 }),
      runtime_capabilities_required: uniqStrings(entry.runtime_capabilities_required || [], { limit: 8 }),
      runtime_capabilities_optional: uniqStrings(entry.runtime_capabilities_optional || [], { limit: 8 }),
      external_tool_requirements: uniqStrings(entry.external_tool_requirements || [], { limit: 8 }),
      external_tool_preferences: uniqStrings(entry.external_tool_preferences || [], { limit: 8 }),
      required_tool_ids: uniqStrings(entry.required_tool_ids || [], { limit: 8 }),
      optional_tool_ids: uniqStrings(entry.optional_tool_ids || entry.recommended_tool_ids || [], { limit: 8 }),
      recommended_tool_ids: uniqStrings(entry.recommended_tool_ids || [...asArray(entry.required_tool_ids || []), ...asArray(entry.optional_tool_ids || [])], { limit: 8 }),
      generated_skill_briefs: asArray(entry.generated_skill_briefs || []).slice(0, 8),
      context_policy: asObject(entry.context_policy),
    }));
  const handoffs = asArray(structure.topology.edges)
    .map((edge) => {
      const from = participantById.get(edge.from);
      const to = participantById.get(edge.to);
      if (!from || !to) return null;
      return {
        from: from.name || from.participant_id,
        to: to.name || to.participant_id,
        payload: cleanId(edge.payload || 'summary_only') || 'summary_only',
        kind: cleanId(edge.kind || 'handoff') || 'handoff',
      };
    })
    .filter(Boolean);
  const finalOwner = participantById.get(structure.control_policy.final_answer_owner_participant_id || structure.topology.final_participant_id || '');
  const patternToExecution = {
    single: 'single_specialist',
    router: 'sequential_pipeline',
    supervisor: 'sequential_pipeline',
    sequential: 'sequential_pipeline',
    parallel: 'parallel_research_then_review_then_synthesize',
    debate: 'multi_research_adjudication',
    committee: 'multi_research_adjudication',
    workflow: 'builder_reviewer_loop',
    graph: 'sequential_pipeline',
    hybrid: 'sequential_pipeline',
  };
  return {
    team_name: structure.metadata.team_name,
    composition_mode: structure.metadata.composition_mode,
    proposal_mode: structure.metadata.proposal_mode,
    task_brief: structure.intent.task_brief,
    design_prompt: structure.intent.design_prompt || structure.intent.task_brief,
    planner_metadata: {
      ...asObject(structure.metadata.planner_metadata),
      primary_schema: 'team_blueprint_v1',
    },
    agents,
    interaction_spec: {
      execution_pattern: structure.topology.execution_pattern || patternToExecution[structure.topology.pattern] || 'single_specialist',
      final_answer_owner: finalOwner?.name || finalOwner?.participant_id || agents[agents.length - 1]?.name || '',
      handoffs,
      policies: {
        reviewer_visibility: structure.interaction_policy.visibility.reviewer_visibility,
        synthesizer_visibility: structure.interaction_policy.visibility.synthesizer_visibility,
        builder_direct_response: structure.interaction_policy.handoff_policy.direct_response_enabled === true,
        require_reviewer_before_final: structure.control_policy.require_reviewer_before_final !== false,
      },
      selection_reason: `Derived from structure_v2 pattern=${structure.topology.pattern}`,
    },
    shortcut_policy: {
      enabled: structure.interaction_policy.handoff_policy.followup_shortcuts_enabled !== false,
      only_for_followups: structure.interaction_policy.followup_policy.only_for_followups !== false,
      disallow_when_pending_approval: structure.interaction_policy.followup_policy.disallow_when_pending_approval !== false,
      max_recent_turns: structure.interaction_policy.handoff_policy.max_recent_turns || 6,
    },
    requirements: asObject(structure.requirements),
    knowledge_surface: asObject(structure.knowledge_surface),
    memory_policy: asObject(structure.memory_policy),
    memory_plan: asObject(structure.memory_plan),
    runtime_execution: asObject(structure.control_policy?.runtime_execution),
    knowledge_base_profile: deriveKnowledgeBaseDesign({ goal: structure.intent.task_brief || '', teamConfig: { structure_v2: structure } }).profile,
    status: structure.metadata.status || 'draft',
    structure_v2: structure,
  };
}
