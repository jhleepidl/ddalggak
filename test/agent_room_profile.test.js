import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAgentRoomProfile,
  buildOperationalControlRedirectMessage,
  inferAgentRoomArchetype,
  isOperationalControlText,
  normalizeRoomAgentRoles,
} from '../src/application/agent_room_profile.js';

test('agent room profile infers loop/review/risk roles from natural language goal', () => {
  const inferred = inferAgentRoomArchetype('국내 주식 웹앱을 계속 개선 loop로 돌리고 매번 review하고 위험 변경은 승인받아');
  assert.equal(inferred.archetype, 'iterative_agent_workspace');
  assert.equal(inferred.default_workflow, 'bounded_review_improve_loop');
  assert.ok(inferred.recommended_roles.includes('planner'));
  assert.ok(inferred.recommended_roles.includes('builder'));
  assert.ok(inferred.recommended_roles.includes('reviewer'));
  assert.ok(inferred.recommended_roles.includes('risk_reviewer'));
});

test('agent room role normalization maps natural role aliases', () => {
  assert.deepEqual(normalizeRoomAgentRoles('설계자,builder,검토자,qa'), ['planner', 'builder', 'reviewer', 'verifier']);
});

test('agent room profile preserves room-level autonomy policy', () => {
  const profile = buildAgentRoomProfile({ chatId: 'c1', goal: '뉴스 가격 기반 금융 리스크 웹앱 구현', roles: ['planner', 'builder'] });
  assert.equal(profile.kind, 'agent_room_profile_v1');
  assert.equal(profile.room_id, 'c1');
  assert.ok(profile.default_agents.includes('planner'));
  assert.equal(profile.autonomy_policy.credential_or_external_api_binding, 'approval_required');
});

test('/chat operational control guard detects pure agent/team control text', () => {
  const text = 'agent team을 builder와 설계자, reviewer로 나누고 무한히 개선 loop 방식으로 계속 발전시키도록 해';
  assert.equal(isOperationalControlText(text), true);
  assert.match(buildOperationalControlRedirectMessage(text), /\/task loop/);
});
