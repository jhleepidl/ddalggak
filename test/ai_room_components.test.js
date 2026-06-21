import test from 'node:test';
import assert from 'node:assert/strict';

import {
  augmentRoomPackageWithComponents,
  buildRoomComponentsFromPackage,
  createBorrowedAgentInvocation,
  findRoomAgentCard,
  recommendBorrowedAgents,
} from '../src/application/ai_room_components.js';
import { buildRoomPackage } from '../src/application/room_package.js';

test('room package is augmented with reusable components without private memory', () => {
  const pkg = buildRoomPackage({ goal: '팬픽 줄거리와 캐릭터 설정을 반복적으로 검토하는 방', chatId: 'c1' });
  assert.equal(pkg.component_model, 'composable_room_components_v1');
  assert.equal(pkg.components.kind, 'room_component_library_v1');
  assert.ok(pkg.components.agents.some((agent) => agent.local_id === 'canon_reviewer'));
  assert.equal(pkg.composition_policy.private_memory_copied, false);
  assert.equal(pkg.components.memory_schema.export_policy.copies_private_memory, false);
});

test('borrowed agent invocation never reads source private memory and writes proposal only', () => {
  const pkg = augmentRoomPackageWithComponents({
    package_id: 'creative_room',
    title: 'Creative Room',
    domain_label: 'creative_writing',
    agents: ['draft_writer', 'canon_reviewer'],
    memory_schema: { object_types: ['characters', 'canon_facts'] },
    private_memory: { secret: 'must not leak' },
  });
  const agent = findRoomAgentCard(pkg, 'canon_reviewer');
  assert.equal(agent.local_id, 'canon_reviewer');

  const invocation = createBorrowedAgentInvocation({
    sourceRoomPackage: pkg,
    agentId: 'canon_reviewer',
    targetRoomId: 'room_b',
    targetRoomPackageId: 'target_room',
  });
  assert.equal(invocation.kind, 'borrowed_agent_invocation_v1');
  assert.equal(invocation.memory_access.read_source_private_memory, false);
  assert.equal(invocation.memory_access.write_memory, false);
  assert.equal(invocation.memory_access.allow_propose_update, true);
  assert.equal(invocation.lineage.copied_private_memory, false);
  assert.equal(JSON.stringify(invocation).includes('must not leak'), false);
});

test('borrow recommendations match reusable agent cards from other room packages', () => {
  const creative = buildRoomPackage({ goal: '소설 팬픽 캐릭터 설정과 연속성 검토', chatId: 'creative' });
  const recs = recommendBorrowedAgents({
    taskText: '이 줄거리의 캐릭터 말투와 설정 모순을 검토해줘',
    availableRoomPackages: [creative],
    targetRoomId: 'target',
  });
  assert.ok(recs.some((rec) => rec.invocation.agent_id === 'canon_reviewer' || rec.invocation.agent_id === 'continuity_checker'));
});
