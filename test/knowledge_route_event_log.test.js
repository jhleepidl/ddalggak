import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendKnowledgeRouteEvent, loadKnowledgeRouteEvents } from '../src/application/knowledge_route_event_log.js';

test('knowledge route event log records selected knowledge surfaces', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-route-events-'));
  try {
    const row = appendKnowledgeRouteEvent({
      jobDir,
      chatId: 'c1',
      userId: 'u1',
      message: '전에 올린 메뉴 이미지 기준으로 추천해줘',
      decision: { route: 'standard_workbench', depth: 'workbench', signals: ['artifact_reference_intent'], blockers: ['needs_artifact_context'] },
      modelPolicy: { provider: 'antigravity', model: 'fast', reasons: ['test'] },
    });
    assert.ok(row);
    assert.deepEqual(row.knowledge_surfaces, ['artifact_memory', 'room_memory']);
    const rows = loadKnowledgeRouteEvents(jobDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].model_policy.provider, 'antigravity');
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('knowledge route event log records route outcomes for optimizer training', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-route-outcomes-'));
  try {
    appendKnowledgeRouteEvent({
      jobDir,
      message: '저녁 메뉴 추천해줘',
      decision: { route: 'concierge_direct_answer', depth: 'direct_answer', signals: ['simple_qa_intent'] },
      modelPolicy: { provider: 'antigravity', model: 'fast' },
      executor: 'direct_ask_fast_path',
      outcome: 'answered_direct_fast_path',
      extra: { cost_estimate: { prompt_tokens: 200 } },
    });
    const rows = loadKnowledgeRouteEvents(jobDir);
    assert.equal(rows[0].outcome, 'answered_direct_fast_path');
    assert.equal(rows[0].executor, 'direct_ask_fast_path');
    assert.deepEqual(rows[0].knowledge_surfaces, ['model_prior']);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
