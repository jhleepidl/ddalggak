import fs from 'node:fs';
import path from 'node:path';
import { extractRoomLearningSignals } from './room_evolution.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value = '', { maxLen = 1000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

function safeId(value = '') {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._:-]+/g, '_').slice(0, 120) || 'unknown';
}

export function buildRoomUsageEvent({ chatId = '', userId = '', eventType = 'room_event', command = '', goal = '', profile = null, recommendation = null, extra = {} } = {}) {
  const prof = asObject(profile);
  const ex = asObject(extra);
  const signalPack = extractRoomLearningSignals({
    text: goal,
    command,
    workMode: ex.depth || ex.work_mode || ex.workMode || '',
    attachments: ex.attachments || [],
    userFeedback: ex.user_feedback || ex.userFeedback || '',
    currentRoom: prof,
  });
  return {
    kind: 'room_usage_event_v1',
    ts: new Date().toISOString(),
    chat_id: String(chatId || ''),
    user_id: String(userId || ''),
    event_type: cleanText(eventType, { maxLen: 80 }),
    command: cleanText(command, { maxLen: 80 }),
    goal: cleanText(goal, { maxLen: 1000 }),
    room: prof.kind ? {
      name: prof.name || '',
      domain_label: prof.domain_label || 'general_workbench',
      default_depth: prof.default_depth || 'ask',
      default_agents: Array.isArray(prof.default_agents) ? prof.default_agents : [],
      memory_object_types: Array.isArray(prof.memory_schema?.object_types) ? prof.memory_schema.object_types : [],
      package_id: prof.package_id || '',
    } : null,
    recommendation: recommendation || null,
    signal_pack: signalPack,
    evolution: {
      formation_mode: 'emergent_from_interactions',
      ai_role: 'architect_advisor_proposer_not_controller',
      auto_apply: false,
      schema_is_dynamic: true,
      private_content_export: 'never_by_default',
    },
    extra: ex,
  };
}

export function appendRoomUsageEvent(event = {}, { rootDir = process.env.DDALGGAK_ROOM_EVENTS_DIR || 'runs/room_events' } = {}) {
  const row = asObject(event);
  const chatId = safeId(row.chat_id || 'unknown');
  const dir = path.resolve(process.cwd(), rootDir, chatId);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'events.jsonl');
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return file;
}

export function summarizeRoomUsage(events = []) {
  const rows = Array.isArray(events) ? events : [];
  const domains = new Set();
  let corrections = 0;
  let approvals = 0;
  let continuationAttempts = 0;
  let continuationCompletions = 0;
  let sourceBoundaryViews = 0;
  let rulesViews = 0;
  let briefViews = 0;
  let branchProposals = 0;
  for (const row of rows) {
    const ev = asObject(row);
    const type = String(ev.event_type || ev.command || '').toLowerCase();
    if (ev.room?.domain_label) domains.add(ev.room.domain_label);
    const pack = asObject(ev.signal_pack);
    if (/correction|retry|reject|branch/i.test(type) || pack.correction_signal) corrections += 1;
    if (/approve|promote|accept|apply/i.test(type)) approvals += 1;
    if (type.includes('room_continuation_requested')) continuationAttempts += 1;
    if (type.includes('room_continuation_completed')) continuationCompletions += 1;
    if (type.includes('room_source_boundary_view')) sourceBoundaryViews += 1;
    if (type.includes('room_rules_view')) rulesViews += 1;
    if (type.includes('room_continuity_brief_view')) briefViews += 1;
    if (type.includes('room_branch_proposed')) branchProposals += 1;
  }
  return {
    task_count: rows.length,
    correction_count: corrections,
    approval_count: approvals,
    distinct_domains: domains.size,
    continuity: {
      continuation_attempt_count: continuationAttempts,
      continuation_completion_count: continuationCompletions,
      continuation_completion_rate: continuationAttempts > 0 ? continuationCompletions / continuationAttempts : null,
      brief_view_count: briefViews,
      source_boundary_view_count: sourceBoundaryViews,
      rules_view_count: rulesViews,
      branch_proposal_count: branchProposals,
    },
  };
}

export function readRoomUsageEvents(chatId = 'unknown', { rootDir = process.env.DDALGGAK_ROOM_EVENTS_DIR || 'runs/room_events', limit = 200 } = {}) {
  const safeChatId = safeId(chatId || 'unknown');
  const file = path.resolve(process.cwd(), rootDir, safeChatId, 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  const rows = [];
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const text = line.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {}
  }
  const n = Math.max(1, Math.min(Number(limit) || 200, 2000));
  return rows.length > n ? rows.slice(rows.length - n) : rows;
}
