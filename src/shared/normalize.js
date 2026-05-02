const PROVIDER_ALIASES = {
  gpt: "chatgpt",
  openai: "chatgpt",
  chatgpt: "chatgpt",
  codex: "codex",
  gemini: "gemini",
  local: "openai_compatible",
  local_model: "openai_compatible",
  openai_compatible: "openai_compatible",
  "openai-compatible": "openai_compatible",
  ollama: "openai_compatible",
  llamacpp: "openai_compatible",
  "llama.cpp": "openai_compatible",
};

export function asObject(v) {
  return v && typeof v === "object" ? v : {};
}

export function normalizeProviderName(raw, fallback = "gemini") {
  const key = String(raw || "").trim().toLowerCase();
  return PROVIDER_ALIASES[key] || fallback;
}

export function normalizeStringList(raw, { max = 24, lower = false } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? raw.split(/[\n,]/) : []);
  const out = [];
  const seen = new Set();
  const maxItems = Math.max(1, Math.floor(Number(max) || 24));
  for (const entry of list) {
    const text = String(entry || "").trim();
    if (!text) continue;
    const value = lower ? text.toLowerCase() : text;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeNodeIds(raw, { max = 200 } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : (typeof raw === "string" ? raw.split(",") : []);
  return normalizeStringList(list, { max, lower: false });
}

export function dedupeStrings(list = [], { lower = true } = {}) {
  return normalizeStringList(list, { max: Number.MAX_SAFE_INTEGER, lower });
}

export function parseClampedInt(raw, fallback, { min = 1, max = 100 } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
