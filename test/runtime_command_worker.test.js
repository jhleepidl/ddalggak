import test from 'node:test';
import assert from 'node:assert/strict';

import { createDefaultRuntimeCommandHandlers, startRuntimeCommandWorker } from '../src/runtime_capabilities/runtime_command_worker.js';

test('default runtime command handlers expose ping and bounded cancel_run', async () => {
  const calls = [];
  const handlers = createDefaultRuntimeCommandHandlers({
    cancelJobExecution(jobId) { calls.push(jobId); return { aborted: true, dropped: 2 }; },
  });
  const ping = await handlers.runtime_ping({ commandId: 'cmd_ping', payload: { value: 1 } });
  assert.equal(ping.ok, true);
  const cancelled = await handlers.cancel_run({ aggregateId: 'job_1', payload: {} });
  assert.deepEqual(calls, ['job_1']);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.dropped, 2);
});

test('runtime command worker remains inert unless explicitly enabled', async () => {
  const worker = startRuntimeCommandWorker({
    client: { async listPendingRuntimeCommands() { throw new Error('must not run'); } },
    pollEnabled: 'false',
  });
  assert.equal(worker.enabled, false);
  const result = await worker.pollOnce();
  assert.equal(result.skipped, true);
});

test('room_command executes only bounded Room continuity commands', async () => {
  const calls = [];
  const handlers = createDefaultRuntimeCommandHandlers({
    async executeRoomCommand(input) {
      calls.push(input);
      return { handled: true, delivery: 'telegram' };
    },
  });

  const result = await handlers.room_command({
    threadId: 'thread_1',
    payload: {
      command: '/correct use the uploaded file as the source of truth',
      chat_id: '-100123',
      user_id: '42',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.delivery, 'telegram');
  assert.equal(result.command, '/correct use the uploaded file as the source of truth');
  assert.deepEqual(calls.map(({ command, chatId, userId, threadId }) => ({ command, chatId, userId, threadId })), [{
    command: '/correct use the uploaded file as the source of truth',
    chatId: '-100123',
    userId: '42',
    threadId: 'thread_1',
  }]);
});

test('room_command rejects unsafe or unrelated Telegram commands', async () => {
  const handlers = createDefaultRuntimeCommandHandlers({
    async executeRoomCommand() { return { handled: true }; },
  });

  await assert.rejects(
    () => handlers.room_command({ threadId: 'thread_1', payload: { command: '/models refresh', chat_id: '123' } }),
    /not allowed/,
  );
  await assert.rejects(
    () => handlers.room_command({ threadId: 'thread_1', payload: { command: '/stop', chat_id: '123' } }),
    /not allowed/,
  );
});

test('room_message accepts bounded plain chat text and rejects commands', async () => {
  const calls = [];
  const handlers = createDefaultRuntimeCommandHandlers({
    async executeRoomMessage(input) {
      calls.push(input);
      return { handled: true, delivery: 'telegram_and_goc', queued: true };
    },
  });

  const result = await handlers.room_message({
    threadId: 'thread_1',
    payload: {
      message: '이전 계획을 이어서 첫 번째 단계만 진행해줘.',
      chat_id: '-100123',
      user_id: '42',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.message_accepted, true);
  assert.equal(result.delivery, 'telegram_and_goc');
  assert.deepEqual(calls.map(({ message, chatId, userId, threadId }) => ({ message, chatId, userId, threadId })), [{
    message: '이전 계획을 이어서 첫 번째 단계만 진행해줘.',
    chatId: '-100123',
    userId: '42',
    threadId: 'thread_1',
  }]);

  await assert.rejects(
    () => handlers.room_message({ threadId: 'thread_1', payload: { message: '/stop', chat_id: '123' } }),
    /plain chat messages/,
  );
});

test('room_command permits explicit memory review and collaboration profile commands for journey evaluation', async () => {
  const seen = [];
  const handlers = createDefaultRuntimeCommandHandlers({
    async executeRoomCommand({ command }) { seen.push(command); return { handled: true }; },
  });
  for (const command of [
    '/memory idle',
    '/memory proposals',
    '/memory approve latest',
    '/memory reject latest temporary condition',
    '/collab use builder_reviewer',
    '/collab reset',
    '/room model-router',
  ]) {
    const result = await handlers.room_command({ threadId: 'thread-1', payload: { command, chat_id: 'chat-1' } });
    assert.equal(result.ok, true);
  }
  assert.deepEqual(seen, [
    '/memory idle',
    '/memory proposals',
    '/memory approve latest',
    '/memory reject latest temporary condition',
    '/collab use builder_reviewer',
    '/collab reset',
    '/room model-router',
  ]);
});
