import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramCommandHandler } from '../src/adapters/telegram/commands.js';

function harness() {
  const messages = [];
  const starts = [];
  const service = {
    isEnabled: () => true,
    startRun: async (args) => {
      starts.push(args);
      return {
        room: { roomId: args.roomId, workspaceRoot: '/rooms/test/workspace' },
        run_id: 'run-1',
        spec: { execution_graph: { topology_id: 'review_loop' } },
        completion: Promise.resolve({ ok: true, finalStage: { structured: { user_message: 'done' } } }),
      };
    },
    initializeRoom: (roomId) => ({ roomId, workspaceRoot: '/rooms/test/workspace' }),
    status: (roomId) => ({ room_id: roomId, workspace_root: '/rooms/test/workspace', active_run_id: null, recent_runs: [] }),
    setVisibility: (_roomId, value) => value,
    timeline: (roomId, { limit } = {}) => ({ room_id: roomId, run_id: 'run-1', status: 'running', objective: 'improve', events: [{ event_type: 'stage_output', stage_id: 'implement', message: `Running tests (${limit})` }] }),
    control: () => ({ ok: true, status: 'paused' }),
    resumeRun: async () => ({ run_id: 'run-1', completion: Promise.resolve({ ok: true, finalStage: { structured: { user_message: '' } } }) }),
  };
  const bot = { sendMessage: async (_chatId, text) => { messages.push(String(text)); return { message_id: messages.length }; } };
  const handler = createTelegramCommandHandler({
    bot,
    sendLong: async (_bot, _chatId, text) => { messages.push(String(text)); },
    runtimeEnv: { ROOM_EXECUTION_ENGINE: 'room_native_v2' },
    roomNativeService: service,
    chatSessionStore: { get: () => ({}), upsert: () => {} },
  });
  return { handler, messages, starts, service };
}

test('/loop is a compatibility alias for Room-native execution', async () => {
  const h = harness();
  const handled = await h.handler({ msg: {}, text: '/loop improve this workspace', chatId: '42', userId: '7' });
  assert.equal(handled, true);
  assert.equal(h.starts.length, 1);
  assert.equal(h.starts[0].roomId, 'telegram-42');
  assert.equal(h.starts[0].objective, 'improve this workspace');
  assert.ok(h.messages.some((text) => text.includes('기존 workbench job workspace는 사용하지 않습니다')));
});

test('/room workspace exposes only the canonical Room workspace', async () => {
  const h = harness();
  const handled = await h.handler({ msg: {}, text: '/room workspace', chatId: '42', userId: '7' });
  assert.equal(handled, true);
  assert.ok(h.messages.some((text) => text.includes('/rooms/test/workspace')));
  assert.ok(h.messages.some((text) => text.includes('ddalggak control-plane source')));
});


test('/room timeline exposes projected provider activity without raw output dumps', async () => {
  const h = harness();
  const handled = await h.handler({ msg: {}, text: '/room timeline 10', chatId: '42', userId: '7' });
  assert.equal(handled, true);
  assert.ok(h.messages.some((text) => text.includes('Room timeline')));
  assert.ok(h.messages.some((text) => text.includes('Running tests (10)')));
});

test('successful Room completion is delivered once with the final answer', async () => {
  const h = harness();
  h.service.startRun = async (args) => {
    h.starts.push(args);
    await args.onProgress?.({ event: 'run_completed', run_id: 'run-1', status: 'completed', message: 'done' });
    return {
      room: { roomId: args.roomId, workspaceRoot: '/rooms/test/workspace' },
      run_id: 'run-1',
      spec: { execution_graph: { topology_id: 'review_loop' } },
      completion: Promise.resolve({
        ok: true,
        needs_attention: false,
        run: { paths: { runId: 'run-1' } },
        finalStage: { structured: { user_message: 'done' } },
      }),
    };
  };
  const handled = await h.handler({ msg: {}, text: '/room run improve this workspace', chatId: '42', userId: '7' });
  assert.equal(handled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.messages.filter((text) => text.includes('✅ Room 실행 완료')).length, 1);
  assert.equal(h.messages.filter((text) => text.trim() === 'done').length, 0);
  assert.equal(h.messages.filter((text) => text.includes('\ndone')).length, 1);
});
