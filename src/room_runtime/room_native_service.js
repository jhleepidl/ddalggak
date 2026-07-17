import fs from 'node:fs';
import path from 'node:path';
import { buildExecutionGraph } from './room_execution_graph.js';
import { RoomLoopEngine } from './room_loop_engine.js';
import {
  createRoomRunId,
  findActiveRoomRun,
  listRoomRuns,
  readRoomRun,
  updateRoomRunControl,
} from './room_run_store.js';
import { cleanText, writeJsonAtomic } from './fs_utils.js';
import { normalizeRoomId, roomPaths } from './room_workspace_registry.js';

function parseTopology(value = '') {
  const text = cleanText(value);
  const match = text.match(/(?:--topology|--mode)\s+(solo|review(?:_loop)?|deliberate)/i);
  return match ? match[1] : '';
}

function stripFlags(value = '') {
  return cleanText(value).replace(/(?:--topology|--mode)\s+(?:solo|review(?:_loop)?|deliberate)/ig, '').trim();
}

export function deriveTelegramRoomId(chatId = '') {
  return normalizeRoomId(`telegram-${cleanText(chatId) || 'unknown'}`);
}

export class RoomNativeService {
  constructor({ env = process.env, engine = null } = {}) {
    this.env = env;
    this.engine = engine || new RoomLoopEngine({ env });
    this.active = new Map();
  }

  isEnabled() {
    return ['room_native_v2', 'room_native', 'v2'].includes(cleanText(this.env.ROOM_EXECUTION_ENGINE).toLowerCase());
  }

  getRoom(roomId, { create = true } = {}) {
    return roomPaths(roomId, { env: this.env, create });
  }

  initializeRoom(roomId, { title = '' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    if (title) {
      writeJsonAtomic(paths.manifestPath, {
        ...(paths.manifest || {}),
        schema_version: 'ai_rooms.room/v2',
        room_id: paths.roomId,
        title: cleanText(title),
        workspace_root: paths.workspaceRoot,
        state_root: paths.roomStateRoot,
        updated_at: new Date().toISOString(),
      });
    }
    return paths;
  }

  async startRun({ roomId, objective, topology = '', modelPolicy = {}, visibility = 'quiet', onProgress = null } = {}) {
    const paths = this.initializeRoom(roomId);
    const active = this.active.get(paths.roomId) || findActiveRoomRun(paths.roomStateRoot);
    if (active) throw Object.assign(new Error(`Room already has an active run: ${active.paths?.runId || active.runId || 'unknown'}`), { code: 'ROOM_RUN_ALREADY_ACTIVE' });
    const cleanObjective = stripFlags(objective);
    if (!cleanObjective) throw new Error('Room run objective is required');
    const graph = buildExecutionGraph({
      objective: cleanObjective,
      topology: topology || parseTopology(objective),
      maxReviewRounds: Number(this.env.ROOM_REVIEW_MAX_ROUNDS || 2),
    });
    const runId = createRoomRunId({ roomId: paths.roomId });
    const spec = {
      schema_version: 'ai_rooms.room_run/v2',
      run_id: runId,
      room_id: paths.roomId,
      objective: cleanObjective,
      workspace_root: paths.workspaceRoot,
      execution_graph: graph,
      progress_policy: { visibility: ['quiet', 'standard', 'debug'].includes(visibility) ? visibility : 'quiet' },
      model_policy: modelPolicy,
      memory_policy: { raw_trace: 'append_only', working_memory: 'compacted', durable_memory: 'proposal_only' },
      created_at: new Date().toISOString(),
    };
    const controller = new AbortController();
    const completion = this.engine.execute({ roomPaths: paths, spec, signal: controller.signal, onProgress })
      .finally(() => this.active.delete(paths.roomId));
    this.active.set(paths.roomId, { runId, controller, completion, paths, spec });
    return { room: paths, run_id: runId, spec, completion };
  }

  async resumeRun({ roomId, onProgress = null } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const inMemory = this.active.get(paths.roomId);
    if (inMemory) {
      const activeRun = readRoomRun(paths.roomStateRoot, inMemory.runId);
      if (activeRun) updateRoomRunControl(activeRun.paths, { status: 'running', reason: 'resume_in_memory' });
      return { room: paths, run_id: inMemory.runId, spec: inMemory.spec, completion: inMemory.completion, resumed: true };
    }
    const persisted = findActiveRoomRun(paths.roomStateRoot)
      || listRoomRuns(paths.roomStateRoot, { limit: 20 }).find((run) => ['failed', 'paused', 'running', 'awaiting_approval'].includes(run.state.status));
    if (!persisted) throw Object.assign(new Error('No resumable Room run found'), { code: 'ROOM_RUN_NOT_FOUND' });
    updateRoomRunControl(persisted.paths, { status: 'running', reason: 'resume_after_restart' });
    const controller = new AbortController();
    const completion = this.engine.execute({ roomPaths: paths, spec: persisted.spec, existingRun: persisted, signal: controller.signal, onProgress })
      .finally(() => this.active.delete(paths.roomId));
    this.active.set(paths.roomId, { runId: persisted.paths.runId, controller, completion, paths, spec: persisted.spec });
    return { room: paths, run_id: persisted.paths.runId, spec: persisted.spec, completion, resumed: true };
  }

  status(roomId) {
    const paths = this.getRoom(roomId, { create: true });
    const activeMemory = this.active.get(paths.roomId);
    const activeRun = activeMemory
      ? readRoomRun(paths.roomStateRoot, activeMemory.runId)
      : findActiveRoomRun(paths.roomStateRoot);
    const recent = listRoomRuns(paths.roomStateRoot, { limit: 5 });
    const focusRun = activeRun || recent[0] || null;
    const completed = new Set(focusRun?.state?.completed_stage_ids || []);
    const skipped = new Set(focusRun?.state?.skipped_stage_ids || []);
    const stages = focusRun?.spec?.execution_graph?.stages || [];
    const nextStage = stages.find((stage) => !completed.has(stage.stage_id) && !skipped.has(stage.stage_id)) || null;
    const doneCount = completed.size + skipped.size;
    return {
      room_id: paths.roomId,
      workspace_root: paths.workspaceRoot,
      state_root: paths.roomStateRoot,
      active_run_id: activeMemory?.runId || activeRun?.paths?.runId || null,
      active_state: activeRun?.state || null,
      focus_run_id: focusRun?.paths?.runId || null,
      focus_status: focusRun?.state?.status || null,
      objective: focusRun?.spec?.objective || '',
      topology_id: focusRun?.spec?.execution_graph?.topology_id || '',
      current_stage_id: focusRun?.state?.current_stage_id || null,
      next_stage_id: nextStage?.stage_id || null,
      stage_done_count: doneCount,
      stage_total: stages.length,
      open_blockers: focusRun?.workingMemory?.open_blockers || [],
      recent_runs: recent.map((run) => ({ run_id: run.paths.runId, status: run.state.status, objective: run.spec.objective, updated_at: run.state.updated_at })),
    };
  }

  timeline(roomId, { limit = 20, runId = '' } = {}) {
    const paths = this.getRoom(roomId, { create: true });
    const selected = cleanText(runId)
      ? readRoomRun(paths.roomStateRoot, cleanText(runId))
      : (findActiveRoomRun(paths.roomStateRoot) || listRoomRuns(paths.roomStateRoot, { limit: 1 })[0] || null);
    if (!selected || !fs.existsSync(selected.paths.eventsPath)) return { room_id: paths.roomId, run_id: null, events: [] };
    const rows = fs.readFileSync(selected.paths.eventsPath, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter((event) => [
        'run_started', 'run_resumed', 'stage_started', 'stage_output', 'stage_completed', 'stage_skipped',
        'stage_retry', 'stage_attempt_failed', 'review_feedback_delivered', 'review_feedback_consumed',
        'run_completed', 'run_completed_with_blockers', 'run_failed', 'run_cancelled', 'control_updated',
      ].includes(event.event_type));
    return {
      room_id: paths.roomId,
      run_id: selected.paths.runId,
      status: selected.state.status,
      objective: selected.spec.objective,
      events: rows.slice(-Math.max(1, Math.min(100, Number(limit) || 20))),
    };
  }

  control(roomId, action = '', reason = '') {
    const paths = this.getRoom(roomId, { create: true });
    const memory = this.active.get(paths.roomId);
    const activeRun = findActiveRoomRun(paths.roomStateRoot);
    const runPaths = activeRun?.paths;
    if (!memory && !runPaths) return { ok: false, reason: 'no_active_run' };
    const cleanAction = cleanText(action).toLowerCase();
    if (cleanAction === 'cancel') {
      if (memory?.controller) memory.controller.abort(reason || 'cancelled_by_user');
      if (runPaths) updateRoomRunControl(runPaths, { status: 'cancelled', reason: reason || 'cancelled_by_user' });
      return { ok: true, status: 'cancelled' };
    }
    if (!runPaths) {
      const current = this.active.get(paths.roomId);
      if (!current) return { ok: false, reason: 'run_state_not_materialized_yet' };
      return { ok: false, reason: 'control_not_ready' };
    }
    if (cleanAction === 'resume' && !memory) return { ok: false, reason: 'resume_requires_executor_restart' };
    const status = cleanAction === 'pause' ? 'paused' : cleanAction === 'resume' ? 'running' : '';
    if (!status) return { ok: false, reason: 'unsupported_control' };
    updateRoomRunControl(runPaths, { status, reason: reason || `user_${cleanAction}` });
    return { ok: true, status };
  }

  setVisibility(roomId, visibility = 'quiet') {
    const paths = this.getRoom(roomId, { create: true });
    const file = path.join(paths.roomStateRoot, 'preferences.json');
    const clean = ['debug', 'standard', 'quiet'].includes(cleanText(visibility).toLowerCase()) ? cleanText(visibility).toLowerCase() : 'quiet';
    writeJsonAtomic(file, { progress_visibility: clean, updated_at: new Date().toISOString() });
    return clean;
  }
}

export function formatRoomNativeStatus(status = {}) {
  const total = Number(status.stage_total || 0);
  const done = Number(status.stage_done_count || 0);
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  const rows = [
    `🏠 Room ${status.room_id || '-'}`,
    status.objective ? `목표: ${status.objective}` : '',
    `상태: ${status.focus_status || '실행 기록 없음'}`,
    status.focus_run_id ? `run: ${status.focus_run_id}` : '',
    status.topology_id ? `방식: ${status.topology_id}` : '',
    total > 0 ? `진행: ${done}/${total} (${percent}%)` : '',
    status.current_stage_id ? `현재 단계: ${status.current_stage_id}` : '',
    status.next_stage_id && status.next_stage_id !== status.current_stage_id ? `다음 단계: ${status.next_stage_id}` : '',
    Array.isArray(status.open_blockers) && status.open_blockers.length ? `미해결 blocker: ${status.open_blockers.length}` : '',
    `workspace: ${status.workspace_root || '-'}`,
  ].filter(Boolean);
  if (status.active_run_id) rows.push('', '제어: /room pause · /room cancel · /room timeline');
  else if (status.focus_run_id) rows.push('', '확인: /room timeline · 새 실행: /room run <목표>');
  else rows.push('', '시작: /room run <목표>');
  if (Array.isArray(status.recent_runs) && status.recent_runs.length > 1) {
    rows.push('', '최근 실행:');
    for (const run of status.recent_runs.slice(0, 3)) rows.push(`- ${run.run_id}: ${run.status} · ${String(run.objective || '').slice(0, 70)}`);
  }
  return rows.join('\n');
}

export function formatRoomNativeTimeline(timeline = {}) {
  if (!timeline.run_id) return '표시할 Room 실행 기록이 없습니다.';
  const labels = {
    run_started: '🚀 시작',
    run_resumed: '▶️ 재개',
    stage_started: '▶️ 단계 시작',
    stage_output: '  · 활동',
    stage_completed: '✅ 단계 완료',
    stage_skipped: '⏭️ 단계 건너뜀',
    stage_retry: '🔁 재시도',
    stage_attempt_failed: '⚠️ 시도 실패',
    review_feedback_delivered: '📨 리뷰 전달',
    review_feedback_consumed: '📥 리뷰 반영',
    run_completed: '🏁 완료',
    run_completed_with_blockers: '⚠️ blocker와 함께 완료',
    run_failed: '❌ 실패',
    run_cancelled: '🛑 취소',
    control_updated: '🎛️ 제어 변경',
  };
  const rows = [
    `🧭 Room timeline · ${timeline.run_id}`,
    timeline.objective ? `목표: ${timeline.objective}` : '',
    `상태: ${timeline.status || '-'}`,
    '',
  ].filter((value, index) => value || index === 3);
  for (const event of timeline.events || []) {
    const label = labels[event.event_type] || event.event_type;
    const stage = event.stage_id ? ` · ${event.stage_id}` : '';
    const provider = event.provider ? ` · ${event.provider}${event.role ? `/${event.role}` : ''}` : '';
    const kind = event.event_type === 'stage_output' && event.output_kind ? ` · ${event.output_kind}` : '';
    let time = '';
    try {
      time = event.at ? new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      }).format(new Date(event.at)) : '';
    } catch {}
    const message = cleanText(event.message || event.summary || event.reason || event.error?.message || '');
    rows.push(`${time ? `${time} ` : ''}${label}${stage}${provider}${kind}${message ? ` — ${message.slice(0, 280)}` : ''}`);
  }
  return rows.join('\n');
}
