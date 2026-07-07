import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildRoomDocumentMocPack } from '../src/application/room_markdown_moc.js';
import { appendRoomActionNoteFromEvent, buildMaterializedRoomDocsInvalidation, materializeRoomDocumentMocPack } from '../src/application/room_markdown_store.js';

test('room docs materialization writes MOC files and invalidation turns stale after later event', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-room-docs-'));
  const chatId = 'chat-docs-store';
  const events = [
    { ts: '2026-07-05T01:00:00.000Z', chat_id: chatId, event_type: 'room_applied', command: '/room apply', goal: '논문 구현 방', room: { domain_label: 'research', package_id: 'research_paper_factory' } },
  ];
  const pack = buildRoomDocumentMocPack({ profile: { name: 'Paper Room', default_agents: ['researcher'] }, events, now: '2026-07-05T01:01:00.000Z' });
  const result = materializeRoomDocumentMocPack({ chatId, pack, events, rootDir });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(path.join(result.root, 'AGENTS.md')));
  assert.ok(fs.existsSync(path.join(result.root, 'moc-by-date.md')));
  assert.ok(fs.existsSync(path.join(result.root, 'moc-manifest.json')));

  const laterTs = new Date(new Date(result.manifest.materialized_at).getTime() + 60000).toISOString();
  const laterEvents = [...events, { ts: laterTs, chat_id: chatId, event_type: 'room_topology_dataset_exported', command: '/room topology export', goal: 'export traces' }];
  const stale = buildMaterializedRoomDocsInvalidation({ chatId, pack, events: laterEvents, rootDir });
  assert.equal(stale.status, 'stale');
  assert.ok(stale.stale_views.includes('moc-by-date.md'));
});

test('action notes are appended for loop and room setting events without raw transcript', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-room-action-'));
  const chatId = 'chat-action';
  const file = appendRoomActionNoteFromEvent({ chatId, rootDir, event: { ts: '2026-07-05T03:00:00.000Z', chat_id: chatId, event_type: 'work_depth_used', command: '/loop', goal: '테스트하고 패치해줘', extra: { depth: 'loop', max_iterations: 3 } } });
  assert.ok(file);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /raw transcript copied: false/);
  assert.match(text, /max_iterations: 3/);
});
