import { loadAgents, getAgent } from "../agents.js";
import { loadAgentsFromGoc } from "../agent_registry.js";

function normalizeLogger(logger = null) {
  return typeof logger === "function" ? logger : null;
}

function toMessage(error) {
  return String(error?.message ?? error ?? "").trim();
}

function normalizeIncludeCompiled(raw = true) {
  return raw !== false;
}

export class LocalAgentCatalog {
  constructor({
    logger = null,
  } = {}) {
    this.source = "local";
    this.logger = normalizeLogger(logger);
    this.registry = null;
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  async load({ refresh = false } = {}) {
    if (!refresh && this.registry && Array.isArray(this.registry.agents)) {
      return this.registry;
    }
    this.registry = loadAgents();
    this._log(`[agent-catalog:local] loaded=${this.registry.agents.length}`);
    return this.registry;
  }

  async get(agentId = "", { registry = null } = {}) {
    const reg = registry || await this.load();
    return getAgent(agentId, reg);
  }
}

export class GocAgentCatalog {
  constructor({
    client = null,
    baseDir = "",
    fallbackCatalog = null,
    logger = null,
  } = {}) {
    this.source = "goc";
    this.client = client || null;
    this.baseDir = String(baseDir || "").trim();
    this.fallbackCatalog = fallbackCatalog || new LocalAgentCatalog({ logger });
    this.logger = normalizeLogger(logger);
    this.registry = null;
    this.lastError = "";
  }

  _log(line = "") {
    if (!this.logger) return;
    try {
      this.logger(String(line || ""));
    } catch {}
  }

  async _loadFallback({ refresh = false } = {}) {
    this.registry = await this.fallbackCatalog.load({ refresh });
    this.source = "local";
    return this.registry;
  }

  async load({
    includeCompiled = true,
    refresh = false,
    fallbackToLocal = true,
  } = {}) {
    if (!refresh && this.registry && Array.isArray(this.registry.agents)) {
      return this.registry;
    }

    if (!this.client) {
      this.lastError = "GoC client unavailable";
      if (!fallbackToLocal) throw new Error(this.lastError);
      return await this._loadFallback({ refresh: true });
    }

    try {
      this.registry = await loadAgentsFromGoc({
        client: this.client,
        baseDir: this.baseDir,
        includeCompiled: normalizeIncludeCompiled(includeCompiled),
      });
      this.source = "goc";
      this.lastError = "";
      this._log(`[agent-catalog:goc] loaded=${this.registry.agents.length} source=${this.registry.source || "goc"}`);
      return this.registry;
    } catch (error) {
      this.lastError = toMessage(error) || "loadAgentsFromGoc failed";
      this._log(`[agent-catalog:goc] fallback_local reason=${this.lastError}`);
      if (!fallbackToLocal) throw error;
      return await this._loadFallback({ refresh: true });
    }
  }

  async get(agentId = "", { registry = null } = {}) {
    const reg = registry || await this.load({ refresh: false });
    return getAgent(agentId, reg);
  }
}

