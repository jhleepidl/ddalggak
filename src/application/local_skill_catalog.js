import fs from 'node:fs';
import path from 'node:path';
import { normalizeLanguageMetadata } from './language_policy.js';
import { buildCanonicalProjectionRequest } from './canonical_projection.js';
import { addSemanticIndexItems, searchSemanticIndex } from './semantic_index.js';

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
  const name = String(row.name || slug || id).trim();
  const description = String(row.description || '').trim();
  const language = normalizeLanguageMetadata({
    text: description || name,
    displayText: description || name,
    locale: row.original_language || row.source_original_language || '',
    canonicalTextEn: row.canonical_description_en || row.canonical_text_en || '',
    source: 'local_skill_catalog',
  });
  const projection = buildCanonicalProjectionRequest({
    object_type: 'skill',
    source_id: id,
    source_ref: dir,
    title: name,
    source_original_text: language.source_original_text,
    source_original_language: language.source_original_language,
    display_text: language.display_text,
    canonical_text_en: language.canonical_text_en,
    metadata: { capability_tags: capabilityTags },
  });
  const canonicalTextEn = projection.canonical_text_en || language.canonical_text_en;
  return {
    ...row,
    id,
    skill_id: id,
    slug,
    name,
    description,
    source_original_language: language.source_original_language,
    source_original_text: language.source_original_text,
    display_text: language.display_text,
    canonical_language: 'en',
    canonical_description_en: canonicalTextEn,
    canonical_text_en: canonicalTextEn,
    canonical_projection_status: projection.canonical_projection_status || language.canonical_projection_status,
    canonical_projection_id: projection.projection_id,
    projection_method: projection.projection_method,
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


export function indexLocalSkillPackages({ rootDir = process.cwd(), skillsDir = 'skills', jobDir = '', indexDir = '' } = {}) {
  const skills = listLocalSkillPackages({ rootDir, skillsDir });
  const items = skills.map((skill) => ({
    itemType: 'skill',
    namespace: 'local_skill_catalog',
    sourceId: skill.skill_id,
    sourceRef: skill.source_dir,
    title: skill.name,
    text: [skill.description, skill.canonical_description_en, ...(skill.capability_tags || [])].filter(Boolean).join('\n'),
    originalLanguage: skill.source_original_language,
    canonicalTextEn: skill.canonical_description_en,
    displayText: skill.display_text || skill.description || skill.name,
    metadata: {
      skill_id: skill.skill_id,
      capability_tags: skill.capability_tags || [],
      side_effect_level: skill.side_effect_level,
      trust_level: skill.trust_level,
      source_dir: skill.source_dir,
    },
    status: skill.disabled ? 'disabled' : 'active',
    visibility: skill.trust_level === 'public' ? 'public' : 'private',
  }));
  const added = addSemanticIndexItems({ jobDir: jobDir || rootDir, indexDir, items });
  return { ok: true, skill_count: skills.length, indexed_count: added.added_count, skills, index: added };
}

export function discoverLocalSkills({ query = '', jobDir = '', rootDir = process.cwd(), skillsDir = 'skills', indexDir = '', limit = 6, autoIndex = true } = {}) {
  const baseJobDir = jobDir || rootDir;
  if (autoIndex) indexLocalSkillPackages({ rootDir, skillsDir, jobDir: baseJobDir, indexDir });
  const result = searchSemanticIndex({ jobDir: baseJobDir, indexDir, query, itemTypes: ['skill'], limit, includeInactive: false, useVector: true });
  return {
    ok: true,
    query: String(query || '').trim(),
    skill_count: result.item_count,
    skills: (result.items || []).map((item) => ({
      skill_id: item.metadata?.skill_id || item.item_id,
      name: item.title,
      score: item.semantic_score,
      vector_score: item.vector_score,
      lexical_score: item.lexical_semantic_score,
      capability_tags: item.metadata?.capability_tags || [],
      source_dir: item.metadata?.source_dir,
      canonical_text_en: item.canonical_text_en,
    })),
  };
}
