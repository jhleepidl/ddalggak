import test from 'node:test';
import assert from 'node:assert/strict';
import { createRoomProviderProgressTracker, projectRoomProviderOutputLine } from '../src/room_runtime/room_provider_progress.js';

test('provider progress projection keeps operational evidence and drops reasoning text', async () => {
  assert.equal(projectRoomProviderOutputLine({ line: 'Thinking: I should inspect the repository' }), null);
  assert.equal(projectRoomProviderOutputLine({ line: 'Running through possible architectural alternatives' }), null);
  assert.equal(projectRoomProviderOutputLine({ line: '<ROOM_STAGE_RESULT>{"summary":"done"}</ROOM_STAGE_RESULT>' }), null);
  assert.deepEqual(projectRoomProviderOutputLine({ line: 'Running npm test', stream: 'stdout' }), { kind: 'validation', message: 'Running npm test' });
  assert.deepEqual(projectRoomProviderOutputLine({ line: 'Executing git status', stream: 'stdout' }), { kind: 'command', message: 'Executing git status' });
  assert.deepEqual(projectRoomProviderOutputLine({ line: 'Updated src/index.js', stream: 'stdout' }), { kind: 'file', message: 'Updated src/index.js' });
});

test('provider progress tracker preserves chunk order and stream statistics', async () => {
  const projected = [];
  const tracker = createRoomProviderProgressTracker({ onProjection: async (row) => projected.push(row) });
  await tracker.observe({ stream: 'stdout', chunk: 'Running npm ', sequence: 1, elapsedMs: 10 });
  await tracker.observe({ stream: 'stdout', chunk: 'test\nUpdated src/app.js\n', sequence: 2, elapsedMs: 20 });
  await tracker.observe({ stream: 'stderr', chunk: 'warning: retrying\n', sequence: 3, elapsedMs: 30 });
  await tracker.flush();
  assert.deepEqual(projected.map((row) => row.kind), ['validation', 'file', 'warning']);
  const summary = tracker.summary();
  assert.equal(summary.chunk_count, 3);
  assert.equal(summary.projected_event_count, 3);
  assert.ok(summary.stdout_chars > 0);
  assert.ok(summary.stderr_chars > 0);
});
