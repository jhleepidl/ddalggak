import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamTransitionGuardrails } from '../src/application/team_configuration.js';

test('buildTeamTransitionGuardrails marks destructive participant and role loss', () => {
  const currentTeam = {
    team_name: 'Current',
    agents: [
      { agent_id: 'repo_scout', name: 'Repo Scout', role: 'researcher', provider: 'gemini', model: 'gemini-2.5-pro', runtime_capabilities_required: ['filesystem_write'] },
      { agent_id: 'builder', name: 'Client Companion Builder', role: 'builder', provider: 'codex', model: 'gpt-5.4-codex', runtime_capabilities_required: ['filesystem_write'], external_tool_requirements: ['git'] },
      { agent_id: 'reviewer', name: 'Safety Reviewer', role: 'reviewer', provider: 'openai', model: 'gpt-5.4' },
    ],
    memory_plan: { writable_surface_ids: ['implementation_notes', 'critic_log'] },
    interaction_spec: { final_answer_owner: 'Safety Reviewer' },
  };
  const nextTeam = {
    team_name: 'Next',
    agents: [
      { agent_id: 'builder', name: 'Client Companion Builder', role: 'researcher' },
    ],
    memory_plan: { writable_surface_ids: ['implementation_notes'] },
    interaction_spec: { final_answer_owner: 'Client Companion Builder' },
  };

  const out = buildTeamTransitionGuardrails(currentTeam, nextTeam);
  assert.equal(out.destructive_changes_present, true);
  assert.equal(out.risk_level, 'high');
  assert.equal(out.issues.removed_agents.includes('Repo Scout'), true);
  assert.equal(out.issues.lost_role_coverage.includes('reviewer'), true);
  assert.match(out.warnings.join('\n'), /에이전트 제거:/);
  assert.equal(out.recommended_action, 'review_and_confirm_apply');
  assert.match(String(out.summary_line || ''), /재확인/);
});
