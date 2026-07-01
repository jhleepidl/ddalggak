import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 1200) {
  const text = String(value || '').trim();
  const n = Math.max(80, Math.floor(Number(max) || 1200));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function ensureDir(dir = '') {
  if (!dir) return '';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localMemoryDir(jobDir = '') {
  const cleanJobDir = String(jobDir || '').trim();
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'local_memory')) : '';
}

function sharedDir(jobDir = '') {
  const cleanJobDir = String(jobDir || '').trim();
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'shared')) : '';
}

function appendJsonl(filePath = '', row = {}) {
  if (!filePath || !row || typeof row !== 'object') return false;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return true;
}

function readJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function asList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export function createRoomLoopId({ chatId = '', objective = '', source = '' } = {}) {
  const seed = `${clean(chatId)}\n${clean(objective).slice(0, 320)}\n${clean(source)}\n${Date.now()}`;
  return `room_loop_${tinyHash(seed)}`;
}

export function normalizeRoomLoopStatus(status = '') {
  const key = clean(status).toLowerCase();
  if (['running', 'active'].includes(key)) return 'running';
  if (['paused', 'blocked', 'completed', 'cancelled', 'rejected'].includes(key)) return key;
  if (['approved', 'accepted'].includes(key)) return 'running';
  if (['forked'].includes(key)) return 'forked';
  return 'running';
}

export function normalizeRoomLoop(loop = {}) {
  if (!loop || typeof loop !== 'object') return null;
  const loopId = clean(loop.loop_id || loop.loopId || loop.id);
  const objective = clip(loop.objective || loop.goal || loop.task || '', 600);
  if (!loopId && !objective) return null;
  return {
    kind: 'room_loop_v1',
    loop_id: loopId || createRoomLoopId({ chatId: loop.chat_id || loop.chatId || '', objective, source: loop.source || 'normalize_room_loop' }),
    room_id: clean(loop.room_id || loop.roomId || loop.chat_id || loop.chatId) || undefined,
    chat_id: clean(loop.chat_id || loop.chatId) || undefined,
    objective,
    status: normalizeRoomLoopStatus(loop.status || 'running'),
    controller: clean(loop.controller || 'user') || 'user',
    command: clean(loop.command || '') || undefined,
    source: clean(loop.source || '') || undefined,
    model_policy: loop.model_policy && typeof loop.model_policy === 'object' ? loop.model_policy : {},
    budget_policy: loop.budget_policy && typeof loop.budget_policy === 'object' ? loop.budget_policy : {},
    current_plan: asList(loop.current_plan || loop.currentPlan).map((item) => clip(item, 260)).filter(Boolean).slice(-12),
    active_constraints: asList(loop.active_constraints || loop.activeConstraints).map((item) => clip(item, 220)).filter(Boolean).slice(-12),
    trace_refs: asList(loop.trace_refs || loop.traceRefs).map((item) => clean(item)).filter(Boolean).slice(-24),
    interruptions: asList(loop.interruptions).filter((item) => item && typeof item === 'object').slice(-24),
    branches: asList(loop.branches).filter((item) => item && typeof item === 'object').slice(-12),
    lessons: asList(loop.lessons).filter(Boolean).slice(-12),
    created_at: clean(loop.created_at || loop.createdAt) || new Date().toISOString(),
    updated_at: clean(loop.updated_at || loop.updatedAt) || new Date().toISOString(),
  };
}

function normalizeInterruptType(type = '') {
  const key = clean(type).toLowerCase();
  if (['pause', 'resume', 'redirect', 'constraint_update', 'fork', 'approve', 'reject', 'cancel', 'status_update'].includes(key)) return key;
  return key || 'constraint_update';
}

export function buildRoomLoopStartEvent({
  loop = null,
  chatId = '',
  userId = '',
  jobId = '',
  command = '/loop',
  source = 'telegram_loop',
} = {}) {
  const normalizedLoop = normalizeRoomLoop(loop || {});
  if (!normalizedLoop) return null;
  return {
    kind: 'room_loop_event_v1',
    event_id: `room_loop_event_${tinyHash(`${normalizedLoop.loop_id}\nstart\n${Date.now()}`)}`,
    ts: new Date().toISOString(),
    event_type: 'loop_started',
    loop_id: normalizedLoop.loop_id,
    chat_id: clean(chatId || normalizedLoop.chat_id) || undefined,
    user_id: clean(userId) || undefined,
    job_id: clean(jobId) || undefined,
    command: clean(command || normalizedLoop.command) || undefined,
    source: clean(source) || 'room_loop_events',
    loop: normalizedLoop,
  };
}

export function classifyRoomLoopInterruption({ text = '', command = '', activeLoop = null } = {}) {
  const message = clean(text);
  if (!message || !activeLoop?.loop_id) return null;
  const lower = message.toLowerCase();
  const cmd = clean(command).toLowerCase();
  let interruptType = '';
  let targetStatus = '';
  let reason = '';

  if (cmd === '/pause' || /^(pause|잠깐|멈춰|중단|정지)(\s|$)/i.test(message)) {
    interruptType = 'pause'; targetStatus = 'paused'; reason = 'user_requested_pause';
  } else if (cmd === '/resume' || /^(resume|계속|재개|이어\s*서|다시\s*시작)(\s|$)/i.test(message)) {
    interruptType = 'resume'; targetStatus = 'running'; reason = 'user_requested_resume';
  } else if (cmd === '/approve' || /^(approve|승인|좋아|진행해|go)(\s|$)/i.test(message)) {
    interruptType = 'approve'; targetStatus = 'running'; reason = 'user_approved_continuation';
  } else if (/^(reject|거절|취소|cancel|그만)(\s|$)/i.test(message)) {
    interruptType = 'reject'; targetStatus = 'rejected'; reason = 'user_rejected_or_cancelled_loop';
  } else if (/\b(fork|branch)\b|분기|다른\s*안|대안|B안|비교해|따로\s*검토/i.test(message)) {
    interruptType = 'fork'; reason = 'user_requested_branch';
  } else if (/바꿔|변경|수정|대신|제외|빼고|추가|조건|예산|budget|constraint|근거|검색\s*기준|목표|방향|우선순위/i.test(message)) {
    interruptType = /목표|방향|대신|바꿔|변경/.test(message) ? 'redirect' : 'constraint_update';
    reason = interruptType === 'redirect' ? 'user_redirected_loop_goal' : 'user_updated_loop_constraints';
  }
  if (!interruptType) return null;
  const payload = {
    text: clip(message, 1000),
    reason,
  };
  if (targetStatus) payload.target_status = targetStatus;
  if (interruptType === 'fork') payload.branch_objective = clip(message.replace(/^(fork|branch)\s*/i, '').trim() || message, 500);
  if (interruptType === 'constraint_update' || interruptType === 'redirect') payload.new_constraint = clip(message, 500);
  return buildRoomLoopEvent({
    eventType: 'user_interrupt',
    interruptType,
    loopId: activeLoop.loop_id,
    payload,
    command,
    source: 'room_loop_interruption_classifier',
  });
}

export function buildRoomLoopEvent({
  eventType = 'user_interrupt',
  interruptType = '',
  loopId = '',
  chatId = '',
  userId = '',
  jobId = '',
  command = '',
  source = 'room_loop_events',
  payload = {},
} = {}) {
  const normalizedLoopId = clean(loopId || payload?.loop_id || payload?.loopId);
  if (!normalizedLoopId) return null;
  const normalizedInterruptType = normalizeInterruptType(interruptType || payload?.interrupt_type || payload?.interruptType || '');
  const ts = new Date().toISOString();
  return {
    kind: 'room_loop_event_v1',
    event_id: `room_loop_event_${tinyHash(`${normalizedLoopId}\n${eventType}\n${normalizedInterruptType}\n${ts}\n${JSON.stringify(payload || {})}`)}`,
    ts,
    event_type: clean(eventType) || 'user_interrupt',
    interrupt_type: normalizedInterruptType || undefined,
    loop_id: normalizedLoopId,
    chat_id: clean(chatId) || undefined,
    user_id: clean(userId) || undefined,
    job_id: clean(jobId) || undefined,
    command: clean(command) || undefined,
    source: clean(source) || 'room_loop_events',
    payload: payload && typeof payload === 'object' ? payload : {},
  };
}

export function applyRoomLoopEvent(loop = null, event = {}) {
  const current = normalizeRoomLoop(loop || event?.loop || {});
  if (!current && event?.event_type !== 'loop_started') return null;
  if (event?.event_type === 'loop_started') return normalizeRoomLoop(event.loop || current || {});
  const next = normalizeRoomLoop(current || {});
  if (!next) return null;
  const interruptType = normalizeInterruptType(event.interrupt_type || event.payload?.interrupt_type || '');
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  next.updated_at = event.ts || new Date().toISOString();
  if (event.event_type === 'loop_trace') {
    const ref = clean(payload.trace_ref || payload.traceRef || event.event_id);
    if (ref && !next.trace_refs.includes(ref)) next.trace_refs.push(ref);
    return next;
  }
  if (event.event_type !== 'user_interrupt' && event.event_type !== 'loop_status_changed') return next;
  const interruption = {
    event_id: clean(event.event_id) || undefined,
    ts: clean(event.ts) || undefined,
    interrupt_type: interruptType,
    text: clip(payload.text || payload.new_constraint || payload.branch_objective || '', 500),
    target_status: clean(payload.target_status || '') || undefined,
    source: clean(event.source || '') || undefined,
  };
  next.interruptions.push(interruption);
  next.interruptions = next.interruptions.slice(-24);
  if (interruptType === 'pause') next.status = 'paused';
  if (interruptType === 'resume' || interruptType === 'approve') next.status = 'running';
  if (interruptType === 'reject' || interruptType === 'cancel') next.status = 'rejected';
  if (interruptType === 'constraint_update') {
    const constraint = clip(payload.new_constraint || payload.text || '', 500);
    if (constraint && !next.active_constraints.some((item) => clean(item).toLowerCase() === clean(constraint).toLowerCase())) next.active_constraints.push(constraint);
    next.status = 'running';
    next.current_plan = [`Recompile plan with updated constraint: ${constraint || 'user-updated loop constraint'}`];
  }
  if (interruptType === 'redirect') {
    const objective = clip(payload.new_constraint || payload.text || '', 600);
    if (objective) next.objective = objective;
    next.status = 'running';
    next.current_plan = [`Replan from redirected objective: ${objective || next.objective}`];
  }
  if (interruptType === 'fork') {
    const branchObjective = clip(payload.branch_objective || payload.text || '', 600);
    const branchId = `branch_${tinyHash(`${next.loop_id}\n${branchObjective}\n${event.ts || ''}`)}`;
    next.branches.push({ branch_id: branchId, objective: branchObjective || next.objective, source_event_id: event.event_id, status: 'open' });
    next.branches = next.branches.slice(-12);
    next.status = 'running';
  }
  return next;
}

export function normalizeRoomLoopEvents(raw = []) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const loopId = clean(row.loop_id || row.loopId || row.loop?.loop_id || row.loop?.loopId);
    const eventType = clean(row.event_type || row.eventType || row.type);
    if (!loopId || !eventType) continue;
    const ts = clean(row.ts || row.created_at || row.createdAt) || new Date().toISOString();
    const event = {
      kind: 'room_loop_event_v1',
      event_id: clean(row.event_id || row.eventId || row.id) || `room_loop_event_${tinyHash(`${loopId}\n${eventType}\n${ts}`)}`,
      ts,
      event_type: eventType,
      interrupt_type: clean(row.interrupt_type || row.interruptType || row.payload?.interrupt_type || row.payload?.interruptType) || undefined,
      loop_id: loopId,
      chat_id: clean(row.chat_id || row.chatId) || undefined,
      user_id: clean(row.user_id || row.userId) || undefined,
      job_id: clean(row.job_id || row.jobId) || undefined,
      command: clean(row.command) || undefined,
      source: clean(row.source) || 'room_loop_events',
      loop: row.loop && typeof row.loop === 'object' ? normalizeRoomLoop(row.loop) : undefined,
      payload: row.payload && typeof row.payload === 'object' ? row.payload : {},
    };
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    out.push(event);
  }
  return out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).slice(-200);
}

export function appendRoomLoopEvent({ jobDir = '', chatSessionStore = null, chatId = '', userId = '', jobId = '', event = null } = {}) {
  const normalized = normalizeRoomLoopEvents([{ ...(event || {}), chat_id: chatId || event?.chat_id, user_id: userId || event?.user_id, job_id: jobId || event?.job_id }])[0];
  if (!normalized) return null;
  const cleanJobDir = clean(jobDir);
  if (cleanJobDir) {
    const localFile = path.join(localMemoryDir(cleanJobDir), 'room_loop_events.jsonl');
    const sharedFile = path.join(sharedDir(cleanJobDir), 'room_loop_events.jsonl');
    appendJsonl(localFile, normalized);
    appendJsonl(sharedFile, normalized);
  }
  if (chatSessionStore && typeof chatSessionStore.upsert === 'function') {
    chatSessionStore.upsert(chatId || normalized.chat_id || '', (session = {}) => {
      const existing = normalizeRoomLoopEvents(session.room_loop_events || session.roomLoopEvents || []);
      const events = normalizeRoomLoopEvents([...existing, normalized]).slice(-80);
      const activeLoop = deriveActiveRoomLoop({ events });
      return {
        ...session,
        room_loop_events: events,
        active_room_loop: activeLoop || session.active_room_loop || session.activeRoomLoop || null,
      };
    });
  }
  return normalized;
}

export function readRoomLoopEvents({ jobDir = '', session = null, limit = 80 } = {}) {
  const maxRows = Math.max(1, Math.floor(Number(limit) || 80));
  const rows = [];
  const seen = new Set();
  const pushRows = (items = []) => {
    for (const event of normalizeRoomLoopEvents(items)) {
      const key = event.event_id || `${event.loop_id}:${event.event_type}:${event.ts}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(event);
    }
  };
  const cleanJobDir = clean(jobDir);
  if (cleanJobDir) {
    pushRows(readJsonl(path.join(localMemoryDir(cleanJobDir), 'room_loop_events.jsonl')));
    pushRows(readJsonl(path.join(sharedDir(cleanJobDir), 'room_loop_events.jsonl')));
  }
  if (session && typeof session === 'object') pushRows(session.room_loop_events || session.roomLoopEvents || []);
  return rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).slice(-maxRows);
}

export function deriveActiveRoomLoop({ events = [], session = null } = {}) {
  const sessionLoop = normalizeRoomLoop(session?.active_room_loop || session?.activeRoomLoop || null);
  const byLoop = new Map();
  if (sessionLoop) byLoop.set(sessionLoop.loop_id, sessionLoop);
  for (const event of normalizeRoomLoopEvents(events)) {
    const prev = byLoop.get(event.loop_id) || null;
    const next = applyRoomLoopEvent(prev, event);
    if (next) byLoop.set(next.loop_id, next);
  }
  const loops = [...byLoop.values()]
    .filter((loop) => loop && !['completed', 'cancelled', 'rejected'].includes(loop.status))
    .sort((a, b) => String(a.updated_at || a.created_at || '').localeCompare(String(b.updated_at || b.created_at || '')));
  return loops.length ? loops[loops.length - 1] : null;
}

export function formatActiveRoomLoopProjectionBlock({ loop = null, maxChars = 1200 } = {}) {
  const activeLoop = normalizeRoomLoop(loop || {});
  if (!activeLoop) return '';
  const lastInterruptions = activeLoop.interruptions.slice(-3);
  const lines = [
    '[ACTIVE ROOM LOOP]',
    `loop_id: ${activeLoop.loop_id}`,
    `status: ${activeLoop.status}`,
    `objective: ${clip(activeLoop.objective, 420)}`,
    activeLoop.controller ? `controller: ${activeLoop.controller}` : '',
    activeLoop.current_plan.length ? '[CURRENT LOOP PLAN]' : '',
    ...activeLoop.current_plan.slice(-5).map((item) => `- ${clip(item, 180)}`),
    activeLoop.active_constraints.length ? '[ACTIVE LOOP CONSTRAINTS]' : '',
    ...activeLoop.active_constraints.slice(-5).map((item) => `- ${clip(item, 180)}`),
    lastInterruptions.length ? '[RECENT LOOP INTERRUPTIONS]' : '',
    ...lastInterruptions.map((item) => `- ${item.interrupt_type || 'interrupt'}: ${clip(item.text || item.target_status || '', 180)}`),
    activeLoop.branches.length ? '[OPEN LOOP BRANCHES]' : '',
    ...activeLoop.branches.slice(-4).map((item) => `- ${item.branch_id || 'branch'}: ${clip(item.objective || '', 180)}`),
    'loop_policy: Treat typed loop interruptions as authoritative control-plane events. Recompile the plan from the active loop objective and constraints before continuing stale work.',
  ].filter(Boolean);
  return clip(lines.join('\n'), Math.max(360, Math.floor(Number(maxChars) || 1200)));
}

export default {
  createRoomLoopId,
  normalizeRoomLoop,
  buildRoomLoopStartEvent,
  buildRoomLoopEvent,
  classifyRoomLoopInterruption,
  applyRoomLoopEvent,
  appendRoomLoopEvent,
  readRoomLoopEvents,
  deriveActiveRoomLoop,
  formatActiveRoomLoopProjectionBlock,
};
