import test from 'node:test';
import assert from 'node:assert/strict';

import { applyInstallProposalActionsToTeam, autoInstallRuntimeSupport } from '../src/application/tool_install_adapter.js';

test('tool install adapter adds workspace tool hints and generated skill briefs to target agents', () => {
  const team = {
    agents: [
      { agent_id: 'builder', name: 'Builder', role: 'builder', recommended_tool_ids: [] },
    ],
  };
  const proposal = {
    actions: {
      tool_install_proposals: [{ tool_id: 'workspace_fs', required_by: 'Builder', strategy: 'enable_workspace_fs', auto_installable: true }],
      generated_skill_proposals: [{ skill_id: 'custom_notebook_export', required_by: 'Builder', prompt_brief: 'Export notebook safely' }],
    },
  };
  const patched = applyInstallProposalActionsToTeam(team, proposal).team;
  assert.ok(patched.agents[0].recommended_tool_ids.includes('workspace_fs'));
  assert.ok(Array.isArray(patched.agents[0].generated_skill_briefs));
  assert.ok(patched.agents[0].generated_skill_briefs.some((entry) => entry.label === 'custom_notebook_export'));
});

test('tool install adapter can materialize workspace for auto-installable runtime tools', () => {
  let called = false;
  const jobs = { ensureWorkspacePath() { called = true; return '/tmp/workspace'; } };
  const applied = autoInstallRuntimeSupport({
    proposal: { actions: { tool_install_proposals: [{ tool_id: 'workspace_fs', strategy: 'enable_workspace_fs', auto_installable: true }] } },
    jobs,
    jobId: 'job-1',
  });
  assert.equal(called, true);
  assert.equal(applied[0].tool_id, 'workspace_fs');
});


test('tool install adapter preserves required vs optional tool expectations', () => {
  const team = {
    agents: [
      { agent_id: 'builder', name: 'Builder', role: 'builder', required_tool_ids: [], optional_tool_ids: [] },
    ],
  };
  const proposal = {
    actions: {
      tool_install_proposals: [
        { tool_id: 'workspace_fs', required_by: 'Builder', severity: 'blocking', strategy: 'enable_workspace_fs', auto_installable: true },
        { tool_id: 'shell', required_by: 'Builder', severity: 'advisory', strategy: 'enable_shell_access', auto_installable: false },
      ],
    },
  };
  const patched = applyInstallProposalActionsToTeam(team, proposal).team;
  assert.deepEqual(patched.agents[0].required_tool_ids, ['workspace_fs']);
  assert.deepEqual(patched.agents[0].optional_tool_ids, ['shell']);
  assert.ok(patched.agents[0].recommended_tool_ids.includes('workspace_fs'));
  assert.ok(patched.agents[0].recommended_tool_ids.includes('shell'));
});
