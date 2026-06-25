import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendPaper4EventJsonl,
  buildPaper4CaptureConfig,
  buildPaper4RoomEvent,
  maybeCapturePaper4RoomEvent,
  validatePaper4Event,
} from '../src/application/paper4_data_collection.js';

test('paper4 room event hashes ids and excludes raw text', () => {
  const event = buildPaper4RoomEvent({
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
  assert.deepEqual(validatePaper4Event(event), { ok: true });
});

test('paper4 capture is disabled by default and writes only when explicitly enabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paper4-capture-'));
  const config = buildPaper4CaptureConfig({ PAPER4_DATA_COLLECTION_ENABLED: '0', PAPER4_DATA_DIR: dir });
  const event = buildPaper4RoomEvent({ taskText: 'hello', chatId: 'c1' });

  const disabled = appendPaper4EventJsonl(event, { config });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.wrote, false);

  const enabled = appendPaper4EventJsonl(event, { config: { ...config, enabled: true } });
  assert.equal(enabled.ok, true);
  assert.equal(enabled.wrote, true);
  assert.ok(fs.existsSync(enabled.file));
  const rows = fs.readFileSync(enabled.file, 'utf8').trim().split(/\n/g);
  assert.equal(rows.length, 1);
});

test('maybeCapturePaper4RoomEvent returns event and write status', () => {
  const out = maybeCapturePaper4RoomEvent({ taskText: 'quick task', chatId: 'room' }, { enabled: false });
  assert.equal(out.event.kind, 'paper4_room_event_v1');
  assert.equal(out.result.wrote, false);
});
