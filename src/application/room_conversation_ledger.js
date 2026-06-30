import fs from 'node:fs';
import path from 'node:path';

import { updateCurrentTaskPacket } from './task_packet.js';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 4000) {
  const text = String(value || '').trim();
  const n = Math.max(80, Math.floor(Number(max) || 4000));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function ensureDir(dir = '') {
  if (!dir) return '';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
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

function localMemoryDir(jobDir = '') {
  const cleanJobDir = String(jobDir || '').trim();
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'local_memory')) : '';
}

function sharedDir(jobDir = '') {
  const cleanJobDir = String(jobDir || '').trim();
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'shared')) : '';
}

function turnId({ chatId = '', role = '', text = '', ts = '', source = '' } = {}) {
  const key = `${chatId}\n${role}\n${clean(text).slice(0, 240)}\n${source}\n${ts}`;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return `room_turn_${Math.abs(hash).toString(36)}`;
}

export function normalizeRecentRoomTurns(raw = []) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const role = clean(row.role || row.author).toLowerCase();
    const text = clip(row.text || row.content || row.message || '', 2400);
    if (!['user', 'assistant', 'system'].includes(role) || !text) continue;
    const normalized = {
      turn_id: clean(row.turn_id || row.turnId || row.id) || turnId({ chatId: row.chat_id || row.chatId || '', role, text, ts: row.ts || row.created_at || '', source: row.source || '' }),
      ts: clean(row.ts || row.created_at || row.createdAt) || new Date().toISOString(),
      role,
      text,
      command: clean(row.command || row.source_command || row.sourceCommand) || undefined,
      source: clean(row.source) || 'room_conversation_ledger',
      provider: clean(row.provider).toLowerCase() || undefined,
      model: clean(row.model) || undefined,
      route: clean(row.route) || undefined,
      job_id: clean(row.job_id || row.jobId) || undefined,
      chat_id: clean(row.chat_id || row.chatId) || undefined,
      user_id: clean(row.user_id || row.userId) || undefined,
      semantic_observations: Array.isArray(row.semantic_observations || row.semanticObservations) ? (row.semantic_observations || row.semanticObservations).filter(Boolean).slice(-12) : undefined,
    };
    if (seen.has(normalized.turn_id)) continue;
    seen.add(normalized.turn_id);
    out.push(normalized);
  }
  return out.slice(-24);
}

export function appendSessionRoomTurn(sessionStore, chatId = '', turn = {}) {
  if (!sessionStore || typeof sessionStore.upsert !== 'function') return null;
  const normalizedTurns = normalizeRecentRoomTurns([{
    ...turn,
    chat_id: chatId,
  }]);
  const normalized = normalizedTurns[0];
  if (!normalized) return null;
  return sessionStore.upsert(chatId, (session = {}) => {
    const existing = normalizeRecentRoomTurns(session.recent_room_turns || session.recentRoomTurns || []);
    const merged = normalizeRecentRoomTurns([...existing, normalized]);
    return {
      ...session,
      recent_room_turns: merged,
      last_room_turn: normalized,
    };
  });
}

function appendJobTurn({ jobDir = '', turn = {}, writeConversation = true } = {}) {
  const cleanJobDir = String(jobDir || '').trim();
  if (!cleanJobDir || !turn?.text) return false;
  const localDir = localMemoryDir(cleanJobDir);
  const shared = sharedDir(cleanJobDir);
  const turnsFile = path.join(localDir, 'turns.jsonl');
  const ledgerFile = path.join(localDir, 'room_turn_ledger.jsonl');
  const sharedLedgerFile = path.join(shared, 'room_turn_ledger.jsonl');
  const conversationFile = path.join(cleanJobDir, 'conversation.jsonl');
  const row = {
    ts: turn.ts || new Date().toISOString(),
    role: turn.role,
    text: turn.text,
    source: turn.source || 'room_conversation_ledger',
    command: turn.command || undefined,
    provider: turn.provider || undefined,
    model: turn.model || undefined,
    route: turn.route || undefined,
    turn_id: turn.turn_id || undefined,
  };
  appendJsonl(turnsFile, row);
  appendJsonl(ledgerFile, { ...turn, ts: row.ts });
  appendJsonl(sharedLedgerFile, { ...turn, ts: row.ts });
  if (writeConversation) {
    appendJsonl(conversationFile, {
      ts: row.ts,
      role: row.role,
      text: row.text,
      kind: row.source || 'room_conversation_turn',
      command: row.command,
      provider: row.provider,
      model: row.model,
      route: row.route,
      turn_id: row.turn_id,
    });
  }
  return true;
}

export function appendRoomConversationTurn({
  jobDir = '',
  chatSessionStore = null,
  chatId = '',
  userId = '',
  role = '',
  text = '',
  command = '',
  source = 'room_concierge_fast_path',
  provider = '',
  model = '',
  route = '',
  jobId = '',
  writeConversation = true,
  updatePacket = true,
  semanticObservations = null,
} = {}) {
  const normalizedRole = clean(role).toLowerCase();
  const cleanText = clip(text, normalizedRole === 'assistant' ? 4000 : 2400);
  if (!['user', 'assistant', 'system'].includes(normalizedRole) || !cleanText) return null;
  const ts = new Date().toISOString();
  const row = {
    turn_id: turnId({ chatId, role: normalizedRole, text: cleanText, ts, source }),
    ts,
    role: normalizedRole,
    text: cleanText,
    command: clean(command) || undefined,
    source: clean(source) || 'room_conversation_ledger',
    provider: clean(provider).toLowerCase() || undefined,
    model: clean(model) || undefined,
    route: clean(route) || undefined,
    job_id: clean(jobId) || undefined,
    chat_id: clean(chatId) || undefined,
    user_id: clean(userId) || undefined,
    semantic_observations: Array.isArray(semanticObservations) ? semanticObservations.filter(Boolean).slice(-12) : undefined,
  };
  appendSessionRoomTurn(chatSessionStore, chatId, row);
  appendJobTurn({ jobDir, turn: row, writeConversation });
  if (updatePacket && jobDir) {
    try { updateCurrentTaskPacket({ jobDir, currentUserText: '', runMeta: {}, persist: true }); } catch {}
  }
  return row;
}

export function appendRoomConversationExchange({
  jobDir = '',
  chatSessionStore = null,
  chatId = '',
  userId = '',
  userText = '',
  assistantText = '',
  command = '',
  source = 'room_concierge_fast_path',
  provider = '',
  model = '',
  route = '',
  jobId = '',
  skipUserTurn = false,
  userSemanticObservations = null,
  assistantSemanticObservations = null,
} = {}) {
  const userTurn = skipUserTurn ? null : appendRoomConversationTurn({
    jobDir,
    chatSessionStore,
    chatId,
    userId,
    role: 'user',
    text: userText,
    command,
    source,
    provider,
    model,
    route,
    jobId,
    updatePacket: false,
    semanticObservations: userSemanticObservations,
  });
  const assistantTurn = appendRoomConversationTurn({
    jobDir,
    chatSessionStore,
    chatId,
    userId,
    role: 'assistant',
    text: assistantText,
    command,
    source,
    provider,
    model,
    route,
    jobId,
    updatePacket: false,
    semanticObservations: assistantSemanticObservations,
  });
  if (jobDir) {
    try { updateCurrentTaskPacket({ jobDir, currentUserText: '', runMeta: {}, persist: true }); } catch {}
  }
  return { userTurn, assistantTurn };
}



export function readRoomConversationLedger({ jobDir = '', session = null, limit = 8 } = {}) {
  const cleanJobDir = String(jobDir || '').trim();
  const maxRows = Math.max(1, Math.floor(Number(limit) || 8));
  const rows = [];
  const seen = new Set();
  const pushRows = (items = []) => {
    for (const row of normalizeRecentRoomTurns(items)) {
      const key = row.turn_id || `${row.role}:${clean(row.text).slice(0, 240)}:${row.ts}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(row);
    }
  };
  if (cleanJobDir) {
    pushRows(readJsonl(path.join(localMemoryDir(cleanJobDir), 'room_turn_ledger.jsonl')));
    pushRows(readJsonl(path.join(sharedDir(cleanJobDir), 'room_turn_ledger.jsonl')));
    pushRows(readJsonl(path.join(localMemoryDir(cleanJobDir), 'turns.jsonl')));
  }
  if (session && typeof session === 'object') {
    pushRows(session.recent_room_turns || session.recentRoomTurns || []);
  }
  return rows
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')))
    .slice(-maxRows);
}

export function formatRoomContinuityPromptBlock({ jobDir = '', session = null, limit = 8, maxChars = 1600 } = {}) {
  const turns = readRoomConversationLedger({ jobDir, session, limit });
  if (!turns.length) return '';
  const rendered = turns.map((turn) => {
    const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'system' ? 'system' : 'user';
    const route = turn.route ? ` · route=${turn.route}` : '';
    const command = turn.command ? ` · ${turn.command}` : '';
    return `- ${role}${command}${route}: ${clip(turn.text, role === 'assistant' ? 360 : 280)}`;
  }).join('\n');
  return clip([
    '[ROOM CONTINUITY — HIGH PRIORITY]',
    'Recent same-chat turns, including direct Room Concierge fast-path turns. Use this before claiming that prior context is missing.',
    'If the latest user omits a referent, constraint, or preference and recent same-chat turns provide it, carry it forward unless contradicted.',
    rendered,
  ].join('\n'), Math.max(400, Math.floor(Number(maxChars) || 1600)));
}

export function seedRoomConversationLedgerIntoJob({ jobDir = '', session = {}, maxTurns = 12, source = 'session_recent_room_turns' } = {}) {
  const cleanJobDir = String(jobDir || '').trim();
  if (!cleanJobDir) return { seeded: 0, skipped: true, reason: 'missing_job_dir' };
  const turns = normalizeRecentRoomTurns(session?.recent_room_turns || session?.recentRoomTurns || []).slice(-Math.max(1, Math.floor(Number(maxTurns) || 12)));
  if (turns.length === 0) return { seeded: 0, skipped: true, reason: 'no_recent_room_turns' };
  const ledgerFile = path.join(localMemoryDir(cleanJobDir), 'room_turn_ledger.jsonl');
  const existingIds = new Set(readJsonl(ledgerFile).map((row) => clean(row.turn_id || row.turnId)).filter(Boolean));
  let seeded = 0;
  for (const turn of turns) {
    if (existingIds.has(turn.turn_id)) continue;
    existingIds.add(turn.turn_id);
    appendJobTurn({ jobDir: cleanJobDir, turn: { ...turn, source: turn.source || source }, writeConversation: false });
    seeded += 1;
  }
  if (seeded > 0) {
    try { updateCurrentTaskPacket({ jobDir: cleanJobDir, currentUserText: '', runMeta: {}, persist: true }); } catch {}
  }
  return { seeded, skipped: false };
}
