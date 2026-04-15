function stableStringify(value) {
  return JSON.stringify(value, Object.keys(value || {}).sort());
}

export class TimedArtifactCache {
  constructor({ ttlMs = 30000, maxEntries = 256 } = {}) {
    this.ttlMs = Number.isFinite(Number(ttlMs)) ? Math.max(1000, Math.floor(Number(ttlMs))) : 30000;
    this.maxEntries = Number.isFinite(Number(maxEntries)) ? Math.max(16, Math.floor(Number(maxEntries))) : 256;
    this.store = new Map();
  }

  _prune() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (Number(entry?.expiresAt || 0) <= now) this.store.delete(key);
    }
    if (this.store.size > this.maxEntries) {
      const ordered = [...this.store.entries()]
        .sort((a, b) => Number(a[1]?.touchedAt || 0) - Number(b[1]?.touchedAt || 0));
      while (this.store.size > this.maxEntries && ordered.length > 0) {
        const [key] = ordered.shift();
        this.store.delete(key);
      }
    }
  }

  get(key) {
    this._prune();
    const entry = this.store.get(key);
    if (!entry) return null;
    entry.touchedAt = Date.now();
    return entry.value;
  }

  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs, touchedAt: Date.now() });
    this._prune();
    return value;
  }

  invalidate(match = null) {
    if (!match) {
      this.store.clear();
      return;
    }
    const matcher = typeof match === 'function'
      ? match
      : (key) => String(key || '').includes(String(match));
    for (const key of [...this.store.keys()]) {
      if (matcher(key)) this.store.delete(key);
    }
  }
}

export function buildContextArtifactCacheKey(namespace, parts = {}) {
  const payload = {};
  for (const [key, value] of Object.entries(parts || {})) {
    if (value === undefined) continue;
    payload[key] = value;
  }
  return `${String(namespace || 'artifact').trim()}:${stableStringify(payload)}`;
}
