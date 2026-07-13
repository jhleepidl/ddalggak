import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') { return String(value || '').trim(); }
function nowIso() { return new Date().toISOString(); }
function safeId(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'activity'; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

export function runtimeActivityDir() {
  const explicit = clean(process.env.RUNTIME_ACTIVITY_DIR);
  if (explicit) return path.resolve(explicit);
  return path.resolve(process.cwd(), process.env.RUNS_DIR || 'runs', '.runtime_activity');
}

function processIsAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLease(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function activityMarkerPath(dir) {
  return path.join(dir, '.last_activity');
}

function writeActivityMarker(dir, payload = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(activityMarkerPath(dir), `${JSON.stringify({ ts: nowIso(), ...asObject(payload) })}\n`, 'utf8');
  } catch {}
}

export function beginRuntimeActivity({ provider = '', kind = 'provider_execution', jobId = '', metadata = {}, dir = runtimeActivityDir() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const id = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const file = path.join(dir, `${safeId(id)}.json`);
  const row = {
    schema_version: 'ddalggak.runtime_activity_lease/v1',
    activity_id: id,
    pid: process.pid,
    provider: clean(provider).toLowerCase() || null,
    kind: clean(kind) || 'provider_execution',
    job_id: clean(jobId) || null,
    started_at: nowIso(),
    metadata: asObject(metadata),
  };
  fs.writeFileSync(file, `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  writeActivityMarker(dir, { event: 'started', provider: row.provider, kind: row.kind, pid: process.pid });
  let released = false;
  return {
    ...row,
    file,
    release() {
      if (released) return;
      released = true;
      try { fs.unlinkSync(file); } catch {}
      writeActivityMarker(dir, { event: 'completed', provider: row.provider, kind: row.kind, pid: process.pid });
    },
  };
}

export function getRuntimeActivityState({ dir = runtimeActivityDir(), staleAfterMs = Number(process.env.RUNTIME_ACTIVITY_STALE_AFTER_MS || 2 * 60 * 60 * 1000) || 2 * 60 * 60 * 1000, cleanup = true } = {}) {
  if (!fs.existsSync(dir)) {
    return { busy: false, active_runs: 0, activities: [], activity_dir: dir };
  }
  const activities = [];
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    const row = readLease(file);
    if (!row) {
      if (cleanup) { try { fs.unlinkSync(file); } catch {} }
      continue;
    }
    const started = Date.parse(row.started_at || '');
    const ageMs = Number.isFinite(started) ? Math.max(0, now - started) : Number.POSITIVE_INFINITY;
    const alive = processIsAlive(row.pid);
    if (!alive && ageMs >= Math.max(60_000, staleAfterMs)) {
      if (cleanup) { try { fs.unlinkSync(file); } catch {} }
      continue;
    }
    if (!alive) {
      if (cleanup) { try { fs.unlinkSync(file); } catch {} }
      continue;
    }
    activities.push({ ...row, age_ms: ageMs, file });
  }
  const marker = readLease(activityMarkerPath(dir)) || {};
  const markerTs = Date.parse(marker.ts || '');
  const idleForMs = activities.length > 0 ? 0 : (Number.isFinite(markerTs) ? Math.max(0, now - markerTs) : Number.POSITIVE_INFINITY);
  return {
    busy: activities.length > 0,
    active_runs: activities.length,
    activities,
    activity_dir: dir,
    last_activity_at: Number.isFinite(markerTs) ? new Date(markerTs).toISOString() : null,
    idle_for_ms: idleForMs,
  };
}

export async function withRuntimeActivity(activity, fn) {
  const lease = beginRuntimeActivity(activity);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}
