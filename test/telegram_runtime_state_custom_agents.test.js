import test from 'node:test';
import assert from 'node:assert/strict';

import { findAgentConfigInRuntime } from '../src/application/telegram_runtime_state.js';

test('findAgentConfigInRuntime resolves custom team agents from conversation/runtime snapshots', () => {
  const runtime = {
    conversationAgents: [
      {
        agent_id: 'notebook_builder',
        enabled: true,
        overrides_json: {
          name: 'Notebook Builder',
          configured_role: 'builder',
          configured_provider: 'codex',
          configured_model: 'gpt-5-codex',
          recommended_tool_ids: ['workspace_fs'],
        },
      },
    ],
    runtimeTeamSnapshot: {
      runtime_agents: [
        {
          template_id: 'notebook_builder',
          display_label: 'Notebook Builder',
          role_id: 'builder',
          provider: 'codex',
          model: 'gpt-5-codex',
        },
      ],
    },
  };

  const agent = findAgentConfigInRuntime('notebook_builder', runtime);
  assert.ok(agent);
  assert.equal(agent.name, 'Notebook Builder');
  assert.equal(agent.provider, 'codex');
});
