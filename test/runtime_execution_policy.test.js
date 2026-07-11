import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeRuntimeExecutionPolicy } from '../src/application/runtime_execution_policy.js';
import { deriveTeamConfigFromStructureV2, normalizeTeamStructureV2 } from '../src/shared/team_structure_v2.js';

test('runtime execution policy normalizes checkpointing and continuous improvement defaults', () => {
  const policy = normalizeRuntimeExecutionPolicy({
    continuous_improvement: {
      enabled: true,
      max_turns: 11,
      stop_signals: ['quality_threshold_met', 'ready_for_user'],
    },
    checkpointing: {
      write_on_turn_end: true,
    },
  });

  assert.equal(policy.checkpointing.enabled, true);
  assert.equal(policy.checkpointing.write_on_turn_end, true);
  assert.equal(policy.continuous_improvement.enabled, true);
  assert.equal(policy.continuous_improvement.max_turns, 11);
  assert.deepEqual(policy.continuous_improvement.stop_signals, ['quality_threshold_met', 'ready_for_user']);
});

test('structure_v2 preserves runtime_execution through normalization and legacy derivation', () => {
  const structure = normalizeTeamStructureV2({
    metadata: { team_name: 'paper_team' },
    participants: [
      { participant_id: 'writer', kind: 'agent', name: 'Writer', role: 'builder' },
    ],
    topology: {
      pattern: 'single',
      nodes: [{ node_id: 'writer_node', participant_id: 'writer', kind: 'agent' }],
      edges: [],
      final_participant_id: 'writer',
    },
    control_policy: {
      final_answer_owner_participant_id: 'writer',
      runtime_execution: {
        checkpointing: { write_on_turn_end: true },
        continuous_improvement: {
          enabled: true,
          max_turns: 9,
          max_total_actions: 44,
          stop_signals: ['quality_threshold_met'],
        },
      },
    },
  });

  assert.equal(structure.control_policy.runtime_execution.checkpointing.write_on_turn_end, true);
  assert.equal(structure.control_policy.runtime_execution.continuous_improvement.enabled, true);
  assert.equal(structure.control_policy.runtime_execution.continuous_improvement.max_turns, 9);

  const team = deriveTeamConfigFromStructureV2(structure);
  assert.equal(team.runtime_execution.continuous_improvement.enabled, true);
  assert.equal(team.runtime_execution.continuous_improvement.max_total_actions, 44);
});


test('runtime execution policy preserves provider policies and approval matrix', () => {
  const policy = normalizeRuntimeExecutionPolicy({
    approval_matrix: { codex_exec: 'ask', verification: 'deny' },
    providers: {
      codex: {
        sandbox_mode: 'danger-full-access',
        approval_policy: 'on-request',
        profile: 'repo-maintainer',
        mcp_servers: { repo_docs: { command: 'npx' } },
      },
      gemini: {
        approval_mode: 'plan',
        settings_overwrite: 'always',
        workspace_settings: { mcpServers: { docs: { command: 'node' } } },
      },
    },
  });

  assert.equal(policy.approval_matrix.codex_exec, 'ask');
  assert.equal(policy.approval_matrix.verification, 'deny');
  assert.equal(policy.providers.codex.sandbox_mode, 'danger-full-access');
  assert.equal(policy.providers.codex.mcp_servers.repo_docs.command, 'npx');
  assert.equal(policy.providers.gemini.approval_mode, 'plan');
  assert.equal(policy.providers.gemini.workspace_settings.mcpServers.docs.command, 'node');
});

test('runtime execution policy preserves provider-specific harness and reasoning controls', () => {
  const policy = normalizeRuntimeExecutionPolicy({
    providers: {
      codex: { reasoning_effort: 'high', harness_variant_id: 'codex.high.v1' },
      claude: { effort: 'medium', harness_variant_id: 'claude.medium.v1' },
      antigravity: { reasoning_effort: 'provider_default', harness_variant_id: 'agy.default.v1' },
    },
  });
  assert.equal(policy.providers.codex.reasoning_effort, 'high');
  assert.equal(policy.providers.codex.harness_variant_id, 'codex.high.v1');
  assert.equal(policy.providers.claude.effort, 'medium');
  assert.equal(policy.providers.claude.harness_variant_id, 'claude.medium.v1');
  assert.equal(policy.providers.antigravity.harness_variant_id, 'agy.default.v1');
});
