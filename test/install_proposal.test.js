import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamInstallProposal } from '../src/application/install_proposal.js';
import { buildTeamBlueprint } from '../src/application/team_blueprint_runtime.js';

test('buildTeamInstallProposal summarizes blocking requirements and commands', () => {
  const proposal = buildTeamInstallProposal({
    team: {
      team_name: 'Notebook Team',
      agents: [
        {
          agent_id: 'builder',
          name: 'Notebook Builder',
          role: 'builder',
          purpose: 'Create notebook outputs',
          recommended_tool_ids: ['workspace_fs'],
        },
      ],
    },
    runtime: { threadId: 'thread-1', availableToolIds: [] },
  });

  assert.equal(proposal.kind, 'capability_install_proposal');
  assert.equal(proposal.blocking, true);
  assert.ok(proposal.requirements.tools.some((entry) => entry.tool_id === 'workspace_fs'));
  assert.ok(proposal.suggested_commands.some((entry) => entry.includes('/team push')));
});

test('buildTeamBlueprint includes install_proposal', () => {
  const manifest = buildTeamBlueprint({
    team_name: 'Research Team',
    agents: [
      { agent_id: 'researcher', name: 'Researcher', role: 'researcher', recommended_tool_ids: ['web_search'] },
    ],
  }, { runtime: { threadId: 'thread-2', availableToolIds: [] } });

  assert.equal(manifest.install_proposal.kind, 'capability_install_proposal');
  assert.ok(Array.isArray(manifest.install_proposal.suggested_commands));
});
