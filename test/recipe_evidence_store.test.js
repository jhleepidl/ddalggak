import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getRecipe } from '../src/application/recipe_catalog.js';
import {
  getCurrentRecipeEvidence,
  recordRecipeEvaluationObservation,
} from '../src/evaluation/recipe_evidence_store.js';

function makeResult(index = 1) {
  return {
    evaluation_id: `eval-${index}`,
    run_id: `run-${index}`,
    runtime_signature: 'variant|codex|gpt-5.6-sol|high|codex-cli-0.144.0',
    provider: 'codex',
    model: 'gpt-5.6-sol',
    reasoning_effort: 'high',
    cli_version: 'codex-cli-0.144.0',
    dry_run: false,
    passed: true,
    score: index === 3 ? 0.9 : 1,
    deterministic_evaluation: { checks: [] },
    completed_at: `2026-07-12T01:0${index}:00.000Z`,
  };
}

test('recipe evidence store aggregates the current runtime signature', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-evidence-'));
  const evidencePath = path.join(temp, 'recipe_evidence.json');
  for (let index = 1; index <= 3; index += 1) {
    recordRecipeEvaluationObservation({
      recipeIds: ['coding.small_change'],
      result: makeResult(index),
      evidencePath,
    });
  }
  const evidence = getCurrentRecipeEvidence('coding.small_change', { evidencePath });
  assert.equal(evidence.live_runs, 3);
  assert.equal(evidence.passed_runs, 3);
  assert.equal(evidence.model, 'gpt-5.6-sol');
  assert.equal(evidence.runtime_signature, 'variant|codex|gpt-5.6-sol|high|codex-cli-0.144.0');
});

test('recipe catalog uses current runtime evidence instead of stale seed evidence', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'recipe-catalog-evidence-'));
  const evidencePath = path.join(temp, 'recipe_evidence.json');
  const previous = process.env.RECIPE_EVIDENCE_PATH;
  try {
    process.env.RECIPE_EVIDENCE_PATH = evidencePath;
    for (let index = 1; index <= 3; index += 1) {
      recordRecipeEvaluationObservation({
        recipeIds: ['coding.small_change'],
        result: makeResult(index),
        evidencePath,
      });
    }
    const recipe = getRecipe('coding.small_change');
    assert.equal(recipe.evidence_summary.status, 'evaluated');
    assert.equal(recipe.evidence_summary.live_runs, 3);
    assert.equal(recipe.evidence_summary.evidence.length, 1);
    assert.equal(recipe.evidence_summary.evidence[0].current, true);
  } finally {
    if (previous === undefined) delete process.env.RECIPE_EVIDENCE_PATH;
    else process.env.RECIPE_EVIDENCE_PATH = previous;
  }
});
