import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateMetrics,
  evaluateModeDecision,
  evaluateTextExpectation,
  runModeSelectionCases,
} from '../src/application/benchmark_runner.js';

test('evaluateTextExpectation scores required and rejected labels', () => {
  const pass = evaluateTextExpectation('햄버거와 땅콩입니다.', {
    must_include: ['햄버거', '땅콩'],
    must_not_include: ['김치찌개'],
  });
  assert.equal(pass.correct_artifact_recall, 1);
  assert.equal(pass.wrong_label_recurrence, 0);
  assert.equal(pass.retraction_suppression, 1);

  const fail = evaluateTextExpectation('김치찌개로 보입니다.', {
    must_include: ['햄버거'],
    must_not_include: ['김치찌개'],
  });
  assert.equal(fail.correct_artifact_recall, 0);
  assert.equal(fail.wrong_label_recurrence, 1);
});

test('evaluateModeDecision separates under- and over-escalation', () => {
  assert.equal(evaluateModeDecision('single', 'hybrid').under_escalation, 1);
  assert.equal(evaluateModeDecision('multi', 'single').over_escalation, 1);
  assert.equal(evaluateModeDecision('hybrid_sidecar', 'hybrid').mode_accuracy, 1);
});

test('runModeSelectionCases can compare current policy against PSI-aware policy', () => {
  const cases = [{
    id: 'case1',
    task: '김치찌개가 아니라 햄버거였던 이미지의 영양성분을 검토해줘.',
    gold_mode: 'hybrid',
    available_agents: 3,
    attached_skills: ['nutrition_estimator'],
    projection_context: {
      activeArtifacts: 1,
      observations: ['햄버거'],
      negativeLabels: ['김치찌개'],
      activeRetractions: 1,
      recentUserCorrection: true,
      artifactAmbiguity: true,
      skillNeeds: ['nutrition_estimator'],
    },
  }];
  const current = runModeSelectionCases(cases, { policy: 'current' })[0];
  const psi = runModeSelectionCases(cases, { policy: 'current+psi' })[0];
  assert.ok(psi.decision.score >= current.decision.score);
  assert.ok(psi.decision.reasons.includes('projection_stress'));
});

test('aggregateMetrics averages numeric metrics only', () => {
  const summary = aggregateMetrics([{ metrics: { a: 1, b: 0 } }, { metrics: { a: 0, b: 1 } }]);
  assert.equal(summary.a, 0.5);
  assert.equal(summary.b, 0.5);
});
