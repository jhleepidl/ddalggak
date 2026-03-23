import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRuntimeExecutionProfileFromStructureV2, buildTeamStructureV2, deriveTeamConfigFromStructureV2, normalizeTeamStructureV2, validateTeamStructureV2 } from '../src/shared/team_structure_v2.js';
import { applyTeamConfigurationToRuntime, buildAutoRefineDraftFromStructureConflict, buildTeamConfigurationTemplate, validateTeamConfiguration } from '../src/application/team_configuration.js';

const baseTeam = {
  team_name: 'Debate Team',
  composition_mode: 'freeform',
  proposal_mode: 'create',
  task_brief: '찬반 토론 후 최종 결론 정리',
  agents: [
    { agent_id: 'pro', name: 'Pro Analyst', role: 'researcher', purpose: '찬성 논리' },
    { agent_id: 'con', name: 'Con Analyst', role: 'researcher', purpose: '반대 논리' },
    { agent_id: 'judge', name: 'Judge', role: 'synthesizer', purpose: '판정 및 종합' },
  ],
  interaction_spec: {
    execution_pattern: 'multi_research_adjudication',
    final_answer_owner: 'Judge',
    handoffs: [
      { from: 'Pro Analyst', to: 'Con Analyst', payload: 'claim_plus_supporting_evidence' },
      { from: 'Con Analyst', to: 'Judge', payload: 'counterargument_plus_risks' },
    ],
    policies: {
      reviewer_visibility: 'summaries_plus_selected_evidence',
      synthesizer_visibility: 'upstream_outputs_only',
      builder_direct_response: false,
      require_reviewer_before_final: true,
    },
  },
  requirements: {
    tools: [{ tool_id: 'web_search', required_by: 'Pro Analyst' }],
  },
};

test('buildTeamStructureV2 projects participants and debate topology', () => {
  const structure = buildTeamStructureV2(baseTeam, { applyState: 'active' });
  assert.equal(structure.kind, 'team_structure_v2');
  assert.equal(structure.version, 2);
  assert.equal(structure.topology.pattern, 'debate');
  assert.equal(structure.participants.length, 3);
  assert.equal(structure.control_policy.final_answer_owner_participant_id, 'judge');
  assert.ok(structure.topology.edges.some((edge) => edge.from === 'pro' && edge.to === 'con'));
  assert.equal(structure.validation.errors.length, 0);
});

test('deriveTeamConfigFromStructureV2 reconstructs legacy team fields', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'Structure Team', composition_mode: 'freeform', proposal_mode: 'refine' },
    intent: { task_brief: '구조 실험' },
    participants: [
      { participant_id: 'router', kind: 'agent', name: 'Router', role: 'researcher' },
      { participant_id: 'judge', kind: 'agent', name: 'Judge', role: 'synthesizer' },
    ],
    topology: {
      pattern: 'sequential',
      execution_pattern: 'sequential_pipeline',
      edges: [{ from: 'router', to: 'judge', payload: 'summary_only' }],
      final_participant_id: 'judge',
    },
    interaction_policy: {
      visibility: { reviewer_visibility: 'summary_only', synthesizer_visibility: 'upstream_outputs_only' },
      handoff_policy: { followup_shortcuts_enabled: true, max_recent_turns: 4 },
      followup_policy: { only_for_followups: true, disallow_when_pending_approval: true },
    },
    control_policy: { require_reviewer_before_final: false },
    requirements: {
      credentials: [{ credential_key: 'OPENAI_API_KEY', required_by: 'Judge' }],
    },
  });

  const team = deriveTeamConfigFromStructureV2(structure);
  assert.equal(team.team_name, 'Structure Team');
  assert.equal(team.agents.length, 2);
  assert.equal(team.interaction_spec.execution_pattern, 'sequential_pipeline');
  assert.equal(team.interaction_spec.final_answer_owner, 'Judge');
  assert.equal(team.requirements.credentials[0].credential_key, 'OPENAI_API_KEY');
});

test('validateTeamStructureV2 flags debate/team shape issues and synthesizes parallel edges', () => {
  const parallel = validateTeamStructureV2({
    metadata: { team_name: 'Parallel Team' },
    participants: [
      { participant_id: 'r1', kind: 'agent', name: 'R1', role: 'researcher' },
      { participant_id: 'r2', kind: 'agent', name: 'R2', role: 'researcher' },
      { participant_id: 'syn', kind: 'agent', name: 'Syn', role: 'synthesizer' },
    ],
    topology: { pattern: 'parallel', final_participant_id: 'syn' },
  });
  assert.equal(parallel.ok, true);
  assert.ok(parallel.structure.topology.edges.some((edge) => edge.to === 'syn'));

  const debate = validateTeamStructureV2({
    metadata: { team_name: 'Weak Debate' },
    participants: [
      { participant_id: 'solo', kind: 'agent', name: 'Solo', role: 'researcher' },
      { participant_id: 'judge', kind: 'agent', name: 'Judge', role: 'synthesizer' },
    ],
    topology: { pattern: 'debate', final_participant_id: 'judge' },
  });
  assert.equal(debate.ok, true);
  assert.ok(debate.warnings.some((entry) => entry.includes('debate pattern works best')));
});

test('buildTeamConfigurationTemplate emits team_blueprint_v1 manifest and validation prefers structure over stale legacy team', () => {
  const template = JSON.parse(buildTeamConfigurationTemplate(baseTeam));
  assert.equal(template.primary_schema, 'team_blueprint_v1');
  assert.equal(template.blueprint.structure.kind, 'team_structure_v2');
  assert.equal(template.team.interaction_spec.final_answer_owner, 'Judge');

  const normalized = validateTeamConfiguration({
    primary_schema: 'team_blueprint_v1',
    team_name: 'Legacy Stale',
    agents: [
      { agent_id: 'legacy', name: 'Legacy', role: 'researcher', purpose: 'stale legacy payload' },
    ],
    interaction_spec: { execution_pattern: 'single_specialist', final_answer_owner: 'Legacy' },
    structure_v2: {
      metadata: { team_name: 'Canonical Structure', composition_mode: 'freeform', proposal_mode: 'create' },
      intent: { task_brief: '구조 우선 정규화' },
      participants: [
        { participant_id: 'router', kind: 'agent', name: 'Router', role: 'researcher' },
        { participant_id: 'judge', kind: 'agent', name: 'Judge', role: 'synthesizer' },
      ],
      topology: {
        pattern: 'sequential',
        execution_pattern: 'sequential_pipeline',
        edges: [{ from: 'router', to: 'judge', payload: 'summary_only' }],
        final_participant_id: 'judge',
      },
    },
  });
  assert.equal(normalized.team_name, 'Canonical Structure');
  assert.equal(normalized.agents[0].agent_id, 'router');
  assert.equal(normalized.structure_v2.topology.pattern, 'sequential');
  assert.equal(normalized.primary_schema, 'team_blueprint_v1');
});


test('buildRuntimeExecutionProfileFromStructureV2 exposes executable and non-executable participants', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'Hybrid Team', composition_mode: 'freeform', proposal_mode: 'create' },
    intent: { task_brief: 'gate 포함 구조 실행' },
    participants: [
      { participant_id: 'router', kind: 'agent', name: 'Router', role: 'researcher', model: 'gemini-2.5-pro' },
      { participant_id: 'approval_gate', kind: 'gate', name: 'Approval Gate', role: 'approval' },
      { participant_id: 'judge', kind: 'judge', name: 'Judge', role: 'synthesizer', model: 'gpt-5.4' },
    ],
    topology: {
      pattern: 'graph',
      nodes: [
        { node_id: 'route', participant_id: 'router', kind: 'task' },
        { node_id: 'gate', participant_id: 'approval_gate', kind: 'gate' },
        { node_id: 'judge_step', participant_id: 'judge', kind: 'task' },
      ],
      edges: [
        { from: 'router', to: 'approval_gate', kind: 'handoff', payload: 'summary_only' },
        { from: 'approval_gate', to: 'judge', kind: 'approval_release', payload: 'summary_only' },
      ],
      final_participant_id: 'judge',
    },
  });
  const profile = buildRuntimeExecutionProfileFromStructureV2(structure, { taskBrief: 'gate 포함 구조 실행' });
  assert.equal(profile.configured_agents.length, 2);
  assert.equal(profile.runtime_participants.length, 3);
  assert.equal(profile.non_executable_participants[0].participant_id, 'approval_gate');
  assert.equal(profile.execution_graph.pattern, 'graph');
});



test('validateTeamStructureV2 adds graph cycle errors and execution profile derives stage order hints', () => {
  const cyclic = validateTeamStructureV2({
    metadata: { team_name: 'Cyclic Graph' },
    participants: [
      { participant_id: 'a', kind: 'agent', name: 'A', role: 'researcher' },
      { participant_id: 'b', kind: 'agent', name: 'B', role: 'reviewer' },
    ],
    topology: {
      pattern: 'graph',
      nodes: [
        { node_id: 'node_a', participant_id: 'a', kind: 'task' },
        { node_id: 'node_b', participant_id: 'b', kind: 'task' },
      ],
      edges: [
        { from: 'a', to: 'b', kind: 'handoff' },
        { from: 'b', to: 'a', kind: 'handoff' },
      ],
      final_participant_id: 'b',
    },
  });
  assert.equal(cyclic.ok, false);
  assert.ok(cyclic.errors.some((entry) => entry.includes('cycle')));

  const profile = buildRuntimeExecutionProfileFromStructureV2(normalizeTeamStructureV2({
    metadata: { team_name: 'Parallel Profile' },
    participants: [
      { participant_id: 'r1', kind: 'agent', name: 'R1', role: 'researcher' },
      { participant_id: 'r2', kind: 'agent', name: 'R2', role: 'researcher' },
      { participant_id: 'syn', kind: 'agent', name: 'Synth', role: 'synthesizer' },
    ],
    topology: {
      pattern: 'parallel',
      final_participant_id: 'syn',
    },
  }));
  assert.equal(profile.execution_graph.parallel_groups.length, 1);
  assert.deepEqual(profile.execution_graph.order.slice(0, 2), ['r1', 'r2']);
  assert.equal(profile.runtime_participants.find((entry) => entry.participant_id === 'syn')?.stage_index, 1);
});

test('applyTeamConfigurationToRuntime builds runtime snapshot from structure_v2 participants', () => {
  const normalized = validateTeamConfiguration({
    primary_schema: 'team_blueprint_v1',
    structure_v2: {
      metadata: { team_name: 'Structure Runtime', composition_mode: 'freeform', proposal_mode: 'create' },
      intent: { task_brief: 'structure 우선 실행' },
      participants: [
        { participant_id: 'r1', kind: 'agent', name: 'Researcher 1', role: 'researcher', model: 'gemini-2.5-pro' },
        { participant_id: 'gate', kind: 'gate', name: 'Gate', role: 'approval' },
        { participant_id: 'judge', kind: 'judge', name: 'Judge', role: 'synthesizer', model: 'gpt-5.4' },
      ],
      topology: {
        pattern: 'debate',
        edges: [
          { from: 'r1', to: 'judge', kind: 'adjudication_input', payload: 'summary_plus_key_evidence' },
        ],
        final_participant_id: 'judge',
      },
    },
  });
  const runtime = applyTeamConfigurationToRuntime({}, normalized);
  assert.equal(runtime.teamTopologyPattern, 'debate');
  assert.equal(runtime.runtimeParticipants.length, 3);
  assert.equal(runtime.nonExecutableParticipants.length, 1);
  assert.equal(runtime.runtimeTeamSnapshot.structure_v2.topology.pattern, 'debate');
  assert.equal(runtime.runtimeTeamSnapshot.runtime_participants.length, 3);
  assert.equal(runtime.runtimeTeamSnapshot.non_executable_participants.length, 1);
  assert.equal(runtime.runtimeTeamSnapshot.execution_graph.order.includes('judge'), true);
  assert.equal(runtime.runtimeTeamSnapshot.runtime_agents[0].slot_id != null, true);
  assert.equal(runtime.agents.length, 2);
});


test('buildAutoRefineDraftFromStructureConflict creates a pending-ready refine proposal with structure metadata', async () => {
  const draft = await buildAutoRefineDraftFromStructureConflict({
    team: baseTeam,
    instruction: '이번에는 committee 구조로 바꾸고 chair가 최종 답하도록 해줘',
    planner: async () => ({ ok: false, reason: 'forced_heuristic_test' }),
  });

  assert.equal(draft.proposal_mode, 'refine');
  assert.equal(draft.status, 'suggested');
  assert.equal(draft.planner_metadata?.auto_refine_from_pattern_conflict, true);
  assert.equal(draft.planner_metadata?.refine_trigger, 'structure_override_required');
  assert.ok(draft.structure_v2);
});

test('structure_v2 carries knowledge surface, memory policy, and memory plan into derived team config', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'KB Structure Team', composition_mode: 'freeform', proposal_mode: 'create' },
    intent: { task_brief: 'Implement and review code changes' },
    participants: [
      { participant_id: 'builder', kind: 'agent', name: 'Builder', role: 'builder' },
      { participant_id: 'reviewer', kind: 'agent', name: 'Reviewer', role: 'reviewer' },
    ],
    topology: {
      pattern: 'workflow',
      execution_pattern: 'builder_reviewer_loop',
      edges: [{ from: 'builder', to: 'reviewer', payload: 'summary_only' }],
      final_participant_id: 'reviewer',
    },
    knowledge_surface: {
      profile_id: 'custom_impl',
      display_name: 'Custom Impl KB',
      docs: [
        { doc_id: 'plan', file_name: 'implementation_map.md', title: 'Implementation Map' },
        { doc_id: 'research', file_name: 'repo_notes.md', title: 'Repo Notes' },
        { doc_id: 'progress', file_name: 'patch_journal.md', title: 'Patch Journal' },
        { doc_id: 'decisions', file_name: 'review_ruling.md', title: 'Review Ruling' },
        { doc_id: 'artifacts', file_name: 'delivery_packet.md', title: 'Delivery Packet' },
      ],
    },
    memory_policy: { stable_semantic_slots: ['decisions', 'artifacts'] },
  });

  assert.equal(structure.knowledge_surface.profile_id, 'custom_impl');
  assert.deepEqual(structure.memory_policy.stable_semantic_slots, ['decisions', 'artifacts']);
  assert.ok(Array.isArray(structure.memory_plan?.surfaces));

  const team = deriveTeamConfigFromStructureV2(structure);
  assert.equal(team.knowledge_base_profile.profile_id, 'custom_impl');
  assert.ok(Array.isArray(team.memory_plan?.surfaces));
  assert.equal(team.knowledge_base_profile.docs.find((doc) => doc.doc_id === 'decisions')?.file_name, 'review_ruling.md');
});


test('team_structure_v2 preserves provider and tool metadata through normalization and derived runtime profile', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'Provider Team', composition_mode: 'freeform', proposal_mode: 'create' },
    intent: { task_brief: 'provider roundtrip' },
    participants: [
      {
        participant_id: 'repo_scout',
        kind: 'agent',
        name: 'Repo Scout',
        role: 'researcher',
        provider: 'gemini',
        model: 'gemini-2.5-pro',
        required_tool_ids: ['workspace_fs'],
        optional_tool_ids: ['ripgrep'],
      },
    ],
    topology: { pattern: 'single', final_participant_id: 'repo_scout' },
  });
  assert.equal(structure.participants[0].provider, 'gemini');
  assert.deepEqual(structure.participants[0].required_tool_ids, ['workspace_fs']);
  const derived = deriveTeamConfigFromStructureV2(structure);
  assert.equal(derived.agents[0].provider, 'gemini');
  assert.deepEqual(derived.agents[0].required_tool_ids, ['workspace_fs']);
  const runtimeProfile = buildRuntimeExecutionProfileFromStructureV2(structure, { taskBrief: 'provider roundtrip' });
  assert.equal(runtimeProfile.runtime_participants[0].provider, 'gemini');
  assert.equal(runtimeProfile.configured_agents[0].provider, 'gemini');
});
