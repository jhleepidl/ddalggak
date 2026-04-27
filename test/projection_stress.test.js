import test from 'node:test';
import assert from 'node:assert/strict';

import { computeProjectionStress, inferProjectionSignals, summarizeProjectionStress } from '../src/application/projection_stress.js';

test('computeProjectionStress raises mode pressure for correction-heavy artifact context', () => {
  const stress = computeProjectionStress({
    activeArtifacts: 1,
    observations: ['햄버거', '땅콩'],
    negativeLabels: ['김치찌개', '된장찌개'],
    activeRetractions: 1,
    recentUserCorrection: true,
    artifactAmbiguity: true,
    skillNeeds: ['nutrition_estimator'],
  });
  assert.ok(stress.score >= 5);
  assert.equal(stress.mode_pressure, 2);
  assert.equal(stress.recommended_mode_hint, 'hybrid_sidecar');
  assert.ok(stress.reasons.includes('negative_label_pressure'));
});

test('inferProjectionSignals extracts correction and artifact signals from active context text', () => {
  const signals = inferProjectionSignals({
    userText: '그거 김치찌개가 아니라 햄버거였지. 영양성분 분석해줘.',
    artifactContextText: '[ACTIVE ARTIFACT CONTEXT]\n- artifact: uploads/photo.jpg\n  rejected_previous_labels: 김치찌개',
    skillNeeds: ['nutrition_estimator'],
  });
  assert.equal(signals.activeArtifacts, 1);
  assert.equal(signals.recentUserCorrection, true);
  assert.equal(signals.artifactAmbiguity, true);
  assert.equal(signals.missingSkillPressure, true);
});

test('summarizeProjectionStress produces compact human-readable trace text', () => {
  const stress = computeProjectionStress({ negativeLabels: ['old'], activeRetractions: 1 });
  const text = summarizeProjectionStress(stress);
  assert.match(text, /PSI=/);
  assert.match(text, /active_retraction/);
});
