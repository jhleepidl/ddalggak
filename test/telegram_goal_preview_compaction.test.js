import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanPreviewLines } from '../src/adapters/telegram/preview_formatting.js';

test('plan preview compacts raw builder goal into implementation-facing summary', () => {
  const lines = buildPlanPreviewLines([
    {
      type: 'run_agent',
      agent_id: 'service_builder',
      goal: '요청된 코드/노트북 산출물을 구현: 새로운 웹 서비스를 구현해줘. 서브컬처 컨텐츠를 본 사람들끼리 서로 겹치는 걸 확인할 수 있는 서비스를 구현해줘.',
      inputs: {
        role_id: 'builder',
        display_label: 'Service Builder',
        provider: 'codex',
        model: 'gpt-5-codex',
      },
    },
  ]);
  const joined = lines.join('\n');
  assert.match(joined, /실제 구현 산출물을 만들고 실행 가능한 결과를 남김/);
  assert.doesNotMatch(joined, /요청된 코드\/노트북 산출물을 구현:/);
});
