import fs from 'node:fs';
import path from 'node:path';

const CANDIDATES_FILE = 'memory_materialization_candidates.jsonl';
const LATEST_FILE = 'memory_materialization_latest.json';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function safeRead(filePath = '') {
  try { return filePath && fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''; } catch { return ''; }
}
function safeReadJson(filePath = '', fallback = null) {
  try { const raw = safeRead(filePath); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}
function safeReadJsonl(filePath = '', { limit = 1000 } = {}) {
  const raw = safeRead(filePath);
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
    } catch {}
  }
  const n = Math.max(1, Math.floor(Number(limit) || 1000));
  return rows.length > n ? rows.slice(rows.length - n) : rows;
}
function clip(value = '', max = 220) {
  const text = clean(value);
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}
function localMemoryDir(jobDir = '') {
  const d = String(jobDir || '').trim();
  return d ? path.join(d, 'local_memory') : '';
}
function normalizeSourceRef(ref = '') { return String(ref || '').replace(/\\/g, '/'); }
function turnText(row = {}) { return clean(row.text || row.content || row.message || row.summary || ''); }
function collectSharedDocs(jobDir = '') {
  const sharedDir = path.join(jobDir, 'shared');
  try {
    if (!fs.existsSync(sharedDir)) return [];
    return fs.readdirSync(sharedDir)
      .filter((name) => /\.(md|txt|json)$/i.test(name))
      .slice(0, 48)
      .map((name) => {
        const filePath = path.join(sharedDir, name);
        return { kind: 'shared_doc', source: normalizeSourceRef(path.relative(jobDir, filePath)), text: safeRead(filePath) };
      })
      .filter((row) => clean(row.text));
  } catch {
    return [];
  }
}
export function collectMemoryEvidence(jobDir = '', { limit = 1200 } = {}) {
  const d = String(jobDir || '').trim();
  if (!d) return [];
  const evidence = [];
  safeReadJsonl(path.join(d, 'local_memory', 'turns.jsonl'), { limit }).forEach((row, index) => {
    const text = turnText(row);
    if (!text) return;
    evidence.push({
      kind: 'turn',
      source: 'local_memory/turns.jsonl',
      source_id: String(row.id || row.turn_id || row.turnId || `turn_${index + 1}`),
      role: clean(row.role || row.author || ''),
      text,
      created_at: clean(row.created_at || row.ts || row.createdAt || ''),
      index,
    });
  });
  const summary = safeRead(path.join(d, 'local_memory', 'summary.md'));
  if (clean(summary)) evidence.push({ kind: 'summary', source: 'local_memory/summary.md', text: summary });
  for (const doc of collectSharedDocs(d)) evidence.push(doc);
  safeReadJsonl(path.join(d, 'user_facts.jsonl'), { limit }).forEach((row, index) => evidence.push({
    kind: 'user_fact',
    source: 'user_facts.jsonl',
    source_id: String(row.id || row.fact_id || `fact_${index + 1}`),
    text: JSON.stringify(row),
    fact: row,
  }));
  safeReadJsonl(path.join(d, 'artifact_observations.jsonl'), { limit: 300 }).forEach((row, index) => evidence.push({
    kind: 'artifact_observation',
    source: 'artifact_observations.jsonl',
    source_id: String(row.id || `artifact_${index + 1}`),
    text: JSON.stringify(row),
    observation: row,
  }));
  return evidence;
}
export function collectDemandQueries(jobDir = '', { limit = 240 } = {}) {
  return safeReadJsonl(path.join(jobDir, 'local_memory', 'memory_demand_events.jsonl'), { limit })
    .map((row, index) => ({
      kind: 'memory_demand',
      source: 'local_memory/memory_demand_events.jsonl',
      source_id: String(row.id || `demand_${index + 1}`),
      query: clean(row.query || ''),
      text: clean([row.query, ...(asArray(row.demand_reasons || row.demandReasons)), ...(asArray(row.sources))].join(' ')),
      event: row,
    }))
    .filter((row) => row.query || row.text);
}

const DOMAIN_SPECS = [
  {
    id: 'meal_tracking',
    title: 'Meal tracking',
    table: 'meal_entries',
    description: 'Repeated meal/food logs should become a queryable time-series table when aggregate questions emerge.',
    evidence: [/아침|점심|저녁|간식|야식|식사|먹었|먹은|메뉴|칼로리|영양|단백질|탄수화물|meal|breakfast|lunch|dinner|snack|ate|diet|food/i],
    aggregate: [/이번\s*주|지난\s*주|최근|평균|합계|며칠|추세|비율|빠진|거른|count|average|trend|weekly|monthly|last\s+\d+|summary/i],
    correction: [/아까|수정|정정|아니라|추가|취소|빼줘|update|correct|instead|actually/i],
    schema: [
      { name: 'id', type: 'text', role: 'primary_key' },
      { name: 'eaten_at', type: 'datetime', nullable: true },
      { name: 'meal_type', type: 'text', nullable: true },
      { name: 'foods', type: 'json', nullable: false },
      { name: 'notes', type: 'text', nullable: true },
      { name: 'source_ref', type: 'text', nullable: false },
      { name: 'confidence', type: 'real', nullable: false },
      { name: 'status', type: 'text', default: 'active' },
      { name: 'created_at', type: 'datetime' },
    ],
    operations: [
      { name: 'add_meal', kind: 'insert', required_fields: ['eaten_at', 'meal_type', 'foods'] },
      { name: 'update_meal', kind: 'update', filters: ['id'], patch_fields: ['eaten_at', 'meal_type', 'foods', 'notes', 'status'] },
      { name: 'list_meals', kind: 'select', filters: ['from', 'to', 'meal_type', 'status'] },
      { name: 'summarize_meals', kind: 'aggregate', group_by: ['day', 'meal_type'] },
      { name: 'detect_missing_meals', kind: 'analysis', filters: ['from', 'to', 'meal_type'] },
    ],
  },
  {
    id: 'expense_tracking',
    title: 'Expense tracking',
    table: 'expense_entries',
    description: 'Repeated spending/payment notes should become a table when totals, categories, or ranges are queried.',
    evidence: [/지출|결제|샀|구매|영수증|가격|비용|원\b|달러|카드|현금|expense|spent|bought|cost|receipt|price|paid/i],
    aggregate: [/합계|총액|평균|카테고리|이번\s*달|지난\s*달|최근|비율|total|average|category|monthly|weekly/i],
    correction: [/환불|취소|정정|수정|아니라|refund|cancel|correct|actually/i],
    schema: [
      { name: 'id', type: 'text', role: 'primary_key' },
      { name: 'spent_at', type: 'datetime', nullable: true },
      { name: 'merchant', type: 'text', nullable: true },
      { name: 'amount', type: 'real', nullable: true },
      { name: 'currency', type: 'text', nullable: true },
      { name: 'category', type: 'text', nullable: true },
      { name: 'notes', type: 'text', nullable: true },
      { name: 'source_ref', type: 'text' },
      { name: 'confidence', type: 'real' },
      { name: 'status', type: 'text', default: 'active' },
    ],
    operations: [
      { name: 'add_expense', kind: 'insert', required_fields: ['spent_at', 'amount'] },
      { name: 'list_expenses', kind: 'select', filters: ['from', 'to', 'category', 'merchant'] },
      { name: 'summarize_expenses', kind: 'aggregate', group_by: ['category', 'month'] },
    ],
  },
  {
    id: 'conference_knowledge',
    title: 'Conference public knowledge',
    table: 'conference_facts',
    description: 'Public conference facts should become a sourced knowledge pack with freshness rules instead of private memory.',
    evidence: [/학회|컨퍼런스|ICDE|NeurIPS|ICML|CVPR|SIGMOD|VLDB|deadline|submission|registration|venue|CFP|call for papers|conference/i],
    aggregate: [/마감|일정|언제|등록|비자|장소|venue|deadline|date|schedule|fee|registration/i],
    correction: [/변경|업데이트|최신|바뀌|update|changed|latest|refresh/i],
    schema: [
      { name: 'id', type: 'text', role: 'primary_key' },
      { name: 'conference_key', type: 'text' },
      { name: 'fact_type', type: 'text' },
      { name: 'title', type: 'text' },
      { name: 'value_json', type: 'json' },
      { name: 'source_url', type: 'text', nullable: true },
      { name: 'retrieved_at', type: 'datetime', nullable: true },
      { name: 'freshness_ttl_days', type: 'integer', default: 14 },
      { name: 'confidence', type: 'real' },
    ],
    operations: [
      { name: 'add_conference_fact', kind: 'insert', required_fields: ['conference_key', 'fact_type', 'title'] },
      { name: 'list_conference_facts', kind: 'select', filters: ['conference_key', 'fact_type', 'freshness_state'] },
      { name: 'refresh_conference_facts', kind: 'refresh_intent', filters: ['conference_key', 'fact_type'] },
    ],
    publishable: true,
    freshness_policy: { refresh_on_clone: true, ttl_days: 14, requires_refresh_for: ['deadlines', 'registration fees', 'venue changes', 'visa/travel advisories'] },
  },
  {
    id: 'action_item_tracking',
    title: 'Action item tracking',
    table: 'action_items',
    description: 'Repeated TODO/action-item decisions should become a status table when ownership or deadlines matter.',
    evidence: [/TODO|할\s*일|액션|담당|마감|해야|진행|pending|done|blocked|action item|owner|deadline|task/i],
    aggregate: [/남은|완료|상태|마감|담당자별|pending|done|status|overdue|by owner/i],
    correction: [/완료|취소|변경|수정|미뤄|done|cancel|update|postpone/i],
    schema: [
      { name: 'id', type: 'text', role: 'primary_key' },
      { name: 'title', type: 'text' },
      { name: 'owner', type: 'text', nullable: true },
      { name: 'status', type: 'text', default: 'pending' },
      { name: 'due_at', type: 'datetime', nullable: true },
      { name: 'source_ref', type: 'text' },
      { name: 'confidence', type: 'real' },
      { name: 'created_at', type: 'datetime' },
      { name: 'updated_at', type: 'datetime' },
    ],
    operations: [
      { name: 'add_action_item', kind: 'insert', required_fields: ['title'] },
      { name: 'update_action_item_status', kind: 'update', filters: ['id'], patch_fields: ['status', 'owner', 'due_at'] },
      { name: 'list_action_items', kind: 'select', filters: ['status', 'owner', 'due_before'] },
    ],
  },
];

function matchesAny(text = '', patterns = []) { return patterns.some((p) => p.test(String(text || ''))); }
function scoreDomain(spec, evidence = [], demandQueries = []) {
  const evidenceRows = evidence.filter((r) => matchesAny(r.text, spec.evidence));
  const queryRows = demandQueries.filter((r) => matchesAny(r.text || r.query, spec.evidence));
  const aggregateRows = demandQueries.filter((r) => matchesAny(r.text || r.query, spec.aggregate));
  const correctionRows = evidence.filter((r) => matchesAny(r.text, spec.correction));
  const factRows = evidenceRows.filter((r) => r.kind === 'user_fact');
  const publicSourceRows = evidenceRows.filter((r) => /https?:\/\/|official|public|source|url|공식/i.test(r.text));
  const repetition = Math.min(1, evidenceRows.length / 10);
  const queryPressure = Math.min(1, (queryRows.length + aggregateRows.length * 1.8) / 6);
  const correctionPressure = Math.min(1, correctionRows.length / 5);
  const typedFactPressure = Math.min(1, factRows.length / 6);
  const publicSourcePressure = spec.publishable ? Math.min(1, publicSourceRows.length / 3) : 0;
  const score = repetition * 0.38 + queryPressure * 0.34 + correctionPressure * 0.14 + typedFactPressure * 0.08 + publicSourcePressure * 0.06;
  const reasons = [];
  if (repetition >= 0.35) reasons.push('repeated_domain_memory');
  if (queryPressure >= 0.25) reasons.push('aggregate_or_range_queries_detected');
  if (correctionPressure >= 0.2) reasons.push('updates_or_retractions_detected');
  if (typedFactPressure >= 0.2) reasons.push('typed_fact_pressure');
  if (publicSourcePressure >= 0.2) reasons.push('public_source_knowledge_candidate');
  return { evidenceRows, queryRows, aggregateRows, correctionRows, factRows, publicSourceRows, score: Number(Math.min(1, score).toFixed(3)), components: { repetition, queryPressure, correctionPressure, typedFactPressure, publicSourcePressure }, reasons };
}
function inferMealType(text = '') {
  const src = String(text || '').toLowerCase();
  if (/아침|breakfast/.test(src)) return 'breakfast';
  if (/점심|lunch/.test(src)) return 'lunch';
  if (/저녁|dinner/.test(src)) return 'dinner';
  if (/간식|snack/.test(src)) return 'snack';
  if (/야식/.test(src)) return 'late_night';
  return '';
}
function parseMealFoods(text = '') {
  const raw = clean(text);
  if (!raw) return [];
  let fragment = raw;
  const m = raw.match(/(?:아침|점심|저녁|간식|야식|breakfast|lunch|dinner|snack)[^\n。.!?]*(?:먹었|먹은|ate|had)?([^\n。.!?]*)/i);
  if (m?.[0]) fragment = m[0];
  fragment = fragment
    .replace(/^(아침|점심|저녁|간식|야식|breakfast|lunch|dinner|snack)(은|는|으로|에)?/i, '')
    .replace(/먹었어|먹었다|먹은|먹었|ate|had/ig, '')
    .replace(/그리고|랑|와|과|및|plus|and/ig, ',');
  return fragment.split(/[,/、，]+/).map((x) => clean(x)).filter((x) => x && x.length <= 80).slice(0, 8);
}
function extractBackfillRows(spec, evidenceRows = []) {
  if (spec.id !== 'meal_tracking') {
    return evidenceRows.slice(0, 12).map((row, i) => ({
      id: `${spec.id}_${i + 1}`,
      source_ref: `${row.source}${row.source_id ? `#${row.source_id}` : ''}`,
      preview: clip(row.text, 180),
      confidence: row.kind === 'user_fact' ? 0.72 : 0.55,
      review_state: 'needs_review',
    }));
  }
  const rows = [];
  evidenceRows.slice(0, 80).forEach((row, i) => {
    const mealType = inferMealType(row.text);
    const foods = parseMealFoods(row.text);
    if (!mealType && !foods.length) return;
    rows.push({
      id: `meal_preview_${i + 1}`,
      eaten_at: row.created_at || null,
      meal_type: mealType || null,
      foods,
      notes: foods.length ? '' : clip(row.text, 180),
      source_ref: `${row.source}${row.source_id ? `#${row.source_id}` : ''}`,
      confidence: Number((0.52 + (mealType ? 0.14 : 0) + (foods.length ? 0.18 : 0) + (row.kind === 'user_fact' ? 0.08 : 0)).toFixed(2)),
      review_state: mealType && foods.length ? 'high_confidence' : 'needs_review',
    });
  });
  return rows.slice(0, 24);
}
function buildCreateTableSql(table = '', columns = []) {
  const safeTable = clean(table).replace(/[^a-zA-Z0-9_]/g, '');
  const lines = asArray(columns).map((col) => {
    const name = clean(col.name).replace(/[^a-zA-Z0-9_]/g, '');
    const type = clean(col.type || 'text').toUpperCase();
    const flags = [];
    if (col.role === 'primary_key') flags.push('PRIMARY KEY');
    if (col.nullable === false) flags.push('NOT NULL');
    return name ? `  ${name} ${type}${flags.length ? ` ${flags.join(' ')}` : ''}` : '';
  }).filter(Boolean);
  return [`CREATE TABLE IF NOT EXISTS ${safeTable} (`, lines.join(',\n'), ');'].join('\n');
}
function recommendationFor(score = 0, rows = []) {
  const high = rows.filter((r) => r.review_state === 'high_confidence' || Number(r.confidence || 0) >= 0.75).length;
  if (score >= 0.72 && high >= 8) return 'create_shadow_table';
  if (score >= 0.55) return 'create_typed_jsonl_first';
  if (score >= 0.32) return 'watch_and_continue_markdown';
  return 'no_action';
}
function buildCandidate(spec, scored) {
  const rows = extractBackfillRows(spec, scored.evidenceRows);
  const rec = recommendationFor(scored.score, rows);
  return {
    candidate_id: `${spec.id}_${Date.now().toString(36)}`,
    domain: spec.id,
    title: spec.title,
    description: spec.description,
    materialization_score: scored.score,
    recommendation: rec,
    reasons: scored.reasons,
    signal_counts: {
      evidence: scored.evidenceRows.length,
      domain_queries: scored.queryRows.length,
      aggregate_queries: scored.aggregateRows.length,
      corrections: scored.correctionRows.length,
      typed_facts: scored.factRows.length,
      public_sources: scored.publicSourceRows.length,
    },
    proposed_store: rec === 'create_shadow_table' ? 'sqlite_shadow_table' : (rec === 'create_typed_jsonl_first' ? 'typed_jsonl_event_log' : 'markdown_with_watch'),
    proposed_schema: { table: spec.table, columns: spec.schema, create_table_sql: buildCreateTableSql(spec.table, spec.schema) },
    proposed_operations: spec.operations,
    backfill_preview: {
      total_candidates: rows.length,
      high_confidence: rows.filter((r) => r.review_state === 'high_confidence' || Number(r.confidence || 0) >= 0.75).length,
      needs_review: rows.filter((r) => r.review_state !== 'high_confidence' && Number(r.confidence || 0) < 0.75).length,
      rows: rows.slice(0, 12),
    },
    source_preview: scored.evidenceRows.slice(0, 6).map((row) => ({ source: row.source, source_id: row.source_id || undefined, kind: row.kind, text: clip(row.text, 180) })),
    safety: {
      approval_required_for: ['canonical_write_path', 'raw_memory_deletion', 'public_publish', 'generated_code_execution'],
      safe_automatic_steps: ['candidate_preview', 'schema_draft', 'backfill_dry_run', 'shadow_table_plan'],
      generated_code_execution: false,
      raw_memory_deletion: false,
      canonical_memory_switch: false,
    },
    publish_policy: spec.publishable
      ? { publishable_as: 'sourced_knowledge_pack', raw_private_memory_included: false, freshness_policy: spec.freshness_policy || { refresh_on_clone: true } }
      : { publishable_as: 'private_memory_module_only', raw_private_memory_included: false },
  };
}
function summarizeInventory(evidence = [], demandQueries = []) {
  const byKind = {};
  for (const row of evidence) byKind[row.kind] = (byKind[row.kind] || 0) + 1;
  return { evidence_items: evidence.length, demand_queries: demandQueries.length, by_kind: byKind };
}

export function planMemoryMaterialization({ jobDir = '', minScore = 0.28, maxCandidates = 6, persist = false, reason = 'manual_preview' } = {}) {
  const d = String(jobDir || '').trim();
  if (!d) throw new Error('jobDir is required');
  const evidence = collectMemoryEvidence(d);
  const demandQueries = collectDemandQueries(d);
  const candidates = DOMAIN_SPECS
    .map((spec) => ({ spec, scored: scoreDomain(spec, evidence, demandQueries) }))
    .filter(({ scored }) => scored.score >= Number(minScore || 0) || scored.evidenceRows.length >= 4 || scored.aggregateRows.length >= 1)
    .map(({ spec, scored }) => buildCandidate(spec, scored))
    .sort((a, b) => Number(b.materialization_score || 0) - Number(a.materialization_score || 0))
    .slice(0, Math.max(1, Math.floor(Number(maxCandidates) || 6)));
  const plan = {
    kind: 'ddalggak_memory_materialization_plan',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    reason,
    inventory: summarizeInventory(evidence, demandQueries),
    candidates,
    summary: {
      candidate_count: candidates.length,
      shadow_table_candidates: candidates.filter((c) => c.recommendation === 'create_shadow_table').length,
      typed_jsonl_candidates: candidates.filter((c) => c.recommendation === 'create_typed_jsonl_first').length,
      watchlist_candidates: candidates.filter((c) => c.recommendation === 'watch_and_continue_markdown').length,
      publishable_knowledge_candidates: candidates.filter((c) => c.publish_policy?.publishable_as === 'sourced_knowledge_pack').length,
    },
    next_steps: candidates.length
      ? ['Review candidate schema and backfill preview in GoC or Telegram.', 'Create only shadow tables automatically; require approval before canonical write-path changes.', 'Keep raw memory as provenance until reviewed migration is complete.']
      : ['Keep compact markdown memory for now.', 'Continue collecting usage signals until a repeated, queryable domain emerges.'],
  };
  if (persist) writeMemoryMaterializationPlan({ jobDir: d, plan });
  return plan;
}
export function writeMemoryMaterializationPlan({ jobDir = '', plan = {} } = {}) {
  const dir = localMemoryDir(jobDir);
  if (!dir) return null;
  fs.mkdirSync(dir, { recursive: true });
  const row = { ts: new Date().toISOString(), ...asObject(plan) };
  fs.writeFileSync(path.join(dir, LATEST_FILE), `${JSON.stringify(row, null, 2)}\n`, 'utf8');
  fs.appendFileSync(path.join(dir, CANDIDATES_FILE), `${JSON.stringify(row)}\n`, 'utf8');
  return row;
}
export function loadLatestMemoryMaterializationPlan({ jobDir = '' } = {}) {
  const dir = localMemoryDir(jobDir);
  return dir ? safeReadJson(path.join(dir, LATEST_FILE), null) : null;
}
export function formatMemoryMaterializationPlanForTelegram(plan = {}) {
  const row = asObject(plan), summary = asObject(row.summary), inv = asObject(row.inventory), candidates = asArray(row.candidates);
  const lines = [
    '🧠 Memory materialization preview',
    `- evidence items: ${Number(inv.evidence_items || 0)}`,
    `- demand queries: ${Number(inv.demand_queries || 0)}`,
    `- candidates: ${Number(summary.candidate_count || candidates.length || 0)}`,
    `- shadow table candidates: ${Number(summary.shadow_table_candidates || 0)}`,
    `- typed JSONL candidates: ${Number(summary.typed_jsonl_candidates || 0)}`,
    `- publishable knowledge candidates: ${Number(summary.publishable_knowledge_candidates || 0)}`,
  ];
  if (!candidates.length) {
    lines.push('', 'No materialization candidate is strong enough yet.', '- Keep compact markdown memory and continue collecting usage signals.');
    return lines.join('\n');
  }
  candidates.slice(0, 5).forEach((c, i) => {
    const counts = asObject(c.signal_counts), back = asObject(c.backfill_preview);
    lines.push('', `${i + 1}. ${c.title} · score=${Number(c.materialization_score || 0).toFixed(2)} · ${c.recommendation}`);
    lines.push(`   - store: ${c.proposed_store} table=${c.proposed_schema?.table || '-'}`);
    lines.push(`   - signals: evidence=${counts.evidence || 0}, queries=${counts.domain_queries || 0}, aggregate=${counts.aggregate_queries || 0}, corrections=${counts.corrections || 0}`);
    lines.push(`   - backfill: ${back.total_candidates || 0} rows (${back.high_confidence || 0} high confidence, ${back.needs_review || 0} review)`);
    if (c.publish_policy?.publishable_as === 'sourced_knowledge_pack') lines.push('   - publish: optional sourced knowledge pack with freshness policy');
    const ops = asArray(c.proposed_operations).slice(0, 4).map((op) => op.name).filter(Boolean);
    if (ops.length) lines.push(`   - functions: ${ops.join(', ')}`);
    const sample = asArray(back.rows)[0];
    if (sample) lines.push(`   - sample: ${clip(JSON.stringify(sample), 190)}`);
  });
  lines.push('', 'Safety:', '- Preview/schema/backfill dry-run can be automatic.', '- Approval is required before canonical DB write-path changes, raw memory deletion, generated code execution, or public publish.');
  return lines.join('\n');
}
