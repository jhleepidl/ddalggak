import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildGocMemoryDemandPayload, syncMemoryDemandToGoc } from '../src/application/goc_memory_demand_sync.js';

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

test('buildGocMemoryDemandPayload normalizes router plan and matching metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-demand-sync-'));
  try {
    writeJsonl(path.join(tempDir, 'local_memory', 'memory_demand_events.jsonl'), [{
      query: 'continue implementation',
      demand_reasons: ['continuity_reference'],
      router_memory_plan: { classifier: 'supervisor_router_llm', confidence: 0.75, source_types: ['turns'], surface_ids: ['shared_core'] },
      sources: ['local_memory/turns.jsonl'],
      item_count: 2,
    }]);
    const payload = buildGocMemoryDemandPayload({ jobDir: tempDir, runId: 'run-1', source: 'test' });
    assert.equal(payload.run_id, 'run-1');
    assert.equal(payload.events.length, 1);
    assert.equal(payload.events[0].classifier, 'supervisor_router_llm');
    assert.deepEqual(payload.events[0].source_types, ['turns']);
    assert.deepEqual(payload.events[0].surface_ids, ['shared_core']);
    assert.equal(payload.events[0].matching.strategy, 'supervisor_router_llm');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('syncMemoryDemandToGoc posts normalized events through the client', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-demand-post-'));
  try {
    writeJsonl(path.join(tempDir, 'local_memory', 'memory_demand_events.jsonl'), [{
      query: 'uploaded file 기준으로 수정',
      demand_reasons: ['artifact_reference'],
      sources: ['workspace/uploads/manifest.jsonl'],
      item_count: 1,
    }]);
    const calls = [];
    const client = {
      async recordMemoryDemand(threadId, body) {
        calls.push({ threadId, body });
        return { ok: true, event_count: body.events.length };
      },
    };
    const result = await syncMemoryDemandToGoc({ client, threadId: 'thread-1', jobDir: tempDir, runId: 'run-2' });
    assert.equal(result.synced, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].threadId, 'thread-1');
    assert.equal(calls[0].body.run_id, 'run-2');
    assert.equal(calls[0].body.events[0].reason, 'context_preflight');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
