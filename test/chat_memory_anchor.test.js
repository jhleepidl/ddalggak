import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildChatMemoryAnchorPromptBlock, loadChatMemoryAnchor, updateChatMemoryAnchor } from '../src/application/chat_memory_anchor.js';
import { syncMemoryTopologyToGoc } from '../src/application/goc_memory_topology_sync.js';
import { planMemoryTopology } from '../src/application/memory_topology.js';

function makeJobDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-anchor-'));
  fs.mkdirSync(path.join(dir, 'local_memory'), { recursive: true });
  return dir;
}

test('chat memory anchor preserves same-chat roots across topology transitions', () => {
  const jobDir = makeJobDir();
  const firstTopology = { mode: 'compact_single', stress: { score: 0.4 }, surfaces: [{ id: 'core' }] };
  const first = updateChatMemoryAnchor({ jobDir, jobId: 'job-a', chatId: 'chat-1', threadId: 'thread-1', topology: firstTopology, reason: 'router_context' });
  assert.equal(first.job_id, 'job-a');
  assert.equal(first.stable_roots.rolling_summary, path.join(jobDir, 'local_memory', 'summary.md'));

  const secondTopology = { mode: 'team_scoped', stress: { score: 4.2 }, surfaces: [{ id: 'shared_core' }, { id: 'implementation' }, { id: 'review' }] };
  const second = updateChatMemoryAnchor({ jobDir, jobId: 'job-a', chatId: 'chat-1', threadId: 'thread-1', topology: secondTopology, reason: 'idle_maintenance' });
  assert.equal(second.active_topology_mode, 'team_scoped');
  assert.deepEqual(second.active_surface_ids, ['shared_core', 'implementation', 'review']);
  assert.ok(second.topology_lineage.some((row) => row.mode === 'compact_single'));
  assert.ok(second.topology_lineage.some((row) => row.mode === 'team_scoped'));

  const prompt = buildChatMemoryAnchorPromptBlock(second);
  assert.match(prompt, /CHAT MEMORY ANCHOR/);
  assert.match(prompt, /durable memory root/);
  assert.match(prompt, /non-destructive/);
  assert.equal(loadChatMemoryAnchor({ jobDir }).job_id, 'job-a');
});

test('memory topology sync posts topology with continuity anchor to GoC client', async () => {
  const jobDir = makeJobDir();
  fs.writeFileSync(path.join(jobDir, 'conversation.jsonl'), JSON.stringify({ role: 'user', text: 'hello' }) + '\n');
  const topology = planMemoryTopology({ jobDir, persist: true, eventReason: 'test_sync' });
  const anchor = updateChatMemoryAnchor({ jobDir, jobId: 'job-sync', chatId: 'chat-sync', threadId: 'thread-sync', topology, reason: 'run_end' });
  const calls = [];
  const client = {
    async recordMemoryTopology(threadId, body) {
      calls.push({ threadId, body });
      return { snapshot_id: 'snap-1', topology: { snapshot_id: 'snap-1' } };
    },
  };
  const result = await syncMemoryTopologyToGoc({ client, threadId: 'thread-sync', jobDir, jobId: 'job-sync', runId: 'run-1', topology, anchor });
  assert.equal(result.synced, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].threadId, 'thread-sync');
  assert.equal(calls[0].body.topology.job_id, 'job-sync');
  assert.equal(calls[0].body.topology.chat_memory_anchor.job_id, 'job-sync');
  assert.equal(calls[0].body.topology.continuity.same_chat_memory_anchor, true);
});
