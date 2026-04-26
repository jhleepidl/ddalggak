import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSkillDraftFromRequest,
  buildSkillDraftApprovalState,
  formatSkillDraftApprovalMessage,
  isSkillDraftApprovalCallbackData,
  parseSkillDraftApprovalCallbackData,
} from '../src/application/skill_draft_approval.js';

test('builds a general user-approval skill draft', () => {
  const draft = buildSkillDraftFromRequest({ request: '주변 음식점을 검색하고 영양 균형을 추정하는 skill을 만들어줘', createdBy: 'telegram:1' });
  assert.ok(draft.id.startsWith('skill.draft.'));
  assert.equal(draft.side_effect_level, 'read_only');
  assert.ok(draft.tags.includes('food'));
  assert.ok(draft.tags.includes('search'));
});

test('formats and parses approval state', () => {
  const draft = buildSkillDraftFromRequest({ request: '프로젝트 결정을 기록하는 skill' });
  const state = buildSkillDraftApprovalState({ draft, chatId: '1', userId: '2' });
  assert.equal(state.token.length, 16);
  assert.match(formatSkillDraftApprovalMessage(state), /skill 초안 승인/);
  assert.equal(isSkillDraftApprovalCallbackData(`approve_skill:${state.token}`), true);
  assert.deepEqual(parseSkillDraftApprovalCallbackData(`reject_skill:${state.token}`), { action: 'reject', token: state.token });
});
