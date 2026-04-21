import test from 'node:test';
import assert from 'node:assert/strict';

import { syncTeamConfigurationToConversationStore, syncTeamEnvelopeToConversationStore, validateTeamConfiguration } from '../src/application/team_configuration.js';

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


test('syncTeamConfigurationToConversationStore uses job target for local conversation stores', async () => {
  const calls = [];
  const store = {
    source: 'local',
    async listAgents(payload) { calls.push(['list', payload]); return { rows: [] }; },
    async addAgent(payload) { calls.push(['add', payload]); return { ok: true }; },
    async setTeamConfig(payload) { calls.push(['set', payload]); return { ok: true }; },
  };
  const runtime = {
    jobId: 'job-local-1',
    map: { threadId: 'local:job-local-1' },
    capabilities: { conversationTeamStore: store },
    agentsCatalog: [],
  };
  const teamConfig = {
    team_name: 'local-team',
    agents: [
      { agent_id: 'researcher_1', name: 'Researcher 1', role: 'researcher', model: 'gemini-2.5-pro' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Researcher 1' },
  };
  await syncTeamConfigurationToConversationStore({ runtime, teamConfig, source: 'test_local' });
  const listPayload = calls.find(([kind]) => kind === 'list')?.[1] || {};
  const setPayload = calls.find(([kind]) => kind === 'set')?.[1] || {};
  assert.equal(listPayload.jobId, 'job-local-1');
  assert.equal(setPayload.jobId, 'job-local-1');
  assert.equal('threadId' in listPayload, false);
  assert.equal('threadId' in setPayload, false);
});


test('syncTeamConfigurationToConversationStore infers local job target from local thread ids', async () => {
  const calls = [];
  const store = {
    source: 'local',
    async listAgents(payload) { calls.push(['list', payload]); return { rows: [] }; },
    async addAgent(payload) { calls.push(['add', payload]); return { ok: true }; },
    async setTeamConfig(payload) { calls.push(['set', payload]); return { ok: true }; },
  };
  const runtime = {
    map: { threadId: 'local:job-local-2' },
    capabilities: { conversationTeamStore: store },
    agentsCatalog: [],
  };
  const teamConfig = {
    team_name: 'local-team-2',
    agents: [
      { agent_id: 'researcher_1', name: 'Researcher 1', role: 'researcher', model: 'gemini-2.5-pro' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Researcher 1' },
  };
  await syncTeamConfigurationToConversationStore({ runtime, teamConfig, source: 'test_local_thread_infer' });
  const listPayload = calls.find(([kind]) => kind === 'list')?.[1] || {};
  const setPayload = calls.find(([kind]) => kind === 'set')?.[1] || {};
  assert.equal(listPayload.jobId, 'job-local-2');
  assert.equal(setPayload.jobId, 'job-local-2');
});


test('syncTeamEnvelopeToConversationStore preserves active and pending teams with strategy metadata', async () => {
  const calls = [];
  const store = {
    async setTeamConfig(payload) { calls.push(payload); return { ok: true, payload }; },
  };
  const runtime = { map: { threadId: 'thread-strategy-1' }, capabilities: { conversationTeamStore: store }, agentsCatalog: [] };
  const activeTeam = {
    team_name: 'starter',
    agents: [
      { agent_id: 'builder_1', name: 'Builder 1', role: 'builder', model: 'gpt-5-codex' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Builder 1' },
    planner_metadata: {
      adaptive_expansion: {
        recommendation: 'augment_context',
        augmentation: { score: 2.1, reasons: ['missing_memory'] },
      },
    },
  };
  const pendingTeam = {
    team_name: 'expanded',
    agents: [
      { agent_id: 'builder_1', name: 'Builder 1', role: 'builder', model: 'gpt-5-codex' },
      { agent_id: 'reviewer_1', name: 'Reviewer 1', role: 'reviewer', model: 'gpt-5.4' },
    ],
    interaction_spec: { execution_pattern: 'sequential_pipeline', final_answer_owner: 'Reviewer 1' },
    planner_metadata: {
      adaptive_expansion: {
        recommendation: 'expand_team',
        role_separation: { score: 3.0, independent_review_needed: true },
      },
    },
  };
  await syncTeamEnvelopeToConversationStore({
    runtime,
    envelope: {
      status: 'suggested',
      composition_mode: 'structured',
      proposal_mode: 'suggest',
      active_team: activeTeam,
      pending_team: pendingTeam,
    },
    source: 'strategy_sync_test',
  });
  assert.equal(calls.length, 1);
  const payload = calls[0];
  assert.equal(payload.threadId, 'thread-strategy-1');
  assert.equal(payload.teamConfig.status, 'active');
  assert.equal(payload.teamConfig.active_team?.planner_metadata?.adaptive_expansion?.recommendation, 'augment_context');
  assert.equal(payload.teamConfig.pending_team?.planner_metadata?.adaptive_expansion?.recommendation, 'expand_team');
});
