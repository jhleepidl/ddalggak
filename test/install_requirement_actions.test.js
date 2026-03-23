import test from 'node:test';
import assert from 'node:assert/strict';

import { buildInstallRequirementActions, normalizeInstallRequirementActions, readLegacyToolInstallProposals } from '../src/shared/install_requirement_actions.js';
import { buildTeamInstallProposal } from '../src/application/install_proposal.js';

test('buildInstallRequirementActions derives tool, credential, and generated skill actions', () => {
  const actions = buildInstallRequirementActions({
    tools: [{ tool_id: 'workspace_fs', required_by: 'builder' }],
    credentials: [{ credential_key: 'OPENAI_API_KEY', required_by: 'researcher' }],
    skills: [{ skill_id: 'custom_notebook_export', required_by: 'builder' }],
  });

  assert.equal(actions.summary.tool_install_count, 1);
  assert.equal(actions.summary.credential_request_count, 1);
  assert.equal(actions.summary.generated_skill_count, 1);
  assert.equal(readLegacyToolInstallProposals(actions)[0].strategy, 'enable_workspace_fs');
  assert.equal(actions.credential_requests[0].credential_key, 'OPENAI_API_KEY');
  assert.equal(actions.generated_skill_proposals[0].skill_id, 'custom_notebook_export');
});

test('buildTeamInstallProposal includes structured action proposals', () => {
  const proposal = buildTeamInstallProposal({
    team: {
      team_name: 'Mixed Team',
      requirements: {
        credentials: [{ credential_key: 'OPENAI_API_KEY', required_by: 'researcher' }],
        skills: [{ skill_id: 'custom_notebook_export', required_by: 'builder' }],
      },
      agents: [
        {
          agent_id: 'builder',
          name: 'Notebook Builder',
          role: 'builder',
          purpose: 'Create notebook outputs',
          runtime_capabilities_optional: ['filesystem_write'],
        },
      ],
    },
    runtime: { availableToolIds: [] },
  });

  const actions = normalizeInstallRequirementActions(proposal.actions);
  assert.equal(actions.summary.tool_install_count, 1);
  assert.equal(actions.summary.credential_request_count, 1);
  assert.equal(actions.summary.generated_skill_count, 1);
});
