import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeRoutePlanActions, repairRoutePlanForTeamExecution } from '../src/application/team_route_repair.js';

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

test('locked non-code builder-reviewer profile repairs a single route into a collaboration pipeline', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'general',
      interaction_spec: { execution_pattern: 'builder_reviewer_loop' },
      agents: [
        { agent_id: 'builder', role: 'builder', provider: 'codex', model_role: 'code_executor' },
        { agent_id: 'reviewer', role: 'reviewer', provider: 'claude', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', provider: 'codex', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'router returned one agent',
    actions: [{ type: 'run_agent', agent_id: 'reviewer', goal: '운영 점검표 작성', inputs: { role_id: 'reviewer' } }],
    team_locked: true,
  }, {
    message: '운영 점검표를 작성하고 독립적으로 검토해줘',
    runtime,
  });
  assert.match(repaired.reason, /repaired_builder_reviewer_collaboration/);
  assert.deepEqual(repaired.actions.map((row) => row.type), ['run_agent', 'run_agent', 'synthesize_final']);
  assert.deepEqual(repaired.actions.map((row) => row.inputs.model_role), ['code_executor', 'verifier_critic', 'delivery_synthesizer']);
});

test('locked parallel profile repairs a single route into independent lanes and synthesis', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'general',
      interaction_spec: { execution_pattern: 'parallel_research_then_review_then_synthesize' },
      agents: [
        { agent_id: 'researcher_lane_1', role: 'researcher', provider: 'claude', model_role: 'source_grounder' },
        { agent_id: 'researcher_lane_2', role: 'researcher', provider: 'claude', model_role: 'source_grounder' },
        { agent_id: 'reviewer', role: 'reviewer', provider: 'claude', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', provider: 'codex', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'router returned one lane',
    actions: [{ type: 'run_agent', agent_id: 'researcher_lane_1', goal: '대안 제안', inputs: { role_id: 'researcher' } }],
    team_locked: true,
  }, {
    message: '겹치지 않는 대안을 비교해줘',
    runtime,
  });
  assert.match(repaired.reason, /repaired_parallel_collaboration/);
  assert.equal(repaired.actions[0].type, 'spawn_agents');
  assert.equal(repaired.actions[0].agents.length, 2);
  assert.equal(repaired.actions[1].type, 'run_agent');
  assert.equal(repaired.actions[1].agent_id, 'reviewer');
  assert.equal(repaired.actions[2].type, 'synthesize_final');
});


test('route action dedupe removes accidental duplicates while preserving independent collaboration lanes', () => {
  const result = dedupeRoutePlanActions({
    actions: [
      {
        type: 'run_agent',
        agent_id: 'reviewer',
        goal: '같은 결과를 검토해줘',
        inputs: { model_role: 'verifier_critic' },
        scope: { mode: 'shared_only' },
      },
      {
        type: 'run_agent',
        agent_id: 'reviewer',
        goal: '같은 결과를 검토해줘',
        inputs: { model_role: 'verifier_critic' },
        scope: { mode: 'shared_only' },
      },
      {
        type: 'spawn_agents',
        agents: [
          {
            agent_id: 'researcher',
            goal: '독립 근거를 분석해줘',
            inputs: { model_role: 'source_grounder', lane_id: 'lane-1' },
            scope: { mode: 'shared_only' },
          },
          {
            agent_id: 'researcher',
            goal: '독립 근거를 분석해줘',
            inputs: { model_role: 'source_grounder', lane_id: 'lane-1' },
            scope: { mode: 'shared_only' },
          },
          {
            agent_id: 'researcher',
            goal: '독립 근거를 분석해줘',
            inputs: { model_role: 'source_grounder', lane_id: 'lane-2' },
            scope: { mode: 'shared_only' },
          },
        ],
      },
    ],
  });

  assert.equal(result.actions.length, 2);
  assert.equal(result.deduplicated_action_count, 1);
  assert.equal(result.actions[1].agents.length, 2);
  assert.deepEqual(result.actions[1].agents.map((row) => row.inputs.lane_id), ['lane-1', 'lane-2']);
});

test('locked parallel profile rebuilds an out-of-order multi-agent plan into lanes then reviewer then synthesizer', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'general',
      interaction_spec: {
        execution_pattern: 'parallel_research_then_review_then_synthesize',
        final_answer_owner: 'Synthesizer',
      },
      agents: [
        { agent_id: 'researcher_lane_1', role: 'researcher', name: 'Lane 1', provider: 'claude', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_1' } },
        { agent_id: 'researcher_lane_2', role: 'researcher', name: 'Lane 2', provider: 'claude', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_2' } },
        { agent_id: 'reviewer', role: 'reviewer', name: 'Reviewer', provider: 'claude', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', name: 'Synthesizer', provider: 'codex', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'supervisor returned wrong order',
    actions: [
      { type: 'run_agent', agent_id: 'researcher_lane_1', goal: 'lane 1', inputs: { role_id: 'researcher' } },
      { type: 'synthesize_final', agent_id: 'reviewer', agent: 'reviewer', goal: 'wrong final owner', inputs: { role_id: 'reviewer', final_synthesis: true } },
      { type: 'run_agent', agent_id: 'researcher_lane_2', goal: 'lane 2', inputs: { role_id: 'researcher' } },
    ],
    team_locked: true,
  }, {
    message: '독립 대안을 비교하고 검토 후 합성해줘',
    runtime,
  });

  assert.deepEqual(repaired.actions.map((row) => row.type), ['spawn_agents', 'run_agent', 'synthesize_final']);
  assert.deepEqual(repaired.actions[0].agents.map((row) => row.agent_id), ['researcher_lane_1', 'researcher_lane_2']);
  assert.equal(repaired.actions[1].agent_id, 'reviewer');
  assert.equal(repaired.actions[2].agent_id, 'synthesizer');
  assert.equal(repaired.actions[2].agent, 'synthesizer');
});


test('explicit parallel collaboration contract outranks accidental code-like task classification', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'code_review',
      interaction_spec: { execution_pattern: 'parallel_research_then_review_then_synthesize', collaboration_profile_id: 'parallel_ideation', final_answer_owner: 'Synthesizer' },
      agents: [
        { agent_id: 'researcher_lane_1', role: 'researcher', name: 'Lane 1', provider: 'claude', model: '', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_1' } },
        { agent_id: 'researcher_lane_2', role: 'researcher', name: 'Lane 2', provider: 'claude', model: '', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_2' } },
        { agent_id: 'reviewer', role: 'reviewer', name: 'Reviewer', provider: 'claude', model: '', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', name: 'Synthesizer', provider: 'codex', model: '', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'misclassified implementation route',
    actions: [
      { type: 'run_agent', agent_id: 'researcher_lane_1', goal: 'first lane', inputs: { role_id: 'researcher' } },
      { type: 'synthesize_final', agent_id: 'reviewer', agent: 'reviewer', goal: 'wrong final', inputs: { role_id: 'reviewer', final_synthesis: true } },
    ],
    team_locked: true,
  }, {
    message: '신입 온보딩 방식을 세 가지로 비교하고 추천해줘',
    runtime,
    runtimeTeamSnapshot: { task_interpretation: { task_type: 'code_change', deliverable_type: 'code_patch' } },
  });
  assert.match(repaired.reason, /repaired_parallel_collaboration/);
  assert.deepEqual(repaired.actions.map((row) => row.type), ['spawn_agents', 'run_agent', 'synthesize_final']);
  assert.deepEqual(repaired.actions[0].agents.map((row) => row.inputs.lane_id), ['lane_1', 'lane_2']);
  assert.equal(repaired.actions[1].agent_id, 'reviewer');
  assert.equal(repaired.actions[1].inputs.final_synthesis, undefined);
  assert.equal(repaired.actions[2].agent_id, 'synthesizer');
  assert.equal(repaired.actions[2].inputs.final_synthesis, true);
});

test('explicit builder reviewer contract is rebuilt even when task is classified as implementation', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      interaction_spec: { execution_pattern: 'builder_reviewer_loop', collaboration_profile_id: 'builder_reviewer', final_answer_owner: 'Synthesizer' },
      agents: [
        { agent_id: 'builder', role: 'builder', name: 'Builder', provider: 'codex', model: '', model_role: 'code_executor' },
        { agent_id: 'reviewer', role: 'reviewer', name: 'Reviewer', provider: 'claude', model: '', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', name: 'Synthesizer', provider: 'codex', model: '', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'wrong implementation order',
    actions: [{ type: 'synthesize_final', agent_id: 'reviewer', agent: 'reviewer', goal: 'review first', inputs: { role_id: 'reviewer', final_synthesis: true } }],
    team_locked: true,
  }, {
    message: '배포 점검표를 작성하고 독립 검토해줘',
    runtime,
    runtimeTeamSnapshot: { task_interpretation: { task_type: 'code_change', deliverable_type: 'software_delivery' } },
  });
  assert.deepEqual(repaired.actions.map((row) => row.agent_id), ['builder', 'reviewer', 'synthesizer']);
  assert.deepEqual(repaired.actions.map((row) => row.type), ['run_agent', 'run_agent', 'synthesize_final']);
  assert.equal(repaired.actions[1].inputs.final_synthesis, undefined);
});

test('named parallel execution pattern remains authoritative even when task interpretation is code-like and profile id is missing', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'implementation',
      interaction_spec: {
        execution_pattern: 'multi_research_adjudication',
        final_answer_owner: 'Synthesizer',
      },
      planner_metadata: { collaboration_profile_id: 'evidence_panel' },
      agents: [
        { agent_id: 'researcher_lane_1', role: 'researcher', name: 'Lane 1', provider: 'claude', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_1' } },
        { agent_id: 'researcher_lane_2', role: 'researcher', name: 'Lane 2', provider: 'claude', model_role: 'source_grounder', collaboration_lane: { lane_id: 'lane_2' } },
        { agent_id: 'reviewer', role: 'reviewer', name: 'Reviewer', provider: 'claude', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', name: 'Synthesizer', provider: 'codex', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'classifier incorrectly preferred implementation pipeline',
    actions: [
      { type: 'run_agent', agent_id: 'researcher_lane_1', goal: 'lane 1', inputs: { role_id: 'researcher' } },
      { type: 'synthesize_final', agent_id: 'reviewer', agent: 'reviewer', goal: 'wrong final', inputs: { role_id: 'reviewer', final_synthesis: true } },
    ],
    team_locked: true,
  }, {
    message: 'A안은 초기 개발 2주, B안은 초기 개발 5주야. 사실을 비교해서 결정 메모를 작성해줘.',
    runtime,
    runtimeTeamSnapshot: { task_interpretation: { task_type: 'code_change', deliverable_type: 'code_patch' } },
  });
  assert.match(repaired.reason, /repaired_parallel_collaboration/);
  assert.equal(repaired.actions[0].type, 'spawn_agents');
  assert.deepEqual(repaired.actions[0].agents.map((row) => row.inputs.lane_id), ['lane_1', 'lane_2']);
  assert.equal(repaired.actions[1].type, 'run_agent');
  assert.equal(repaired.actions[1].agent_id, 'reviewer');
  assert.equal(repaired.actions[2].type, 'synthesize_final');
  assert.equal(repaired.actions[2].agent_id, 'synthesizer');
});

test('benchmark authoritative context survives role-goal repair without the 180 character request clip', () => {
  const runtime = {
    teamLocked: true,
    activeTeamConfig: {
      task_archetype: 'general',
      interaction_spec: { execution_pattern: 'parallel_research_then_review_then_synthesize', collaboration_profile_id: 'evidence_panel' },
      agents: [
        { agent_id: 'lane_1', role: 'researcher', provider: 'claude', model_role: 'source_grounder' },
        { agent_id: 'lane_2', role: 'researcher', provider: 'claude', model_role: 'source_grounder' },
        { agent_id: 'reviewer', role: 'reviewer', provider: 'claude', model_role: 'verifier_critic' },
        { agent_id: 'synthesizer', role: 'synthesizer', provider: 'codex', model_role: 'delivery_synthesizer' },
      ],
    },
  };
  const evidence = [
    '[ROOM_JOURNEY_AUTHORITATIVE_CONTEXT manifest_id=manifest_abc sha256=hash_abc]',
    'The following items are immutable.',
    '- source_step_id=fact_cost sha256=h1',
    '  A는 월 180만원, B는 월 90만원이다.',
    '- source_step_id=fact_recovery sha256=h2',
    '  A는 수동 복구 40분, B는 자동 복구 8분이다.',
    '- source_step_id=fact_constraints sha256=h3',
    '  출시 기한은 6주이고 장애 대응 인력은 1명이다.',
    '[/ROOM_JOURNEY_AUTHORITATIVE_CONTEXT]',
  ].join('\n');
  const message = `${evidence}\n\nA/B 중 하나를 추천해줘.`;
  const repaired = repairRoutePlanForTeamExecution({
    reason: 'single lane fallback',
    actions: [{ type: 'run_agent', agent_id: 'lane_1', goal: message, inputs: { role_id: 'researcher' } }],
    team_locked: true,
  }, { message, runtime });

  const goals = [
    ...repaired.actions[0].agents.map((row) => row.goal),
    repaired.actions[1].goal,
    repaired.actions[2].goal,
  ];
  assert.equal(goals.length, 4);
  for (const goal of goals) {
    assert.match(goal, /manifest_id=manifest_abc/);
    assert.match(goal, /source_step_id=fact_cost/);
    assert.match(goal, /source_step_id=fact_recovery/);
    assert.match(goal, /source_step_id=fact_constraints/);
    assert.match(goal, /장애 대응 인력은 1명/);
  }
});
