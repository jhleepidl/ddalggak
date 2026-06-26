import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendRoomMemoryEventJsonl,
  buildRoomMemoryCaptureConfig,
  buildRoomMemoryEvent,
  maybeCaptureRoomMemoryEvent,
  validateRoomMemoryEvent,
} from '../src/application/room_memory_data_collection.js';

test('room_memory_trials room event hashes ids and excludes raw text', () => {
  const event = buildRoomMemoryEvent({
    taskText: 'private user request with sensitive details',
    chatId: 'chat-123',
    roomTurnRoute: {
      depth: 'ask',
      execution_shape: 'single_agent',
      reason_codes: ['simple_question'],
      raw_text: 'must not appear',
    },
    roomEvolution: {
      maturity: 'soft_typed_memory_candidate',
      aggregate: { counts: { total_events: 3 }, top_objects: [{ id: 'strategy_note' }] },
      proposals: [{ proposal_type: 'memory_schema', title: 'private title should be stripped if key is title?' }],
    },
  });

  const encoded = JSON.stringify(event);
  assert.equal(event.privacy.includes_raw_text, false);
  assert.notEqual(event.ids.chat_id_hash, 'chat-123');
  assert.ok(event.turn.task_hash);
  assert.ok(!encoded.includes('private user request'));
  assert.ok(!encoded.includes('must not appear'));
  assert.deepEqual(validateRoomMemoryEvent(event), { ok: true });
});

test('room_memory_trials capture is disabled by default and writes only when explicitly enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room_memory_trials-capture-'));
  const config = buildRoomMemoryCaptureConfig({ ROOM_MEMORY_TRIALS_DATA_COLLECTION_ENABLED: '0', ROOM_MEMORY_TRIALS_DATA_DIR: dir });
  const event = buildRoomMemoryEvent({ taskText: 'hello', chatId: 'c1' });

  const disabled = appendRoomMemoryEventJsonl(event, { config });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.wrote, false);

  const enabled = appendRoomMemoryEventJsonl(event, { config: { ...config, enabled: true } });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.wrote, true);
  assert.ok(fs.existsSync(enabled.file));
  const rows = fs.readFileSync(enabled.file, 'utf8').trim().split(/\n/g);
  assert.equal(rows.length, 1);
});

test('maybeCaptureRoomMemoryEvent returns event and write status', () => {
  const out = maybeCaptureRoomMemoryEvent({ taskText: 'quick task', chatId: 'room' }, { enabled: false });
  assert.equal(out.event.kind, 'room_memory_event_v1');
  assert.equal(out.result.wrote, false);
});

test('room_memory_trials event captures room package elicitation metadata without raw text', () => {
  const event = buildRoomMemoryEvent({
    taskText: 'do not store this raw request',
    chatId: 'chat-elicitation',
    roomPackageQuestionPlan: {
      kind: 'room_package_question_plan_v1',
      should_ask: true,
      questions: [{ question_type: 'scope_confirmation', question: 'raw user-facing question text should be stripped?' }],
    },
    roomPackageElicitationEvent: {
      kind: 'room_package_elicitation_event_v1',
      question_type: 'scope_confirmation',
      selected: 'current_room',
      freeform_note: 'raw note should be stripped',
    },
  });
  const encoded = JSON.stringify(event);
  assert.equal(event.room_package_elicitation.plan.kind, 'room_package_question_plan_v1');
  assert.equal(event.room_package_elicitation.answer_event.kind, 'room_package_elicitation_event_v1');
  assert.ok(!encoded.includes('do not store this raw request'));
  assert.ok(!encoded.includes('raw user-facing question text'));
  assert.ok(!encoded.includes('raw note should be stripped'));
  assert.deepEqual(validateRoomMemoryEvent(event), { ok: true });
});

test('room_memory_trials event captures learned concierge metadata without raw prompts', () => {
  const event = buildRoomMemoryEvent({
    taskText: 'private raw user question should not leak',
    chatId: 'chat-concierge',
    roomConciergeDecision: {
      kind: 'room_concierge_route_v1',
      route: 'standard_workbench',
      learned_model: {
        applied: true,
        score: {
          model: { version: 'local-v1' },
          ranked: [{ route: 'standard_workbench', probability: 0.88 }],
        },
      },
      prompt: 'raw model prompt should be stripped',
    },
  });
  const encoded = JSON.stringify(event);
  assert.equal(event.room_concierge.decision.route, 'standard_workbench');
  assert.equal(event.room_concierge.decision.learned_model.applied, true);
  assert.ok(!encoded.includes('private raw user question'));
  assert.ok(!encoded.includes('raw model prompt'));
  assert.deepEqual(validateRoomMemoryEvent(event), { ok: true });
});
