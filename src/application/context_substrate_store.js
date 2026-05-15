import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { classifyContextCommitLane } from './context_commit_lanes.js';
import { getCachedContextProjection, invalidateContextProjectionCache } from './context_projection_cache.js';
import { readSemanticBoard, writeSemanticBoard } from './semantic_board.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value ?? '').trim(); }
function nowIso() { return new Date().toISOString(); }

function stableHash(value = '') {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 12);
}

function slugify(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'item';
}

function safeReadJson(filePath = '', fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function safeReadJsonl(filePath = '', limit = 100) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
    const slice = limit > 0 ? lines.slice(-limit) : lines;
    return slice.map((line) => JSON.parse(line)).filter(Boolean);
  } catch {
    return [];
  }
}

function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonl(filePath = '', row = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
}

function fileExists(filePath = '') {
  try { return fs.existsSync(filePath); } catch { return false; }
}

export function defaultContextSubstrateDir({ rootDir = process.cwd(), jobId = '', substrateDir = '' } = {}) {
  if (substrateDir) return path.resolve(rootDir, substrateDir);
  const cleanJobId = clean(jobId);
  if (cleanJobId) return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', cleanJobId, 'local_memory', 'context_substrate');
  return path.resolve(rootDir, process.env.CONTEXT_SUBSTRATE_DIR || 'config/context_substrate');
}

function emptyManifest({ scope = 'global', source = 'ddalggak' } = {}) {
  const now = nowIso();
  return {
    kind: 'context_substrate_manifest_v1',
    version: 1,
    scope,
    source,
    created_at: now,
    updated_at: now,
    operation_count: 0,
    atom_count: 0,
    link_count: 0,
    latest_version: 0,
    latest_snapshot_id: 'ctx_000000',
  };
}

export function normalizeContextAtom(raw = {}) {
  const row = asObject(raw);
  const atomType = clean(row.atom_type || row.type || row.kind || 'memory').toLowerCase();
  const structured = asObject(row.structured || row.content || row.payload);
  const textOriginal = clean(row.text_original || row.original || structured.original || structured.text_original || row.text || '');
  const canonical = clean(row.canonical_text_en || row.canonical_en || structured.canonical_en || structured.canonical_text_en || row.summary || '');
  const title = clean(row.title || structured.title || textOriginal || canonical || atomType).replace(/\s+/g, ' ').slice(0, 180);
  const id = clean(row.id || row.atom_id || row.card_id) || `atom_${slugify(atomType)}_${stableHash(JSON.stringify({ atomType, title, textOriginal, canonical }))}`;
  const version = Number(row.version);
  const created = clean(row.created_at || row.createdAt) || nowIso();
  return {
    kind: 'semantic_atom_v1',
    id,
    atom_type: atomType,
    status: clean(row.status || 'active').toLowerCase() || 'active',
    title,
    text_original: textOriginal,
    canonical_text_en: canonical,
    structured,
    scope: asObject(row.scope),
    evidence_refs: asArray(row.evidence_refs || row.evidence).map(clean).filter(Boolean),
    tags: [...new Set(asArray(row.tags).map(clean).filter(Boolean))],
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
    source_ref: clean(row.source_ref || row.sourceRef || ''),
    created_at: created,
    updated_at: clean(row.updated_at || row.updatedAt) || created,
    version: Number.isFinite(version) ? version : 1,
  };
}

export function normalizeContextLink(raw = {}) {
  const row = asObject(raw);
  const from = clean(row.from || row.from_id || row.source);
  const to = clean(row.to || row.to_id || row.target);
  const type = clean(row.type || row.relation || 'related_to').toLowerCase() || 'related_to';
  if (!from || !to) return null;
  const id = clean(row.id || row.link_id) || `link_${slugify(type)}_${stableHash(`${from}:${type}:${to}`)}`;
  const version = Number(row.version);
  const weight = Number(row.weight);
  const created = clean(row.created_at || row.createdAt) || nowIso();
  return {
    kind: 'semantic_link_v1',
    id,
    from,
    to,
    type,
    status: clean(row.status || 'active').toLowerCase() || 'active',
    weight: Number.isFinite(weight) ? Math.max(0, Math.min(1, weight)) : undefined,
    evidence_refs: asArray(row.evidence_refs || row.evidence).map(clean).filter(Boolean),
    metadata: asObject(row.metadata),
    created_at: created,
    updated_at: clean(row.updated_at || row.updatedAt) || created,
    version: Number.isFinite(version) ? version : 1,
  };
}

function substratePaths(dir = '') {
  return {
    dir,
    manifest: path.join(dir, 'substrate_manifest.json'),
    atoms: path.join(dir, 'atoms_current.json'),
    links: path.join(dir, 'links_current.json'),
    operations: path.join(dir, 'operations.jsonl'),
    proposals: path.join(dir, 'proposals.jsonl'),
    materializationInvalidations: path.join(dir, 'materialization_invalidations.jsonl'),
    snapshotsDir: path.join(dir, 'snapshots'),
  };
}

export function ensureContextSubstrate(options = {}) {
  const dir = defaultContextSubstrateDir(options);
  const paths = substratePaths(dir);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(paths.snapshotsDir, { recursive: true });
  if (!fileExists(paths.manifest)) writeJson(paths.manifest, emptyManifest({ scope: options.jobId ? 'run' : 'global' }));
  if (!fileExists(paths.atoms)) writeJson(paths.atoms, []);
  if (!fileExists(paths.links)) writeJson(paths.links, []);
  if (!fileExists(path.join(paths.snapshotsDir, 'ctx_000000.json'))) {
    writeJson(path.join(paths.snapshotsDir, 'ctx_000000.json'), {
      kind: 'context_snapshot_v1',
      snapshot_id: 'ctx_000000',
      version: 0,
      created_at: nowIso(),
      atom_count: 0,
      link_count: 0,
      atoms: [],
      links: [],
    });
  }
  return paths;
}

export function readContextSubstrate(options = {}) {
  const paths = ensureContextSubstrate(options);
  const manifest = safeReadJson(paths.manifest, emptyManifest({ scope: options.jobId ? 'run' : 'global' }));
  const atoms = asArray(safeReadJson(paths.atoms, [])).map(normalizeContextAtom);
  const links = asArray(safeReadJson(paths.links, [])).map(normalizeContextLink).filter(Boolean);
  return {
    kind: 'context_substrate_v1',
    dir: paths.dir,
    manifest,
    snapshot_id: manifest.latest_snapshot_id || 'ctx_000000',
    version: manifest.latest_version || 0,
    atoms,
    links,
  };
}

function nextSnapshotId(version = 0) {
  return `ctx_${String(Math.max(0, Number(version) || 0)).padStart(6, '0')}`;
}

export function createContextSnapshot(options = {}) {
  const paths = ensureContextSubstrate(options);
  const substrate = readContextSubstrate(options);
  const version = Number(substrate.manifest.latest_version || 0);
  const snapshotId = nextSnapshotId(version);
  const snapshot = {
    kind: 'context_snapshot_v1',
    snapshot_id: snapshotId,
    version,
    created_at: nowIso(),
    atom_count: substrate.atoms.length,
    link_count: substrate.links.length,
    atoms: substrate.atoms,
    links: substrate.links,
  };
  writeJson(path.join(paths.snapshotsDir, `${snapshotId}.json`), snapshot);
  const manifest = {
    ...substrate.manifest,
    latest_snapshot_id: snapshotId,
    latest_version: version,
    atom_count: substrate.atoms.length,
    link_count: substrate.links.length,
    updated_at: nowIso(),
  };
  writeJson(paths.manifest, manifest);
  return { ok: true, snapshot, manifest };
}

export function readContextSnapshot(snapshotId = '', options = {}) {
  const paths = ensureContextSubstrate(options);
  const cleanId = clean(snapshotId) || safeReadJson(paths.manifest, {})?.latest_snapshot_id || 'ctx_000000';
  return safeReadJson(path.join(paths.snapshotsDir, `${cleanId}.json`), null);
}

function checkPreconditions(intent = {}, substrate = {}) {
  const pre = asObject(intent.preconditions);
  const errors = [];
  if (pre.base_snapshot_id && substrate.snapshot_id && pre.base_snapshot_id !== substrate.snapshot_id) {
    errors.push({ code: 'base_snapshot_changed', message: `Expected ${pre.base_snapshot_id}, current ${substrate.snapshot_id}.` });
  }
  const expectedAtomVersions = asObject(pre.expected_atom_versions);
  const atomsById = new Map(asArray(substrate.atoms).map((atom) => [atom.id, atom]));
  for (const [id, version] of Object.entries(expectedAtomVersions)) {
    if (Number(atomsById.get(id)?.version || 0) !== Number(version)) {
      errors.push({ code: 'atom_version_conflict', atom_id: id, expected: Number(version), actual: Number(atomsById.get(id)?.version || 0) });
    }
  }
  const targetId = clean(intent.atom_id || intent.payload?.atom_id || intent.payload?.id);
  if (pre.expected_version && targetId && Number(atomsById.get(targetId)?.version || 0) !== Number(pre.expected_version)) {
    errors.push({ code: 'atom_version_conflict', atom_id: targetId, expected: Number(pre.expected_version), actual: Number(atomsById.get(targetId)?.version || 0) });
  }
  return errors;
}

function normalizeOperation(intent = {}, { laneResult = {}, version = 0, status = 'committed', errors = [] } = {}) {
  const op = clean(intent.intent_type || intent.op || intent.operation || 'assert_atom').toLowerCase() || 'assert_atom';
  const id = clean(intent.id || intent.intent_id || intent.operation_id) || `op_${stableHash(`${Date.now()}:${JSON.stringify(intent)}`)}`;
  return {
    kind: 'context_operation_v1',
    id,
    op,
    version,
    actor: clean(intent.actor || 'runtime'),
    timestamp: nowIso(),
    status,
    lane: laneResult.lane || 'normal',
    commit_mode: laneResult.commit_mode || 'auto',
    lane_reasons: asArray(laneResult.reasons),
    payload: asObject(intent.payload || intent),
    preconditions: asObject(intent.preconditions),
    errors,
    source_view: asObject(intent.source_view),
  };
}

function applyOperationToState(operation = {}, atoms = [], links = []) {
  const byAtom = new Map(asArray(atoms).map((atom) => [atom.id, atom]));
  const byLink = new Map(asArray(links).map((link) => [link.id, link]));
  const op = operation.op;
  const payload = asObject(operation.payload);
  const ts = operation.timestamp || nowIso();

  if (op === 'assert_atom' || op === 'upsert_atom' || op === 'patch_atom') {
    const atom = normalizeContextAtom({ ...payload, ...(payload.atom || {}) });
    const prev = byAtom.get(atom.id);
    byAtom.set(atom.id, {
      ...(prev || {}),
      ...atom,
      structured: { ...asObject(prev?.structured), ...asObject(atom.structured) },
      scope: { ...asObject(prev?.scope), ...asObject(atom.scope) },
      tags: [...new Set([...(asArray(prev?.tags)), ...(asArray(atom.tags))])],
      evidence_refs: [...new Set([...(asArray(prev?.evidence_refs)), ...(asArray(atom.evidence_refs))])],
      version: Number(prev?.version || 0) + 1,
      updated_at: ts,
    });
  } else if (op === 'retract_atom') {
    const id = clean(payload.atom_id || payload.id);
    const prev = byAtom.get(id);
    if (prev) byAtom.set(id, { ...prev, status: 'retracted', version: Number(prev.version || 0) + 1, updated_at: ts, retraction_reason: clean(payload.reason || '') });
  } else if (op === 'assert_link' || op === 'link' || op === 'upsert_link' || op === 'patch_link') {
    const link = normalizeContextLink({ ...payload, ...(payload.link || {}) });
    if (link) {
      const prev = byLink.get(link.id);
      byLink.set(link.id, {
        ...(prev || {}),
        ...link,
        metadata: { ...asObject(prev?.metadata), ...asObject(link.metadata) },
        evidence_refs: [...new Set([...(asArray(prev?.evidence_refs)), ...(asArray(link.evidence_refs))])],
        version: Number(prev?.version || 0) + 1,
        updated_at: ts,
      });
    }
  } else if (op === 'unlink' || op === 'retract_link') {
    const id = clean(payload.link_id || payload.id);
    const prev = byLink.get(id);
    if (prev) byLink.set(id, { ...prev, status: 'retracted', version: Number(prev.version || 0) + 1, updated_at: ts });
  } else if (op === 'record_skill_outcome' || op === 'record_rule_outcome' || op === 'record_usage' || op === 'append_event') {
    // Append-only event operations intentionally do not mutate current atom/link state.
  } else if (op === 'materialize' || op === 'invalidate_materialization') {
    // Materialization updates are handled asynchronously by materializers.
  }

  return { atoms: [...byAtom.values()], links: [...byLink.values()] };
}

function writeCurrentState(paths = {}, substrate = {}, operation = null) {
  const version = Number(substrate.manifest.latest_version || 0) + (operation ? 1 : 0);
  const snapshotId = nextSnapshotId(version);
  const manifest = {
    ...substrate.manifest,
    updated_at: nowIso(),
    operation_count: Number(substrate.manifest.operation_count || 0) + (operation ? 1 : 0),
    atom_count: asArray(substrate.atoms).length,
    link_count: asArray(substrate.links).length,
    latest_version: version,
    latest_snapshot_id: snapshotId,
  };
  writeJson(paths.atoms, substrate.atoms);
  writeJson(paths.links, substrate.links);
  writeJson(paths.manifest, manifest);
  writeJson(path.join(paths.snapshotsDir, `${snapshotId}.json`), {
    kind: 'context_snapshot_v1',
    snapshot_id: snapshotId,
    version,
    created_at: nowIso(),
    atom_count: asArray(substrate.atoms).length,
    link_count: asArray(substrate.links).length,
    atoms: substrate.atoms,
    links: substrate.links,
  });
  return manifest;
}

function writeCurrentStateWithDelta(paths = {}, substrate = {}, { versionDelta = 0, operationDelta = 0 } = {}) {
  const version = Number(substrate.manifest.latest_version || 0) + Math.max(0, Number(versionDelta) || 0);
  const snapshotId = nextSnapshotId(version);
  const manifest = {
    ...substrate.manifest,
    updated_at: nowIso(),
    operation_count: Number(substrate.manifest.operation_count || 0) + Math.max(0, Number(operationDelta) || 0),
    atom_count: asArray(substrate.atoms).length,
    link_count: asArray(substrate.links).length,
    latest_version: version,
    latest_snapshot_id: snapshotId,
  };
  writeJson(paths.atoms, substrate.atoms);
  writeJson(paths.links, substrate.links);
  writeJson(paths.manifest, manifest);
  writeJson(path.join(paths.snapshotsDir, `${snapshotId}.json`), {
    kind: 'context_snapshot_v1',
    snapshot_id: snapshotId,
    version,
    created_at: nowIso(),
    atom_count: asArray(substrate.atoms).length,
    link_count: asArray(substrate.links).length,
    atoms: substrate.atoms,
    links: substrate.links,
  });
  return manifest;
}

function operationMutatesContextState(operation = {}) {
  return ['assert_atom', 'upsert_atom', 'patch_atom', 'retract_atom', 'assert_link', 'link', 'upsert_link', 'patch_link', 'unlink', 'retract_link'].includes(operation.op);
}

export function commitContextWriteIntent(intent = {}, options = {}) {
  const paths = ensureContextSubstrate(options);
  const substrate = readContextSubstrate(options);
  const laneResult = classifyContextCommitLane(intent);
  const preconditionErrors = checkPreconditions(intent, substrate);

  if (preconditionErrors.length) {
    const rejected = normalizeOperation(intent, { laneResult, version: Number(substrate.manifest.latest_version || 0), status: 'conflict', errors: preconditionErrors });
    appendJsonl(paths.proposals, rejected);
    return { ok: false, status: 'conflict', lane: laneResult.lane, operation: rejected, errors: preconditionErrors };
  }

  if (laneResult.commit_mode === 'review_required') {
    const proposal = normalizeOperation(intent, { laneResult, version: Number(substrate.manifest.latest_version || 0), status: 'review_required' });
    appendJsonl(paths.proposals, proposal);
    return { ok: true, status: 'review_required', lane: laneResult.lane, operation: proposal };
  }

  const nextVersion = Number(substrate.manifest.latest_version || 0) + 1;
  const operation = normalizeOperation(intent, { laneResult, version: nextVersion, status: 'committed' });
  const nextState = applyOperationToState(operation, substrate.atoms, substrate.links);
  const manifest = writeCurrentState(paths, { ...substrate, atoms: nextState.atoms, links: nextState.links }, operation);
  appendJsonl(paths.operations, operation);
  if (['assert_atom', 'upsert_atom', 'patch_atom', 'retract_atom', 'assert_link', 'link', 'upsert_link', 'patch_link', 'unlink', 'retract_link'].includes(operation.op)) {
    appendJsonl(paths.materializationInvalidations, { kind: 'materialization_invalidation_v1', operation_id: operation.id, version: operation.version, timestamp: nowIso(), reason: 'context_state_changed' });
    invalidateContextProjectionCache({ substrateDir: paths.dir });
  }
  return { ok: true, status: 'committed', lane: laneResult.lane, operation, manifest };
}

export function commitContextWriteIntentsBatch(intents = [], options = {}) {
  const rows = asArray(intents).filter((intent) => intent && typeof intent === 'object');
  const paths = ensureContextSubstrate(options);
  const initial = readContextSubstrate(options);
  let working = { ...initial, atoms: initial.atoms, links: initial.links };
  const baseVersion = Number(initial.manifest.latest_version || 0);
  const results = [];
  const committedOperations = [];
  const proposalOperations = [];
  let stateChanged = false;

  for (const intent of rows) {
    const laneResult = classifyContextCommitLane(intent);
    const preconditionErrors = checkPreconditions(intent, { ...working, snapshot_id: initial.snapshot_id });
    if (preconditionErrors.length) {
      const rejected = normalizeOperation(intent, { laneResult, version: baseVersion + committedOperations.length, status: 'conflict', errors: preconditionErrors });
      proposalOperations.push(rejected);
      results.push({ ok: false, status: 'conflict', lane: laneResult.lane, operation: rejected, errors: preconditionErrors });
      continue;
    }

    if (laneResult.commit_mode === 'review_required') {
      const proposal = normalizeOperation(intent, { laneResult, version: baseVersion + committedOperations.length, status: 'review_required' });
      proposalOperations.push(proposal);
      results.push({ ok: true, status: 'review_required', lane: laneResult.lane, operation: proposal });
      continue;
    }

    const nextVersion = baseVersion + committedOperations.length + 1;
    const operation = normalizeOperation(intent, { laneResult, version: nextVersion, status: 'committed' });
    const nextState = applyOperationToState(operation, working.atoms, working.links);
    working = { ...working, atoms: nextState.atoms, links: nextState.links };
    committedOperations.push(operation);
    if (operationMutatesContextState(operation)) stateChanged = true;
    results.push({ ok: true, status: 'committed', lane: laneResult.lane, operation });
  }

  let manifest = initial.manifest;
  if (committedOperations.length > 0) {
    manifest = writeCurrentStateWithDelta(paths, working, {
      versionDelta: committedOperations.length,
      operationDelta: committedOperations.length,
    });
    for (const operation of committedOperations) appendJsonl(paths.operations, operation);
  }
  for (const operation of proposalOperations) appendJsonl(paths.proposals, operation);
  if (stateChanged) {
    appendJsonl(paths.materializationInvalidations, {
      kind: 'materialization_invalidation_v1',
      operation_ids: committedOperations.filter(operationMutatesContextState).map((op) => op.id),
      version: baseVersion + committedOperations.length,
      timestamp: nowIso(),
      reason: 'context_state_changed_batch',
    });
    invalidateContextProjectionCache({ substrateDir: paths.dir });
  }

  return {
    ok: results.every((row) => row.ok !== false || row.status === 'conflict'),
    status: proposalOperations.length && !committedOperations.length ? 'review_required' : 'committed',
    total: rows.length,
    committed: committedOperations.length,
    proposals: proposalOperations.filter((op) => op.status === 'review_required').length,
    conflicts: proposalOperations.filter((op) => op.status === 'conflict').length,
    operations: committedOperations,
    proposal_operations: proposalOperations,
    results,
    manifest,
  };
}

export function listContextOperations(options = {}, { limit = 20, proposals = false } = {}) {
  const paths = ensureContextSubstrate(options);
  return safeReadJsonl(proposals ? paths.proposals : paths.operations, limit);
}

function boardCardToAtom(card = {}) {
  return normalizeContextAtom({
    id: card.id,
    atom_type: String(card.type || card.kind || 'memory_card').replace(/_card$/, ''),
    status: card.status || 'candidate',
    title: card.title,
    text_original: card.content?.original || card.description || '',
    canonical_text_en: card.content?.canonical_en || card.content?.canonical_text_en || card.description || '',
    structured: { semantic_board_card: card },
    scope: card.scope,
    evidence_refs: card.evidence,
    tags: card.tags,
    confidence: card.confidence,
    source_ref: `semantic_board:${card.id}`,
  });
}

function boardLinkToContextLink(link = {}) {
  return normalizeContextLink({ ...link, source_ref: `semantic_board:${link.id}` });
}

export function mirrorSemanticBoardToContextSubstrate(options = {}) {
  const board = readSemanticBoard(options);
  let committed = 0;
  let proposals = 0;
  for (const card of asArray(board.cards)) {
    const result = commitContextWriteIntent({ actor: 'runtime:semantic_board_mirror', intent_type: 'upsert_atom', payload: boardCardToAtom(card) }, options);
    if (result.status === 'committed') committed += 1; else proposals += 1;
  }
  for (const link of asArray(board.links)) {
    const result = commitContextWriteIntent({ actor: 'runtime:semantic_board_mirror', intent_type: 'upsert_link', payload: boardLinkToContextLink(link) }, options);
    if (result.status === 'committed') committed += 1; else proposals += 1;
  }
  return { ok: true, committed, proposals, board_card_count: board.cards.length, board_link_count: board.links.length };
}

function atomToBoardCard(atom = {}) {
  const type = `${clean(atom.atom_type || 'memory')}_card`;
  return {
    id: atom.id,
    type,
    title: atom.title || atom.id,
    status: atom.status || 'active',
    content: {
      original: atom.text_original || '',
      canonical_en: atom.canonical_text_en || '',
      structured: atom.structured || {},
    },
    scope: atom.scope || {},
    evidence: atom.evidence_refs || [],
    tags: atom.tags || [],
    confidence: atom.confidence,
    source: 'context_substrate',
    source_ref: `context_substrate:${atom.id}`,
    created_at: atom.created_at,
    updated_at: atom.updated_at,
  };
}

export function mirrorContextSubstrateToSemanticBoard(options = {}) {
  const substrate = readContextSubstrate(options);
  const board = readSemanticBoard(options);
  const cardsById = new Map(asArray(board.cards).map((card) => [card.id, card]));
  for (const atom of substrate.atoms) cardsById.set(atom.id, { ...(cardsById.get(atom.id) || {}), ...atomToBoardCard(atom) });
  const linksById = new Map(asArray(board.links).map((link) => [link.id, link]));
  for (const link of substrate.links) linksById.set(link.id, { ...link, kind: 'semantic_board_link_v1' });
  const saved = writeSemanticBoard({ ...board, cards: [...cardsById.values()], links: [...linksById.values()] }, options);
  return { ok: true, cards: substrate.atoms.length, links: substrate.links.length, board: saved };
}

export function compactContextSubstrate(options = {}) {
  const snapshot = createContextSnapshot(options);
  return { ok: true, snapshot_id: snapshot.snapshot.snapshot_id, version: snapshot.snapshot.version, atom_count: snapshot.snapshot.atom_count, link_count: snapshot.snapshot.link_count };
}

export function getContextProjection(options = {}, query = {}) {
  const paths = ensureContextSubstrate(options);
  const substrate = readContextSubstrate(options);
  return getCachedContextProjection({ substrateDir: paths.dir, substrate, query, cache: query.cache !== false, limit: Number(query.limit || 24) });
}

export function summarizeContextSubstrate(options = {}) {
  const paths = ensureContextSubstrate(options);
  const substrate = readContextSubstrate(options);
  const operations = listContextOperations(options, { limit: 1 });
  const proposals = listContextOperations(options, { limit: 50, proposals: true });
  return {
    kind: 'context_substrate_summary_v1',
    dir: paths.dir,
    snapshot_id: substrate.snapshot_id,
    version: substrate.version,
    atom_count: substrate.atoms.length,
    link_count: substrate.links.length,
    operation_count: substrate.manifest.operation_count || 0,
    proposal_count: proposals.length,
    latest_operation: operations[0] || null,
  };
}

export function formatContextSubstrateSummary(summary = {}) {
  return [
    'Context Substrate',
    `- snapshot: ${summary.snapshot_id || 'ctx_000000'} · version=${summary.version || 0}`,
    `- atoms: ${summary.atom_count || 0}`,
    `- links: ${summary.link_count || 0}`,
    `- operations: ${summary.operation_count || 0}`,
    `- pending proposals/conflicts: ${summary.proposal_count || 0}`,
    '',
    'Commands:',
    '- /context ops [limit]',
    '- /context proposals [limit]',
    '- /context projection [role] [task_type]',
    '- /context mirror-board',
    '- /context mirror-to-board',
    '- /context compact',
  ].join('\n');
}
