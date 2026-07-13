import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRoomFirstRuntimeSelection, buildRoomFirstTeamConfiguration } from '../src/application/ai_room_runtime_selection.js';
import { buildRoomPackage } from '../src/application/room_package.js';

function roles(team) {
  return (team.agents || []).map((agent) => agent.role);
}

test('room-first ask uses one reusable room component and never chooses workspace builder', () => {
  const pkg = buildRoomPackage({ goal: '초 카구야 공주 팬픽 캐릭터 설정과 모순 검토', chatId: 'creative' });
  const team = buildRoomFirstTeamConfiguration({
    taskText: '초 카구야 공주 팬픽을 위해서 알아야할 캐릭터별 정보',
    workMode: 'ask',
    roomPackage: pkg,
    chatId: 'creative',
  });

  assert.equal(team.ephemeral, true);
  assert.equal(team.agents.length, 1);
  assert.notEqual(team.agents[0].role, 'builder');
  assert.notEqual(team.agents[0].name, 'Workspace Builder');
  assert.equal(team.ai_room_selection.policies.source_room_private_memory_read, false);
  assert.equal(team.ai_room_selection.policies.direct_memory_write, false);
  assert.equal(team.interaction_spec.execution_pattern, 'single_specialist');
});

test('room-first creative team task is a writing/review team, not implementation fallback', () => {
  const pkg = buildRoomPackage({ goal: '팬픽 줄거리 작성과 캐릭터 연속성 검토', chatId: 'creative' });
  const team = buildRoomFirstTeamConfiguration({
    taskText: '줄거리를 글로 생성하고 모순점을 찾아줘',
    workMode: 'team_task',
    roomPackage: pkg,
    chatId: 'creative',
  });

  assert.equal(team.composition_mode, 'room_components');
  assert.equal(team.ephemeral, false);
  assert.ok(team.room_runtime_selection.roles.includes('draft_writer'));
  assert.ok(team.room_runtime_selection.roles.includes('canon_reviewer') || team.room_runtime_selection.roles.includes('continuity_checker'));
  assert.equal(roles(team).includes('builder'), false);
  assert.ok(team.agents.some((agent) => agent.agent_id === 'draft_writer'));
  assert.ok(team.agents.some((agent) => agent.agent_id === 'canon_reviewer'));
  assert.equal(team.planner_metadata.room_first, true);
});

test('room-first code review may use builder only for code review room', () => {
  const pkg = buildRoomPackage({ goal: '코드 레포 패치와 테스트를 반복 검토하는 방', chatId: 'code' });
  const selection = buildRoomFirstRuntimeSelection({
    taskText: '이 버그를 패치하고 테스트해줘',
    workMode: 'team_loop_task',
    roomPackage: pkg,
    chatId: 'code',
  });

  assert.equal(selection.room.domain_label, 'code_review');
  assert.ok(selection.roles.includes('builder'));
  assert.ok(selection.roles.includes('verifier'));
  assert.equal(selection.policies.source_room_private_memory_read, false);
});


test('explicit parallel ideation profile changes team execution without scenario-specific keyword matching', () => {
  const pkg = buildRoomPackage({ goal: '일반적인 선택지 탐색 공간', chatId: 'ideas' });
  const team = buildRoomFirstTeamConfiguration({
    taskText: '서로 다른 접근을 검토해줘',
    workMode: 'team_task',
    roomPackage: pkg,
    roomProfile: { kind: 'agent_room_profile_v1', collaboration_profile_id: 'parallel_ideation' },
    chatId: 'ideas',
  });

  assert.equal(team.interaction_spec.execution_pattern, 'parallel_research_then_review_then_synthesize');
  assert.equal(team.interaction_spec.collaboration_profile_id, 'parallel_ideation');
  assert.equal(team.interaction_spec.policies.initial_visibility, 'isolated_until_submission');
  assert.equal(team.interaction_spec.policies.diversity_contract.required, true);
  assert.ok(team.agents.filter((agent) => agent.role === 'researcher').length >= 2);
  assert.ok(team.agents.some((agent) => /independent contribution lane/i.test(agent.purpose || '')));
  assert.ok(team.agents.length <= 5);
});

test('explicit team_task and builder-reviewer collaboration cannot be downgraded to a single ask route', () => {
  const pkg = buildRoomPackage({ goal: '일반 운영 산출물을 만들고 독립 검토하는 방', chatId: 'builder-reviewer' });
  const selection = buildRoomFirstRuntimeSelection({
    taskText: '운영 체크리스트를 만든 뒤 독립적으로 검토하고 최종본을 정리해줘',
    workMode: 'team_task',
    roomPackage: pkg,
    roomProfile: { kind: 'agent_room_profile_v1', collaboration_profile_id: 'builder_reviewer' },
    chatId: 'builder-reviewer',
  });

  assert.equal(selection.work_mode, 'team_task');
  assert.equal(selection.collaboration_profile.id, 'builder_reviewer');
  assert.ok(selection.roles.includes('builder'));
  assert.ok(selection.roles.includes('reviewer'));
  assert.ok(selection.roles.includes('synthesizer'));
  assert.ok(selection.agents.length >= 3);
});


test('room-first team resolves role-fit providers and models from the general model-role router', () => {
  const keys = {
    DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_PROVIDER: process.env.DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_PROVIDER,
    DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_MODEL: process.env.DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_MODEL,
    DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER: process.env.DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER,
    DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_MODEL: process.env.DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_MODEL,
    DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER: process.env.DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER,
    DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_MODEL: process.env.DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_MODEL,
  };
  try {
    process.env.DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_PROVIDER = 'claude';
    process.env.DDALGGAK_MODEL_ROLE_SOURCE_GROUNDER_MODEL = 'claude-source-test';
    process.env.DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_PROVIDER = 'codex';
    process.env.DDALGGAK_MODEL_ROLE_VERIFIER_CRITIC_MODEL = 'codex-review-test';
    process.env.DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_PROVIDER = 'claude';
    process.env.DDALGGAK_MODEL_ROLE_DELIVERY_SYNTHESIZER_MODEL = 'claude-delivery-test';

    const pkg = buildRoomPackage({ goal: '팀 온보딩 방식의 대안을 비교하고 검토하는 방', chatId: 'portfolio' });
    const selection = buildRoomFirstRuntimeSelection({
      taskText: '독립적인 대안을 만들고 검토한 뒤 최종안을 합성해줘',
      workMode: 'team_task',
      roomPackage: pkg,
      roomProfile: { kind: 'agent_room_profile_v1', collaboration_profile_id: 'parallel_ideation' },
      chatId: 'portfolio',
    });

    const sourceAgent = selection.agents.find((agent) => agent.model_role === 'source_grounder');
    const reviewerAgent = selection.agents.find((agent) => agent.model_role === 'verifier_critic');
    const deliveryAgent = selection.agents.find((agent) => agent.model_role === 'delivery_synthesizer');
    assert.equal(sourceAgent?.provider, 'claude');
    assert.equal(sourceAgent?.model, 'claude-source-test');
    assert.equal(reviewerAgent?.provider, 'codex');
    assert.equal(reviewerAgent?.model, 'codex-review-test');
    assert.equal(deliveryAgent?.provider, 'claude');
    assert.equal(deliveryAgent?.model, 'claude-delivery-test');
    assert.equal(sourceAgent?.model_role_resolution?.source, 'env_model_role_override');
  } finally {
    for (const [key, value] of Object.entries(keys)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
