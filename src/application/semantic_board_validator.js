import { readSemanticBoard, writeSemanticBoard, appendSemanticBoardEvent, normalizeSemanticBoardCard, normalizeSemanticBoardLink } from './semantic_board.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value ?? '').trim(); }
function lower(value = '') { return clean(value).toLowerCase(); }
function uniq(values = []) { return [...new Set(values.map((v) => clean(v)).filter(Boolean))]; }

const ALLOWED_CARD_TYPES = new Set([
  'memory_card', 'skill_card', 'rule_card', 'agent_card', 'package_card', 'model_node_card',
  'task_card', 'evidence_card', 'artifact_card', 'review_card',
]);

const ALLOWED_CARD_STATUS = new Set(['active', 'candidate', 'archived', 'retracted', 'disabled', 'review_needed', 'draft']);
const ALLOWED_LINK_STATUS = new Set(['active', 'candidate', 'archived', 'retracted', 'disabled', 'review_needed', 'draft']);

function issue(severity, code, message, details = {}) {
  return { severity, code, message, details: asObject(details) };
}

function fingerprintCard(card = {}) {
  const type = lower(card.type || card.kind || 'memory_card');
  const title = lower(card.title || '');
  const content = asObject(card.content);
  const canonical = lower(content.canonical_en || content.canonical_text_en || content.original || content.markdown || '');
  return `${type}:${title}:${canonical.slice(0, 240)}`;
}

function mergeCards(base = {}, incoming = {}) {
  return normalizeSemanticBoardCard({
    ...base,
    ...incoming,
    content: { ...asObject(base.content), ...asObject(incoming.content) },
    scope: { ...asObject(base.scope), ...asObject(incoming.scope) },
    performance: { ...asObject(base.performance), ...asObject(incoming.performance) },
    tags: uniq([...(asArray(base.tags)), ...(asArray(incoming.tags))]),
    evidence: uniq([...(asArray(base.evidence)), ...(asArray(incoming.evidence))]),
    status: incoming.status || base.status,
    updated_at: new Date().toISOString(),
  });
}

function mergeLinks(base = {}, incoming = {}) {
  return normalizeSemanticBoardLink({
    ...base,
    ...incoming,
    metadata: { ...asObject(base.metadata), ...asObject(incoming.metadata) },
    updated_at: new Date().toISOString(),
  });
}

export function validateSemanticBoard(board = {}) {
  const cards = asArray(board.cards).map((card) => normalizeSemanticBoardCard(card)).filter(Boolean);
  const links = asArray(board.links).map((link) => normalizeSemanticBoardLink(link)).filter(Boolean);
  const issues = [];
  const cardIds = new Set();
  const cardStatus = new Map();
  const fpToIds = new Map();
  const linkIds = new Set();

  for (const card of cards) {
    if (!card.id) issues.push(issue('error', 'card_missing_id', 'Card is missing a stable id.', { title: card.title }));
    if (!ALLOWED_CARD_TYPES.has(card.type)) issues.push(issue('warning', 'unknown_card_type', `Unknown card type: ${card.type}`, { card_id: card.id, type: card.type }));
    if (!ALLOWED_CARD_STATUS.has(card.status)) issues.push(issue('warning', 'unknown_card_status', `Unknown card status: ${card.status}`, { card_id: card.id, status: card.status }));
    if (cardIds.has(card.id)) issues.push(issue('error', 'duplicate_card_id', `Duplicate card id: ${card.id}`, { card_id: card.id }));
    cardIds.add(card.id);
    cardStatus.set(card.id, card.status);
    if (!clean(card.title)) issues.push(issue('warning', 'card_missing_title', 'Card has no display title.', { card_id: card.id }));
    if (['memory_card', 'skill_card', 'rule_card'].includes(card.type)) {
      const content = asObject(card.content);
      if (!clean(content.canonical_en || content.original || content.markdown)) {
        issues.push(issue('warning', 'card_missing_semantic_content', 'Semantic card has no canonical/original/markdown content.', { card_id: card.id, type: card.type }));
      }
    }
    const fp = fingerprintCard(card);
    if (fp && fp !== `${card.type}::`) {
      const ids = fpToIds.get(fp) || [];
      ids.push(card.id);
      fpToIds.set(fp, ids);
    }
  }

  for (const [fp, ids] of fpToIds.entries()) {
    const uniqueIds = uniq(ids);
    if (uniqueIds.length > 1) issues.push(issue('info', 'possible_duplicate_cards', 'Cards appear semantically duplicated.', { fingerprint: fp, card_ids: uniqueIds }));
  }

  for (const link of links) {
    if (!link.id) issues.push(issue('error', 'link_missing_id', 'Link is missing a stable id.', { from: link.from, to: link.to, type: link.type }));
    if (linkIds.has(link.id)) issues.push(issue('error', 'duplicate_link_id', `Duplicate link id: ${link.id}`, { link_id: link.id }));
    linkIds.add(link.id);
    if (!link.from || !link.to) issues.push(issue('error', 'link_missing_endpoint', 'Link is missing one endpoint.', { link_id: link.id, from: link.from, to: link.to }));
    if (link.from === link.to) issues.push(issue('warning', 'self_link', 'Link points to the same card.', { link_id: link.id, card_id: link.from }));
    if (link.from && !cardIds.has(link.from)) issues.push(issue('error', 'dangling_link_from', 'Link source card is missing.', { link_id: link.id, from: link.from }));
    if (link.to && !cardIds.has(link.to)) issues.push(issue('error', 'dangling_link_to', 'Link target card is missing.', { link_id: link.id, to: link.to }));
    if (!ALLOWED_LINK_STATUS.has(link.status)) issues.push(issue('warning', 'unknown_link_status', `Unknown link status: ${link.status}`, { link_id: link.id, status: link.status }));
    const fromStatus = cardStatus.get(link.from);
    const toStatus = cardStatus.get(link.to);
    if (link.status === 'active' && ['retracted', 'disabled', 'archived'].includes(fromStatus)) {
      issues.push(issue('warning', 'active_link_from_inactive_card', 'Active link originates from an inactive card.', { link_id: link.id, from: link.from, from_status: fromStatus }));
    }
    if (link.status === 'active' && ['retracted', 'disabled', 'archived'].includes(toStatus)) {
      issues.push(issue('warning', 'active_link_to_inactive_card', 'Active link targets an inactive card.', { link_id: link.id, to: link.to, to_status: toStatus }));
    }
    const weight = Number(link.weight);
    if (link.weight !== undefined && (!Number.isFinite(weight) || weight < 0 || weight > 1)) {
      issues.push(issue('warning', 'invalid_link_weight', 'Link weight should be between 0 and 1.', { link_id: link.id, weight: link.weight }));
    }
  }

  const errors = issues.filter((row) => row.severity === 'error').length;
  const warnings = issues.filter((row) => row.severity === 'warning').length;
  const infos = issues.filter((row) => row.severity === 'info').length;
  return {
    ok: errors === 0,
    issue_count: issues.length,
    errors,
    warnings,
    infos,
    card_count: cards.length,
    link_count: links.length,
    issues,
  };
}

export function repairSemanticBoard(board = {}, { removeDanglingLinks = true, mergeDuplicateIds = true, deactivateLinksToInactiveCards = true } = {}) {
  const cardMap = new Map();
  const duplicateCardIds = [];
  for (const raw of asArray(board.cards)) {
    const card = normalizeSemanticBoardCard(raw);
    if (!card?.id) continue;
    if (mergeDuplicateIds && cardMap.has(card.id)) duplicateCardIds.push(card.id);
    cardMap.set(card.id, cardMap.has(card.id) ? mergeCards(cardMap.get(card.id), card) : card);
  }

  const linkMap = new Map();
  const removedLinks = [];
  const deactivatedLinks = [];
  for (const raw of asArray(board.links)) {
    const link = normalizeSemanticBoardLink(raw);
    if (!link?.id) continue;
    if (removeDanglingLinks && (!cardMap.has(link.from) || !cardMap.has(link.to))) {
      removedLinks.push(link.id);
      continue;
    }
    const fromStatus = cardMap.get(link.from)?.status;
    const toStatus = cardMap.get(link.to)?.status;
    if (deactivateLinksToInactiveCards && link.status === 'active' && (['retracted', 'disabled', 'archived'].includes(fromStatus) || ['retracted', 'disabled', 'archived'].includes(toStatus))) {
      link.status = 'disabled';
      link.reason = link.reason || 'Disabled by semantic board repair because one endpoint is inactive.';
      deactivatedLinks.push(link.id);
    }
    linkMap.set(link.id, linkMap.has(link.id) ? mergeLinks(linkMap.get(link.id), link) : link);
  }

  const repaired = {
    ...board,
    cards: [...cardMap.values()],
    links: [...linkMap.values()],
  };
  return {
    ok: true,
    board: repaired,
    duplicate_card_ids: uniq(duplicateCardIds),
    removed_link_ids: removedLinks,
    deactivated_link_ids: deactivatedLinks,
    validation: validateSemanticBoard(repaired),
  };
}

export function validateSemanticBoardStore(options = {}) {
  const board = readSemanticBoard(options);
  return { board, validation: validateSemanticBoard(board) };
}

export function repairSemanticBoardStore(options = {}) {
  const board = readSemanticBoard(options);
  const result = repairSemanticBoard(board, options);
  const saved = writeSemanticBoard(result.board, options);
  appendSemanticBoardEvent({ type: 'repair', payload: { duplicate_card_ids: result.duplicate_card_ids, removed_link_ids: result.removed_link_ids, deactivated_link_ids: result.deactivated_link_ids, validation: result.validation } }, options);
  return { ...result, board: saved };
}

export function buildSemanticBoardConsistencyReport({ board = {}, skillCatalog = [], performanceStore = {} } = {}) {
  const cards = asArray(board.cards);
  const skillCards = new Set(cards.filter((card) => card.type === 'skill_card').map((card) => card.id));
  const ruleCards = new Set(cards.filter((card) => card.type === 'rule_card').map((card) => card.id));
  const catalogSkillIds = new Set(asArray(skillCatalog).map((row) => clean(row.id || row.skill_id)).filter(Boolean));
  const performanceSkillIds = new Set(Object.keys(asObject(performanceStore.skills)));
  const performanceRuleIds = new Set(Object.keys(asObject(performanceStore.rules)));
  return {
    kind: 'semantic_board_consistency_report_v1',
    skill_cards: skillCards.size,
    rule_cards: ruleCards.size,
    catalog_skills: catalogSkillIds.size,
    performance_skills: performanceSkillIds.size,
    performance_rules: performanceRuleIds.size,
    missing_skill_cards: [...catalogSkillIds].filter((id) => !skillCards.has(id)).slice(0, 50),
    missing_performance_skill_cards: [...performanceSkillIds].filter((id) => !skillCards.has(id)).slice(0, 50),
    missing_performance_rule_cards: [...performanceRuleIds].filter((id) => !ruleCards.has(id)).slice(0, 50),
    stale_skill_cards: [...skillCards].filter((id) => catalogSkillIds.size > 0 && !catalogSkillIds.has(id) && !performanceSkillIds.has(id)).slice(0, 50),
  };
}

export function formatSemanticBoardValidation(validation = {}) {
  const lines = [
    'Semantic Board validation',
    `- ok: ${validation.ok ? 'yes' : 'no'}`,
    `- cards: ${validation.card_count ?? 0}`,
    `- links: ${validation.link_count ?? 0}`,
    `- issues: ${validation.issue_count ?? 0} (${validation.errors ?? 0} errors, ${validation.warnings ?? 0} warnings, ${validation.infos ?? 0} info)`,
  ];
  for (const row of asArray(validation.issues).slice(0, 12)) {
    lines.push(`- [${row.severity}] ${row.code}: ${row.message}`);
  }
  if ((validation.issues?.length || 0) > 12) lines.push(`- …and ${validation.issues.length - 12} more`);
  return lines.join('\n');
}

export function formatSemanticBoardRepair(result = {}) {
  const lines = [
    'Semantic Board repair complete',
    `- duplicate card ids merged: ${asArray(result.duplicate_card_ids).length}`,
    `- dangling links removed: ${asArray(result.removed_link_ids).length}`,
    `- inactive endpoint links disabled: ${asArray(result.deactivated_link_ids).length}`,
    `- remaining issues: ${result.validation?.issue_count ?? 0}`,
  ];
  return lines.join('\n');
}
