import test from 'node:test';
import assert from 'node:assert/strict';

import { attachTeamBlueprint, summarizeExecutableTeamDefinition } from '../src/application/team_blueprint.js';

test('executable team definition summarizes topology memory and capability readiness', () => {
  const attached = attachTeamBlueprint({
    team_name: 'Impl Team',
    task_brief: 'Implement and review a patch',
    agents: [
      { agent_id: 'builder', role: 'builder', purpose: 'Implement code', runtime_capabilities_required: ['filesystem_write'] },
      { agent_id: 'reviewer', role: 'reviewer', purpose: 'Review patch', runtime_capabilities_optional: ['web_browse'] },
    ],
    structure_v2: {
      participants: [
        { participant_id: 'builder', role: 'builder' },
        { participant_id: 'reviewer', role: 'reviewer' },
      ],
      topology: { pattern: 'review_loop', edges: [{ from: 'builder', to: 'reviewer' }], final_participant_id: 'reviewer' },
      control_policy: {},
    },
    memory_plan: {
      surfaces: [
        { surface_id: 'plan', file_name: 'plan.md', write_policy: 'shared', target_roles: ['builder','reviewer'] },
        { surface_id: 'final_answer', file_name: 'final_answer.md', write_policy: 'final', target_roles: ['reviewer'], semantic_slots: ['decisions'] },
      ],
    },
  }, { runtime: { availableCapabilityIds: ['filesystem_write'] } });

  const summary = summarizeExecutableTeamDefinition({
    blueprint: attached.team_blueprint,
    memoryAclSummary: attached.memory_acl_summary,
  });

  assert.equal(summary.topology_contract.pattern, 'hybrid');
  assert.equal(summary.memory_contract.final_answer_surface_ready, true);
  assert.equal(summary.capability_contract.missing_required_tool_count, 0);
  assert.ok(Array.isArray(summary.role_ids));
});
