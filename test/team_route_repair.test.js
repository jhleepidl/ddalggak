import test from 'node:test';
import assert from 'node:assert/strict';
import { repairRoutePlanForTeamExecution } from '../src/application/team_route_repair.js';

test('locked implementation team repairs researcher-only route into build pipeline', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      interaction_spec: {
        execution_pattern: 'builder_reviewer_loop',
      },
      agents: [
        { agent_id: 'product_researcher', role: 'researcher', name: 'Product Researcher', provider: 'gemini', model: 'gemini-2.5-pro' },
        { agent_id: 'service_builder', role: 'builder', name: 'Service Builder', provider: 'codex', model: 'gpt-5-codex' },
        { agent_id: 'quality_reviewer', role: 'reviewer', name: 'Quality Reviewer', provider: 'chatgpt', model: 'gpt-5.4' },
        { agent_id: 'delivery_synthesizer', role: 'synthesizer', name: 'Delivery Synthesizer', provider: 'chatgpt', model: 'gpt-5.4' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'default run_agent fallback',
    actions: [
      {
        type: 'run_agent',
        agent_id: 'product_researcher',
        goal: '새로운 웹 서비스를 구현해줘',
        inputs: { role_id: 'researcher' },
      },
    ],
    team_locked: true,
  }, {
    message: '새로운 웹 서비스를 구현해줘',
    runtime,
    runtimeTeamSnapshot: {
      task_interpretation: { task_type: 'code_change', deliverable_type: 'software_delivery' },
    },
  });

  assert.equal(repaired.done, false);
  assert.equal(repaired.await_user, false);
  assert.match(repaired.reason, /repaired_locked_team_pipeline/);
  const agentIds = repaired.actions.map((action) => action.agent_id);
  assert.deepEqual(agentIds, [
    'product_researcher',
    'service_builder',
    'quality_reviewer',
    'delivery_synthesizer',
  ]);
  assert.match(repaired.actions[1].goal, /실제 구현 산출물/);
  assert.equal(repaired.actions[3].inputs.final_synthesis, true);
});

test('route repair rewrites raw builder goal into structured implementation goal', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      agents: [
        { agent_id: 'service_builder', role: 'builder', name: 'Service Builder', provider: 'codex', model: 'gpt-5-codex' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'forced_coder_for_code_deliverable',
    actions: [
      {
        type: 'run_agent',
        agent_id: 'service_builder',
        goal: '요청된 코드/노트북 산출물을 구현: 새로운 웹 서비스를 구현해줘',
      },
    ],
    team_locked: true,
  }, {
    message: '새로운 웹 서비스를 구현해줘',
    runtime,
    runtimeTeamSnapshot: {
      task_interpretation: { task_type: 'code_change', deliverable_type: 'software_delivery' },
    },
  });
  assert.equal(repaired.actions.length, 1);
  assert.match(repaired.actions[0].goal, /실제 구현 산출물/);
  assert.equal(repaired.actions[0].inputs.role_id, 'builder');
});


test('route repair assigns synthesize_final to declared final answer owner when available', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      interaction_spec: { execution_pattern: 'builder_reviewer_loop', final_answer_owner: 'Quality Reviewer' },
      structure_v2: { control_policy: { final_answer_owner_participant_id: 'quality_reviewer' } },
      agents: [
        { agent_id: 'product_researcher', role: 'researcher', name: 'Product Researcher', provider: 'gemini' },
        { agent_id: 'service_builder', role: 'builder', name: 'Service Builder', provider: 'codex' },
        { agent_id: 'quality_reviewer', role: 'reviewer', name: 'Quality Reviewer', provider: 'chatgpt' },
        { agent_id: 'delivery_synthesizer', role: 'synthesizer', name: 'Delivery Synthesizer', provider: 'chatgpt' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'default run_agent fallback',
    actions: [
      { type: 'run_agent', agent_id: 'product_researcher', goal: '새로운 웹 서비스를 구현해줘', inputs: { role_id: 'researcher' } },
    ],
    team_locked: true,
  }, {
    message: '새로운 웹 서비스를 구현해줘',
    runtime,
    runtimeTeamSnapshot: { task_interpretation: { task_type: 'code_change', deliverable_type: 'software_delivery' } },
  });

  const finalAction = repaired.actions[repaired.actions.length - 1];
  assert.equal(finalAction.type, 'synthesize_final');
  assert.equal(finalAction.agent_id, 'quality_reviewer');
  assert.equal(finalAction.agent, 'quality_reviewer');
});
