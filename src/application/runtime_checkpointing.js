import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
  const stamp = ts.toISOString().replace(/[:.]/g, '-');
  const checkpointId = `${stamp}_${safeSlug(stage || trigger || 'checkpoint')}`;
  const payload = {
    checkpoint_id: checkpointId,
    created_at: ts.toISOString(),
    job_id: clean(jobId),
    stage: clean(stage),
    trigger: clean(trigger),
    user_text: clean(userText),
    reason: clean(reason),
    results: Array.isArray(results) ? results : [],
    outputs: Array.isArray(outputs) ? outputs : [],
    remaining_actions: Array.isArray(remainingActions) ? remainingActions : [],
    pending_approval: pendingApproval && typeof pendingApproval === 'object' ? pendingApproval : null,
    route_plan: routePlan && typeof routePlan === 'object' ? routePlan : null,
    continuous_state: continuousState && typeof continuousState === 'object' ? continuousState : null,
    metadata: asObject(metadata),
  };
  const jsonFile = path.join(dir, `${checkpointId}.json`);
  const markdownFile = path.join(dir, `${checkpointId}.md`);
  fs.writeFileSync(jsonFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.writeFileSync(markdownFile, `${formatRuntimeCheckpointSummary(payload)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'latest.json'), `${JSON.stringify({ checkpoint_id: checkpointId, json_file: jsonFile, markdown_file: markdownFile }, null, 2)}\n`, 'utf8');
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
  const jsonFiles = fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.json') && entry !== 'latest.json')
    .map((entry) => ({
      file: path.join(dir, entry),
      mtimeMs: fs.statSync(path.join(dir, entry)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latest = jsonFiles[0];
  if (!latest) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(latest.file, 'utf8'));
    const markdownFile = latest.file.replace(/\.json$/i, '.md');
    return {
      checkpoint_id: clean(payload?.checkpoint_id),
      json_file: latest.file,
      markdown_file: markdownFile,
      payload,
      summary: formatRuntimeCheckpointSummary(payload),
    };
  } catch {
    return null;
  }
}
