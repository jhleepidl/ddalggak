import test from 'node:test';
import assert from 'node:assert/strict';

import { CODE_ARTIFACT_TERMS, CODE_REQUEST_TERMS, hasImplementationLikeIntent, hasSoftwareDeliveryIntent, inferExecutionRoleFromText } from '../src/shared/work_intent.js';

test('shared work intent detects implementation and software delivery requests', () => {
  assert.equal(hasImplementationLikeIntent('React 기반 웹 서비스 백엔드 API를 구현해줘'), true);
  assert.equal(hasSoftwareDeliveryIntent('React 기반 웹 서비스 백엔드 API를 구현해줘'), true);
  assert.equal(hasImplementationLikeIntent('시장 뉴스만 조사해줘'), false);
});

test('shared work intent infers execution roles from mixed-language text', () => {
  assert.equal(inferExecutionRoleFromText('Frontend builder for React app'), 'builder');
  assert.equal(inferExecutionRoleFromText('검토와 품질 확인 담당 리뷰어'), 'reviewer');
  assert.equal(inferExecutionRoleFromText('최종 요약 전달 담당'), 'synthesizer');
  assert.equal(inferExecutionRoleFromText('runtime coordinator operator'), 'operator');
  assert.equal(inferExecutionRoleFromText('research analyst for filings'), 'researcher');
});

test('shared work intent exports stable code request term lists', () => {
  assert.ok(CODE_REQUEST_TERMS.includes('web service'));
  assert.ok(CODE_REQUEST_TERMS.includes('웹 서비스'));
  assert.ok(CODE_ARTIFACT_TERMS.includes('ipynb'));
  assert.ok(CODE_ARTIFACT_TERMS.includes('주피터'));
});

test('shared work intent does not treat a development-duration fact as a software implementation request', () => {
  assert.equal(hasImplementationLikeIntent('A안은 초기 개발 2주이고 B안은 초기 개발 5주야. 비용과 복구 시간을 비교해줘.'), false);
  assert.equal(hasImplementationLikeIntent('이 기능을 실제로 개발해줘'), true);
  assert.equal(hasImplementationLikeIntent('이 API를 구현해줘'), true);
});
