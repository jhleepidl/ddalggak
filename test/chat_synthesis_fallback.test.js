import test from 'node:test';
import assert from 'node:assert/strict';

import { buildChatSynthesisFallback } from '../src/adapters/telegram/preview_formatting.js';

test('buildChatSynthesisFallback accepts execution-like objects and summarizes outputs', () => {
  const text = buildChatSynthesisFallback('ignored message', {
    outputs: [
      { agentId: 'researcher', output: '핵심 근거를 정리했습니다.' },
    ],
  });
  assert.match(text, /핵심 근거를 정리했습니다|현재까지 결과 요약/);
});

test('buildChatSynthesisFallback summarizes execution errors when outputs are missing', () => {
  const text = buildChatSynthesisFallback('ignored message', {
    outputs: [],
    results: [
      { label: 'run_agent:Lead Thesis Researcher', status: 'error', note: 'gemini auth failed' },
      { label: 'run_agent:Counterpoint Researcher', status: 'blocked', note: 'authority denied' },
    ],
  });
  assert.match(text, /실행 중 일부 단계가 완료되지 않았습니다/);
  assert.match(text, /gemini auth failed/);
  assert.match(text, /authority denied/);
});


test('buildChatSynthesisFallback surfaces missing tool and credential gaps before partial summaries', () => {
  const text = buildChatSynthesisFallback('ignored message', {
    outputs: [
      { agentId: 'course_researcher', output: "Tool 'write_file' not found. Please provide OPENAI_API_KEY." },
    ],
    results: [
      { label: 'run_agent:Notebook Builder', status: 'error', note: 'Unknown agent: notebook_builder' },
    ],
  });
  assert.match(text, /필요한 도구\/자격 정보가 부족/);
  assert.match(text, /write_file/);
  assert.match(text, /API 키|환경 변수/);
});


test('buildChatSynthesisFallback does not treat notebook setup guidance as a credential blocker', () => {
  const text = buildChatSynthesisFallback('ignored message', {
    outputs: [
      { agentId: 'notebook_builder', output: 'Notebook updated. To test live calls later, set OPENAI_API_KEY in your environment and run the demo cells.' },
    ],
  });
  assert.match(text, /Notebook updated/);
  assert.doesNotMatch(text, /필요한 도구\/자격 정보가 부족/);
});


test('buildChatSynthesisFallback prefers final-like synthesizer output over per-agent recap bullets', () => {
  const text = buildChatSynthesisFallback('ignored message', {
    outputs: [
      { agentId: 'builder', output: '빌드는 완료했습니다.' },
      { agentId: '최종_설계_신서사이저', output: '최종 전달: Windows PE 런처와 .pyz를 함께 제공합니다.' },
    ],
  });
  assert.match(text, /최종 전달/);
  assert.doesNotMatch(text, /현재까지 결과 요약/);
});
