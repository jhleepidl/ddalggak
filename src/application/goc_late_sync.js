import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function asBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const key = String(value ?? '').trim().toLowerCase();
  if (!key) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(key)) return true;
  if (['0', 'false', 'no', 'off'].includes(key)) return false;
  return fallback;
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(process.env[name]);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function cleanText(value = '') {
  return String(value || '').trim();
}

function safeJson(value, fallback = null) {
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function ensureLocalMemoryDir(jobs, jobId = '') {
  const dir = path.join(jobs.jobDir(jobId), 'local_memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function gocLateSyncMode() {
  const raw = String(process.env.GOC_SYNC_MODE || '').trim().toLowerCase();
  if (['immediate', 'sync', 'inline'].includes(raw)) return 'immediate';
  if (['off', 'disabled', 'none'].includes(raw)) return 'off';
  return 'late';
}

export function isGocLateSyncEnabled() {
  if (gocLateSyncMode() === 'off') return false;
  return asBool(process.env.GOC_LATE_SYNC_ENABLED, true);
}

export function gocLateSyncPaths(jobs, jobId = '') {
  const dir = ensureLocalMemoryDir(jobs, jobId);
  return {
    dir,
    queuePath: path.join(dir, 'goc_late_sync_queue.jsonl'),
    statePath: path.join(dir, 'goc_late_sync_state.json'),
  };
}

function readQueueRows(queuePath = '') {
  if (!queuePath || !fs.existsSync(queuePath)) return [];
  return String(fs.readFileSync(queuePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => safeJson(line))
    .filter((row) => row && typeof row === 'object');
}

function writeQueueRows(queuePath = '', rows = []) {
  const tmp = `${queuePath}.tmp`;
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
  fs.writeFileSync(tmp, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, queuePath);
}

function writeState(statePath = '', patch = {}) {
  if (!statePath) return;
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
  const next = { ...prev, ...patch, updated_at: new Date().toISOString() };
  try { fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n', 'utf8'); } catch {}
}

export function enqueueGocLateSync({ jobs, jobId = '', kind = '', payload = {}, priority = 'normal', reason = '' } = {}) {
  const cleanJobId = cleanText(jobId);
  const cleanKind = cleanText(kind);
  if (!jobs || !cleanJobId || !cleanKind || !isGocLateSyncEnabled()) {
    return { queued: false, reason: 'disabled_or_invalid' };
  }
  const { queuePath, statePath } = gocLateSyncPaths(jobs, cleanJobId);
  const row = {
    id: `gocls_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
    ts: new Date().toISOString(),
    job_id: cleanJobId,
    kind: cleanKind,
    priority: cleanText(priority) || 'normal',
    reason: cleanText(reason) || undefined,
    attempts: 0,
    payload: payload && typeof payload === 'object' ? payload : {},
  };
  fs.appendFileSync(queuePath, `${JSON.stringify(row)}\n`, 'utf8');
  writeState(statePath, { last_enqueue_at: row.ts, last_enqueue_kind: cleanKind });
  return { queued: true, id: row.id, queuePath };
}

const flushTimers = new Map();

export function scheduleGocLateSyncFlush({ jobs, jobId = '', flush, delayMs = null, logger = null } = {}) {
  const cleanJobId = cleanText(jobId);
  if (!jobs || !cleanJobId || typeof flush !== 'function' || !isGocLateSyncEnabled()) return false;
  const waitMs = Number.isFinite(Number(delayMs))
    ? Math.max(0, Math.floor(Number(delayMs)))
    : intEnv('GOC_LATE_SYNC_DEBOUNCE_MS', 3000, { min: 0, max: 600000 });
  if (flushTimers.has(cleanJobId)) return true;
  const timer = setTimeout(async () => {
    flushTimers.delete(cleanJobId);
    try { await flush(); }
    catch (error) {
      try { logger?.(`[goc-late-sync] flush failed: ${String(error?.message || error || 'unknown')}`); } catch {}
    }
  }, waitMs);
  try { timer.unref?.(); } catch {}
  flushTimers.set(cleanJobId, timer);
  return true;
}

export function readGocLateSyncQueue(jobs, jobId = '') {
  try {
    const { queuePath } = gocLateSyncPaths(jobs, jobId);
    return readQueueRows(queuePath);
  } catch {
    return [];
  }
}

export async function flushGocLateSyncQueue({
  jobs,
  jobId = '',
  maxBatch = null,
  handler,
  logger = null,
} = {}) {
  const cleanJobId = cleanText(jobId);
  if (!jobs || !cleanJobId || typeof handler !== 'function') return { ok: false, processed: 0, failed: 0, remaining: 0 };
  const { queuePath, statePath } = gocLateSyncPaths(jobs, cleanJobId);
  const rows = readQueueRows(queuePath);
  if (!rows.length) {
    writeState(statePath, { last_flush_at: new Date().toISOString(), last_flush_processed: 0, last_flush_failed: 0, queue_remaining: 0 });
    return { ok: true, processed: 0, failed: 0, remaining: 0 };
  }
  const limit = Number.isFinite(Number(maxBatch))
    ? Math.max(1, Math.floor(Number(maxBatch)))
    : intEnv('GOC_LATE_SYNC_MAX_BATCH', 50, { min: 1, max: 500 });
  const batch = rows.slice(0, limit);
  const rest = rows.slice(limit);
  const keep = [];
  let processed = 0;
  let failed = 0;
  const now = new Date().toISOString();
  for (const row of batch) {
    try {
      await handler(row);
      processed += 1;
    } catch (error) {
      failed += 1;
      const nextAttempts = Math.floor(Number(row?.attempts) || 0) + 1;
      const maxAttempts = intEnv('GOC_LATE_SYNC_MAX_ATTEMPTS', 5, { min: 1, max: 50 });
      if (nextAttempts < maxAttempts) {
        keep.push({
          ...row,
          attempts: nextAttempts,
          last_error: String(error?.message || error || 'unknown').slice(0, 500),
          last_failed_at: now,
        });
      } else {
        try { logger?.(`[goc-late-sync] dropping ${row?.kind || 'event'} after ${nextAttempts} attempts: ${String(error?.message || error || 'unknown')}`); } catch {}
      }
    }
  }
  const remaining = keep.concat(rest);
  writeQueueRows(queuePath, remaining);
  writeState(statePath, {
    last_flush_at: now,
    last_flush_processed: processed,
    last_flush_failed: failed,
    queue_remaining: remaining.length,
  });
  return { ok: failed === 0, processed, failed, remaining: remaining.length };
}
