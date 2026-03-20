import test from 'node:test';
import assert from 'node:assert/strict';

import { buildManifestRequirements, formatManifestRequirementLines, normalizeManifestRequirements } from '../src/shared/manifest_requirements.js';
import { validateTeamConfiguration } from '../src/application/team_configuration.js';

test('buildManifestRequirements infers missing tools and credentials from capability gaps', () => {
  const requirements = buildManifestRequirements({
    team: {},
    capabilityGaps: [
      { kind: 'missing_tool', agent_name: 'Builder', tool_id: 'workspace_fs', detail: 'workspace_fs missing' },
      { kind: 'missing_credential', agent_name: 'Researcher', credential_key: 'OPENAI_API_KEY', detail: 'credential required' },
    ],
  });

  assert.equal(requirements.summary.tool_count, 1);
  assert.equal(requirements.summary.credential_count, 1);
  assert.equal(requirements.tools[0].tool_id, 'workspace_fs');
  assert.equal(requirements.credentials[0].credential_key, 'OPENAI_API_KEY');
  assert.ok(formatManifestRequirementLines(requirements).some((line) => line.includes('workspace_fs')));
});

test('validateTeamConfiguration attaches normalized requirements summary', () => {
  const team = validateTeamConfiguration({
    team_name: 'Notebook Team',
    task_brief: 'Build a notebook and save files',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    agents: [
      {
        agent_id: 'builder',
        name: 'Notebook Builder',
        role: 'builder',
        purpose: 'Create a notebook file',
        recommended_tool_ids: ['workspace_fs'],
      },
    ],
  }, { runtime: { agentsCatalog: [], agents: [], availableToolIds: [] } });

  const requirements = normalizeManifestRequirements(team.requirements);
  assert.equal(requirements.tools[0].tool_id, 'workspace_fs');
  assert.equal(requirements.summary.tool_count, 1);
});
