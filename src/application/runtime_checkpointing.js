import fs from 'node:fs';
import path from 'node:path';

let lastCheckpointEpochMs = 0;
let checkpointSequenceWithinMs = 0;

function nextCheckpointSequence(nowMs = Date.now()) {
  const epochMs = Math.max(0, Math.floor(Number(nowMs) || 0));
  if (epochMs === lastCheckpointEpochMs) checkpointSequenceWithinMs += 1;
  else {
    lastCheckpointEpochMs = epochMs;
    checkpointSequenceWithinMs = 0;
  }
  return (epochMs * 1000) + Math.min(999, checkpointSequenceWithinMs);
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

function clean(value = '') {
  return String(value || '').trim();
}

function safeSlug(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64) || 'checkpoint';
}

function clip(text = '', max = 400) {
  const src = String(text || '').trim();
  if (src.length <= max) return src;
  return `${src.slice(0, Math.max(0, max - 1))}…`;
}

export function resolveRuntimeCheckpointDir({ sharedDir = '', workspaceRoot = '' } = {}) {
  if (sharedDir) return path.join(path.resolve(String(sharedDir)), 'runtime_checkpoints');
  const workspace = path.resolve(String(workspaceRoot || process.cwd()));
  return path.join(path.dirname(workspace), 'shared', 'runtime_checkpoints');
}

function summarizeOutputs(outputs = []) {
  const rows = Array.isArray(outputs) ? outputs : [];
  return rows.slice(-6).map((row, index) => {
    const agentId = clean(row?.agentId || row?.agent_id || 'system');
    const mode = clean(row?.mode || 'output');
    const text = clip(row?.output || '', 240).replace(/\s+/g, ' ');
    return `- ${index + 1}. ${agentId} [${mode}]${text ? ` :: ${text}` : ''}`;
  });
}

function summarizeResults(results = []) {
  const rows = Array.isArray(results) ? results : [];
  return rows.slice(-8).map((row, index) => {
    const label = clean(row?.label || 'step');
    const status = clean(row?.status || 'unknown');
    const note = clip(row?.note || '', 180).replace(/\s+/g, ' ');
    return `- ${index + 1}. ${label} -> ${status}${note ? ` :: ${note}` : ''}`;
  });
}

export function formatRuntimeCheckpointSummary(record = {}) {
  const row = asObject(record);
  const results = summarizeResults(row.results || []);
  const outputs = summarizeOutputs(row.outputs || []);
  const remainingCount = Array.isArray(row.remaining_actions) ? row.remaining_actions.length : 0;
  return [
    `checkpoint_id: ${clean(row.checkpoint_id || '') || '(unknown)'}`,
    row.stage ? `stage: ${clean(row.stage)}` : '',
    row.trigger ? `trigger: ${clean(row.trigger)}` : '',
    row.job_id ? `job_id: ${clean(row.job_id)}` : '',
    row.user_text ? `user_text: ${clip(row.user_text, 240)}` : '',
    row.reason ? `reason: ${clip(row.reason, 240)}` : '',
    `remaining_actions: ${remainingCount}`,
    results.length > 0 ? 'recent_results:' : '',
    ...results,
    outputs.length > 0 ? 'recent_outputs:' : '',
    ...outputs,
  ].filter(Boolean).join('\n');
}

export function summarizeRuntimeCheckpointRef(checkpoint = {}) {
  const row = asObject(checkpoint);
  return {
    checkpoint_id: clean(row.checkpoint_id || row.id),
    json_file: clean(row.json_file),
    markdown_file: clean(row.markdown_file),
    directory: clean(row.directory),
    summary: clean(row.summary),
  };
}

export function writeRuntimeCheckpointBundle({
  sharedDir = '',
  workspaceRoot = '',
  jobId = '',
  stage = '',
  trigger = '',
  userText = '',
  reason = '',
  results = [],
  outputs = [],
  remainingActions = [],
  pendingApproval = null,
  routePlan = null,
  continuousState = null,
  metadata = {},
} = {}) {
  const dir = resolveRuntimeCheckpointDir({ sharedDir, workspaceRoot });
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date();
  const checkpointSequence = nextCheckpointSequence(ts.getTime());
  const stamp = ts.toISOString().replace(/[:.]/g, '-');
  const checkpointId = `${stamp}_${String(checkpointSequence).slice(-6).padStart(6, '0')}_${safeSlug(stage || trigger || 'checkpoint')}`;
  const payload = {
    checkpoint_id: checkpointId,
    created_at: ts.toISOString(),
    checkpoint_sequence: checkpointSequence,
    job_id: clean(jobId),
    stage: clean(stage),
    trigger: clean(trigger),
    user_text: clean(userText),
    reason: clean(reason),
    results: cloneJsonSafe(Array.isArray(results) ? results : []) || [],
    outputs: cloneJsonSafe(Array.isArray(outputs) ? outputs : []) || [],
    remaining_actions: cloneJsonSafe(Array.isArray(remainingActions) ? remainingActions : []) || [],
    pending_approval: cloneJsonSafe(pendingApproval && typeof pendingApproval === 'object' ? pendingApproval : null),
    route_plan: cloneJsonSafe(routePlan && typeof routePlan === 'object' ? routePlan : null),
    continuous_state: cloneJsonSafe(continuousState && typeof continuousState === 'object' ? continuousState : null),
    metadata: cloneJsonSafe(asObject(metadata)) || {},
  };
  const jsonFile = path.join(dir, `${checkpointId}.json`);
  const markdownFile = path.join(dir, `${checkpointId}.md`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownFile, `${formatRuntimeCheckpointSummary(payload)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({ checkpoint_id: checkpointId, checkpoint_sequence: checkpointSequence, created_at: payload.created_at, json_file: jsonFile, markdown_file: markdownFile }, null, 2)}\n`, 'utf8');
  return {
    checkpoint_id: checkpointId,
    directory: dir,
    json_file: jsonFile,
    markdown_file: markdownFile,
    summary: formatRuntimeCheckpointSummary(payload),
    payload,
  };
}

export function loadLatestRuntimeCheckpoint({ sharedDir = '', workspaceRoot = '' } = {}) {
  const dir = resolveRuntimeCheckpointDir({ sharedDir, workspaceRoot });
  if (!fs.existsSync(dir)) return null;
  try {
    const latestFile = path.join(dir, 'latest.json');
    if (fs.existsSync(latestFile)) {
      const meta = JSON.parse(fs.readFileSync(latestFile, 'utf8'));
      const jsonFile = clean(meta?.json_file);
      if (jsonFile && fs.existsSync(jsonFile)) {
        const payload = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
        return {
          checkpoint_id: clean(meta?.checkpoint_id || payload?.checkpoint_id),
          json_file: jsonFile,
          markdown_file: clean(meta?.markdown_file),
          payload,
          summary: formatRuntimeCheckpointSummary(payload),
        };
      }
    }
  } catch {}
  const candidates = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json') || entry === 'latest.json') continue;
    const file = path.join(dir, entry);
    try {
      const stat = fs.statSync(file, { bigint: true });
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      candidates.push({
        file,
        entry,
        payload,
        createdAtMs: Date.parse(clean(payload?.created_at)) || 0,
        checkpointSequence: Number(payload?.checkpoint_sequence || 0) || 0,
        mtimeNs: stat.mtimeNs || 0n,
      });
    } catch {
      // A damaged historical checkpoint must not prevent recovery from an older valid one.
    }
  }
  candidates.sort((a, b) => {
    if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs;
    if (a.checkpointSequence !== b.checkpointSequence) return b.checkpointSequence - a.checkpointSequence;
    if (a.mtimeNs !== b.mtimeNs) return a.mtimeNs > b.mtimeNs ? -1 : 1;
    return b.entry.localeCompare(a.entry);
  });
  const latest = candidates[0];
  if (!latest) return null;
  const markdownFile = latest.file.replace(/\.json$/i, '.md');
  return {
    checkpoint_id: clean(latest.payload?.checkpoint_id),
    json_file: latest.file,
    markdown_file: markdownFile,
    payload: latest.payload,
    summary: formatRuntimeCheckpointSummary(latest.payload),
  };
}
