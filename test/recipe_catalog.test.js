import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRecipeTaskContract,
  deriveRecipeEvidenceStatus,
  formatRecipeDetailForTelegram,
  formatRecipeListForTelegram,
  getRecipe,
  listRecipes,
  parseRecipeForm,
} from '../src/application/recipe_catalog.js';

test('recipe catalog exposes evidence-aware starter recipes', () => {
  const catalog = listRecipes();
  assert.ok(catalog.recipes.length >= 12);
  const smallChange = getRecipe('coding.small_change');
  assert.ok(smallChange);
  assert.equal(smallChange.evidence_summary.status, 'revalidation_needed');
  assert.equal(smallChange.evidence_summary.live_runs, 4);
  assert.equal(smallChange.evidence_summary.success_rate, 1);
  assert.match(formatRecipeListForTelegram(), /Recipe Catalog/);
  assert.match(formatRecipeDetailForTelegram(smallChange), /live runs: 4/i);
});

test('recipe evidence policy promotes only sufficiently broad evidence to recommended', () => {
  const status = deriveRecipeEvidenceStatus({
    evaluation: {
      evidence_scope: 'representative',
      evidence: [{ live_runs: 10, passed_runs: 9, policy_violations: 0, average_score: 0.9 }],
    },
  }, {
    status_policy: {
      recommended: { min_live_runs: 8, min_success_rate: 0.85, max_policy_violations: 0, required_evidence_scope: ['representative'] },
      evaluated: { min_live_runs: 3, min_success_rate: 0.8, max_policy_violations: 0 },
    },
  });
  assert.equal(status.status, 'recommended');
});

test('recipe form parses Korean labels and builds a structured task contract', () => {
  const recipe = getRecipe('coding.bug_fix');
  const values = parseRecipeForm(recipe, [
    '현재 증상: 없는 사용자 조회가 500을 반환함',
    '기대 동작: 404를 반환해야 함',
    '금지 사항: DB schema 변경 금지',
    '완료 조건: 회귀 테스트 추가 및 npm test 통과',
  ].join('\n'));
  const contract = buildRecipeTaskContract(recipe, values);
  assert.equal(contract.ready, true);
  assert.match(contract.contract.goal, /404/);
  assert.match(contract.contract.constraints, /DB schema/);
  assert.match(contract.contract.done_when, /npm test/);
});


test('recipe catalog covers non-coding task forms with generic contracts and collaboration profiles', () => {
  const expected = [
    'recommendation.contextual',
    'source.file_grounded',
    'thinking.parallel_ideas',
    'research.long_horizon',
    'artifact.prototype',
    'decision.risk_reviewed',
  ];
  for (const id of expected) assert.ok(getRecipe(id), `missing ${id}`);

  const fileGrounded = getRecipe('source.file_grounded');
  assert.equal(fileGrounded.recommended_collaboration_profile, 'solo');
  assert.ok(fileGrounded.input_fields.some((field) => field.id === 'authority'));

  const parallel = getRecipe('thinking.parallel_ideas');
  assert.equal(parallel.recommended_collaboration_profile, 'parallel_ideation');
  const values = parseRecipeForm(parallel, [
    '탐색할 질문: 장기 메모리 개선 접근',
    '다르게 탐색할 관점: 사용자 가치, 구조, 위험',
    '최종 선택 기준: 상위 3개와 검증 방법',
  ].join('\n'));
  const contract = buildRecipeTaskContract(parallel, values);
  assert.equal(contract.ready, true);
  assert.equal(contract.recommended_collaboration_profile, 'parallel_ideation');
  assert.match(contract.contract.diversity_contract, /사용자 가치/);
});
