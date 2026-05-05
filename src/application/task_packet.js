import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';
import { mergeExecutionRequirements, extractExecutionRequirements } from './execution_requirements.js';

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
  const dir = localMemoryDir(jobDir);
  const filePath = dir ? path.join(dir, 'turns.jsonl') : '';
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

function normalizeSentenceParts(text = '') {
  return String(text || '')
    .split(/\r?\n|(?<=[.!?。？！])\s+/)
    .map((row) => normalizeQuote(row, 220))
    .filter(Boolean);
}

function collectTextPool({ objectiveQuote = '', latestUserQuote = '', phaseUserQuotes = [], carryForwardQuotes = [], explicitNotes = [] } = {}) {
  return uniqQuotes([
    objectiveQuote,
    latestUserQuote,
    ...asArray(phaseUserQuotes),
    ...asArray(carryForwardQuotes),
    ...asArray(explicitNotes),
  ], { maxItems: 14, maxChars: 320 });
}

function deriveGoalSummary({ objectiveQuote = '', latestUserQuote = '', phaseUserQuotes = [], override = {}, previous = {} } = {}) {
  return normalizeQuote(
    override.goal
      || override.goal_summary
      || previous.goal
      || previous.goal_summary
      || objectiveQuote
      || latestUserQuote
      || asArray(phaseUserQuotes)[0]
      || '',
    320,
  );
}

function pushUnique(out = [], seen = new Set(), value = '', maxChars = 190) {
  const clean = normalizeQuote(value, maxChars);
  if (!clean) return;
  const key = clean.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  out.push(clean);
}

function deriveDeliverables(textPool = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  const execution = mergeExecutionRequirements(...textPool.map((text) => extractExecutionRequirements(text)));
  const previousDeliverables = execution.artifact_delivery_forbidden
    ? asArray(previous.deliverables).filter((entry) => !/(파일|문서|산출물|결과물|artifact|deliverable|경로|전달|send|file)/i.test(String(entry || '')))
    : asArray(previous.deliverables);
  for (const entry of [...asArray(override.deliverables), ...previousDeliverables]) pushUnique(out, seen, entry, 180);
  if (execution.memory_only_requested) pushUnique(out, seen, '새 산출물 없이 runtime memory에 기록·관리한다.', 180);
  if (execution.artifact_delivery_requested) pushUnique(out, seen, '생성된 파일 경로/이름까지 포함해 산출물을 전달해야 한다.', 180);
  if (execution.expected_artifact_kinds.includes('exe')) pushUnique(out, seen, 'Windows 실행 파일(.exe) 산출물이 기대된다.', 180);
  if (execution.expected_artifact_kinds.includes('zip')) pushUnique(out, seen, '압축(zip) 형태 산출물이 기대된다.', 180);
  for (const text of textPool) {
    if (/(오버레이|overlay)/i.test(text)) pushUnique(out, seen, '게임 창 위에 뜨는 오버레이 형태를 유지한다.', 180);
    if (/(companion app|companion|앱|app)/i.test(text)) pushUnique(out, seen, '사용자 요청에 맞는 companion app 형태의 결과를 낸다.', 180);
  }
  return out.slice(0, 5);
}

function deriveVerificationExpectations(textPool = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(override.verification_expectations), ...asArray(previous.verification_expectations)]) pushUnique(out, seen, entry, 190);
  const execution = mergeExecutionRequirements(...textPool.map((text) => extractExecutionRequirements(text)));
  if (execution.shell_execution_requested || execution.direct_execution_requested) pushUnique(out, seen, '필요한 dependency 설치 및 bounded shell 실행 여부를 확인한다.', 190);
  if (execution.artifact_build_requested) pushUnique(out, seen, '실제 빌드/패키징 산출이 생성됐는지 확인한다.', 190);
  if (execution.artifact_delivery_requested) pushUnique(out, seen, '산출물을 만들지 못했으면 blocker를 명시하고 성공처럼 쓰지 않는다.', 190);
  if (execution.artifact_delivery_forbidden) pushUnique(out, seen, '산출물 생성·전달 없이 메모리/응답만으로 처리한다.', 190);
  return out.slice(0, 4);
}

function deriveConstraints(textPool = [], explicitNotes = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(override.constraints), ...asArray(previous.constraints), ...asArray(explicitNotes)]) pushUnique(out, seen, entry, 190);
  for (const text of textPool) {
    for (const sentence of normalizeSentenceParts(text)) {
      if (/(반드시|기억해|기억해둬|주의해|주의하|must|should|needs? to|필요)/i.test(sentence)) {
        pushUnique(out, seen, sentence, 190);
      }
    }
  }
  return out.slice(0, 6);
}

function deriveProhibitions(textPool = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(override.prohibitions), ...asArray(previous.prohibitions)]) pushUnique(out, seen, entry, 190);
  for (const text of textPool) {
    for (const sentence of normalizeSentenceParts(text)) {
      if (/(절대로|하지\s*마|하지마|never|do not|don't|금지)/i.test(sentence)) pushUnique(out, seen, sentence, 190);
      const correction = sentence.match(/(.+?)\s+아니라\s+(.+)/);
      if (correction && correction[1]) pushUnique(out, seen, `${normalizeQuote(correction[1], 120)} 전제로 진행하지 말 것.`, 190);
    }
  }
  return out.slice(0, 5);
}

function deriveSupersededAssumptions(textPool = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(override.superseded_assumptions), ...asArray(previous.superseded_assumptions)]) pushUnique(out, seen, entry, 170);
  for (const text of textPool) {
    for (const sentence of normalizeSentenceParts(text)) {
      const correction = sentence.match(/(.+?)\s+아니라\s+(.+)/);
      if (correction && correction[1]) pushUnique(out, seen, `${normalizeQuote(correction[1], 140)} 가정은 폐기되었다.`, 170);
      const instead = sentence.match(/instead of\s+(.+?)(?:,|$)/i);
      if (instead && instead[1]) pushUnique(out, seen, `${normalizeQuote(instead[1], 140)} 가정은 더 이상 우선하지 않는다.`, 170);
    }
  }
  return out.slice(0, 5);
}

function deriveUnresolvedQuestions(textPool = [], override = {}, previous = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of [...asArray(override.unresolved_questions), ...asArray(previous.unresolved_questions)]) pushUnique(out, seen, entry, 190);
  for (const text of textPool) {
    for (const sentence of normalizeSentenceParts(text)) {
      if (/\?$/.test(sentence) || /(어떻게|가능할까|가능해\?|can we|should we)/i.test(sentence)) pushUnique(out, seen, sentence, 190);
    }
  }
  return out.slice(0, 4);
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
  const explicitNotes = mergeExplicitNotes(previous, override);
  const textPool = collectTextPool({
    objectiveQuote,
    latestUserQuote,
    phaseUserQuotes,
    carryForwardQuotes,
    explicitNotes,
  });
  return {
    version: 2,
    updated_at: new Date().toISOString(),
    objective_quote: objectiveQuote,
    latest_user_quote: latestUserQuote,
    phase_user_quotes: phaseUserQuotes,
    carry_forward_quotes: carryForwardQuotes,
    explicit_notes: explicitNotes,
    goal: deriveGoalSummary({ objectiveQuote, latestUserQuote, phaseUserQuotes, override, previous }),
    deliverables: deriveDeliverables(textPool, override, previous),
    verification_expectations: deriveVerificationExpectations(textPool, override, previous),
    constraints: deriveConstraints(textPool, explicitNotes, override, previous),
    prohibitions: deriveProhibitions(textPool, override, previous),
    superseded_assumptions: deriveSupersededAssumptions(textPool, override, previous),
    unresolved_questions: deriveUnresolvedQuestions(textPool, override, previous),
    source_of_truth: safe(override.source_of_truth) || 'Current Task Packet and operator overrides win over stale summaries when they conflict.',
    source_quotes: {
      active: phaseUserQuotes,
      carry_forward: carryForwardQuotes,
      latest: latestUserQuote ? [latestUserQuote] : [],
    },
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

function comparablePacket(packet = null) {
  const row = asObject(packet);
  if (Object.keys(row).length === 0) return {};
  const next = { ...row };
  delete next.updated_at;
  return next;
}

function packetsEqual(a = null, b = null) {
  try {
    return JSON.stringify(comparablePacket(a)) === JSON.stringify(comparablePacket(b));
  } catch {
    return false;
  }
}

export function updateCurrentTaskPacket({ jobDir = '', currentUserText = '', runMeta = {}, persist = true } = {}) {
  const cleanJobDir = safe(jobDir);
  if (!cleanJobDir) return null;
  const previousPacket = loadPacket(cleanJobDir);
  const packet = buildTaskPacket({ jobDir: cleanJobDir, currentUserText, runMeta, previousPacket });
  if (persist) {
    writeJson(packetFile(cleanJobDir), packet);
    writeJson(sharedPacketFile(cleanJobDir), packet);
    if (!packetsEqual(previousPacket, packet)) {
      appendJsonl(packetHistoryFile(cleanJobDir), packet);
    }
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
  if (row.goal) lines.push(`- Goal: ${normalizeQuote(row.goal, 320)}`);
  if (row.objective_quote) lines.push(`- Baseline objective: "${normalizeQuote(row.objective_quote, 320)}"`);
  if (row.latest_user_quote) lines.push(`- Latest user request: "${normalizeQuote(row.latest_user_quote, 320)}"`);
  const phaseQuotes = renderQuoteList(asArray(row.phase_user_quotes), { maxItems: role === 'builder' ? 4 : 3, maxChars: 220 });
  if (phaseQuotes) lines.push(`- Active user quotes to honor verbatim:\n${phaseQuotes}`);
  const deliverables = renderQuoteList(asArray(row.deliverables), { maxItems: 4, maxChars: 190 });
  if (deliverables) lines.push(`- Deliverables:\n${deliverables}`);
  const verification = renderQuoteList(asArray(row.verification_expectations), { maxItems: 4, maxChars: 190 });
  if (verification) lines.push(`- Verification expectations:\n${verification}`);
  const prohibitions = renderQuoteList(asArray(row.prohibitions), { maxItems: 4, maxChars: 180 });
  if (prohibitions) lines.push(`- Do not:\n${prohibitions}`);
  const superseded = renderQuoteList(asArray(row.superseded_assumptions), { maxItems: 4, maxChars: 170 });
  if (superseded) lines.push(`- Superseded assumptions:\n${superseded}`);
  const carryForward = renderQuoteList(asArray(row.carry_forward_quotes), { maxItems: 3, maxChars: 200 });
  if (carryForward) lines.push(`- Carry-forward task context:\n${carryForward}`);
  const constraints = renderQuoteList(asArray(row.constraints), { maxItems: 4, maxChars: 190 });
  if (constraints) lines.push(`- Constraints and notes:\n${constraints}`);
  const unresolved = renderQuoteList(asArray(row.unresolved_questions), { maxItems: 3, maxChars: 180 });
  if (unresolved) lines.push(`- Open questions:\n${unresolved}`);
  const explicitNotes = renderQuoteList(asArray(row.explicit_notes), { maxItems: 4, maxChars: 200 });
  if (explicitNotes) lines.push(`- Operator / GoC overrides:\n${explicitNotes}`);
  lines.push(`- Conflict rule: ${safe(row.source_of_truth) || 'Current task packet wins over stale summaries.'}`);
  const body = clip(lines.join('\n'), Math.max(600, Math.floor(Number(maxChars) || 1800)));
  return body ? `[CURRENT TASK PACKET]\n${body}` : '';
}
