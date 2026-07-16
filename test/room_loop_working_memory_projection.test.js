import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildLoopRunSpec } from '../src/application/loop_execution_kernel.js';
import { createLoopRun } from '../src/application/loop_run_store.js';
import { createRoomContextSnapshot, formatRoomContextProjectionBlock } from '../src/application/room_context_projection.js';
import { appendRoomLoopEvent, buildRoomLoopStartEvent, normalizeRoomLoop } from '../src/application/room_loop_events.js';

function makeSessionStore() {
  const state = new Map();
  return {
    get: (id) => state.get(id) || {},
    upsert: (id, updater) => { const prev = state.get(id) || {}; const next = updater(prev); state.set(id, next); return next; },
  };
}

test('room projection includes compact loop working memory but not raw loop event log', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-loop-working-projection-'));
  const sessionStore = makeSessionStore();
  try {
    const spec = buildLoopRunSpec({ loopId: 'loop-projection', roomId: 'chat-1', chatId: 'chat-1', objective: 'review implementation', workflowContract: { workflow_kind: 'review_gated_pipeline' } });
    createLoopRun({ jobDir, spec });
    const roomLoop = normalizeRoomLoop({ loop_id: spec.loop_id, chat_id: 'chat-1', objective: spec.objective, topology_id: spec.topology.topology_id, loop_run_ref: `local_memory/loop_runs/${spec.loop_id}/state.json` });
    appendRoomLoopEvent({ jobDir, chatSessionStore: sessionStore, chatId: 'chat-1', event: buildRoomLoopStartEvent({ loop: roomLoop, chatId: 'chat-1', jobId: 'job-1' }) });
    const snapshot = createRoomContextSnapshot({ jobDir, session: sessionStore.get('chat-1'), latestUserText: '계속 진행해', command: '/chat' });
    const text = formatRoomContextProjectionBlock({ snapshot, tier: 'team', maxChars: 6000 });
    assert.match(text, /LOOP WORKING MEMORY — COMPACTED PROMPT SURFACE/);
    assert.match(text, /review implementation/);
    assert.doesNotMatch(text, /events\.jsonl/);
    assert.doesNotMatch(text, /discussion_ledger\.jsonl/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
