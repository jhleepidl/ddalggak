import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value ?? '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }

function safeReadJson(filePath = '', fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function runContextDir({ rootDir = process.cwd(), jobId = '', runDir = '' } = {}) {
  if (runDir) return path.resolve(rootDir, runDir, 'local_memory', 'run_context');
  const cleanJobId = clean(jobId) || '_global';
  return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', cleanJobId, 'local_memory', 'run_context');
}

export function loadRunContext(options = {}) {
  const dir = runContextDir(options);
  const file = path.join(dir, 'run_context_state.json');
  const state = safeReadJson(file, null);
  if (state && state.kind === 'run_context_state_v1') return { ...state, dir, file };
  const now = nowIso();
  return {
    kind: 'run_context_state_v1',
    created_at: now,
    updated_at: now,
    base_snapshot_id: clean(options.baseSnapshotId || ''),
    projections: {},
    handoffs: [],
    pending_write_intents: [],
    dir,
    file,
  };
}

export function saveRunContext(state = {}, options = {}) {
  const current = state && typeof state === 'object' ? state : loadRunContext(options);
  const dir = current.dir || runContextDir(options);
  const file = current.file || path.join(dir, 'run_context_state.json');
  const payload = {
    ...current,
    dir: undefined,
    file: undefined,
    updated_at: nowIso(),
  };
  writeJson(file, payload);
  return { ...payload, dir, file };
}

export function rememberCompiledProjection(projection = {}, options = {}) {
  const state = loadRunContext(options);
  const key = clean(projection.cache_key || projection.projection_key || projection.projection_id || `${projection.role || 'agent'}:${projection.task_type || 'task'}:${projection.model_node || ''}`);
  if (!key) return state;
  state.projections = asObject(state.projections);
  state.projections[key] = {
    projection_id: clean(projection.projection_id || ''),
    snapshot_id: clean(projection.snapshot_id || ''),
    role: clean(projection.role || ''),
    task_type: clean(projection.task_type || ''),
    model_node: clean(projection.model_node || ''),
    context_tokens: Number(projection.context_tokens || projection.metrics?.context_tokens || 0),
    cache_hit: projection.cache_hit === true,
    updated_at: nowIso(),
  };
  if (!state.base_snapshot_id && projection.snapshot_id) state.base_snapshot_id = clean(projection.snapshot_id);
  return saveRunContext(state, options);
}

export function appendRunContextHandoff(handoff = {}, options = {}) {
  const state = loadRunContext(options);
  state.handoffs = asArray(state.handoffs);
  const row = {
    kind: 'run_context_handoff_v1',
    id: clean(handoff.id) || `handoff_${Date.now().toString(36)}_${state.handoffs.length + 1}`,
    timestamp: nowIso(),
    from_agent: clean(handoff.from_agent || handoff.from || ''),
    to_agent: clean(handoff.to_agent || handoff.to || ''),
    handoff_type: clean(handoff.handoff_type || handoff.type || 'agent_delta'),
    snapshot_id: clean(handoff.snapshot_id || state.base_snapshot_id || ''),
    delta: asObject(handoff.delta || handoff.payload),
    summary: clean(handoff.summary || ''),
  };
  state.handoffs.push(row);
  return { state: saveRunContext(state, options), handoff: row };
}

export function getRecentRunContextHandoffs({ agentId = '', limit = 8 } = {}, options = {}) {
  const state = loadRunContext(options);
  const id = clean(agentId).toLowerCase();
  return asArray(state.handoffs)
    .filter((row) => !id || clean(row.to_agent).toLowerCase() === id || clean(row.from_agent).toLowerCase() === id)
    .slice(-Math.max(1, Number(limit) || 8));
}
