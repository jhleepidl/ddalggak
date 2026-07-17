import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendJsonl, cleanText, ensureDir, readJson, safeSegment, writeJsonAtomic } from './fs_utils.js';

export function createRoomRunId({ roomId = 'room' } = {}) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${safeSegment(roomId)}-${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

export function roomRunPaths(roomStateRoot = '', runId = '', { create = false } = {}) {
  const id = safeSegment(runId, 'run');
  const runsRoot = path.resolve(cleanText(roomStateRoot), 'runs');
  const runRoot = path.resolve(runsRoot, id);
  if (create) {
    ensureDir(runRoot);
    ensureDir(path.join(runRoot, 'stages'));
    ensureDir(path.join(runRoot, 'snapshots'));
    ensureDir(path.join(runRoot, 'raw'));
  }
  return {
    runId: id,
    runsRoot,
    runRoot,
    specPath: path.join(runRoot, 'spec.json'),
    statePath: path.join(runRoot, 'state.json'),
    controlPath: path.join(runRoot, 'control.json'),
    eventsPath: path.join(runRoot, 'events.jsonl'),
    discussionPath: path.join(runRoot, 'discussion.jsonl'),
    workingMemoryPath: path.join(runRoot, 'working_memory.json'),
    stagesRoot: path.join(runRoot, 'stages'),
    snapshotsRoot: path.join(runRoot, 'snapshots'),
    rawRoot: path.join(runRoot, 'raw'),
  };
}

export function createRoomRun({ roomStateRoot = '', spec = {} } = {}) {
  const paths = roomRunPaths(roomStateRoot, spec.run_id, { create: true });
  const now = new Date().toISOString();
  const state = {
    schema_version: 'ai_rooms.room_run_state/v2',
    run_id: paths.runId,
    room_id: spec.room_id,
    status: 'queued',
    current_stage_id: null,
    stage_index: -1,
    completed_stage_ids: [],
    skipped_stage_ids: [],
    failed_stage_id: null,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
    error: null,
  };
  writeJsonAtomic(paths.specPath, spec);
  writeJsonAtomic(paths.statePath, state);
  writeJsonAtomic(paths.controlPath, { status: 'running', updated_at: now, reason: 'initial' });
  writeJsonAtomic(paths.workingMemoryPath, {
    schema_version: 'ai_rooms.working_memory/v2',
    objective: spec.objective,
    decisions: [],
    open_blockers: [],
    milestones: [],
    stage_summaries: [],
    updated_at: now,
  });
  appendJsonl(paths.eventsPath, { event_type: 'run_created', at: now, run_id: paths.runId, room_id: spec.room_id });
  return { paths, spec, state };
}

export function readRoomRun(roomStateRoot = '', runId = '') {
  const paths = roomRunPaths(roomStateRoot, runId);
  const spec = readJson(paths.specPath, null);
  const state = readJson(paths.statePath, null);
  if (!spec || !state) return null;
  return { paths, spec, state, control: readJson(paths.controlPath, null), workingMemory: readJson(paths.workingMemoryPath, null) };
}

export function updateRoomRunState(paths, patch = {}) {
  const current = readJson(paths.statePath, {});
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeJsonAtomic(paths.statePath, next);
  return next;
}

export function appendRoomRunEvent(paths, event = {}) {
  const row = { ...event, at: event.at || new Date().toISOString(), run_id: event.run_id || paths.runId };
  appendJsonl(paths.eventsPath, row);
  return row;
}

export function writeStageResult(paths, stageId = '', value = {}) {
  const file = path.join(paths.stagesRoot, `${safeSegment(stageId, 'stage')}.json`);
  writeJsonAtomic(file, value);
  return file;
}

export function readRoomRunControl(paths) {
  return readJson(paths.controlPath, { status: 'running' });
}

export function updateRoomRunControl(paths, patch = {}) {
  const current = readRoomRunControl(paths);
  const next = { ...current, ...patch, updated_at: new Date().toISOString() };
  writeJsonAtomic(paths.controlPath, next);
  appendRoomRunEvent(paths, { event_type: 'control_updated', control: next.status, reason: next.reason || null });
  return next;
}

export function writeWorkingMemory(paths, value = {}) {
  const next = { ...value, updated_at: new Date().toISOString() };
  writeJsonAtomic(paths.workingMemoryPath, next);
  return next;
}

export function findActiveRoomRun(roomStateRoot = '') {
  const runsRoot = path.resolve(cleanText(roomStateRoot), 'runs');
  if (!fs.existsSync(runsRoot)) return null;
  const candidates = fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRoomRun(roomStateRoot, entry.name))
    .filter(Boolean)
    .filter((run) => ['queued', 'running', 'paused', 'awaiting_approval'].includes(run.state.status))
    .sort((a, b) => String(b.state.updated_at).localeCompare(String(a.state.updated_at)));
  return candidates[0] || null;
}

export function listRoomRuns(roomStateRoot = '', { limit = 20 } = {}) {
  const runsRoot = path.resolve(cleanText(roomStateRoot), 'runs');
  if (!fs.existsSync(runsRoot)) return [];
  return fs.readdirSync(runsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRoomRun(roomStateRoot, entry.name))
    .filter(Boolean)
    .sort((a, b) => String(b.state.updated_at).localeCompare(String(a.state.updated_at)))
    .slice(0, Math.max(1, Number(limit) || 20));
}
