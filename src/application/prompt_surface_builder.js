import { clip } from '../textutil.js';

function safeString(value = '') {
  return String(value || '');
}

function prunePromptValue(value, { maxDepth = 3, maxItems = 8, maxStringChars = 220 } = {}, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return clip(value, maxStringChars);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= maxDepth) {
    if (Array.isArray(value)) return `[${Math.min(value.length, maxItems)} items]`;
    return '{...}';
  }
  if (Array.isArray(value)) {
    const rows = value.slice(0, maxItems).map((entry) => prunePromptValue(entry, { maxDepth, maxItems, maxStringChars }, depth + 1));
    if (value.length > maxItems) rows.push(`...(+${value.length - maxItems} more)`);
    return rows;
  }
  if (typeof value === 'object') {
    const out = {};
    const entries = Object.entries(value).slice(0, maxItems);
    for (const [key, entry] of entries) {
      out[key] = prunePromptValue(entry, { maxDepth, maxItems, maxStringChars }, depth + 1);
    }
    const extraCount = Math.max(0, Object.keys(value).length - entries.length);
    if (extraCount > 0) out.__truncated_keys = `+${extraCount}`;
    return out;
  }
  return safeString(value);
}

export function compactPromptJson(value, options = {}) {
  try {
    return JSON.stringify(prunePromptValue(value, options));
  } catch {
    return safeString(value);
  }
}
