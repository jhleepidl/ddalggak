import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTelegramApprovedRoomMemoryNodePayload,
  deriveTelegramRoomMemorySurfaceSpec,
  syncTelegramApprovedRoomMemoryToGoc,
} from '../src/application/goc_memory_sync.js';

const memoryItem = {
  kind: 'room_memory_item_v1',
  memory_id: 'mem_123',
  type: 'preference',
  title: 'preferred response shape',
  summary: 'User prefers concise Korean implementation summaries with tests listed.',
  content: 'raw should not be needed',
  owner_companion_ids: ['builder'],
  sensitivity: 'medium',
  confidence: 0.9,
  source_candidate_id: 'cand_1',
  source_turn_id: 'turn_1',
  source_quote: 'this quote must not be exported by default',
  review: { approved_at: '2026-07-08T00:00:00.000Z' },
};

test('telegram approved room memory sync payload is summary-only and provenance-rich', () => {
  const surface = deriveTelegramRoomMemorySurfaceSpec({ memoryItem, chatId: 'chat-1' });
  const node = buildTelegramApprovedRoomMemoryNodePayload({ memoryItem, chatId: 'chat-1', userId: 'user-1' });
  assert.equal(surface.surface_id, 'telegram_approved_room_memory');
  assert.equal(surface.policy.raw_transcript_exported, false);
  assert.equal(node.content.memory_id, 'mem_123');
  assert.equal(node.content.summary.includes('concise Korean'), true);
  assert.equal(node.content.raw_transcript_exported, false);
  assert.equal(node.provenance.source, 'telegram_approved_room_memory');
  assert.equal(node.provenance.raw_transcript_exported, false);
  assert.equal(JSON.stringify(node).includes('this quote must not be exported'), false);
});

test('syncTelegramApprovedRoomMemoryToGoc creates surface before upserting node', async () => {
  const calls = [];
  const client = {
    async createMemorySurface(threadId, body) { calls.push(['surface', threadId, body]); return { surface: body }; },
    async createMemoryNode(threadId, body) { calls.push(['node', threadId, body]); return { node: { id: 'node_1' }, upserted: true }; },
  };
  const result = await syncTelegramApprovedRoomMemoryToGoc({ client, threadId: 'thread-1', memoryItem, chatId: 'chat-1', userId: 'user-1' });
  assert.equal(result.synced, true);
  assert.equal(result.upserted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'surface');
  assert.equal(calls[1][0], 'node');
  assert.equal(calls[1][2].content.memory_id, 'mem_123');
});
