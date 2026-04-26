import fs from 'node:fs';
import path from 'node:path';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeJson(filePath = '') {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function uniqStrings(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).map((v) => String(v || '').trim()).filter(Boolean))];
}

export function normalizeLocalSkillManifest(manifest = {}, { dir = '' } = {}) {
  const row = asObject(manifest);
  const slug = String(row.slug || (dir ? path.basename(dir) : '') || '').trim();
  const id = String(row.id || row.skill_id || (slug ? `skill.${slug}.local` : '')).trim();
  if (!id) return null;
  const capabilityTags = uniqStrings([
    ...(Array.isArray(row.capability_tags) ? row.capability_tags : []),
    ...(Array.isArray(row.tags) ? row.tags : []),
    row.category,
    row.kind,
  ]);
  return {
    ...row,
    id,
    skill_id: id,
    slug,
    name: String(row.name || slug || id).trim(),
    description: String(row.description || '').trim(),
    capability_tags: capabilityTags,
    tags: capabilityTags,
    source: 'local_skills_dir',
    source_dir: dir,
    side_effect_level: String(row.side_effect_level || row.sideEffectLevel || row.safety_policy?.side_effect_level || (row.kind === 'tool' ? 'read_only' : 'none')).trim() || 'unknown',
    trust_level: String(row.trust_level || row.trustLevel || row.visibility || 'local').trim() || 'local',
  };
}

export function listLocalSkillPackages({ rootDir = process.cwd(), skillsDir = 'skills' } = {}) {
  const base = path.resolve(rootDir, skillsDir);
  try {
    if (!fs.existsSync(base)) return [];
    return fs.readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(base, entry.name, 'manifest.json'))
      .filter((manifestPath) => fs.existsSync(manifestPath))
      .map((manifestPath) => normalizeLocalSkillManifest(safeJson(manifestPath), { dir: path.dirname(manifestPath) }))
      .filter(Boolean)
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
  } catch {
    return [];
  }
}

export function getLocalSkillPackage(skillId = '', options = {}) {
  const clean = String(skillId || '').trim().toLowerCase();
  if (!clean) return null;
  return listLocalSkillPackages(options).find((row) => {
    return [row.id, row.skill_id, row.slug, row.name]
      .map((value) => String(value || '').trim().toLowerCase())
      .includes(clean);
  }) || null;
}
