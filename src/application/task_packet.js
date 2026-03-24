import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';

function safe(value = '') {
  return String(value || '').trim();
}

function ensureDir(dirPath = '') {
  if (!dirPath) return '';
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readText(filePath = '') {
  try {
    return filePath && fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function parseJsonMaybe(text = '') {
  const raw = safe(text);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function normalizeQuote(text = '', maxChars = 260) {
  return clip(String(text || '').replace(/\s+/g, ' ').trim(), Math.max(80, Math.floor(Number(maxChars) || 260)));
}

function uniqQuotes(values = [], { maxItems = 8, maxChars = 260 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const quote = normalizeQuote(raw, maxChars);
    if (!quote) continue;
    const key = quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(quote);
    if (out.length >= Math.max(1, Math.floor(Number(maxItems) || 8))) break;
  }
  return out;
}

function localMemoryDir(jobDir = '') {
  const clean = safe(jobDir);
  return clean ? ensureDir(path.join(clean, 'local_memory')) : '';
}

function sharedDir(jobDir = '') {
  const clean = safe(jobDir);
  return clean ? ensureDir(path.join(clean, 'shared')) : '';
}

function packetFile(jobDir = '') {
  const dir = localMemoryDir(jobDir);
  return dir ? path.join(dir, 'current_task_packet.json') : '';
}

function packetHistoryFile(jobDir = '') {
  const dir = localMemoryDir(jobDir);
  return dir ? path.join(dir, 'task_packet_history.jsonl') : '';
}

function sharedPacketFile(jobDir = '') {
  const dir = sharedDir(jobDir);
  return dir ? path.join(dir, 'current_task_packet.json') : '';
}

function overrideFiles(jobDir = '') {
  const clean = safe(jobDir);
  if (!clean) return [];
  return [
    path.join(clean, 'shared', 'current_task_packet.override.json'),
    path.join(clean, 'workspace', '.orchestrator', 'current_task_packet.override.json'),
  ];
}

function normalizeTurn(row = {}) {
  const data = asObject(row);
  return {
    role: safe(data.role || data.author || data.agent || 'user').toLowerCase() || 'user',
    text: safe(data.text || data.content),
    ts: safe(data.ts || data.created_at),
  };
}

function loadTurns(jobDir = '') {
  const filePath = localMemoryDir(jobDir) ? path.join(localMemoryDir(jobDir), 'turns.jsonl') : '';
  const raw = readText(filePath);
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parsed = parseJsonMaybe(line);
    if (!parsed || typeof parsed !== 'object') continue;
    const turn = normalizeTurn(parsed);
    if (!turn.text) continue;
    rows.push(turn);
  }
  return rows;
}

function loadPacket(jobDir = '') {
  const packet = asObject(parseJsonMaybe(readText(packetFile(jobDir))));
  if (Object.keys(packet).length > 0) return packet;
  return asObject(parseJsonMaybe(readText(sharedPacketFile(jobDir))));
}

function loadOverridePacket(jobDir = '', runMeta = {}) {
  const meta = asObject(runMeta);
  const inline = asObject(meta.taskPacket || meta.task_packet || meta.currentTaskPacket || meta.current_task_packet);
  const sources = [inline];
  for (const filePath of overrideFiles(jobDir)) {
    const parsed = asObject(parseJsonMaybe(readText(filePath)));
    if (Object.keys(parsed).length > 0) sources.push(parsed);
  }
  const merged = {};
  for (const source of sources) {
    if (!source || Object.keys(source).length === 0) continue;
    Object.assign(merged, source);
  }
  return merged;
}

function findInitialRequest(userTurns = []) {
  for (const row of asArray(userTurns)) {
    if (/^\/chat\b/i.test(row.text)) return row.text;
  }
  return asArray(userTurns)[0]?.text || '';
}

function selectPhaseUserTurns(turns = [], { maxItems = 4 } = {}) {
  const rows = asArray(turns);
  if (rows.length === 0) return [];
  let boundary = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]?.role === 'assistant') { boundary = i; break; }
  }
  const phaseTurns = rows.filter((row, idx) => row.role === 'user' && idx > boundary);
  if (phaseTurns.length > 0) return uniqQuotes(phaseTurns.map((row) => row.text), { maxItems, maxChars: 260 });
  const userTurns = rows.filter((row) => row.role === 'user');
  return uniqQuotes(userTurns.slice(-Math.max(1, Math.floor(Number(maxItems) || 4))).map((row) => row.text), { maxItems, maxChars: 260 });
}

function mergeExplicitNotes(previous = {}, override = {}) {
  return uniqQuotes([
    ...asArray(previous.explicit_notes),
    ...asArray(override.explicit_notes),
    ...asArray(override.operator_notes),
    ...asArray(override.directives),
  ], { maxItems: 6, maxChars: 220 });
}

function buildTaskPacket({ jobDir = '', currentUserText = '', runMeta = {}, previousPacket = null } = {}) {
  const previous = asObject(previousPacket);
  const override = loadOverridePacket(jobDir, runMeta);
  const turns = loadTurns(jobDir);
  const currentQuote = normalizeQuote(currentUserText, 260);
  if (currentQuote) turns.push({ role: 'user', text: currentQuote, ts: new Date().toISOString() });
  const userTurns = turns.filter((row) => row.role === 'user' && row.text);
  const objectiveQuote = normalizeQuote(
    override.objective_quote || override.goal_quote || previous.objective_quote || findInitialRequest(userTurns),
    320,
  );
  const latestUserQuote = normalizeQuote(
    override.latest_user_quote || override.latest_quote || currentQuote || userTurns[userTurns.length - 1]?.text || previous.latest_user_quote,
    320,
  );
  const phaseUserQuotes = uniqQuotes(
    asArray(override.phase_user_quotes).length > 0 ? asArray(override.phase_user_quotes) : selectPhaseUserTurns(turns, { maxItems: 4 }),
    { maxItems: 4, maxChars: 260 },
  );
  const carryForwardQuotes = uniqQuotes([
    ...asArray(override.carry_forward_quotes),
    objectiveQuote,
    ...asArray(previous.phase_user_quotes),
    ...asArray(previous.carry_forward_quotes),
  ].filter(Boolean), { maxItems: 4, maxChars: 240 }).filter((quote) => !phaseUserQuotes.some((cur) => cur.toLowerCase() === quote.toLowerCase()));

  return {
    version: 1,
    updated_at: new Date().toISOString(),
    objective_quote: objectiveQuote,
    latest_user_quote: latestUserQuote,
    phase_user_quotes: phaseUserQuotes,
    carry_forward_quotes: carryForwardQuotes,
    explicit_notes: mergeExplicitNotes(previous, override),
    source_of_truth: safe(override.source_of_truth) || 'Latest user quotes and operator overrides win over stale summaries when they conflict.',
    source: safe(override.source) || 'local_task_packet',
  };
}

function writeJson(filePath = '', value = null) {
  try {
    if (!filePath) return;
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  } catch {}
}

function appendJsonl(filePath = '', value = null) {
  try {
    if (!filePath || !value) return;
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
  } catch {}
}

export function updateCurrentTaskPacket({ jobDir = '', currentUserText = '', runMeta = {}, persist = true } = {}) {
  const cleanJobDir = safe(jobDir);
  if (!cleanJobDir) return null;
  const packet = buildTaskPacket({ jobDir: cleanJobDir, currentUserText, runMeta, previousPacket: loadPacket(cleanJobDir) });
  if (persist) {
    writeJson(packetFile(cleanJobDir), packet);
    writeJson(sharedPacketFile(cleanJobDir), packet);
    appendJsonl(packetHistoryFile(cleanJobDir), packet);
  }
  return packet;
}

export function loadCurrentTaskPacket({ jobDir = '', runMeta = {}, currentUserText = '', refresh = false } = {}) {
  const cleanJobDir = safe(jobDir);
  if (!cleanJobDir) return null;
  const inline = asObject(runMeta.taskPacket || runMeta.task_packet || runMeta.currentTaskPacket || runMeta.current_task_packet);
  if (refresh || currentUserText || Object.keys(inline).length > 0) {
    return updateCurrentTaskPacket({ jobDir: cleanJobDir, currentUserText, runMeta, persist: true });
  }
  const packet = loadPacket(cleanJobDir);
  if (Object.keys(packet).length > 0) return packet;
  return updateCurrentTaskPacket({ jobDir: cleanJobDir, currentUserText, runMeta, persist: true });
}

function renderQuoteList(quotes = [], { maxItems = 4, maxChars = 220 } = {}) {
  return uniqQuotes(quotes, { maxItems, maxChars })
    .map((quote, idx) => `${idx + 1}. "${quote}"`)
    .join('\n');
}

export function renderTaskPacket(packet = null, { roleId = '', maxChars = 1800 } = {}) {
  const row = asObject(packet);
  if (Object.keys(row).length === 0) return '';
  const lines = [];
  const role = safe(roleId).toLowerCase();
  if (row.objective_quote) lines.push(`- Baseline objective: "${normalizeQuote(row.objective_quote, 320)}"`);
  if (row.latest_user_quote) lines.push(`- Latest user request: "${normalizeQuote(row.latest_user_quote, 320)}"`);
  const phaseQuotes = renderQuoteList(asArray(row.phase_user_quotes), { maxItems: role === 'builder' ? 4 : 3, maxChars: 220 });
  if (phaseQuotes) lines.push(`- Active user quotes to honor verbatim:\n${phaseQuotes}`);
  const carryForward = renderQuoteList(asArray(row.carry_forward_quotes), { maxItems: 3, maxChars: 200 });
  if (carryForward) lines.push(`- Carry-forward task context:\n${carryForward}`);
  const explicitNotes = renderQuoteList(asArray(row.explicit_notes), { maxItems: 4, maxChars: 200 });
  if (explicitNotes) lines.push(`- Operator / GoC overrides:\n${explicitNotes}`);
  lines.push(`- Conflict rule: ${safe(row.source_of_truth) || 'Latest user quotes win over stale summaries.'}`);
  const body = clip(lines.join('\n'), Math.max(500, Math.floor(Number(maxChars) || 1800)));
  return body ? `[CURRENT TASK PACKET]\n${body}` : '';
}
