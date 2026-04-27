import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').trim();
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir = '') {
  if (!dir) return;
  fs.mkdirSync(dir, { recursive: true });
}

function safeJson(value) {
  return JSON.stringify(value, null, 2);
}

export function appendJsonl(filePath = '', payload = {}) {
  if (!filePath) return null;
  ensureDir(path.dirname(filePath));
  const row = { ts: nowIso(), ...payload };
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}

export function readJsonl(filePath = '') {
  if (!filePath || !fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

export function makeRunId({ suite = 'experiment', condition = 'default', id = '' } = {}) {
  const suffix = clean(id) || Math.random().toString(36).slice(2, 10);
  return `${clean(suite) || 'experiment'}_${clean(condition) || 'default'}_${suffix}`.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

export function createExperimentRun({
  outDir = 'experiments/runs/manual',
  runId = '',
  suite = '',
  condition = '',
  paper = '',
  metadata = {},
} = {}) {
  const id = clean(runId) || makeRunId({ suite, condition });
  const dir = path.join(outDir, id);
  ensureDir(dir);
  const manifest = {
    run_id: id,
    paper: clean(paper),
    suite: clean(suite),
    condition: clean(condition),
    created_at: nowIso(),
    metadata,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), safeJson(manifest), 'utf8');
  appendJsonl(path.join(dir, 'events.jsonl'), { event: 'run_created', run_id: id, suite, condition, paper });
  return { run_id: id, dir, manifest };
}

export function recordExperimentEvent(runDir = '', event = '', payload = {}) {
  if (!runDir || !event) return null;
  return appendJsonl(path.join(runDir, 'events.jsonl'), { event, ...payload });
}

export function writeExperimentResult(runDir = '', payload = {}) {
  if (!runDir) return null;
  ensureDir(runDir);
  const result = { ts: nowIso(), ...payload };
  fs.writeFileSync(path.join(runDir, 'result.json'), safeJson(result), 'utf8');
  appendJsonl(path.join(path.dirname(runDir), 'results.jsonl'), result);
  return result;
}

export function buildProjectionSnapshot({
  artifactContext = {},
  projectionStress = {},
  autonomyDecision = {},
  promptChars = 0,
  extra = {},
} = {}) {
  return {
    active_artifacts: Number(artifactContext.active_artifacts || artifactContext.activeArtifacts || 0),
    observations: artifactContext.observations || [],
    negative_labels: artifactContext.negative_labels || artifactContext.negativeLabels || [],
    retractions: artifactContext.retractions || [],
    prompt_chars: Number(promptChars || 0),
    projection_stress: projectionStress,
    autonomy_decision: autonomyDecision,
    ...extra,
  };
}

export function finalizeExperimentRun(runDir = '', payload = {}) {
  if (!runDir) return null;
  recordExperimentEvent(runDir, 'run_finalized', payload);
  const manifestPath = path.join(runDir, 'manifest.json');
  let manifest = {};
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  const updated = { ...manifest, finalized_at: nowIso(), summary: payload };
  fs.writeFileSync(manifestPath, safeJson(updated), 'utf8');
  return updated;
}
