import fs from 'node:fs';
import path from 'node:path';

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
    extra: asObject(extra),
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
  for (const row of rows) {
    const ev = asObject(row);
    if (ev.room?.domain_label) domains.add(ev.room.domain_label);
    if (/correction|retry|reject|branch/i.test(ev.event_type || ev.command || '')) corrections += 1;
    if (/approve|promote|accept|apply/i.test(ev.event_type || ev.command || '')) approvals += 1;
  }
  return {
    task_count: rows.length,
    correction_count: corrections,
    approval_count: approvals,
    distinct_domains: domains.size,
  };
}
