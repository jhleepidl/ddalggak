import test from 'node:test';
import assert from 'node:assert/strict';

import { validateTeamConfiguration } from '../src/application/team_configuration.js';

test('validateTeamConfiguration converts non-builder file write expectations into read-only workspace access', () => {
  const team = validateTeamConfiguration({
    team_name: 'repo-team',
    task_brief: '코드베이스를 조사하고 구조를 정리한다',
    agents: [
      {
        name: 'Repo Scout',
        agent_id: 'repo_scout',
        role: 'researcher',
        model: 'gemini-2.5-pro',
        provider: 'gemini',
        purpose: '코드베이스를 읽고 구조를 파악한다',
        runtime_capabilities_required: ['filesystem_write'],
        runtime_capabilities_optional: ['filesystem_write'],
      },
      {
        name: 'Builder',
        agent_id: 'builder',
        role: 'builder',
        model: 'gpt-5-codex',
        provider: 'codex',
        purpose: '실제 파일을 수정한다',
        runtime_capabilities_required: ['filesystem_write'],
      },
    ],
    interaction_spec: { execution_pattern: 'builder_reviewer_loop', final_answer_owner: 'Builder' },
  });

  const scout = team.agents.find((row) => row.name === 'Repo Scout');
  const builder = team.agents.find((row) => row.name === 'Builder');
  assert.deepEqual(scout.runtime_capabilities_required, ['filesystem_read']);
  assert.equal(scout.runtime_capabilities_optional.includes('filesystem_write'), false);
  assert.equal(scout.runtime_capabilities_optional.includes('filesystem_write'), false);
  assert.equal(builder.runtime_capabilities_required.includes('filesystem_write'), true);
});
