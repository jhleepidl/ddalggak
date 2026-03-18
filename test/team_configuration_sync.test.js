import test from 'node:test';
import assert from 'node:assert/strict';

import { syncTeamConfigurationToConversationStore, validateTeamConfiguration } from '../src/application/team_configuration.js';

test('validateTeamConfiguration rejects duplicate agent ids and names', () => {
  assert.throws(() => validateTeamConfiguration({
    team_name: 'dup',
    agents: [
      { agent_id: 'a1', name: 'Researcher', role: 'researcher', model: 'gemini-2.5-pro' },
      { agent_id: 'a1', name: 'Researcher 2', role: 'reviewer', model: 'gpt-5.4' },
    ],
  }), /duplicate agent_id/i);

  assert.throws(() => validateTeamConfiguration({
    team_name: 'dup-name',
    agents: [
      { agent_id: 'a1', name: 'Researcher', role: 'researcher', model: 'gemini-2.5-pro' },
      { agent_id: 'a2', name: 'researcher', role: 'reviewer', model: 'gpt-5.4' },
    ],
  }), /duplicate agent name/i);
});

test('syncTeamConfigurationToConversationStore reconciles stale conversation rows', async () => {
  const calls = [];
  const store = {
    async listAgents() {
      return { rows: [
        { agent_id: 'old_agent', enabled: true, order_index: 0, overrides_json: {} },
        { agent_id: 'researcher_1', enabled: false, order_index: 7, overrides_json: {} },
      ] };
    },
    async removeAgent(payload) { calls.push(['remove', payload]); return { ok: true }; },
    async addAgent(payload) { calls.push(['add', payload]); return { ok: true }; },
    async patchAgent(payload) { calls.push(['patch', payload]); return { ok: true }; },
    async setTeamConfig(payload) { calls.push(['set', payload]); return { ok: true }; },
  };
  const runtime = { map: { threadId: 'thread-1' }, capabilities: { conversationTeamStore: store }, agentsCatalog: [] };
  const teamConfig = {
    team_name: 'team',
    mode: 'scoped_context',
    agents: [
      { agent_id: 'researcher_1', name: 'Researcher 1', role: 'researcher', model: 'gemini-2.5-pro' },
      { agent_id: 'reviewer_1', name: 'Reviewer 1', role: 'reviewer', model: 'gpt-5.4' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Reviewer 1' },
  };
  await syncTeamConfigurationToConversationStore({ runtime, teamConfig, source: 'test' });
  assert.equal(calls.some(([kind, payload]) => kind === 'remove' && payload.agentId === 'old_agent'), true);
  assert.equal(calls.some(([kind, payload]) => kind === 'patch' && payload.agentId === 'researcher_1'), true);
  assert.equal(calls.some(([kind, payload]) => kind === 'add' && payload.agentId === 'reviewer_1'), true);
  assert.equal(calls.some(([kind]) => kind === 'set'), true);
});
