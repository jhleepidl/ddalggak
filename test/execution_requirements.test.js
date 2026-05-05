import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectUnmetExecutionRequirements,
  extractExecutionRequirements,
  formatExecutionRequirementsBlock,
  mergeExecutionRequirements,
  applyRuntimeRulePolicy,
} from '../src/application/execution_requirements.js';

test('extractExecutionRequirements captures direct execution and exe delivery requests', () => {
  const req = extractExecutionRequirements('너가 직접 npm install 해서 빌드 도구 설치하고, .exe 설치 파일까지 생성해서 산출물을 만들어줘.');
  assert.equal(req.direct_execution_requested, true);
  assert.equal(req.shell_execution_requested, true);
  assert.equal(req.artifact_build_requested, true);
  assert.equal(req.artifact_delivery_requested, true);
  assert.ok(req.expected_artifact_kinds.includes('exe'));
});

test('merge and format execution requirements preserve delivery expectations', () => {
  const merged = mergeExecutionRequirements(
    extractExecutionRequirements('너가 직접 npm install 해서 dist까지 만들어줘'),
    extractExecutionRequirements('.exe 파일로 전달해줘'),
  );
  const block = formatExecutionRequirementsBlock(merged);
  assert.equal(merged.shell_execution_requested, true);
  assert.equal(merged.artifact_build_requested, true);
  assert.ok(merged.expected_artifact_kinds.includes('exe'));
  assert.match(block, /bounded shell command를 직접 실행/);
  assert.match(block, /기대 산출물: exe/);
});

test('detectUnmetExecutionRequirements catches skipped build and missing exe artifacts', () => {
  const requirements = extractExecutionRequirements('너가 직접 npm install 하고 .exe 설치 파일까지 만들어줘');
  const unmet = detectUnmetExecutionRequirements({
    requirements,
    output: '이번 턴에서는 빌드/테스트는 실행하지 않았습니다. 실제 .exe 파일은 아직 생성 확인하지 않았습니다.',
    artifactPaths: ['dist/release-manifest.json'],
  });
  assert.ok(unmet.some((row) => row.code === 'direct_execution_not_performed'));
  assert.ok(unmet.some((row) => row.code === 'artifact_build_not_verified'));
  assert.ok(unmet.some((row) => row.code === 'missing_exe_artifact'));
});


test('extractExecutionRequirements captures notebook file delivery requests', () => {
  const req = extractExecutionRequirements('CE2026S_Assignment_5.ipynb 노트북 파일을 만들어줘.');
  assert.equal(req.artifact_delivery_requested, true);
  assert.ok(req.expected_artifact_kinds.includes('ipynb'));
});

test('extractExecutionRequirements captures general file delivery requests', () => {
  const req = extractExecutionRequirements('분석 결과를 reports/summary.md 파일로 저장해서 전달해줘.');
  assert.equal(req.artifact_delivery_requested, true);
  assert.ok(req.expected_artifact_kinds.includes('markdown'));
});

test('memory-only correction forbids artifact delivery even when an old artifact path is mentioned', () => {
  const req = extractExecutionRequirements('해당 산출물 travel/icde2026_itinerary.md 는 삭제하고, 그냥 메모리에 기억해두라는 말이었어.');
  assert.equal(req.artifact_delivery_forbidden, true);
  assert.equal(req.memory_only_requested, true);
  assert.equal(req.artifact_delivery_requested, false);
  assert.deepEqual(req.expected_artifact_kinds, []);
});

test('information-only messages do not request artifact delivery without an explicit output operation', () => {
  const req = extractExecutionRequirements('귀항 비행기 정보: YUL 10:10 YYZ 11:38 AC407');
  assert.equal(req.artifact_delivery_requested, false);
  assert.equal(req.artifact_delivery_forbidden, false);
});

test('merge lets a memory-only rule override stale artifact requirements', () => {
  const merged = mergeExecutionRequirements(
    extractExecutionRequirements('생성된 파일 경로/이름까지 포함해 산출물을 전달해야 한다.'),
    extractExecutionRequirements('여행 일정은 산출물 파일을 만들지 말고 메모리에만 관리해줘'),
  );
  assert.equal(merged.artifact_delivery_forbidden, true);
  assert.equal(merged.artifact_delivery_requested, false);
  const block = formatExecutionRequirementsBlock(merged);
  assert.match(block, /파일\/산출물 생성·업데이트·전달을 하지 말고/);
  assert.doesNotMatch(block, /artifact index와 최종 응답에 명시/);
});


test('runtime rules can default artifact creation to explicit-only without hardcoded phrasing', () => {
  const base = extractExecutionRequirements('회의 내용을 정리해줘');
  const ruled = applyRuntimeRulePolicy(base, '산출물은 내가 명시적으로 요청할 때만 만들어줘. 평소에는 메모리 중심으로 처리해줘.');
  assert.equal(ruled.artifact_delivery_forbidden, true);
  assert.equal(ruled.memory_only_requested, true);
});
