import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatRoomGranularityRecommendation,
  recommendRoomGranularity,
} from '../src/application/room_granularity_advisor.js';

test('room granularity advisor recommends specialized room for repeated domain-specific work', () => {
  const rec = recommendRoomGranularity({
    goal: '매주 연구 아이디어를 논문으로 발전시키고 related work, figure, evaluation을 계속 관리하는 방',
    profile: {
      kind: 'agent_room_profile_v1',
      domain_label: 'research_paper',
      memory_schema: { object_types: ['research_claims', 'related_work', 'figure_plans', 'evaluation_metrics'] },
      default_agents: ['idea_expander', 'novelty_critic', 'paper_synthesizer'],
    },
    usage: { task_count: 12, correction_count: 2, approval_count: 3, distinct_domains: 1 },
  });
  assert.equal(rec.recommended, 'specialized_room');
  assert.match(formatRoomGranularityRecommendation(rec), /specialized_room/);
  assert.ok(rec.signals.recurrence > 0.5);
});

test('room granularity advisor recommends hierarchical hybrid for cross-domain recurring work', () => {
  const rec = recommendRoomGranularity({
    goal: '여러 방의 연구, 주식, 식단 기록을 연결해서 공통 preference를 유지하면서 private memory는 분리하고 싶다',
    profile: {
      kind: 'agent_room_profile_v1',
      domain_label: 'general_workbench',
      memory_schema: { object_types: ['room_preferences', 'decisions', 'saved_workflows'] },
      default_agents: ['planner', 'reviewer'],
    },
    usage: { task_count: 20, distinct_domains: 4 },
  });
  assert.equal(rec.recommended, 'hierarchical_hybrid');
  assert.match(formatRoomGranularityRecommendation(rec), /hierarchical_hybrid/);
});

test('room granularity advisor keeps general workspace for cold one-off tasks', () => {
  const rec = recommendRoomGranularity({
    goal: '간단히 이 용어가 뭔지 알려줘',
    profile: {},
    usage: { task_count: 0, distinct_domains: 0 },
  });
  assert.equal(rec.recommended, 'general_workspace');
  assert.ok(rec.signals.cold_start_risk > 0.2);
});
