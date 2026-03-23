import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatSessionStore } from '../src/chat/session.js';

test('chat session store compacts heavy team and route state before persisting', () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-session-'));
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
