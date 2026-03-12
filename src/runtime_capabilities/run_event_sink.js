import fs from "node:fs";
import path from "node:path";

function asObject(value) {
  return value && typeof value === "object" ? value : {};
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

export class LocalRunEventSink {
  constructor({
    jobs = null,
    logger = null,
  } = {}) {
    this.source = "local";
    this.jobs = jobs || null;
    this.logger = normalizeLogger(logger);
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

  record(eventType = "", payload = {}, { jobId = "" } = {}) {
    const cleanType = String(eventType || "").trim();
    if (!cleanType) return;
    const filePath = this._eventFile(jobId);
    appendJsonl(filePath, {
      event_type: cleanType,
      payload: asObject(payload),
    });
    this._log(`[run-events:local] ${cleanType}`);
  }

  async startRun(input = {}, { jobId = "" } = {}) {
    this.record("run.start", input, { jobId });
    return null;
  }

  async queueMainSteps(actions = [], { metadata = null, jobId = "" } = {}) {
    this.record("run.queue_steps", {
      actions: Array.isArray(actions) ? actions : [],
      metadata: asObject(metadata),
    }, { jobId });
    return null;
  }

  async updateRunMetadata(metadata = null, { jobId = "" } = {}) {
    this.record("run.metadata", {
      metadata: asObject(metadata),
    }, { jobId });
    return null;
  }

  async finishRun(input = {}, { jobId = "" } = {}) {
    this.record("run.finish", input, { jobId });
    return null;
  }
}

export class GocRunEventSink {
  constructor({
    executionGraph = null,
    fallbackSink = null,
  } = {}) {
    this.source = "goc";
    this.executionGraph = executionGraph || null;
    this.fallbackSink = fallbackSink || null;
  }

  isEnabled() {
    return !!(this.executionGraph && typeof this.executionGraph.isEnabled === "function" && this.executionGraph.isEnabled());
  }

  async startRun(input = {}, { jobId = "" } = {}) {
    if (this.isEnabled() && typeof this.executionGraph.startRun === "function") {
      return await this.executionGraph.startRun(input);
    }
    if (this.fallbackSink && typeof this.fallbackSink.startRun === "function") {
      return await this.fallbackSink.startRun(input, { jobId });
    }
    return null;
  }

  async queueMainSteps(actions = [], { metadata = null, jobId = "" } = {}) {
    if (this.isEnabled() && typeof this.executionGraph.queueMainSteps === "function") {
      return await this.executionGraph.queueMainSteps(actions, { metadata });
    }
    if (this.fallbackSink && typeof this.fallbackSink.queueMainSteps === "function") {
      return await this.fallbackSink.queueMainSteps(actions, { metadata, jobId });
    }
    return null;
  }

  async updateRunMetadata(metadata = null, { jobId = "" } = {}) {
    if (this.isEnabled() && typeof this.executionGraph.updateRunMetadata === "function") {
      return await this.executionGraph.updateRunMetadata(metadata);
    }
    if (this.fallbackSink && typeof this.fallbackSink.updateRunMetadata === "function") {
      return await this.fallbackSink.updateRunMetadata(metadata, { jobId });
    }
    return null;
  }

  async finishRun(input = {}, { jobId = "" } = {}) {
    if (this.isEnabled() && typeof this.executionGraph.finishRun === "function") {
      return await this.executionGraph.finishRun(input);
    }
    if (this.fallbackSink && typeof this.fallbackSink.finishRun === "function") {
      return await this.fallbackSink.finishRun(input, { jobId });
    }
    return null;
  }
}

