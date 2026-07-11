import fs from "node:fs";
import path from "node:path";
import { buildRunTraceRecord } from "../shared/openharness_contracts.js";
import { isHarnessTimelineEnabled } from "../application/harness_runtime_behavior.js";
import { OpenHarnessRunEventOutbox } from './run_event_outbox.js';

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

function normalizeJobId(jobId = "") {
  return String(jobId || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function appendJsonl(filePath = "", record = {}) {
  if (!filePath) return;
  const row = {
    ts: nowIso(),
    ...asObject(record),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, "utf8");
}

function safeError(error) {
  return String(error?.message ?? error ?? '').trim();
}

export class LocalRunEventSink {
  constructor({
    jobs = null,
    logger = null,
    runtimePolicy = null,
    gocClient = null,
    outbox = null,
    outboxEnabled = null,
  } = {}) {
    this.source = "local";
    this.jobs = jobs || null;
    this.logger = normalizeLogger(logger);
    this.runIdsByJob = new Map();
    this.sequenceByJob = new Map();
    this.runtimePolicy = runtimePolicy || null;
    const enabledByEnv = ['1', 'true', 'yes', 'on'].includes(String(process.env.GOC_RUN_EVENT_OUTBOX_ENABLED || '').trim().toLowerCase());
    this.outboxEnabled = typeof outboxEnabled === 'boolean' ? outboxEnabled : (!!gocClient || enabledByEnv);
    this.outbox = outbox || (this.outboxEnabled
      ? new OpenHarnessRunEventOutbox({ jobs, client: gocClient, logger: this.logger })
      : null);
  }

  _timelineEnabled() {
    return isHarnessTimelineEnabled(this.runtimePolicy);
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  _eventFile(jobId = "") {
    const cleanJobId = normalizeJobId(jobId);
    if (!cleanJobId || !this.jobs || typeof this.jobs.jobDir !== "function") return "";
    return path.join(this.jobs.jobDir(cleanJobId), "runtime_events.jsonl");
  }

  _lastPersistedSequence(jobId = '') {
    const filePath = this._eventFile(jobId);
    if (!filePath || !fs.existsSync(filePath)) return 0;
    try {
      const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/g).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
          const row = JSON.parse(lines[index]);
          const sequence = Number(row?.event_sequence || 0);
          if (Number.isFinite(sequence) && sequence > 0) return Math.floor(sequence);
        } catch {}
      }
    } catch {}
    return 0;
  }

  _nextSequence(jobId = '') {
    const cleanJobId = normalizeJobId(jobId) || '_global';
    if (!this.sequenceByJob.has(cleanJobId)) {
      this.sequenceByJob.set(cleanJobId, this._lastPersistedSequence(jobId));
    }
    const next = Number(this.sequenceByJob.get(cleanJobId) || 0) + 1;
    this.sequenceByJob.set(cleanJobId, next);
    return next;
  }

  record(eventType = "", payload = {}, { jobId = "", commandId = '', causationId = '' } = {}) {
    if (!this._timelineEnabled()) return null;
    const cleanType = String(eventType || "").trim();
    if (!cleanType) return null;
    const cleanJobId = normalizeJobId(jobId);
    const normalizedPayload = asObject(payload);
    const explicitRunId = String(normalizedPayload.run_id || normalizedPayload.runId || "").trim();
    if (cleanJobId && explicitRunId) {
      this.runIdsByJob.set(cleanJobId, explicitRunId);
    }
    const runId = explicitRunId || this.runIdsByJob.get(cleanJobId) || '';
    const eventSequence = this._nextSequence(cleanJobId);
    const record = buildRunTraceRecord(cleanType, normalizedPayload, {
      source: 'ddalggak',
      target: this.outbox ? 'goc' : 'local',
      jobId: cleanJobId,
      runId,
      eventSequence,
      commandId,
      causationId,
      aggregateType: runId ? 'run' : 'job',
      aggregateId: runId || cleanJobId,
      aggregateRevision: eventSequence,
    });
    appendJsonl(this._eventFile(cleanJobId), record);
    if (this.outbox) this.outbox.enqueue(record, { jobId: cleanJobId });
    this._log(`[run-events:local] ${cleanType} seq=${eventSequence}`);
    return record;
  }

  async flush({ jobId = '', limit = 100 } = {}) {
    if (!this.outbox) return { delivered: 0, pending: 0, skipped: true };
    return await this.outbox.flush({ jobId, limit });
  }

  async startRun(input = {}, { jobId = "" } = {}) {
    return this.record("run.start", input, { jobId });
  }

  async queueMainSteps(actions = [], { metadata = null, jobId = "" } = {}) {
    return this.record("run.queue_steps", {
      actions: Array.isArray(actions) ? actions : [],
      metadata: asObject(metadata),
    }, { jobId });
  }

  async updateRunMetadata(metadata = null, { jobId = "" } = {}) {
    return this.record("run.metadata", {
      metadata: asObject(metadata),
    }, { jobId });
  }

  async recordAgentEvent(eventType = "", input = {}, { jobId = "" } = {}) {
    return this.record(eventType, input, { jobId });
  }

  async finishRun(input = {}, { jobId = "" } = {}) {
    const record = this.record("run.finish", input, { jobId });
    const cleanJobId = normalizeJobId(jobId);
    if (this.outbox) {
      try { await this.outbox.flush({ jobId: cleanJobId, limit: 1000 }); } catch {}
    }
    if (cleanJobId) {
      this.runIdsByJob.delete(cleanJobId);
      this.sequenceByJob.delete(cleanJobId);
    }
    return record;
  }
}

export class GocRunEventSink {
  constructor({
    executionGraph = null,
    fallbackSink = null,
    runtimePolicy = null,
    logger = null,
  } = {}) {
    this.source = "goc";
    this.executionGraph = executionGraph || null;
    this.fallbackSink = fallbackSink || null;
    this.runtimePolicy = runtimePolicy || null;
    this.logger = normalizeLogger(logger);
  }

  _timelineEnabled() {
    return isHarnessTimelineEnabled(this.runtimePolicy);
  }

  _log(message = '') {
    if (!this.logger) return;
    try { this.logger(String(message || '')); } catch {}
  }

  isEnabled() {
    return this._timelineEnabled() && !!(this.executionGraph && typeof this.executionGraph.isEnabled === "function" && this.executionGraph.isEnabled());
  }

  async _localFirst(method, args = [], options = {}) {
    if (!this.fallbackSink || typeof this.fallbackSink[method] !== 'function') return null;
    return await this.fallbackSink[method](...args, options);
  }

  async _bestEffort(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this._log(`[run-events:goc] ${label} failed after local commit: ${safeError(error)}`);
      return null;
    }
  }

  async startRun(input = {}, { jobId = "" } = {}) {
    const local = await this._localFirst('startRun', [input], { jobId });
    if (this.isEnabled() && typeof this.executionGraph.startRun === "function") {
      await this._bestEffort('startRun', () => this.executionGraph.startRun(input));
    }
    return local;
  }

  async queueMainSteps(actions = [], { metadata = null, jobId = "" } = {}) {
    const local = await this._localFirst('queueMainSteps', [actions], { metadata, jobId });
    if (this.isEnabled() && typeof this.executionGraph.queueMainSteps === "function") {
      await this._bestEffort('queueMainSteps', () => this.executionGraph.queueMainSteps(actions, { metadata }));
    }
    return local;
  }

  async updateRunMetadata(metadata = null, { jobId = "" } = {}) {
    const local = await this._localFirst('updateRunMetadata', [metadata], { jobId });
    if (this.isEnabled() && typeof this.executionGraph.updateRunMetadata === "function") {
      await this._bestEffort('updateRunMetadata', () => this.executionGraph.updateRunMetadata(metadata));
    }
    return local;
  }

  async recordAgentEvent(eventType = "", input = {}, { jobId = "" } = {}) {
    const local = await this._localFirst('recordAgentEvent', [eventType, input], { jobId });
    const cleanType = String(eventType || '').trim().toLowerCase();
    if (this.isEnabled() && cleanType === 'participant.contribution' && typeof this.executionGraph.recordParticipantContribution === 'function') {
      await this._bestEffort(cleanType, () => this.executionGraph.recordParticipantContribution(input));
    }
    if (this.isEnabled() && cleanType === 'participant.folded_digest' && typeof this.executionGraph.recordParticipantDigest === 'function') {
      await this._bestEffort(cleanType, () => this.executionGraph.recordParticipantDigest(input));
    }
    if (this.isEnabled() && cleanType === 'channel.verifier_decision' && typeof this.executionGraph.recordChannelVerifierDecision === 'function') {
      await this._bestEffort(cleanType, () => this.executionGraph.recordChannelVerifierDecision(input));
    }
    if (this.isEnabled() && cleanType === 'channel.promotion_applied' && typeof this.executionGraph.recordChannelPromotionApplied === 'function') {
      await this._bestEffort(cleanType, () => this.executionGraph.recordChannelPromotionApplied(input));
    }
    return local;
  }

  async finishRun(input = {}, { jobId = "" } = {}) {
    const local = await this._localFirst('finishRun', [input], { jobId });
    if (this.isEnabled() && typeof this.executionGraph.finishRun === "function") {
      await this._bestEffort('finishRun', () => this.executionGraph.finishRun(input));
    }
    return local;
  }
}
