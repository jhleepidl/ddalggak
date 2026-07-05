import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRoomPackage,
  buildRoomProfileFromGoal,
  getDefaultRoomPackage,
  listDefaultRoomPackages,
  recommendDefaultRoomPackages,
  renderRoomMarkdown,
} from '../src/application/room_package.js';

test('default room library exposes many reusable room presets', () => {
  const presets = listDefaultRoomPackages({ limit: 100 });
  assert.ok(presets.length >= 20);
  assert.ok(getDefaultRoomPackage('research_paper_factory'));
  assert.ok(getDefaultRoomPackage('autonomous_code_loop'));
});

test('goal specialization starts from reusable preset rather than no-base routing', () => {
  const profile = buildRoomProfileFromGoal({ chatId: 'c1', goal: 'SIGIR AP 논문 연구와 실험 코드를 loop로 진행하는 방' });
  assert.equal(profile.preset_id, 'research_paper_factory');
  assert.equal(profile.default_depth, 'loop');
  assert.ok(profile.installed_skills.includes('related_work_mapping'));
  assert.ok(profile.memory_hierarchy.includes('claim_ledger'));
  assert.equal(profile.loop_policy.default_iterations, 3);
  assert.match(profile.reasons.join('\n'), /default_room_preset:research_paper_factory/);
});

test('room package export preserves skill cards, memory hierarchy, and loop policy without private memory', () => {
  const profile = buildRoomProfileFromGoal({ chatId: 'c1', goal: 'repo 코드를 자동 loop로 패치하고 테스트하는 방' });
  const pkg = buildRoomPackage({ profile, chatId: 'c1', goal: profile.current_goal });
  const markdown = renderRoomMarkdown(pkg);
  assert.ok(pkg.skills.length > 0);
  assert.ok(pkg.memory_hierarchy.length > 0);
  assert.equal(pkg.memory_schema.private_memory_export, 'never_by_default');
  assert.match(markdown, /## Skills/);
  assert.match(markdown, /## Memory hierarchy/);
  assert.match(markdown, /## Loop policy/);
});

test('preset recommendation is catalog retrieval, not a fixed per-user prompt', () => {
  const rows = recommendDefaultRoomPackages('월요일 교수님 미팅 준비와 최근 피드백 정리', { limit: 3, minScore: 1 });
  assert.ok(rows.some((row) => row.package_id === 'meeting_prep_council' || row.package_id === 'personal_research_assistant'));
  for (const row of rows) {
    assert.ok(Array.isArray(row.skills));
    assert.ok(Array.isArray(row.memory_schema));
  }
});

test('room setting composes base package with borrowed skills and memory instead of forcing one preset', () => {
  const profile = buildRoomProfileFromGoal({
    chatId: 'c-compose',
    goal: '논문 아이디어를 실험 코드로 검증하고 교수님 미팅 준비까지 같이 하는 방',
  });
  assert.equal(profile.preset_id, 'research_paper_factory');
  assert.equal(profile.room_package_composition.kind, 'room_package_composition_v1');
  assert.equal(profile.room_package_composition.mode, 'retrieve_compose_trial');
  const borrowedIds = profile.room_package_composition.borrowed_packages.map((row) => row.package_id);
  assert.ok(borrowedIds.includes('experiment_bench_builder'));
  assert.ok(borrowedIds.includes('meeting_prep_council') || borrowedIds.includes('personal_research_assistant'));
  assert.ok(profile.installed_skills.includes('synthetic_task_generation'));
  assert.ok(profile.memory_schema.object_types.includes('benchmark_specs'));
  assert.match(profile.reasons.join('\n'), /borrowed_room_components:/);
});
