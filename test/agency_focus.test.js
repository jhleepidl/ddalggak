import test from 'node:test';
import assert from 'node:assert/strict';

import { buildAgencyFocusSummary } from '../src/application/agency_focus.js';

test('buildAgencyFocusSummary highlights independent reviewer collaboration', () => {
  const summary = buildAgencyFocusSummary({
    actions: [
      { type: 'agent_run', agent: 'builder', prompt: '구현', inputs: { role_id: 'builder', provider: 'codex', model: 'gpt-5.5', display_label: 'Builder' } },
      { type: 'agent_run', agent: 'reviewer', prompt: '검토', inputs: { role_id: 'reviewer', provider: 'gemini', model: 'gemini-2.5-pro', display_label: 'Reviewer' } },
      { type: 'synthesize_final', agent: 'synthesizer', prompt: '최종 정리', inputs: { role_id: 'synthesizer', display_label: 'Synthesizer' } },
    ],
  });
  assert.equal(summary.pattern, 'build → review → synthesize');
  assert.equal(summary.reviewer_count, 1);
  assert.equal(summary.independent_review, 'independent_provider');
  assert.equal(summary.focus_status, 'agency_first');
  assert.ok(summary.lines.some((line) => line.includes('리뷰 구조')));
});

test('buildAgencyFocusSummary warns when backend overhead hides agency surface', () => {
  const summary = buildAgencyFocusSummary({
    actions: [
      { type: 'agent_run', agent: 'researcher', prompt: '근거 조사', inputs: { role_id: 'researcher', display_label: 'Researcher' } },
      { type: 'checkpoint', label: 'internal' },
      { type: 'memory_sync', label: 'internal' },
      { type: 'supervisor_decision', label: 'internal' },
      { type: 'gate_wait', label: 'internal' },
    ],
  });
  assert.equal(summary.backend_only_count, 4);
  assert.equal(summary.focus_status, 'needs_compaction');
  assert.ok(summary.lines.some((line) => line.includes('숨긴 내부 단계')));
});
