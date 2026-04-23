import fs from "node:fs";
import path from "node:path";

import { normalizeSkillPackage } from "../domain/skill_packages.js";
import { splitToolishIds, uniqueIds } from "../shared/participant_schema.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function slugify(value = '') {
  return clean(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function safeVersionSegment(value = '') {
  return slugify(clean(value).replace(/\./g, '_')) || 'v1';
}

function buildGeneratedSkillMarkdown(skill = {}) {
  const credentials = asArray(skill.credential_requirements)
    .map((entry) => `- ${entry.key}${entry.required === false ? ' (optional)' : ''}${entry.provider ? ` · provider=${entry.provider}` : ''}`);
  const setup = asArray(skill.install_recipe?.setup_steps).map((entry) => `- ${entry}`);
  const verify = asArray(skill.install_recipe?.verify_commands).map((entry) => `- ${entry}`);
  return [
    `# ${skill.name || skill.id}`,
    '',
    skill.description || 'Imported skill package from GoC catalog.',
    '',
    `- skill_id: ${skill.id}`,
    `- version: ${skill.version || '1.0.0'}`,
    `- adapter: ${skill.execution_adapter?.kind || 'prompt_only'}`,
    `- trust_level: ${skill.trust_level || 'reviewed'}`,
    `- side_effect_level: ${skill.side_effect_level || 'none'}`,
    '',
    '## Credential requirements',
    ...(credentials.length > 0 ? credentials : ['- none']),
    '',
    '## Setup steps',
    ...(setup.length > 0 ? setup : ['- none']),
    '',
    '## Verification',
    ...(verify.length > 0 ? verify : ['- none']),
    '',
    '## Adapter',
    `- entrypoint: ${skill.execution_adapter?.entrypoint || '-'}`,
    `- endpoint: ${skill.execution_adapter?.endpoint || '-'}`,
  ].join('\n');
}

export function resolveImportedSkillDir(skill = {}, { skillsDir = path.resolve(process.cwd(), 'skills') } = {}) {
  const slug = slugify(skill.slug || skill.name || skill.id || 'skill');
  const version = safeVersionSegment(skill.version || 'v1');
  return path.join(skillsDir, `goc_imported__${slug}__${version}`);
}

export function installSkillPackageToCatalog(rawSkillPackage = {}, { skillsDir = path.resolve(process.cwd(), 'skills') } = {}) {
  const skill = normalizeSkillPackage(rawSkillPackage, {});
  if (!skill) throw new Error('invalid skill package');
  const dir = resolveImportedSkillDir(skill, { skillsDir });
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const instructionsRef = skill.instructions_ref || 'SKILL.md';
  fs.writeFileSync(manifestPath, JSON.stringify({
    ...skill,
    source_package: {
      ...asObject(skill.source_package),
      imported_from: 'goc_catalog',
    },
  }, null, 2));
  const instructionPath = path.join(dir, instructionsRef);
  if (!fs.existsSync(instructionPath)) {
    fs.writeFileSync(instructionPath, buildGeneratedSkillMarkdown(skill));
  }
  return {
    skill,
    dir,
    manifest_path: manifestPath,
    instructions_path: instructionPath,
  };
}

export async function syncSkillPackagesFromGoC({ client = null, skillIds = [], threadId = '', skillsDir = path.resolve(process.cwd(), 'skills'), includeDefaults = false } = {}) {
  if (!client || typeof client.exportSkillPackage !== 'function') {
    throw new Error('syncSkillPackagesFromGoC requires client.exportSkillPackage');
  }
  const installed = [];
  for (const skillId of uniqueIds(skillIds, { max: 24 })) {
    const exported = await client.exportSkillPackage(skillId, { threadId, includeDefaults });
    const pkg = exported?.package || exported;
    installed.push(installSkillPackageToCatalog(pkg, { skillsDir }));
  }
  return installed;
}

export function summarizeTeamSkillPackages({ team = {}, skillRegistry = null } = {}) {
  const packages = [];
  const seen = new Set();
  for (const agent of asArray(team?.agents)) {
    const skillIds = uniqueIds(agent?.attached_skill_ids || agent?.attachedSkillIds || agent?.skills || [], { max: 16 });
    for (const skillId of skillIds) {
      const skill = skillRegistry?.resolve?.(skillId);
      if (!skill || seen.has(skill.id)) continue;
      seen.add(skill.id);
      const toolSplit = splitToolishIds(skill.required_tools || []);
      packages.push({
        id: skill.id,
        name: skill.name,
        credential_requirements: asArray(skill.credential_requirements),
        execution_adapter: asObject(skill.execution_adapter),
        runtime_capabilities_required: toolSplit.runtimeCapabilities,
        external_tool_requirements: toolSplit.externalTools,
        trust_level: skill.trust_level,
        side_effect_level: skill.side_effect_level,
      });
    }
  }
  return packages;
}
