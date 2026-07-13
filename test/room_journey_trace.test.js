import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  appendRoomJourneyTrace,
  isRoomJourneyTraceEnabled,
  readRoomJourneyTrace,
  sanitizeRoomJourneyPayload,
  traceMemoryCandidates,
  traceMemoryDecision,
} from '../src/application/room_journey_trace.js';


test('room journey tracing is opt-in per Room with an expiring lease', () => {
  assert.equal(isRoomJourneyTraceEnabled({ session: {} }), false);
  assert.equal(isRoomJourneyTraceEnabled({ session: { room_journey_trace_enabled: true, room_journey_trace_until: new Date(Date.now() + 60000).toISOString() } }), true);
  assert.equal(isRoomJourneyTraceEnabled({ session: { room_journey_trace_enabled: true, room_journey_trace_until: new Date(Date.now() - 60000).toISOString() } }), false);
});

test('room journey trace redacts secrets and stores raw text as preview plus hash', () => {
  const payload = sanitizeRoomJourneyPayload({
    api_key: 'secret-value',
    message: '사용자가 제공한 민감할 수 있는 긴 원문',
    memory_summary: '조용한 장소를 선호함',
    model: 'gpt-5.5',
  });
  assert.equal(payload.api_key, '[redacted]');
  assert.equal(payload.message, undefined);
  assert.match(payload.message_preview, /사용자가 제공한/);
  assert.match(payload.message_hash, /^[a-f0-9]{20}$/);
  assert.equal(payload.memory_summary, undefined);
  assert.match(payload.memory_summary_hash, /^[a-f0-9]{20}$/);
  assert.equal(payload.model, 'gpt-5.5');
});

test('memory lifecycle trace records candidate, decision, and commit without raw source text', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-journey-trace-'));
  try {
    traceMemoryCandidates({
      chatId: 'chat-1',
      source: 'test',
      traceRoot: root,
      candidates: [{
        candidate_id: 'cand-1',
        observation_type: 'preference',
        memory_summary: '시끄러운 장소를 피한다',
        source_quote: '나는 시끄러운 곳은 싫어',
        status: 'pending',
      }],
    });
    appendRoomJourneyTrace({ chatId: 'chat-1', traceRoot: root, eventType: 'memory.candidate_created', payload: { source_quote: '원문', memory_summary: '요약' } });
    traceMemoryDecision({
      chatId: 'chat-2',
      decision: 'approve',
      userId: 'user-1',
      traceRoot: root,
      result: {
        ok: true,
        status: 'active',
        candidate: { candidate_id: 'cand-2', review_required: true },
        memory_item: { memory_id: 'mem-2', source_candidate_id: 'cand-2', type: 'preference', status: 'active', summary: '조용한 환경 선호' },
      },
    });
    const rows = readRoomJourneyTrace({ chatId: 'chat-1', traceRoot: root });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].event_type, 'memory.candidate_created');
    assert.equal(rows[0].payload.source_quote, undefined);
    assert.equal(rows[0].payload.memory_summary, undefined);
    assert.match(rows[0].payload.source_quote_hash, /^[a-f0-9]{20}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
