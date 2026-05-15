import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value ?? '').trim(); }

function stableHash(value = '') {
  return crypto.createHash('sha1').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeReadJson(filePath = '', fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}

function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function projectionCacheDir(substrateDir = '') {
  return path.join(substrateDir, 'projection_cache');
}

export function buildContextProjectionCacheKey({ snapshot_id = '', role = '', task_type = '', goal = '', scope = '', budget_tokens = 1800 } = {}) {
  const raw = JSON.stringify({ snapshot_id, role, task_type, goal_hash: stableHash(goal), scope, budget_tokens });
  return `projection_${stableHash(raw)}`;
}

function atomMatches(atom = {}, query = {}) {
  const role = clean(query.role).toLowerCase();
  const taskType = clean(query.task_type).toLowerCase();
  const wantedTypes = asArray(query.atom_types).map((v) => clean(v).toLowerCase()).filter(Boolean);
  if (wantedTypes.length && !wantedTypes.includes(clean(atom.atom_type || atom.type).toLowerCase())) return false;
  if (atom.status && !['active', 'candidate'].includes(clean(atom.status).toLowerCase())) return false;
  const tags = asArray(atom.tags).map((v) => clean(v).toLowerCase());
  const roles = asArray(atom.applies_to_roles || atom.structured?.applies_to_roles || atom.scope?.roles).map((v) => clean(v).toLowerCase());
  const tasks = asArray(atom.task_types || atom.structured?.task_types || atom.scope?.task_types).map((v) => clean(v).toLowerCase());
  if (role && roles.length && !roles.includes(role)) return false;
  if (taskType && tasks.length && !tasks.includes(taskType)) return false;
  if (role && (tags.includes(role) || roles.includes(role))) return true;
  if (taskType && (tags.includes(taskType) || tasks.includes(taskType))) return true;
  return true;
}

function compactAtom(atom = {}) {
  const structured = asObject(atom.structured);
  return {
    id: atom.id,
    atom_type: atom.atom_type || atom.type || 'memory',
    status: atom.status || 'active',
    title: atom.title || structured.title || '',
    text_original: atom.text_original || structured.text_original || '',
    canonical_text_en: atom.canonical_text_en || structured.canonical_text_en || atom.canonical_en || '',
    confidence: atom.confidence,
    tags: asArray(atom.tags),
    evidence_refs: asArray(atom.evidence_refs || atom.evidence),
  };
}

export function buildContextProjection({ substrate = {}, query = {}, limit = 24 } = {}) {
  const atoms = asArray(substrate.atoms)
    .filter((atom) => atomMatches(atom, query))
    .sort((a, b) => Number(b.weight || b.confidence || 0) - Number(a.weight || a.confidence || 0))
    .slice(0, limit)
    .map(compactAtom);
  const atomIds = new Set(atoms.map((atom) => atom.id));
  const links = asArray(substrate.links)
    .filter((link) => atomIds.has(link.from) || atomIds.has(link.to))
    .slice(0, limit * 2)
    .map((link) => ({ id: link.id, from: link.from, to: link.to, type: link.type, weight: link.weight, status: link.status }));
  return {
    kind: 'context_projection_v1',
    snapshot_id: substrate.snapshot_id || substrate.manifest?.latest_snapshot_id || 'ctx_000000',
    generated_at: new Date().toISOString(),
    query,
    atom_count: atoms.length,
    link_count: links.length,
    atoms,
    links,
  };
}

export function getCachedContextProjection({ substrateDir = '', substrate = {}, query = {}, cache = true, limit = 24 } = {}) {
  const key = buildContextProjectionCacheKey({ snapshot_id: substrate.snapshot_id || substrate.manifest?.latest_snapshot_id || 'ctx_000000', ...query });
  const filePath = path.join(projectionCacheDir(substrateDir), `${key}.json`);
  if (cache) {
    const cached = safeReadJson(filePath, null);
    if (cached?.kind === 'context_projection_v1') return { ...cached, cache_hit: true, cache_key: key };
  }
  const projection = buildContextProjection({ substrate, query, limit });
  writeJson(filePath, { ...projection, cache_key: key });
  return { ...projection, cache_hit: false, cache_key: key };
}

export function invalidateContextProjectionCache({ substrateDir = '' } = {}) {
  const dir = projectionCacheDir(substrateDir);
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    }
  } catch {
    // cache may not exist yet
  }
  return { ok: true, removed };
}
