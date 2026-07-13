import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { ChatSessionStore } from '../src/chat/session.js';
import {
  createHeadlessResponseSink,
  createHeadlessRoomRuntime,
  executeHeadlessRoomCommand,
} from '../src/evaluation/headless_room_runtime.js';

function homeTempDir(prefix) {
  const root = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, prefix));
}

test('headless Room command path persists settings and governed memory without Telegram', async () => {
  const root = homeTempDir('headless-room-runtime-');
  const priorTraceRoot = process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR;
  try {
    const traceRoot = path.join(root, 'trace');
    process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR = traceRoot;
    const store = new ChatSessionStore({ baseDir: root });
    const roomId = 'headless-room-1';
    store.upsert(roomId, {
      recent_room_turns: [{
        role: 'user',
        text: '앞으로 장소를 추천할 때 조용한 곳을 선호해. 이 선호는 기억해도 돼.',
        turn_id: 'turn-user-1',
        ts: new Date().toISOString(),
      }],
      room_journey_trace_enabled: true,
      room_journey_trace_until: '2099-01-01T00:00:00.000Z',
      room_journey_trace_source: 'headless_room_journey_benchmark',
      room_journey_identity: {
        thread_id: 'headless-thread-1',
        chat_id: roomId,
        user_id: 'benchmark-user',
        transport: 'headless',
      },
    });
    const runtimeCore = {
      chatSessionStore: store,
      resolveCurrentJobIdForChat() { return ''; },
      jobs: { jobDir() { return ''; } },
    };
    const sink = createHeadlessResponseSink();
    const invoke = (text) => executeHeadlessRoomCommand({
      runtimeCore,
      sink,
      roomId,
      userId: 'benchmark-user',
      commandText: text,
    });

    assert.equal((await invoke('/rule 결론을 먼저 말하고 근거를 이어서 제시해줘')).ok, true);
    assert.equal((await invoke('/collab use builder_reviewer')).ok, true);
    const structured = await invoke('/memory idle');
    assert.equal(structured.ok, true);
    assert.ok(structured.candidates_created >= 1);
    const approved = await invoke('/memory approve latest benchmark approval');
    assert.equal(approved.ok, true);
    assert.ok(approved.memory_item?.memory_id);

    const reloaded = new ChatSessionStore({ baseDir: root }).get(roomId);
    assert.equal(reloaded.runtime_rules.length, 1);
    assert.equal(reloaded.agent_room_profile.collaboration_profile_id, 'builder_reviewer');
    assert.equal(reloaded.room_idle_memory_candidates[0].status, 'accepted');
    assert.equal(reloaded.room_memory_items.length, 1);
    assert.equal(reloaded.room_memory_items[0].source_candidate_id, reloaded.room_idle_memory_candidates[0].candidate_id);
    assert.equal(reloaded.room_journey_identity.transport, 'headless');
    assert.ok(sink.messages.some((row) => row.method === 'sendMessage'));
  } finally {
    if (priorTraceRoot === undefined) delete process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR;
    else process.env.DDALGGAK_ROOM_JOURNEY_TRACE_DIR = priorTraceRoot;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless runtime module has no Telegram client or Telegram app dependency', () => {
  const file = path.resolve(new URL('../src/evaluation/headless_room_runtime.js', import.meta.url).pathname);
  const source = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(source, /node-telegram-bot-api/);
  assert.doesNotMatch(source, /adapters\/telegram\/app\.js/);
  assert.doesNotMatch(source, /TelegramBot/);
});


test('headless runtime bootstraps the production Room execution core without Telegram polling', async () => {
  const root = homeTempDir('headless-room-bootstrap-');
  try {
    const runtime = await createHeadlessRoomRuntime({
      runtimeRoot: root,
      traceRoot: path.join(root, 'trace'),
    });
    assert.equal(runtime.telegramConnected, false);
    assert.equal(runtime.transport, 'headless');
    assert.equal(typeof runtime.chatRunManager.handleIncoming, 'function');
    assert.equal(typeof runtime.runtimeCore.runSupervisorChat, 'function');

    const result = await runtime.handleRoomCommand({
      chatId: 'bootstrap-room',
      userId: 'benchmark-user',
      text: '/collab use solo',
    });
    assert.equal(result.ok, true);
    assert.equal(runtime.runtimeCore.chatSessionStore.get('bootstrap-room').agent_room_profile.collaboration_profile_id, 'solo');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
