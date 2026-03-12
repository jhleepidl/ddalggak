import { LocalContextEngine } from "../context_engine/local_engine.js";
import { GocContextEngine } from "../context_engine/goc_engine.js";

function normalizeSource(raw = "") {
  return String(raw || "").trim().toLowerCase() === "goc" ? "goc" : "local";
}

class ContextStoreAdapter {
  constructor({ source = "local", engine = null } = {}) {
    this.source = normalizeSource(source);
    this.engine = engine || null;
  }

  setRuntime(runtime = null) {
    if (this.engine && typeof this.engine.setRuntime === "function") {
      this.engine.setRuntime(runtime);
    }
  }

  async onRunStart(input = {}) {
    if (!this.engine || typeof this.engine.onRunStart !== "function") return null;
    return await this.engine.onRunStart(input);
  }

  async onRunEnd(input = {}) {
    if (!this.engine || typeof this.engine.onRunEnd !== "function") return null;
    return await this.engine.onRunEnd(input);
  }

  async prepareRouterContext(input = {}) {
    if (!this.engine || typeof this.engine.prepareRouterContext !== "function") {
      return { contextText: "", meta: {} };
    }
    return await this.engine.prepareRouterContext(input);
  }

  async prepareStepContext(input = {}) {
    if (!this.engine || typeof this.engine.prepareStepContext !== "function") {
      return { contextText: "", meta: {} };
    }
    return await this.engine.prepareStepContext(input);
  }

  async recordMeta(input = {}) {
    if (!this.engine || typeof this.engine.recordMeta !== "function") return null;
    return await this.engine.recordMeta(input);
  }
}

export class LocalContextStore extends ContextStoreAdapter {
  constructor({
    jobs = null,
    logger = null,
  } = {}) {
    super({
      source: "local",
      engine: new LocalContextEngine({
        jobs,
        logger,
      }),
    });
  }
}

export class GocContextStore extends ContextStoreAdapter {
  constructor({
    client = null,
    runtime = null,
    jobs = null,
    logger = null,
  } = {}) {
    super({
      source: "goc",
      engine: new GocContextEngine({
        client,
        runtime,
        jobs,
        logger,
      }),
    });
  }
}

export function createContextStore({
  source = "local",
  client = null,
  runtime = null,
  jobs = null,
  logger = null,
} = {}) {
  const normalized = normalizeSource(source);
  if (normalized === "goc") {
    return new GocContextStore({
      client,
      runtime,
      jobs,
      logger,
    });
  }
  return new LocalContextStore({
    jobs,
    logger,
  });
}

