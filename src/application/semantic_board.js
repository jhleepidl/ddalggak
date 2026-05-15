import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value ?? '').trim();
}

function cleanOneLine(value = '', maxLen = 300) {
  const text = clean(value).replace(/\s+/g, ' ');
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function slugify(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}

function stableHash(value = '') {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function safeJsonText(text = '') {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

function safeReadJson(filePath = '', fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath = '', row = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function uniqStrings(values = []) {
  return [...new Set(asArray(values).map((v) => clean(v)).filter(Boolean))];
}

export function defaultSemanticBoardDir({ rootDir = process.cwd(), jobId = '', boardDir = '' } = {}) {
  if (boardDir) return path.resolve(rootDir, boardDir);
  const cleanJobId = clean(jobId);
  if (cleanJobId) return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', cleanJobId, 'local_memory', 'semantic_board');
  return path.resolve(rootDir, process.env.SEMANTIC_BOARD_DIR || 'config/semantic_board');
}

export function buildEmptySemanticBoard({ scope = 'global', source = 'ddalggak' } = {}) {
  const now = new Date().toISOString();
  return {
    kind: 'semantic_board_v1',
    version: 1,
    scope,
    source,
    created_at: now,
    updated_at: now,
    cards: [],
    links: [],
  };
}

function normalizeCardType(value = '') {
  const cleanType = clean(value).toLowerCase();
  if (['memory_card', 'skill_card', 'rule_card', 'agent_card', 'package_card', 'model_node_card', 'task_card', 'evidence_card', 'artifact_card', 'review_card'].includes(cleanType)) return cleanType;
  if (['memory', 'fact', 'preference'].includes(cleanType)) return 'memory_card';
  if (cleanType === 'skill') return 'skill_card';
  if (cleanType === 'rule') return 'rule_card';
  if (cleanType === 'agent') return 'agent_card';
  if (cleanType === 'package') return 'package_card';
  if (cleanType === 'model' || cleanType === 'model_node') return 'model_node_card';
  return cleanType || 'memory_card';
}

function normalizeStatus(value = '') {
  const status = clean(value).toLowerCase();
  if (['active', 'candidate', 'archived', 'retracted', 'disabled', 'review_needed', 'draft'].includes(status)) return status;
  return status || 'candidate';
}

function normalizeCardId(id = '', type = 'memory_card', title = '', content = {}) {
  const explicit = clean(id);
  if (explicit) return explicit;
  const base = slugify(title || content?.canonical_en || content?.original || type);
  return `${normalizeCardType(type).replace(/_card$/, '')}_${base}_${stableHash(JSON.stringify({ type, title, content }))}`;
}

export function normalizeSemanticBoardCard(raw = {}, { source = 'ddalggak' } = {}) {
  const row = asObject(raw);
  const type = normalizeCardType(row.type || row.kind || row.card_type || row.cardType);
  const title = cleanOneLine(row.title || row.name || row.display_name || row.id || row.skill_id || row.rule_id || type, 180);
  const content = asObject(row.content);
  const normalizedContent = {
    ...content,
    ...(row.original || row.text_original ? { original: clean(row.original || row.text_original) } : {}),
    ...(row.canonical_en || row.canonical_text_en ? { canonical_en: clean(row.canonical_en || row.canonical_text_en) } : {}),
    ...(row.markdown && !content.markdown ? { markdown: clean(row.markdown) } : {}),
  };
  const id = normalizeCardId(row.id || row.card_id || row.cardId || row.skill_id || row.skillId || row.rule_id || row.ruleId, type, title, normalizedContent);
  const now = new Date().toISOString();
  const performance = asObject(row.performance);
  const ranking = asObject(row.ranking_metadata || row.rankingMetadata);
  const reuse = Number(row.reuse_score ?? row.reuseScore ?? performance.reuse_score ?? ranking.reuse_score);
  return {
    kind: type,
    id,
    type,
    title,
    description: cleanOneLine(row.description || row.summary || row.reason || '', 600),
    content: normalizedContent,
    scope: asObject(row.scope),
    status: normalizeStatus(row.status || row.lifecycle || 'candidate'),
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
    evidence: asArray(row.evidence).map((v) => clean(v)).filter(Boolean),
    tags: uniqStrings([...(asArray(row.tags)), ...(asArray(row.capability_tags)), row.category, row.role].filter(Boolean)),
    performance: {
      ...performance,
      ...(Number.isFinite(reuse) ? { reuse_score: reuse } : {}),
    },
    source: clean(row.source || source) || source,
    source_ref: clean(row.source_ref || row.sourceRef || row.repo_path || row.path || ''),
    created_at: clean(row.created_at || row.createdAt) || now,
    updated_at: clean(row.updated_at || row.updatedAt) || now,
    raw: asObject(row.raw),
  };
}

export function normalizeSemanticBoardLink(raw = {}) {
  const row = asObject(raw);
  const from = clean(row.from || row.from_id || row.fromId || row.source);
  const to = clean(row.to || row.to_id || row.toId || row.target);
  const type = clean(row.type || row.kind || row.relation || 'related_to').toLowerCase() || 'related_to';
  if (!from || !to) return null;
  const weight = Number(row.weight);
  const id = clean(row.id || row.link_id || row.linkId) || `link_${slugify(type)}_${stableHash(`${from}:${type}:${to}`)}`;
  const now = new Date().toISOString();
  return {
    kind: 'semantic_board_link_v1',
    id,
    from,
    to,
    type,
    weight: Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : undefined,
    status: normalizeStatus(row.status || 'active'),
    reason: cleanOneLine(row.reason || row.summary || '', 400),
    metadata: asObject(row.metadata),
    created_at: clean(row.created_at || row.createdAt) || now,
    updated_at: clean(row.updated_at || row.updatedAt) || now,
  };
}

export function readSemanticBoard({ rootDir = process.cwd(), jobId = '', boardDir = '' } = {}) {
  const dir = defaultSemanticBoardDir({ rootDir, jobId, boardDir });
  const manifest = safeReadJson(path.join(dir, 'board_manifest.json'), null) || buildEmptySemanticBoard({ scope: jobId ? 'run' : 'global' });
  const cards = asArray(safeReadJson(path.join(dir, 'cards.json'), []))
    .map((card) => normalizeSemanticBoardCard(card))
    .filter(Boolean);
  const links = asArray(safeReadJson(path.join(dir, 'links.json'), []))
    .map((link) => normalizeSemanticBoardLink(link))
    .filter(Boolean);
  return {
    ...manifest,
    dir,
    cards,
    links,
    updated_at: manifest.updated_at || new Date().toISOString(),
  };
}

export function writeSemanticBoard(board = {}, { rootDir = process.cwd(), jobId = '', boardDir = '' } = {}) {
  const dir = defaultSemanticBoardDir({ rootDir, jobId, boardDir });
  const now = new Date().toISOString();
  const manifest = {
    kind: 'semantic_board_v1',
    version: 1,
    scope: board.scope || (jobId ? 'run' : 'global'),
    source: board.source || 'ddalggak',
    created_at: board.created_at || now,
    updated_at: now,
    card_count: asArray(board.cards).length,
    link_count: asArray(board.links).length,
  };
  const cards = asArray(board.cards).map((card) => normalizeSemanticBoardCard(card)).filter(Boolean);
  const links = asArray(board.links).map((link) => normalizeSemanticBoardLink(link)).filter(Boolean);
  writeJson(path.join(dir, 'board_manifest.json'), manifest);
  writeJson(path.join(dir, 'cards.json'), cards);
  writeJson(path.join(dir, 'links.json'), links);
  return { ...manifest, dir, cards, links };
}

export function upsertSemanticBoardCards(cards = [], options = {}) {
  const incoming = asArray(cards).map((card) => normalizeSemanticBoardCard(card, { source: options.source || 'ddalggak' })).filter(Boolean);
  const board = readSemanticBoard(options);
  const byId = new Map(board.cards.map((card) => [card.id, card]));
  for (const card of incoming) {
    const prev = byId.get(card.id);
    byId.set(card.id, {
      ...(prev || {}),
      ...card,
      content: { ...asObject(prev?.content), ...asObject(card.content) },
      scope: { ...asObject(prev?.scope), ...asObject(card.scope) },
      performance: { ...asObject(prev?.performance), ...asObject(card.performance) },
      tags: uniqStrings([...(asArray(prev?.tags)), ...(asArray(card.tags))]),
      evidence: uniqStrings([...(asArray(prev?.evidence)), ...(asArray(card.evidence))]),
      updated_at: new Date().toISOString(),
    });
  }
  const saved = writeSemanticBoard({ ...board, cards: [...byId.values()] }, options);
  if (incoming.length) appendSemanticBoardEvent({ type: 'upsert_cards', card_ids: incoming.map((c) => c.id), count: incoming.length }, options);
  return { ok: true, upserted: incoming.length, board: saved, cards: incoming };
}

export function upsertSemanticBoardLinks(links = [], options = {}) {
  const incoming = asArray(links).map((link) => normalizeSemanticBoardLink(link)).filter(Boolean);
  const board = readSemanticBoard(options);
  const byId = new Map(board.links.map((link) => [link.id, link]));
  for (const link of incoming) {
    const prev = byId.get(link.id);
    byId.set(link.id, { ...(prev || {}), ...link, metadata: { ...asObject(prev?.metadata), ...asObject(link.metadata) }, updated_at: new Date().toISOString() });
  }
  const saved = writeSemanticBoard({ ...board, links: [...byId.values()] }, options);
  if (incoming.length) appendSemanticBoardEvent({ type: 'upsert_links', link_ids: incoming.map((l) => l.id), count: incoming.length }, options);
  return { ok: true, upserted: incoming.length, board: saved, links: incoming };
}

export function appendSemanticBoardEvent(event = {}, { rootDir = process.cwd(), jobId = '', boardDir = '', source = 'ddalggak' } = {}) {
  const dir = defaultSemanticBoardDir({ rootDir, jobId, boardDir });
  const row = {
    kind: 'semantic_board_event_v1',
    event_id: clean(event.event_id || event.id) || `evt_${Date.now()}_${stableHash(JSON.stringify(event))}`,
    type: clean(event.type || event.event || 'event'),
    source: clean(event.source || source) || source,
    created_at: clean(event.created_at || event.createdAt) || new Date().toISOString(),
    payload: asObject(event.payload || event),
  };
  appendJsonl(path.join(dir, 'board_events.jsonl'), row);
  return row;
}

export function skillPackageToSemanticCard(skill = {}, { status = 'active', source = 'skill_catalog' } = {}) {
  const row = asObject(skill.skill || skill);
  const id = clean(row.id || row.skill_id || row.skillId);
  const title = clean(row.name || row.title || row.slug || id || 'Skill');
  const reuse = Number(row.performance?.reuse_score ?? row.ranking_metadata?.reuse_score ?? row.reuse_score);
  return normalizeSemanticBoardCard({
    type: 'skill_card',
    id,
    title,
    description: row.description || row.summary || '',
    content: {
      canonical_en: row.canonical_description_en || row.canonical_text_en || row.description || title,
      instructions_ref: row.instructions_ref || 'SKILL.md',
      procedure: row.procedure,
      trigger: row.trigger || row.trigger_terms,
      anti_patterns: row.anti_patterns,
    },
    status: row.status || status,
    tags: uniqStrings([...(asArray(row.capability_tags)), ...(asArray(row.compatible_roles)), row.category, row.kind]),
    performance: Number.isFinite(reuse) ? { ...asObject(row.performance), reuse_score: reuse } : asObject(row.performance),
    source,
    source_ref: row.source_dir || row.dir || row.source_package?.repo_path || '',
    raw: row,
  }, { source });
}

export function runtimeRuleToSemanticCard(rule = {}, { status = 'active', source = 'runtime_rule' } = {}) {
  const row = typeof rule === 'string' ? { text: rule } : asObject(rule);
  const text = clean(row.text || row.rule || row.instruction || row.markdown || row.content);
  const id = clean(row.id || row.rule_id || row.ruleId) || `rule_${slugify(text).slice(0, 42)}_${stableHash(text)}`;
  return normalizeSemanticBoardCard({
    type: 'rule_card',
    id,
    title: cleanOneLine(row.title || row.name || text, 120),
    description: row.description || row.reason || '',
    content: { original: text, canonical_en: row.canonical_text_en || row.canonical_en || text },
    status: row.status || status,
    tags: uniqStrings([row.topic, row.category, 'runtime_rule']),
    confidence: row.confidence,
    source: row.source || source,
    source_ref: row.origin || row.source_ref || '',
    raw: row,
  }, { source });
}

export function importSemanticBoardSource(source = '', options = {}) {
  const raw = clean(source);
  if (!raw) throw new Error('semantic board import source is required');
  if (/^https?:\/\//i.test(raw)) throw new Error('remote URL import is disabled; download/review the file first');
  let parsed = safeJsonText(raw);
  let sourceType = 'json_inline';
  if (!parsed) {
    const resolved = path.resolve(options.rootDir || process.cwd(), raw);
    if (!fs.existsSync(resolved)) throw new Error('expected local path or JSON object');
    const stat = fs.statSync(resolved);
    if (stat.isDirectory()) {
      parsed = safeReadJson(path.join(resolved, 'board_manifest.json'), {}) || {};
      parsed.cards = asArray(safeReadJson(path.join(resolved, 'cards.json'), []));
      parsed.links = asArray(safeReadJson(path.join(resolved, 'links.json'), []));
      sourceType = 'board_directory';
    } else {
      parsed = safeJsonText(fs.readFileSync(resolved, 'utf8'));
      sourceType = 'json_file';
    }
  }
  const pkg = asObject(parsed);
  const cards = [
    ...asArray(pkg.cards),
    ...asArray(pkg.memory_cards),
    ...asArray(pkg.skill_cards),
    ...asArray(pkg.rule_cards),
  ];
  for (const skill of asArray(pkg.skills)) cards.push(skillPackageToSemanticCard(skill, { source: 'semantic_board_import' }));
  for (const rule of [...asArray(pkg.rules), ...asArray(pkg.runtime_rules), ...asArray(pkg.runtimeRules)]) cards.push(runtimeRuleToSemanticCard(rule, { source: 'semantic_board_import' }));
  const links = asArray(pkg.links);
  const cardResult = upsertSemanticBoardCards(cards, { ...options, source: 'semantic_board_import' });
  const linkResult = upsertSemanticBoardLinks(links, options);
  return {
    ok: true,
    source_type: sourceType,
    cards_imported: cardResult.upserted,
    links_imported: linkResult.upserted,
    board: summarizeSemanticBoard(cardResult.board),
  };
}

export function mirrorSkillRuleImportToSemanticBoard(importResult = {}, options = {}) {
  const skills = asArray(importResult.installed_skills).map((row) => skillPackageToSemanticCard(row.skill || row, { source: 'skill_import' }));
  const rules = asArray(importResult.imported_rules).map((row) => runtimeRuleToSemanticCard(row, { source: 'rule_import' }));
  const cards = [...skills, ...rules];
  const cardResult = upsertSemanticBoardCards(cards, { ...options, source: 'skill_rule_import' });
  return { ok: true, mirrored: cardResult.upserted, cards };
}

export function mirrorSkillPerformanceToSemanticBoard(performanceStore = {}, options = {}) {
  const skills = Object.values(asObject(performanceStore.skills)).map((metric) => normalizeSemanticBoardCard({
    type: 'skill_card',
    id: metric.id,
    title: metric.id,
    status: 'active',
    performance: metric,
    tags: ['performance', 'skill'],
    source: 'skill_rule_performance',
  }));
  const rules = Object.values(asObject(performanceStore.rules)).map((metric) => normalizeSemanticBoardCard({
    type: 'rule_card',
    id: metric.id,
    title: metric.id,
    status: 'active',
    performance: metric,
    tags: ['performance', 'rule'],
    source: 'skill_rule_performance',
  }));
  return upsertSemanticBoardCards([...skills, ...rules], { ...options, source: 'skill_rule_performance' });
}

export function summarizeSemanticBoard(board = {}) {
  const cards = asArray(board.cards);
  const links = asArray(board.links);
  const byType = {};
  const byStatus = {};
  for (const card of cards) {
    byType[card.type || card.kind || 'unknown'] = (byType[card.type || card.kind || 'unknown'] || 0) + 1;
    byStatus[card.status || 'unknown'] = (byStatus[card.status || 'unknown'] || 0) + 1;
  }
  const topReusable = cards
    .filter((card) => Number.isFinite(Number(card.performance?.reuse_score)))
    .sort((a, b) => Number(b.performance?.reuse_score || 0) - Number(a.performance?.reuse_score || 0))
    .slice(0, 8)
    .map((card) => ({ id: card.id, title: card.title, type: card.type, reuse_score: card.performance?.reuse_score }));
  return {
    kind: 'semantic_board_summary_v1',
    dir: board.dir,
    card_count: cards.length,
    link_count: links.length,
    by_type: byType,
    by_status: byStatus,
    top_reusable: topReusable,
    updated_at: board.updated_at,
  };
}

export function formatSemanticBoardSummary(board = {}) {
  const summary = summarizeSemanticBoard(board);
  const lines = [
    'Semantic Board',
    `- cards: ${summary.card_count}`,
    `- links: ${summary.link_count}`,
  ];
  const types = Object.entries(summary.by_type || {}).sort((a, b) => b[1] - a[1]);
  if (types.length) lines.push(`- types: ${types.map(([k, v]) => `${k}=${v}`).join(', ')}`);
  if (summary.top_reusable?.length) {
    lines.push('', 'Top reusable cards:');
    for (const row of summary.top_reusable) lines.push(`- ${row.title || row.id} (${row.type}) · reuse=${row.reuse_score}`);
  }
  lines.push('', 'Commands:', '- /board cards', '- /board export', '- /board import <path|json>');
  return lines.join('\n');
}

export function formatSemanticBoardCards(board = {}, { limit = 20, type = '' } = {}) {
  const filterType = clean(type).toLowerCase();
  const rows = asArray(board.cards)
    .filter((card) => !filterType || card.type === filterType || card.kind === filterType)
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  const lines = [`Semantic Board cards (${rows.length}/${board.cards?.length || 0})`];
  for (const card of rows) {
    const reuse = Number.isFinite(Number(card.performance?.reuse_score)) ? ` · reuse=${card.performance.reuse_score}` : '';
    lines.push(`- ${card.id} · ${card.type} · ${card.status}${reuse}\n  ${card.title}`);
  }
  return lines.join('\n');
}

export function buildPromptProjectionFromBoard(board = {}, { cardTypes = [], limit = 12 } = {}) {
  const typeSet = new Set(asArray(cardTypes).map((v) => clean(v).toLowerCase()).filter(Boolean));
  const cards = asArray(board.cards)
    .filter((card) => card.status === 'active' || card.status === 'candidate')
    .filter((card) => typeSet.size === 0 || typeSet.has(card.type) || typeSet.has(card.kind))
    .sort((a, b) => Number(b.performance?.reuse_score || 0) - Number(a.performance?.reuse_score || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 12, 50)));
  return {
    kind: 'semantic_board_prompt_projection_v1',
    card_count: cards.length,
    cards: cards.map((card) => ({
      id: card.id,
      type: card.type,
      title: card.title,
      status: card.status,
      canonical: card.content?.canonical_en || card.description || card.title,
      tags: card.tags || [],
      reuse_score: card.performance?.reuse_score,
    })),
  };
}

export function mirrorLocalSkillCatalogToSemanticBoard({ rootDir = process.cwd(), skillsDir = 'skills', jobId = '', boardDir = '' } = {}) {
  const base = path.resolve(rootDir, skillsDir);
  const cards = [];
  if (fs.existsSync(base)) {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(base, entry.name);
      const manifest = safeReadJson(path.join(dir, 'manifest.json'), null);
      if (!manifest) continue;
      cards.push(skillPackageToSemanticCard({ ...manifest, source_dir: dir }, { source: 'local_skill_catalog' }));
    }
  }
  return upsertSemanticBoardCards(cards, { rootDir, jobId, boardDir, source: 'local_skill_catalog' });
}
