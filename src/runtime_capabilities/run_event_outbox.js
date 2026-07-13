import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '', maxLen = 500) {
  return String(value || '').trim().slice(0, maxLen);
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonl(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, 'utf8')
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath = '', value = {}) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function clampInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

export class OpenHarnessRunEventOutbox {
  constructor({ jobs = null, client = null, logger = null, autoFlush = true, batchSize = process.env.GOC_RUN_EVENT_BATCH_SIZE } = {}) {
    this.jobs = jobs || null;
    this.client = client || null;
    this.logger = typeof logger === 'function' ? logger : null;
    this.autoFlush = autoFlush !== false;
    this.batchSize = clampInt(batchSize, 50, 1, 200);
    this.flushLocks = new Map();
    this.flushTimers = new Map();
    this.knownEventIds = new Map();
    this.deliveryState = new Map();
  }

  _log(message = '') {
    if (!this.logger) return;
    try { this.logger(String(message || '')); } catch {}
  }

  _jobDir(jobId = '') {
    const cleanJobId = clean(jobId, 160);
    if (!cleanJobId || !this.jobs || typeof this.jobs.jobDir !== 'function') return '';
    return this.jobs.jobDir(cleanJobId);
  }

  outboxPath(jobId = '') {
    const dir = this._jobDir(jobId);
    return dir ? path.join(dir, 'runtime_event_outbox.jsonl') : '';
  }

  deliveryPath(jobId = '') {
    const dir = this._jobDir(jobId);
    return dir ? path.join(dir, 'runtime_event_delivery.jsonl') : '';
  }

  _knownIds(jobId = '') {
    const cleanJobId = clean(jobId, 160);
    if (!this.knownEventIds.has(cleanJobId)) {
      const ids = new Set(readJsonl(this.outboxPath(cleanJobId)).map((entry) => clean(entry.event_id || entry.event?.event_id, 200)).filter(Boolean));
      this.knownEventIds.set(cleanJobId, ids);
    }
    return this.knownEventIds.get(cleanJobId);
  }

  _deliveryState(jobId = '') {
    const cleanJobId = clean(jobId, 160);
    if (!this.deliveryState.has(cleanJobId)) {
      const state = new Map();
      for (const row of readJsonl(this.deliveryPath(cleanJobId))) {
        const eventId = clean(row.event_id, 200);
        if (eventId) state.set(eventId, row);
      }
      this.deliveryState.set(cleanJobId, state);
    }
    return this.deliveryState.get(cleanJobId);
  }

  _recordDelivery(jobId = '', row = {}) {
    appendJsonl(this.deliveryPath(jobId), row);
    const eventId = clean(row.event_id, 200);
    if (eventId) this._deliveryState(jobId).set(eventId, row);
  }

  _scheduleFlush(jobId = '', delayMs = 80) {
    const cleanJobId = clean(jobId, 160);
    if (!this.autoFlush || !this.client || !cleanJobId || this.flushTimers.has(cleanJobId)) return;
    const timer = setTimeout(() => {
      this.flushTimers.delete(cleanJobId);
      void this.flush({ jobId: cleanJobId }).catch(() => {});
    }, Math.max(20, Number(delayMs || 80)));
    if (typeof timer.unref === 'function') timer.unref();
    this.flushTimers.set(cleanJobId, timer);
  }

  enqueue(event = {}, { jobId = '' } = {}) {
    const row = asObject(event);
    const eventId = clean(row.event_id, 200);
    if (!eventId) throw new Error('runtime outbox event_id is required');
    const cleanJobId = clean(jobId, 160);
    const filePath = this.outboxPath(cleanJobId);
    if (!filePath) return row;
    const known = this._knownIds(cleanJobId);
    if (!known.has(eventId)) {
      appendJsonl(filePath, {
        kind: 'openharness_runtime_outbox_entry_v1',
        recorded_at: nowIso(),
        event_id: eventId,
        event_sequence: Number(row.event_sequence || 0),
        event: row,
      });
      known.add(eventId);
    }
    this._scheduleFlush(cleanJobId);
    return row;
  }

  pending(jobId = '', { limit = 100 } = {}) {
    const cleanJobId = clean(jobId, 160);
    const delivery = this._deliveryState(cleanJobId);
    return readJsonl(this.outboxPath(cleanJobId))
      .filter((row) => {
        const eventId = clean(row.event_id || row.event?.event_id, 200);
        return eventId && delivery.get(eventId)?.status !== 'delivered';
      })
      .sort((a, b) => Number(a.event_sequence || a.event?.event_sequence || 0) - Number(b.event_sequence || b.event?.event_sequence || 0))
      .slice(0, Math.max(1, Math.min(Number(limit || 100), 1000)));
  }

  async flush({ jobId = '', limit = 100 } = {}) {
    const cleanJobId = clean(jobId, 160);
    if (!cleanJobId || !this.client || typeof this.client.ingestOpenHarnessRuntimeEvents !== 'function') {
      return { delivered: 0, pending: this.pending(cleanJobId, { limit }).length, skipped: true };
    }
    if (this.flushLocks.has(cleanJobId)) return await this.flushLocks.get(cleanJobId);

    const task = (async () => {
      let delivered = 0;
      let failed = 0;
      const entries = this.pending(cleanJobId, { limit });
      for (let offset = 0; offset < entries.length; offset += this.batchSize) {
        const batch = entries.slice(offset, offset + this.batchSize);
        const events = batch.map((entry) => asObject(entry.event));
        try {
          const result = await this.client.ingestOpenHarnessRuntimeEvents(events);
          const explicitIds = new Set([
            ...(Array.isArray(result?.accepted_event_ids) ? result.accepted_event_ids : []),
            ...(Array.isArray(result?.duplicate_event_ids) ? result.duplicate_event_ids : []),
          ].map((value) => clean(value, 200)).filter(Boolean));
          const confirmedCount = Number(result?.accepted || result?.accepted_count || 0) + Number(result?.duplicates || result?.duplicate_count || 0);
          const assumeWholeBatch = explicitIds.size === 0 && confirmedCount >= batch.length;

          for (const entry of batch) {
            const event = asObject(entry.event);
            const eventId = clean(entry.event_id || event.event_id, 200);
            const previous = this._deliveryState(cleanJobId).get(eventId);
            const attempts = Number(previous?.attempts || 0) + 1;
            const confirmed = assumeWholeBatch || explicitIds.has(eventId);
            this._recordDelivery(cleanJobId, {
              kind: 'openharness_runtime_delivery_v1',
              event_id: eventId,
              event_sequence: Number(event.event_sequence || entry.event_sequence || 0),
              status: confirmed ? 'delivered' : 'retry',
              attempts,
              ...(confirmed ? { delivered_at: nowIso() } : { failed_at: nowIso(), last_error: 'event was not confirmed by batch ingest' }),
              response: {
                accepted: Number(result?.accepted || result?.accepted_count || 0),
                duplicates: Number(result?.duplicates || result?.duplicate_count || 0),
                batch_size: batch.length,
              },
            });
            if (confirmed) delivered += 1;
            else failed += 1;
          }
          if (!assumeWholeBatch && explicitIds.size < batch.length) break;
        } catch (error) {
          for (const entry of batch) {
            const event = asObject(entry.event);
            const eventId = clean(entry.event_id || event.event_id, 200);
            const previous = this._deliveryState(cleanJobId).get(eventId);
            this._recordDelivery(cleanJobId, {
              kind: 'openharness_runtime_delivery_v1',
              event_id: eventId,
              event_sequence: Number(event.event_sequence || entry.event_sequence || 0),
              status: 'retry',
              attempts: Number(previous?.attempts || 0) + 1,
              failed_at: nowIso(),
              last_error: clean(error?.message || error, 800),
            });
          }
          failed += batch.length;
          this._log(`[run-events:outbox] batch delivery failed job=${cleanJobId} size=${batch.length}: ${clean(error?.message || error, 300)}`);
          break;
        }
      }
      const remainingEntries = this.pending(cleanJobId, { limit: 1000 });
      const remaining = remainingEntries.length;
      if (this.autoFlush && remaining > 0) {
        const maxAttempts = remainingEntries.reduce((max, entry) => {
          const eventId = clean(entry.event_id || entry.event?.event_id, 200);
          return Math.max(max, Number(this._deliveryState(cleanJobId).get(eventId)?.attempts || 0));
        }, 0);
        const retryDelay = failed > 0 ? Math.min(30000, 1000 * (2 ** Math.min(maxAttempts, 5))) : 100;
        this._scheduleFlush(cleanJobId, retryDelay);
      }
      return { delivered, failed, pending: remaining, batches: Math.ceil(entries.length / this.batchSize) };
    })();

    this.flushLocks.set(cleanJobId, task);
    try {
      return await task;
    } finally {
      this.flushLocks.delete(cleanJobId);
    }
  }
}
