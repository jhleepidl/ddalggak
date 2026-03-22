import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamBlueprint, normalizeTeamBlueprint } from '../src/application/team_blueprint_runtime.js';
import { createPendingInstallProposalState } from '../src/application/install_proposal_state.js';
import { buildManifestInstallHints } from '../src/shared/manifest_requirements.js';

const baseTeam = {
  team_name: 'Notebook Team',
  composition_mode: 'freeform',
  proposal_mode: 'create',
  agents: [
    {
      agent_id: 'builder',
      name: 'Notebook Builder',
      role: 'builder',
      purpose: 'Create a notebook artifact',
      recommended_tool_ids: ['workspace_fs'],
    },
  ],
  interaction_spec: {
    final_owner: 'builder',
  },
};

test('buildTeamBlueprint attaches requirements and install hints', () => {
  const manifest = buildTeamBlueprint(baseTeam, { runtime: null, applyState: 'pending' });
  assert.equal(manifest.kind, 'ddalggak_team_blueprint');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.primary_schema, 'team_blueprint_v1');
  assert.equal(manifest.blueprint.structure.topology.pattern, 'single');
  assert.equal(manifest.team.agents[0].agent_id, 'builder');
  assert.ok(Array.isArray(manifest.blueprint.memory_plan.surfaces));
  assert.equal(manifest.requirements.tools[0].tool_id, 'workspace_fs');
  assert.ok(Array.isArray(manifest.requirements.install_hints));
  assert.ok(manifest.requirements.install_hints.some((entry) => entry.includes('/team export')));
});

test('normalizeTeamBlueprint accepts team-only payloads', () => {
  const normalized = normalizeTeamBlueprint({
    team: baseTeam,
    requirements: {
      credentials: [{ credential_key: 'OPENAI_API_KEY', required_by: 'Notebook Builder' }],
    },
  }, { applyState: 'active' });
  assert.equal(normalized.apply_state, 'active');
  assert.equal(normalized.team.agents[0].agent_id, 'builder');
  assert.equal(normalized.blueprint.requirements.credentials[0].credential_key, 'OPENAI_API_KEY');
});

test('buildManifestInstallHints includes GoC sync hint when thread target exists', () => {
  const hints = buildManifestInstallHints({
    tools: [{ tool_id: 'workspace_fs', required_by: 'builder' }],
  }, { hasGocThreadTarget: true });
  assert.ok(hints.some((entry) => entry.includes('/team push')));
});


test('buildTeamBlueprint preserves install proposal state when provided', () => {
  const state = createPendingInstallProposalState({
    proposal: {
      kind: 'capability_install_proposal',
      source: 'execution_gap',
      gap_count: 1,
      blocking: true,
      requirements: { tools: [{ tool_id: 'workspace_fs', required_by: 'builder' }] },
    },
    applyState: 'active',
    resumeRequest: { message: '다시 실행해줘' },
  });
  const manifest = buildTeamBlueprint(baseTeam, { runtime: { threadId: 'thread-3' }, applyState: 'active', installProposalState: state });
  assert.equal(manifest.install_proposal_state.status, 'awaiting_install_approval');
  assert.equal(manifest.install_proposal_state.proposal.gap_count, 1);
});



test('normalizeTeamBlueprint accepts structure_v2-only payloads', () => {
  const normalized = normalizeTeamBlueprint({
    structure_v2: {
      metadata: { team_name: 'Structured Debate', composition_mode: 'freeform', proposal_mode: 'refine' },
      intent: { task_brief: '찬반 토론 구조' },
      participants: [
        { participant_id: 'pro', kind: 'agent', name: 'Pro', role: 'researcher' },
        { participant_id: 'judge', kind: 'agent', name: 'Judge', role: 'synthesizer' }
      ],
      topology: {
        pattern: 'sequential',
        execution_pattern: 'sequential_pipeline',
        edges: [{ from: 'pro', to: 'judge', payload: 'summary_only' }],
        final_participant_id: 'judge'
      },
      interaction_policy: {
        visibility: { reviewer_visibility: 'summary_only', synthesizer_visibility: 'upstream_outputs_only' },
        handoff_policy: { followup_shortcuts_enabled: true, max_recent_turns: 4 },
        followup_policy: { only_for_followups: true, disallow_when_pending_approval: true }
      }
    }
  }, { applyState: 'pending' });
  assert.equal(normalized.team.team_name, 'Structured Debate');
  assert.equal(normalized.team.agents[0].agent_id, 'pro');
  assert.equal(normalized.blueprint.blueprint.structure.topology.pattern, 'sequential');
});


test('normalizeTeamBlueprint prefers structure_v2 over stale legacy team payloads', () => {
  const normalized = normalizeTeamBlueprint({
    primary_schema: 'team_blueprint_v1',
    team: {
      team_name: 'Stale Team',
      agents: [{ agent_id: 'stale', name: 'Stale', role: 'researcher' }],
      interaction_spec: { execution_pattern: 'single_specialist', final_answer_owner: 'Stale' },
    },
    structure_v2: {
      metadata: { team_name: 'Fresh Structure', composition_mode: 'freeform', proposal_mode: 'refine' },
      intent: { task_brief: '구조 우선 manifest' },
      participants: [
        { participant_id: 'router', kind: 'agent', name: 'Router', role: 'researcher' },
        { participant_id: 'judge', kind: 'agent', name: 'Judge', role: 'synthesizer' }
      ],
      topology: {
        pattern: 'sequential',
        execution_pattern: 'sequential_pipeline',
        edges: [{ from: 'router', to: 'judge', payload: 'summary_only' }],
        final_participant_id: 'judge'
      },
    }
  }, { applyState: 'active' });
  assert.equal(normalized.blueprint.primary_schema, 'team_blueprint_v1');
  assert.equal(normalized.team.team_name, 'Fresh Structure');
  assert.equal(normalized.team.agents[0].agent_id, 'router');
  assert.equal(normalized.blueprint.blueprint.structure.validation.errors.length, 0);
});


test('buildTeamBlueprint preserves required and optional tool expectations', () => {
  const manifest = buildTeamBlueprint({
    team_name: 'Implementation Team',
    agents: [
      {
        agent_id: 'builder',
        name: 'Builder',
        role: 'builder',
        required_tool_ids: ['workspace_fs'],
        optional_tool_ids: ['shell'],
      },
    ],
  }, { runtime: null, applyState: 'pending' });

  assert.deepEqual(manifest.team.agents[0].required_tool_ids, ['workspace_fs']);
  assert.deepEqual(manifest.team.agents[0].optional_tool_ids, ['shell']);
});
