import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionStore } from '../src/chat/session.js';
import { installTeamBlueprintToSession } from '../src/application/team_blueprint_runtime.js';

test('installTeamBlueprintToSession accepts manifest alias used by telegram handlers', async () => {
  const store = new ChatSessionStore({ persistPath: '' });
  const manifest = {
    team: {
      team_name: 'Alias Test Team',
      agents: [{ agent_id: 'builder', name: 'Builder', role: 'builder' }],
    },
  };
  const installed = await installTeamBlueprintToSession({
    sessionStore: store,
    chatId: 'chat-1',
    manifest,
    applyState: 'pending',
  });
  assert.equal(installed.team.team_name, 'Alias Test Team');
  assert.equal(store.get('chat-1').team_config.pending_team.team_name, 'Alias Test Team');
});
