import fs from 'node:fs';
import path from 'node:path';
import { installSkillPackageToCatalog } from './skill_package_runtime.js';
import { validateSkillPackage } from '../domain/skill_packages.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function slugify(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'external';
}

function safeJsonText(text = '') {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

function safeRead(filePath = '') {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
}

function safeReadJson(filePath = '') {
  return safeJsonText(safeRead(filePath));
}

function uniqueRows(rows = []) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

export function normalizeImportedRuntimeRule(raw = {}, { source = 'external_import' } = {}) {
  const row = typeof raw === 'string' ? { text: raw } : asObject(raw);
  const text = clean(row.text || row.rule || row.instruction || row.markdown || row.content);
  if (!text) return null;
  return {
    id: clean(row.id || row.rule_id || row.ruleId) || `imported_rule_${slugify(text).slice(0, 48)}`,
    text: text.slice(0, 800),
    source: clean(row.source || source) || source,
    origin: clean(row.origin || source) || source,
    topic: clean(row.topic || row.category) || undefined,
    confidence: Number.isFinite(Number(row.confidence)) ? Math.max(0, Math.min(1, Number(row.confidence))) : undefined,
    reason: clean(row.reason || row.description) || undefined,
  };
}

function skillFromMarkdown(markdown = '', { sourceId = '', filename = '' } = {}) {
  const lines = String(markdown || '').split(/\r?\n/);
  const titleLine = lines.find((line) => /^#\s+/.test(line));
  const title = clean(titleLine ? titleLine.replace(/^#\s+/, '') : path.basename(filename || sourceId || 'external_skill', path.extname(filename || '')));
  const slug = slugify(title || sourceId || filename || 'external_skill');
  return {
    id: `skill.${slug}.external.v1`,
    slug,
    name: title || slug,
    version: '1.0.0',
    description: clean(lines.find((line) => line.trim() && !line.startsWith('#')) || 'Imported external markdown skill.'),
    category: 'external',
    kind: 'method',
    visibility: 'internal',
    status: 'active',
    trust_level: 'reviewed',
    side_effect_level: 'none',
    compatible_roles: ['builder', 'reviewer', 'operator'],
    capability_tags: ['external_skill', 'method'],
    trigger_terms: [slug, title].filter(Boolean),
    instructions_ref: 'SKILL.md',
    source_package: { type: 'local_file', repo_path: filename || sourceId },
    __instructions_markdown: markdown,
  };
}

function materializeMarkdownSkill(skill = {}, { skillsDir = path.resolve(process.cwd(), 'skills') } = {}) {
  const instructions = clean(skill.__instructions_markdown);
  const copy = { ...skill };
  delete copy.__instructions_markdown;
  const installed = installSkillPackageToCatalog(copy, { skillsDir });
  if (instructions) fs.writeFileSync(path.join(installed.dir, copy.instructions_ref || 'SKILL.md'), instructions);
  return installed;
}

function copyExternalSkillDir(srcDir = '', { skillsDir = path.resolve(process.cwd(), 'skills') } = {}) {
  const manifestPath = path.join(srcDir, 'manifest.json');
  const manifest = safeReadJson(manifestPath);
  if (!manifest) throw new Error(`missing manifest.json in ${srcDir}`);
  const validation = validateSkillPackage(manifest);
  if (!validation.ok) throw new Error(`invalid skill manifest: ${validation.errors.join(', ')}`);
  const installed = installSkillPackageToCatalog({
    ...manifest,
    source_package: {
      ...asObject(manifest.source_package),
      type: 'local_dir',
      repo_path: srcDir,
    },
  }, { skillsDir });
  for (const ref of [manifest.instructions_ref || 'SKILL.md', ...(manifest.resource_refs || []), ...(manifest.utility_refs || [])]) {
    const sourcePath = path.resolve(srcDir, String(ref || ''));
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).isDirectory()) continue;
    const targetPath = path.resolve(installed.dir, String(ref || ''));
    if (!targetPath.startsWith(path.resolve(installed.dir))) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return installed;
}

function importSkillObject(rawSkill = {}, options = {}) {
  const row = asObject(rawSkill);
  if (row.__instructions_markdown) return materializeMarkdownSkill(row, options);
  return installSkillPackageToCatalog(row, options);
}

export function importExternalSkillRuleSource(source = '', {
  rootDir = process.cwd(),
  skillsDir = path.resolve(rootDir, 'skills'),
} = {}) {
  const raw = clean(source);
  if (!raw) throw new Error('import source is required');
  if (/^https?:\/\//i.test(raw)) {
    throw new Error('remote URL import is disabled; download/review the file first, then import a local path or pasted JSON');
  }

  const installedSkills = [];
  const importedRules = [];
  let parsed = safeJsonText(raw);
  let sourcePath = '';

  if (!parsed) {
    const resolved = path.resolve(rootDir, raw);
    if (fs.existsSync(resolved)) {
      sourcePath = resolved;
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        installedSkills.push(copyExternalSkillDir(resolved, { skillsDir }));
        return {
          ok: true,
          source_type: 'directory',
          installed_skills: installedSkills,
          imported_rules: importedRules,
        };
      }
      const ext = path.extname(resolved).toLowerCase();
      const text = safeRead(resolved);
      if (ext === '.json') parsed = safeJsonText(text);
      else if (ext === '.md' || ext === '.txt') {
        const skill = skillFromMarkdown(text, { sourceId: resolved, filename: path.basename(resolved) });
        installedSkills.push(materializeMarkdownSkill(skill, { skillsDir }));
        return {
          ok: true,
          source_type: 'markdown',
          installed_skills: installedSkills,
          imported_rules: importedRules,
        };
      }
    }
  }

  if (!parsed) throw new Error('expected local path or JSON package');
  const pkg = asObject(parsed);
  const skills = asArray(pkg.skills).length > 0 ? asArray(pkg.skills) : (
    pkg.kind === 'skill_package_v1' || pkg.skill_id || pkg.id || pkg.slug ? [pkg] : []
  );
  for (const skill of skills) {
    installedSkills.push(importSkillObject(skill, { skillsDir }));
  }
  const rawRules = [
    ...asArray(pkg.rules),
    ...asArray(pkg.runtime_rules),
    ...asArray(pkg.runtimeRules),
  ];
  for (const rule of rawRules) {
    const normalized = normalizeImportedRuntimeRule(rule, { source: 'external_import' });
    if (normalized) importedRules.push(normalized);
  }
  return {
    ok: true,
    source_type: sourcePath ? 'json_file' : 'json_inline',
    installed_skills: installedSkills,
    imported_rules: uniqueRows(importedRules),
  };
}

export function formatExternalSkillRuleImportResult(result = {}) {
  const skills = asArray(result.installed_skills);
  const rules = asArray(result.imported_rules);
  const lines = [
    'External skill/rule import complete.',
    `- skills installed: ${skills.length}`,
    `- runtime rules imported: ${rules.length}`,
  ];
  if (skills.length) {
    lines.push('', 'Skills:');
    for (const row of skills.slice(0, 8)) {
      lines.push(`- ${row.skill?.id || row.skill?.skill_id || path.basename(row.dir || '')}`);
    }
  }
  if (rules.length) {
    lines.push('', 'Rules:');
    for (const row of rules.slice(0, 8)) lines.push(`- ${row.text}`);
  }
  return lines.join('\n');
}
