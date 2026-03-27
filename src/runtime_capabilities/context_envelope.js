const ORDER = [
  'focus',
  'job_constraints',
  'current_task_packet',
  'active_directives',
  'pinned_facts',
  'role_summary',
  'iteration_delta',
  'rolling_summary',
  'recent_turns',
  'recent_tool_results',
  'shared_summary',
  'lens_context',
  'detail_context',
  'global_memory',
  'raw',
];

function clean(value = '') {
  return String(value || '').trim();
}

function normalizeKey(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function labelForKey(key = '') {
  const cleanKey = normalizeKey(key);
  switch (cleanKey) {
    case 'focus': return 'FOCUS';
    case 'job_constraints': return 'JOB CONSTRAINTS';
    case 'current_task_packet': return 'CURRENT TASK PACKET';
    case 'active_directives': return 'ACTIVE DIRECTIVES';
    case 'pinned_facts': return 'PINNED FACTS';
    case 'role_summary': return 'ROLE SUMMARY';
    case 'iteration_delta': return 'ITERATION DELTA';
    case 'rolling_summary': return 'ROLLING SUMMARY';
    case 'recent_turns': return 'RECENT TURNS';
    case 'recent_tool_results': return 'RECENT TOOL RESULTS';
    case 'shared_summary': return 'SHARED SUMMARY';
    case 'lens_context': return 'LENS CONTEXT';
    case 'detail_context': return 'DETAIL CONTEXT';
    case 'global_memory': return 'GLOBAL MEMORY';
    default: return '';
  }
}

export function renderContextSection(label = '', body = '') {
  const cleanBody = clean(body);
  if (!cleanBody) return '';
  const cleanLabel = clean(label);
  if (!cleanLabel) return cleanBody;
  if (/^\[[^\]]+\]/.test(cleanBody)) return cleanBody;
  return `[${cleanLabel}]\n${cleanBody}`;
}

export function buildContextEnvelope(sections = [], { maxChars = 0 } = {}) {
  const rows = Array.isArray(sections) ? sections : [];
  const normalized = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row) continue;
    const key = normalizeKey(row.key || row.id || row.label || row.section || 'raw');
    const raw = clean(row.raw);
    const body = clean(row.body);
    const label = clean(row.label || labelForKey(key));
    const text = raw || renderContextSection(label, body);
    if (!text) continue;
    const dedupeKey = `${key}::${text}`.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({
      key,
      order: ORDER.includes(key) ? ORDER.indexOf(key) : ORDER.length,
      text,
    });
  }
  normalized.sort((a, b) => a.order - b.order);
  let text = normalized.map((entry) => entry.text).filter(Boolean).join('\n\n');
  const limit = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.max(400, Math.floor(Number(maxChars)))
    : 0;
  if (limit && text.length > limit) {
    text = `${text.slice(0, Math.max(120, limit - 18))}\n…(truncated)…`;
  }
  return {
    text,
    section_keys: normalized.map((entry) => entry.key),
  };
}
