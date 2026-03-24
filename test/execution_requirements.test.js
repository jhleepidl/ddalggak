import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectUnmetExecutionRequirements,
  extractExecutionRequirements,
  formatExecutionRequirementsBlock,
  mergeExecutionRequirements,
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
