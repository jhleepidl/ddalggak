import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionStore } from '../src/chat/session.js';

const testTmpRoot = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
fs.mkdirSync(testTmpRoot, { recursive: true });

function makeTestTempDir(prefix) {
  return fs.mkdtempSync(path.join(testTmpRoot, prefix));
}

test('chat session store compacts heavy team and route state before persisting', () => {
  const baseDir = makeTestTempDir('dd-session-');
  try {
    const store = new ChatSessionStore({ baseDir });
    store.upsert('chat-1', {
      pending_user_request: {
        type: 'followup',
        prompt: 'x'.repeat(1200),
        followup_hint: 'y'.repeat(400),
        reason: 'z'.repeat(300),
      },
      team_config: {
        status: 'suggested',
        pending_team: {
          team_name: 'web_service_team',
          task_brief: '새로운 웹 서비스를 개발하기 위한 팀.',
          design_prompt: '새로운 웹 서비스를 개발하기 위한 팀.' + 'a'.repeat(800),
          agents: [
            {
              agent_id: 'service_builder',
              name: 'Service Builder',
              role: 'builder',
              model: 'gpt-5-codex',
              provider: 'codex',
              purpose: '실제 변경안과 실행 계획을 만든다.' + 'b'.repeat(400),
              required_tool_ids: ['workspace_fs'],
              optional_tool_ids: ['shell'],
              recommended_tool_ids: ['workspace_fs', 'shell'],
              source_agent: { huge: 'c'.repeat(5000) },
            },
          ],
          structure: { should_not: 'persist' },
          team_blueprint: { giant: 'd'.repeat(5000) },
          knowledge_base_profile: { giant: 'e'.repeat(5000) },
          structure_v2: {
            participants: [
              { participant_id: 'service_builder', role_id: 'builder', label: 'Service Builder', provider: 'codex', model: 'gpt-5-codex', purpose: '실제 변경안과 실행 계획을 만든다.', recommended_tool_ids: ['workspace_fs', 'shell'], context_policy: { reads: { grants: ['upstream_results'] } } },
            ],
            topology: {
              pattern: 'workflow',
              execution_pattern: 'builder_reviewer_loop',
              final_participant_id: 'delivery_synthesizer',
              nodes: [{ node_id: 'node_service_builder' }],
              edges: [{ edge_id: 'service_builder_to_quality_reviewer' }],
            },
            runtime_state: { giant: 'f'.repeat(5000) },
          },
        },
      },
      last_route: {
        reason: 'default run_agent fallback; repaired_locked_team_pipeline',
        action_source: 'default_fallback_route',
        actions: [
          {
            type: 'run_agent',
            agent_id: 'service_builder',
            goal: 'g'.repeat(1200),
            inputs: { role_id: 'builder', provider: 'codex', model: 'gpt-5-codex', huge: 'h'.repeat(2000) },
            scope: { mode: 'shared_only', huge: 'i'.repeat(2000) },
          },
        ],
        runtime_team_snapshot: {
          task_interpretation: {
            task_type: 'code_change',
            deliverable_type: 'code_patch',
            risk_level: 'high',
            task_summary: 'j'.repeat(1000),
            preferred_roles: ['builder', 'reviewer', 'synthesizer', 'researcher'],
            suppressed_role_ids: ['operator', 'synthesizer'],
          },
          runtime_agents: [
            { agent_id: 'service_builder', name: 'Service Builder', role: 'builder', provider: 'codex', model: 'gpt-5-codex', source_agent: { giant: 'k'.repeat(5000) } },
          ],
          execution_graph: {
            pattern: 'workflow',
            execution_pattern: 'builder_reviewer_loop',
            order: ['service_builder', 'quality_reviewer', 'delivery_synthesizer'],
            validation: { errors: ['workflow pattern contains a cycle in executable topology'] },
          },
          team_plan: { giant: 'l'.repeat(8000) },
        },
      },
    });

    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'chat_sessions.json'), 'utf8'));
    const session = persisted.sessions['chat-1'];
    assert.equal(Boolean(session.team_config.pending_team.team_blueprint), false);
    assert.equal(Boolean(session.team_config.pending_team.structure), false);
    assert.equal(Boolean(session.team_config.pending_team.knowledge_base_profile), false);
    assert.equal(Boolean(session.team_config.pending_team.agents[0].source_agent), false);
    assert.equal(Boolean(session.team_config.pending_team.structure_v2.runtime_state), false);
    assert.equal(session.team_config.pending_team.structure_v2.participants[0].role, 'builder');
    assert.equal(session.team_config.pending_team.structure_v2.participants[0].role_id, 'builder');
    assert.equal(session.team_config.pending_team.structure_v2.participants[0].purpose.includes('실제 변경안과 실행 계획'), true);
    assert.deepEqual(session.team_config.pending_team.structure_v2.participants[0].recommended_tool_ids, ['workspace_fs', 'shell']);
    assert.deepEqual(session.team_config.pending_team.structure_v2.participants[0].context_policy, { reads: { grants: ['upstream_results'] } });
    assert.equal(Boolean(session.last_route.runtime_team_snapshot.team_plan), false);
    assert.equal(session.last_route.actions[0].goal.length <= 221, true);
    assert.equal(session.pending_user_request.prompt.length <= 321, true);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('chat session store preserves Room Concierge cross-path state', () => {
  const baseDir = makeTestTempDir('dd-session-room-');
  try {
    const store = new ChatSessionStore({ baseDir });
    store.upsert('chat-1', {
      recent_room_turns: [
        { role: 'user', text: 'direct path에서 말한 사실', turn_id: 'turn_user_direct', source: 'room_concierge_direct_fast_path' },
        { role: 'assistant', text: 'direct path 답변', turn_id: 'turn_assistant_direct', source: 'room_concierge_direct_fast_path' },
      ],
      last_room_concierge_route: { route: 'concierge_direct_answer', depth: 'direct_answer' },
      last_room_selection: { room_action: 'use_current_or_inbox_room', execution_room: { room_id: 'inbox', name: 'Inbox' } },
      last_team_selection: { execution_mode: 'single_model_direct_answer', team_action: 'skip_team_for_direct_answer' },
      last_direct_ask: { provider: 'antigravity', duration_ms: 123 },
    });
    const persisted = JSON.parse(fs.readFileSync(path.join(baseDir, 'chat_sessions.json'), 'utf8'));
    const session = persisted.sessions['chat-1'];
    assert.equal(session.recent_room_turns.length, 2);
    assert.equal(session.last_room_concierge_route.route, 'concierge_direct_answer');
    assert.equal(session.last_room_selection.room_action, 'use_current_or_inbox_room');
    assert.equal(session.last_team_selection.execution_mode, 'single_model_direct_answer');
    assert.equal(session.last_direct_ask.provider, 'antigravity');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('chat session store preserves governed Room profile, memory lifecycle, and benchmark trace state', () => {
  const baseDir = makeTestTempDir('dd-session-room-memory-');
  try {
    const store = new ChatSessionStore({ baseDir });
    store.upsert('room-headless', {
      agent_room_profile: {
        kind: 'agent_room_profile_v1',
        collaboration_profile_id: 'builder_reviewer',
        memory_schema: { object_types: ['preference', 'correction'] },
      },
      room_idle_memory_candidates: [
        { kind: 'room_memory_candidate_v1', candidate_id: 'candidate-1', status: 'pending', memory_summary: '조용한 장소를 선호함' },
      ],
      room_idle_memory_maintenance: { kind: 'room_idle_memory_maintenance_v1', candidate_only: true },
      room_memory_items: [
        { kind: 'room_memory_item_v1', memory_id: 'memory-1', status: 'active', summary: '조용한 장소를 선호함' },
      ],
      room_companion_events: [
        { event_id: 'event-1', event_type: 'room_idle_memory_observation_proposed' },
      ],
      room_companion_state: { kind: 'room_companion_state_v1', active_companion: { id: 'planner' } },
      room_journey_trace_enabled: true,
      room_journey_trace_until: '2099-01-01T00:00:00.000Z',
      room_journey_trace_source: 'headless_room_journey_benchmark',
      room_journey_identity: { thread_id: 'synthetic-thread', chat_id: 'room-headless', user_id: 'benchmark-user', transport: 'headless' },
      room_memory_updated_at: '2098-12-31T23:59:00.000Z',
    });

    const reloaded = new ChatSessionStore({ baseDir }).get('room-headless');
    assert.equal(reloaded.agent_room_profile.collaboration_profile_id, 'builder_reviewer');
    assert.deepEqual(reloaded.agent_room_profile.memory_schema.object_types, ['preference', 'correction']);
    assert.equal(reloaded.room_idle_memory_candidates[0].candidate_id, 'candidate-1');
    assert.equal(reloaded.room_idle_memory_maintenance.candidate_only, true);
    assert.equal(reloaded.room_memory_items[0].memory_id, 'memory-1');
    assert.equal(reloaded.room_companion_events[0].event_id, 'event-1');
    assert.equal(reloaded.room_companion_state.active_companion.id, 'planner');
    assert.equal(reloaded.room_journey_trace_enabled, true);
    assert.equal(reloaded.room_journey_trace_source, 'headless_room_journey_benchmark');
    assert.equal(reloaded.room_journey_identity.transport, 'headless');
    assert.equal(reloaded.room_memory_updated_at, '2098-12-31T23:59:00.000Z');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test('pending team-task messages preserve execution metadata across session normalization', () => {
  const root = makeTestTempDir('session-pending-team-config-');
  try {
    const store = new ChatSessionStore({ baseDir: root });
    store.upsert('pending-team-room', {
      pending_user_messages: [{
        ts: new Date().toISOString(),
        user_id: 'benchmark-user',
        text: 'Run the configured collaboration graph',
        kind: 'team_task',
        user_reply_to_message_id: 42,
        team_config: {
          team_name: 'portfolio_team',
          agents: [{
            agent_id: 'reviewer',
            name: 'Independent Reviewer',
            role: 'reviewer',
            provider: 'claude',
            model_role: 'verifier_critic',
            collaboration_lane: { lane_id: 'review_lane' },
          }],
          interaction_spec: {
            execution_pattern: 'builder_reviewer_loop',
            final_answer_owner: 'Independent Reviewer',
            handoffs: [],
          },
        },
      }],
    });
    const reloaded = new ChatSessionStore({ baseDir: root }).get('pending-team-room');
    const pending = reloaded.pending_user_messages[0];
    assert.equal(pending.kind, 'team_task');
    assert.equal(pending.user_reply_to_message_id, 42);
    assert.equal(pending.team_config.team_name, 'portfolio_team');
    assert.equal(pending.team_config.agents[0].model_role, 'verifier_critic');
    assert.equal(pending.team_config.agents[0].collaboration_lane.lane_id, 'review_lane');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
