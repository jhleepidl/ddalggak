import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const script = path.join(root, 'scripts', 'run_room_journey_bench.js');
const coreSuite = path.join(root, 'scenarios', 'room_journeys', 'core_suite.json');
const portfolioSuite = path.join(root, 'scenarios', 'room_journeys', 'model_portfolio_suite.json');
const exampleMap = path.join(root, 'scenarios', 'room_journeys', 'staging_room_map.example.json');
const testTmpRoot = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
mkdirSync(testTmpRoot, { recursive: true });

function makeTestTempDir(prefix) {
  return mkdtempSync(path.join(testTmpRoot, prefix));
}

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
  const dir = makeTestTempDir('room-journey-plan-');
  try {
    const result = run(['--suite', coreSuite, '--out', dir]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.status, 'planned');
    assert.equal(summary.run_count, 4);
    assert.equal(summary.results.length, 4);
    assert.equal(summary.execution_environment.telegram_required, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room journey CLI rejects shared Room identities before creating a GoC client', () => {
  const result = run(['--transport', 'goc', '--suite', coreSuite, '--execute', '--thread-id', 'same-thread', '--chat-id', 'same-chat']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /share a Room/i);
  assert.doesNotMatch(result.stderr, /GOC_BASE_URL|runtime token/i);
});

test('room journey CLI rejects unedited example placeholders before execution', () => {
  const result = run(['--transport', 'goc', '--suite', coreSuite, '--execute', '--room-map', exampleMap]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Replace placeholder Room identity/i);
  assert.doesNotMatch(result.stderr, /GOC_BASE_URL|runtime token/i);
});

test('room journey CLI accepts a unique map far enough to reach GoC configuration', () => {
  const dir = makeTestTempDir('room-journey-map-');
  const mapPath = path.join(dir, 'rooms.json');
  try {
    writeFileSync(mapPath, JSON.stringify({
      'room_settings_multiturn_cli/default': { thread_id: 'thread-a', chat_id: 'chat-a' },
      'memory_approval_reuse/default': { thread_id: 'thread-b', chat_id: 'chat-b' },
      'unapproved_memory_suppression/default': { thread_id: 'thread-c', chat_id: 'chat-c' },
      'correction_stale_memory/default': { thread_id: 'thread-d', chat_id: 'chat-d' },
    }));
    const result = run(['--transport', 'goc', '--suite', coreSuite, '--execute', '--room-map', mapPath]);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /share a Room|placeholder Room identity/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});


test('room journey CLI accepts a model-role map in headless plan mode and records the normalized assignment', () => {
  const dir = makeTestTempDir('room-journey-role-map-');
  const mapPath = path.join(dir, 'model-role-map.json');
  const out = path.join(dir, 'out');
  try {
    writeFileSync(mapPath, JSON.stringify({
      source_grounder: { provider: 'claude', model: 'claude-source-test' },
      verifier_critic: { provider: 'codex', model: 'codex-review-test' },
    }));
    const result = run(['--suite', coreSuite, '--model-role-map', mapPath, '--out', out]);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.equal(summary.execution_environment.model_role_map.assignments.source_grounder.provider, 'claude');
    assert.equal(summary.execution_environment.model_role_map.assignments.verifier_critic.model, 'codex-review-test');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('room journey CLI rejects unsupported model roles before provider execution', () => {
  const dir = makeTestTempDir('room-journey-bad-role-map-');
  const mapPath = path.join(dir, 'model-role-map.json');
  try {
    writeFileSync(mapPath, JSON.stringify({ scenario_specific_router: { provider: 'codex' } }));
    const result = run(['--suite', coreSuite, '--execute', '--model-role-map', mapPath, '--out', path.join(dir, 'out')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported model role/i);
    assert.doesNotMatch(result.stderr, /run\.agent_start|provider CLI/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('portfolio execution requires an explicit model-role map before provider execution', () => {
  const dir = makeTestTempDir('room-journey-required-role-map-');
  try {
    const result = run(['--suite', portfolioSuite, '--execute', '--out', path.join(dir, 'out')]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires --model-role-map/i);
    assert.doesNotMatch(result.stderr, /run\.agent_start|provider CLI/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
