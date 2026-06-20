import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRoomPackage,
  buildRoomProfileFromGoal,
  formatRoomPackageSummary,
  inferRoomDomain,
  renderRoomMarkdown,
  roomPackageToProfilePatch,
  sanitizeRoomPackage,
} from '../src/application/room_package.js';


test('room domain inference recognizes recurring specialized rooms', () => {
  assert.equal(inferRoomDomain('주식 포트폴리오 리서치와 리스크 검토를 도와줘').domain_label, 'portfolio_research');
  assert.equal(inferRoomDomain('음식 사진을 올리면 영양분과 칼로리를 분석해줘').domain_label, 'nutrition_tracker');
  assert.equal(inferRoomDomain('연구 아이디어를 논문으로 발전시키고 related work를 찾아줘').domain_label, 'research_paper');
  assert.equal(inferRoomDomain('팬픽 줄거리와 캐릭터 모순을 검토해줘').domain_label, 'creative_writing');
});

test('ROOM.md package is shareable without private memory', () => {
  const profile = buildRoomProfileFromGoal({ chatId: 'c1', goal: '논문 아이디어를 계속 발전시키는 연구방' });
  const pkg = buildRoomPackage({ profile, chatId: 'c1', title: 'Paper Room' });
  const sanitized = sanitizeRoomPackage({
    ...pkg,
    private_memory_content: 'do not copy',
    credentials: { api_key: 'secret' },
  });
  assert.equal(sanitized.kind, 'shared_room_package_v1');
  assert.equal(sanitized.safety_report.copies_private_memory, false);
  assert.equal(sanitized.memory_schema.copies_private_memory, false);
  assert.ok(!('private_memory_content' in sanitized));
  assert.ok(!('credentials' in sanitized));
  assert.match(renderRoomMarkdown(sanitized), /Shared room packages never include private user memory/);
  assert.match(formatRoomPackageSummary(sanitized), /private memory copied: no/);
});

test('room package install creates fresh local room profile patch', () => {
  const pkg = buildRoomPackage({ goal: '팬픽 작성과 설정 검토를 반복하는 방', title: 'Creative Room' });
  const patch = roomPackageToProfilePatch(pkg, { chatId: 'chat-2' });
  assert.equal(patch.room_id, 'chat-2');
  assert.equal(patch.domain_label, 'creative_writing');
  assert.equal(patch.memory_scope, 'room');
  assert.equal(patch.context_policy.shared_package_copies_private_memory, false);
  assert.ok(patch.default_agents.includes('canon_reviewer'));
});
