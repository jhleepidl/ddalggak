import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function nowIso() { return new Date().toISOString(); }

function safeRunDir({ rootDir = process.cwd(), jobId = '', runDir = '' } = {}) {
  if (runDir) return path.resolve(rootDir, runDir);
  const cleanJobId = clean(jobId);
  if (!cleanJobId) return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', '_global');
  return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', cleanJobId);
}

function appendJsonl(filePath = '', row = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function contextMetricsDir(options = {}) {
  return path.join(safeRunDir(options), 'local_memory');
}

export function appendContextRuntimeMetric(kind = '', row = {}, options = {}) {
  const cleanKind = clean(kind) || 'context_metric';
  const dir = contextMetricsDir(options);
  const fileMap = {
    projection: 'context_projection_events.jsonl',
    write: 'context_write_metrics.jsonl',
    handoff: 'handoff_metrics.jsonl',
    parallel: 'parallel_execution_metrics.jsonl',
    materialization: 'materialization_metrics.jsonl',
  };
  const fileName = fileMap[cleanKind] || 'context_runtime_metrics.jsonl';
  const payload = {
    kind: `context_${cleanKind}_metric_v1`,
    timestamp: nowIso(),
    ...asObject(row),
  };
  const ok = appendJsonl(path.join(dir, fileName), payload);
  return { ok, file: path.join(dir, fileName), row: payload };
}

export function estimateContextTokens(text = '') {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
