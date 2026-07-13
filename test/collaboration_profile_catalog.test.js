import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCollaborationInteractionPatch,
  formatCollaborationProfileListForTelegram,
  getCollaborationProfile,
  listCollaborationProfiles,
} from '../src/application/collaboration_profile_catalog.js';

test('collaboration catalog exposes generic native and preview profiles', () => {
  const catalog = listCollaborationProfiles();
  assert.ok(catalog.profiles.length >= 7);
  assert.ok(getCollaborationProfile('parallel_ideation'));
  assert.ok(getCollaborationProfile('evidence_panel'));
  assert.equal(getCollaborationProfile('selective_panel')?.runtime_support, 'metadata_only');
  assert.match(formatCollaborationProfileListForTelegram(), /병렬 아이디어 탐색/);
});

test('native collaboration profile becomes an interaction patch without task keyword rules', () => {
  const patch = buildCollaborationInteractionPatch('parallel_ideation');
  assert.equal(patch.execution_pattern, 'parallel_research_then_review_then_synthesize');
  assert.equal(patch.collaboration_profile_id, 'parallel_ideation');
  assert.equal(patch.collaboration_contract.initial_visibility, 'isolated_until_submission');
  assert.equal(patch.collaboration_contract.diversity_contract.required, true);
});

test('auto profile leaves the existing task-adaptive router unchanged', () => {
  assert.deepEqual(buildCollaborationInteractionPatch('auto'), {});
});
