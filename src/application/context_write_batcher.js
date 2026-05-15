import { commitContextWriteIntentsBatch as commitContextWriteIntentsBatchStore } from './context_substrate_store.js';
import { appendContextRuntimeMetric } from './context_runtime_metrics.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '') { return String(value ?? '').trim(); }

export function commitContextWriteIntentsBatch(intents = [], options = {}) {
  const started = Date.now();
  const rows = asArray(intents).filter((intent) => intent && typeof intent === 'object');
  let storeResult = null;
  try {
    storeResult = commitContextWriteIntentsBatchStore(rows, options);
  } catch (error) {
    storeResult = { ok: false, total: rows.length, committed: 0, proposals: 0, conflicts: 0, errors: rows.length, results: [{ ok: false, status: 'error', error: String(error?.message ?? error) }] };
  }
  const results = asArray(storeResult.results);
  const summary = {
    ok: storeResult.ok !== false,
    total: rows.length,
    committed: Number(storeResult.committed || 0),
    proposals: Number(storeResult.proposals || 0),
    conflicts: Number(storeResult.conflicts || 0),
    errors: Number(storeResult.errors || 0),
    duration_ms: Date.now() - started,
    lanes: results.reduce((acc, row) => {
      const lane = clean(row.lane || 'unknown') || 'unknown';
      acc[lane] = Number(acc[lane] || 0) + 1;
      return acc;
    }, {}),
    results,
    store_result: storeResult,
  };
  appendContextRuntimeMetric('write', {
    batch_size: rows.length,
    committed: summary.committed,
    proposals: summary.proposals,
    conflicts: summary.conflicts,
    errors: summary.errors,
    duration_ms: summary.duration_ms,
    lanes: summary.lanes,
  }, options);
  return summary;
}
