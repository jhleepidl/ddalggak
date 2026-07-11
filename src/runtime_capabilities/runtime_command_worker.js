import { RuntimeCommandProcessor } from './runtime_command_processor.js';

function enabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function clampInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

export function createDefaultRuntimeCommandHandlers({ cancelJobExecution = null } = {}) {
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
  };
}

export function startRuntimeCommandWorker({
  client = null,
  handlers = {},
  workerId = '',
  logger = console,
  pollEnabled = process.env.GOC_RUNTIME_COMMAND_POLL_ENABLED,
  intervalMs = process.env.GOC_RUNTIME_COMMAND_POLL_INTERVAL_MS,
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
  const delay = clampInt(intervalMs, 5000, 1000, 300000);
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

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await pollOnce();
      schedule();
    }, delay);
    if (typeof timer.unref === 'function') timer.unref();
  };

  void pollOnce();
  schedule();
  log(`[runtime-command] worker enabled id=${processor.workerId} interval_ms=${delay} limit=${pollLimit}`);
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
