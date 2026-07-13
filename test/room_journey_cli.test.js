import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(root, 'scripts', 'run_room_journey_bench.js');
const coreSuite = path.join(root, 'scenarios', 'room_journeys', 'core_suite.json');
const exampleMap = path.join(root, 'scenarios', 'room_journeys', 'staging_room_map.example.json');

function run(args = []) {
  const env = { ...process.env };
  delete env.GOC_BASE_URL;
  delete env.GOC_RUNTIME_TOKEN;
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30000,
  });
}

test('room journey CLI plan mode requires neither GoC nor provider access', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'room-journey-plan-'));
  try {
    const result = run(['--suite', coreSuite, '--out', dir]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'planned');
    assert.equal(summary.run_count, 3);
    assert.equal(summary.results.length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room journey CLI rejects shared Room identities before creating a GoC client', () => {
  const result = run(['--suite', coreSuite, '--execute', '--thread-id', 'same-thread', '--chat-id', 'same-chat']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /share a Room/i);
  assert.doesNotMatch(result.stderr, /GOC_BASE_URL|runtime token/i);
});

test('room journey CLI rejects unedited example placeholders before execution', () => {
  const result = run(['--suite', coreSuite, '--execute', '--room-map', exampleMap]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Replace placeholder Room identity/i);
  assert.doesNotMatch(result.stderr, /GOC_BASE_URL|runtime token/i);
});

test('room journey CLI accepts a unique map far enough to reach GoC configuration', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'room-journey-map-'));
  const mapPath = path.join(dir, 'rooms.json');
  try {
    writeFileSync(mapPath, JSON.stringify({
      'memory_approval_reuse/default': { thread_id: 'thread-a', chat_id: 'chat-a' },
      'unapproved_memory_suppression/default': { thread_id: 'thread-b', chat_id: 'chat-b' },
      'correction_stale_memory/default': { thread_id: 'thread-c', chat_id: 'chat-c' },
    }));
    const result = run(['--suite', coreSuite, '--execute', '--room-map', mapPath]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /share a Room|placeholder Room identity/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
