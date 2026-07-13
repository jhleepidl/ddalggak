import { RuntimeCommandProcessor } from './runtime_command_processor.js';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeSafeRoomCommand(value = '') {
  const command = String(value || '').trim();
  if (!command.startsWith('/')) throw new Error('room_command requires a Telegram command');
  const safeExact = new Set([
    '/brief',
    '/continue',
    '/sources',
    '/rules',
    '/context project-only',
    '/context clean-slate',
    '/context reset',
    '/memory idle',
    '/memory proposals',
    '/collab reset',
    '/room model-router',
  ]);
  const safePrefixes = [
    '/correct ',
    '/rule ',
    '/context exclude ',
    '/branch ',
    '/memory approve ',
    '/memory reject ',
    '/collab use ',
  ];
  if (!safeExact.has(command) && !safePrefixes.some((prefix) => command.startsWith(prefix))) {
    throw new Error(`room_command is not allowed: ${command.split(/\s+/)[0]}`);
  }
  return command;
}

export function createDefaultRuntimeCommandHandlers({ cancelJobExecution = null, executeRoomCommand = null, executeRoomMessage = null } = {}) {
  return {
    runtime_ping: async ({ commandId, payload }) => ({
      ok: true,
      command_id: commandId,
      echo: payload,
      handled_at: new Date().toISOString(),
    }),
    cancel_run: async ({ aggregateId, payload }) => {
      if (typeof cancelJobExecution !== 'function') {
        throw new Error('cancel_run handler is unavailable');
      }
      const jobId = String(payload?.job_id || payload?.jobId || aggregateId || '').trim();
      if (!jobId) throw new Error('cancel_run requires payload.job_id or aggregate_id');
      const result = cancelJobExecution(jobId) || {};
      return {
        job_id: jobId,
        cancelled: Boolean(result.aborted || result.dropped),
        aborted: Boolean(result.aborted),
        dropped: Number(result.dropped || 0),
      };
    },
    room_command: async ({ threadId, payload }) => {
      if (typeof executeRoomCommand !== 'function') {
        throw new Error('room_command handler is unavailable');
      }
      const command = normalizeSafeRoomCommand(payload?.command);
      const chatId = String(payload?.chat_id || payload?.chatId || '').trim();
      const userId = String(payload?.user_id || payload?.userId || chatId).trim();
      if (!chatId) throw new Error('room_command requires payload.chat_id');
      const handled = await executeRoomCommand({ command, chatId, userId, threadId, payload });
      if (handled !== true && handled?.handled !== true) throw new Error('room_command was not handled');
      return {
        ok: true,
        command,
        thread_id: threadId,
        chat_id: chatId,
        handled_at: new Date().toISOString(),
        ...(handled && typeof handled === 'object' ? handled : {}),
      };
    },
    room_message: async ({ threadId, payload }) => {
      if (typeof executeRoomMessage !== 'function') {
        throw new Error('room_message handler is unavailable');
      }
      const message = String(payload?.message || payload?.text || '').trim();
      if (!message) throw new Error('room_message requires payload.message');
      if (message.startsWith('/')) throw new Error('room_message only accepts plain chat messages');
      if (message.length > 12000) throw new Error('room_message exceeds 12000 characters');
      const chatId = String(payload?.chat_id || payload?.chatId || '').trim();
      const userId = String(payload?.user_id || payload?.userId || chatId).trim();
      if (!chatId) throw new Error('room_message requires payload.chat_id');
      const handled = await executeRoomMessage({ message, chatId, userId, threadId, payload });
      if (handled !== true && handled?.handled !== true) throw new Error('room_message was not handled');
      return {
        ok: true,
        message_accepted: true,
        thread_id: threadId,
        chat_id: chatId,
        handled_at: new Date().toISOString(),
        ...(handled && typeof handled === 'object' ? handled : {}),
      };
    },
  };
}

export function startRuntimeCommandWorker({
  client = null,
  handlers = {},
  workerId = '',
  logger = console,
  pollEnabled = process.env.GOC_RUNTIME_COMMAND_POLL_ENABLED,
  intervalMs = process.env.GOC_RUNTIME_COMMAND_POLL_INTERVAL_MS,
  maxIntervalMs = process.env.GOC_RUNTIME_COMMAND_POLL_MAX_INTERVAL_MS,
  errorIntervalMs = process.env.GOC_RUNTIME_COMMAND_POLL_ERROR_INTERVAL_MS,
  limit = process.env.GOC_RUNTIME_COMMAND_POLL_LIMIT,
} = {}) {
  const active = enabled(pollEnabled) && client && typeof client.listPendingRuntimeCommands === 'function';
  const log = (message) => {
    try {
      if (logger && typeof logger.log === 'function') logger.log(message);
      else if (typeof logger === 'function') logger(message);
    } catch {}
  };
  if (!active) {
    return { enabled: false, stop() {}, async pollOnce() { return { processed: 0, skipped: true, results: [] }; } };
  }

  const processor = new RuntimeCommandProcessor({
    client,
    workerId,
    handlers,
    logger: log,
  });
  const baseDelay = clampInt(intervalMs, 1500, 500, 300000);
  const maxDelay = clampInt(maxIntervalMs, 5000, baseDelay, 300000);
  const maxErrorDelay = clampInt(errorIntervalMs, 30000, maxDelay, 600000);
  const pollLimit = clampInt(limit, 20, 1, 200);
  let stopped = false;
  let timer = null;
  let running = false;

  const pollOnce = async () => {
    if (stopped || running) return { processed: 0, skipped: true, reason: stopped ? 'stopped' : 'poll_in_progress', results: [] };
    running = true;
    try {
      return await processor.pollOnce({ limit: pollLimit });
    } catch (error) {
      log(`[runtime-command] poll failed: ${String(error?.message || error).slice(0, 500)}`);
      return { processed: 0, failed: true, error: String(error?.message || error), results: [] };
    } finally {
      running = false;
    }
  };

  let currentDelay = baseDelay;
  const jittered = (value) => Math.max(250, Math.round(value * (0.9 + Math.random() * 0.2)));
  const schedule = (delay = currentDelay) => {
    if (stopped) return;
    timer = setTimeout(async () => {
      const result = await pollOnce();
      if (result?.failed) {
        currentDelay = Math.min(maxErrorDelay, Math.max(maxDelay, currentDelay * 2));
      } else if (Number(result?.processed || 0) > 0) {
        currentDelay = baseDelay;
      } else {
        currentDelay = Math.min(maxDelay, Math.max(baseDelay, Math.round(currentDelay * 1.5)));
      }
      schedule(jittered(currentDelay));
    }, jittered(delay));
    if (typeof timer.unref === 'function') timer.unref();
  };

  void pollOnce().then((result) => {
    currentDelay = Number(result?.processed || 0) > 0 ? baseDelay : Math.min(maxDelay, Math.round(baseDelay * 1.5));
  }).catch(() => {});
  schedule(baseDelay);
  log(`[runtime-command] worker enabled id=${processor.workerId} interval_ms=${baseDelay}-${maxDelay} error_max_ms=${maxErrorDelay} limit=${pollLimit}`);
  return {
    enabled: true,
    processor,
    pollOnce,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
