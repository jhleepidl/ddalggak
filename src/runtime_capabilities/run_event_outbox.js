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

export class OpenHarnessRunEventOutbox {
  constructor({ jobs = null, client = null, logger = null, autoFlush = true } = {}) {
    this.jobs = jobs || null;
    this.client = client || null;
    this.logger = typeof logger === 'function' ? logger : null;
    this.autoFlush = autoFlush !== false;
    this.flushLocks = new Map();
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

  enqueue(event = {}, { jobId = '' } = {}) {
    const row = asObject(event);
    const eventId = clean(row.event_id, 200);
    if (!eventId) throw new Error('runtime outbox event_id is required');
    const filePath = this.outboxPath(jobId);
    if (!filePath) return row;
    const existing = readJsonl(filePath).some((entry) => clean(entry.event_id || entry.event?.event_id, 200) === eventId);
    if (!existing) {
      appendJsonl(filePath, {
        kind: 'openharness_runtime_outbox_entry_v1',
        recorded_at: nowIso(),
        event_id: eventId,
        event_sequence: Number(row.event_sequence || 0),
        event: row,
      });
    }
    if (this.autoFlush && this.client) {
      void this.flush({ jobId }).catch(() => {});
    }
    return row;
  }

  _deliveryState(jobId = '') {
    const state = new Map();
    for (const row of readJsonl(this.deliveryPath(jobId))) {
      const eventId = clean(row.event_id, 200);
      if (!eventId) continue;
      state.set(eventId, row);
    }
    return state;
  }

  pending(jobId = '', { limit = 100 } = {}) {
    const delivery = this._deliveryState(jobId);
    return readJsonl(this.outboxPath(jobId))
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
      for (const entry of this.pending(cleanJobId, { limit })) {
        const event = asObject(entry.event);
        const eventId = clean(entry.event_id || event.event_id, 200);
        const previous = this._deliveryState(cleanJobId).get(eventId);
        const attempts = Number(previous?.attempts || 0) + 1;
        try {
          const result = await this.client.ingestOpenHarnessRuntimeEvents([event]);
          appendJsonl(this.deliveryPath(cleanJobId), {
            kind: 'openharness_runtime_delivery_v1',
            event_id: eventId,
            event_sequence: Number(event.event_sequence || entry.event_sequence || 0),
            status: 'delivered',
            attempts,
            delivered_at: nowIso(),
            response: {
              accepted: Number(result?.accepted || result?.accepted_count || 0),
              duplicates: Number(result?.duplicates || result?.duplicate_count || 0),
            },
          });
          delivered += 1;
        } catch (error) {
          appendJsonl(this.deliveryPath(cleanJobId), {
            kind: 'openharness_runtime_delivery_v1',
            event_id: eventId,
            event_sequence: Number(event.event_sequence || entry.event_sequence || 0),
            status: 'retry',
            attempts,
            failed_at: nowIso(),
            last_error: clean(error?.message || error, 800),
          });
          failed += 1;
          this._log(`[run-events:outbox] delivery failed job=${cleanJobId} event=${eventId}: ${clean(error?.message || error, 300)}`);
          break;
        }
      }
      return { delivered, failed, pending: this.pending(cleanJobId, { limit: 1000 }).length };
    })();
    this.flushLocks.set(cleanJobId, task);
    try {
      return await task;
    } finally {
      this.flushLocks.delete(cleanJobId);
    }
  }
}
