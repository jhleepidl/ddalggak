import fs from 'node:fs';
import path from 'node:path';
import { sanitizeRoomPackage } from './room_package.js';

function clean(value = '', { maxLen = 2000, lower = false } = {}) {
  const text = String(value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function slug(value = '', fallback = 'manifest') {
  const out = clean(value || fallback, { maxLen: 160, lower: true })
    .replace(/[^a-z0-9가-힣._:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return out || fallback;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values = [], max = 32) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw, { maxLen: 120 });
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export const DEFAULT_PROJECT_MANIFEST_FILENAMES = Object.freeze([
  'CLAUDE.md',
  'AGENTS.md',
  'SKILL.md',
  'ROOM.md',
  'PROJECT.md',
]);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BULLET_RE = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+?)\s*$/;
const CODE_FENCE_RE = /^\s*```/;

function inferManifestType(filename = '') {
  const base = path.basename(filename).toLowerCase();
  if (base === 'claude.md') return 'claude_md';
  if (base === 'agents.md') return 'agents_md';
  if (base === 'skill.md') return 'skill_md';
  if (base === 'room.md') return 'room_md';
  return 'project_markdown';
}

function classifyHeading(heading = '') {
  const h = clean(heading, { lower: true, maxLen: 180 });
  if (/overview|summary|purpose|project|about|소개|개요|목적/.test(h)) return 'overview';
  if (/architecture|structure|design|module|component|구조|아키텍처|설계/.test(h)) return 'architecture';
  if (/command|script|build|test|run|deploy|실행|명령|테스트|빌드|배포/.test(h)) return 'commands';
  if (/style|convention|guideline|coding|format|lint|규칙|컨벤션|스타일/.test(h)) return 'conventions';
  if (/workflow|process|procedure|steps|작업|절차|프로세스/.test(h)) return 'workflow';
  if (/do not|forbidden|avoid|never|주의|금지|하지 말|금지사항/.test(h)) return 'forbidden_actions';
  if (/review|checklist|verify|검토|확인|체크리스트/.test(h)) return 'review_checklist';
  if (/tool|permission|api|external|도구|권한/.test(h)) return 'tool_policy';
  if (/memory|context|state|history|맥락|컨텍스트|기억|메모리/.test(h)) return 'memory_policy';
  if (/agent|skill|role|persona|에이전트|스킬|역할/.test(h)) return 'agent_or_skill';
  return 'other';
}

function splitSections(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const sections = [];
  let current = { level: 1, heading: 'Preamble', lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (CODE_FENCE_RE.test(line)) inFence = !inFence;
    const match = !inFence ? HEADING_RE.exec(line) : null;
    if (match) {
      if (current.lines.join('\n').trim() || current.heading !== 'Preamble') sections.push(current);
      current = { level: match[1].length, heading: clean(match[2], { maxLen: 180 }), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.join('\n').trim() || current.heading !== 'Preamble') sections.push(current);
  return sections.map((section, index) => {
    const text = clean(section.lines.join('\n'), { maxLen: 4000 });
    const bullets = [];
    for (const line of section.lines) {
      const m = BULLET_RE.exec(line);
      if (m) bullets.push(clean(m[1], { maxLen: 300 }));
    }
    return {
      section_id: `section_${String(index + 1).padStart(2, '0')}`,
      level: section.level,
      heading: section.heading,
      category: classifyHeading(section.heading),
      text,
      bullets: unique(bullets, 20),
    };
  }).filter((section) => section.heading || section.text);
}

function collectCategories(sections = []) {
  const out = {
    overview: [],
    architecture: [],
    commands: [],
    conventions: [],
    workflow: [],
    forbidden_actions: [],
    review_checklist: [],
    tool_policy: [],
    memory_policy: [],
    agent_or_skill: [],
    other: [],
  };
  for (const section of sections) {
    const key = out[section.category] ? section.category : 'other';
    const lines = section.bullets.length ? section.bullets : [section.text].filter(Boolean);
    out[key].push(...lines.slice(0, 8));
  }
  for (const key of Object.keys(out)) out[key] = unique(out[key], 24);
  return out;
}

function inferDomainFromPolicies(policies = {}, content = '') {
  const text = `${content}\n${Object.values(policies).flat().join('\n')}`.toLowerCase();
  if (/repo|code|test|build|lint|deploy|api|frontend|backend|typescript|python|pytest|node/.test(text)) return 'code_review';
  if (/paper|research|experiment|evaluation|latex|sigir|novelty/.test(text)) return 'research_paper';
  return 'general_workbench';
}

function inferAgents(policies = {}, domain = 'general_workbench') {
  const roles = [];
  const text = Object.values(policies).flat().join('\n').toLowerCase();
  if (/architecture|design|plan|workflow/.test(text)) roles.push('project_planner');
  if (/test|verify|review|checklist|lint/.test(text)) roles.push('verifier', 'reviewer');
  if (/code|patch|implement|build/.test(text)) roles.push('builder');
  if (/research|paper|literature|experiment/.test(text)) roles.push('researcher', 'novelty_critic');
  if (/memory|context|state/.test(text)) roles.push('context_curator');
  if (!roles.length) roles.push(domain === 'code_review' ? 'implementation_planner' : 'researcher', 'reviewer', 'synthesizer');
  return unique(roles.map(slug), 10);
}

function inferMemoryObjects(policies = {}, domain = 'general_workbench') {
  const base = ['project_overview', 'workflow_rules', 'constraints'];
  const text = Object.values(policies).flat().join('\n').toLowerCase();
  if (/architecture|module|component|design/.test(text)) base.push('architecture_notes');
  if (/command|build|test|run|deploy|script/.test(text)) base.push('commands');
  if (/style|convention|guideline|coding/.test(text)) base.push('conventions');
  if (/review|checklist|verify/.test(text)) base.push('review_checklist');
  if (/tool|permission|api/.test(text)) base.push('tool_policy');
  if (/memory|context/.test(text)) base.push('context_policy');
  if (domain === 'research_paper') base.push('research_claims', 'evaluation_plan');
  return unique(base.map(slug), 24);
}

export function parseProjectManifest({ filename = 'CLAUDE.md', content = '', source = 'manual_import' } = {}) {
  const raw = String(content || '');
  const sections = splitSections(raw);
  const policies = collectCategories(sections);
  const manifestType = inferManifestType(filename);
  const domain = inferDomainFromPolicies(policies, raw);
  const titleSection = sections.find((s) => s.level === 1 && s.heading && s.heading !== 'Preamble');
  const title = titleSection?.heading || path.basename(filename);
  return {
    kind: 'static_project_manifest_v1',
    manifest_type: manifestType,
    source,
    filename: path.basename(filename),
    title: clean(title, { maxLen: 140 }) || path.basename(filename),
    domain_label: domain,
    sections,
    policies,
    derived: {
      agents: inferAgents(policies, domain),
      memory_object_types: inferMemoryObjects(policies, domain),
      tags: unique([manifestType, domain, 'static_manifest', 'project_guidance'], 10).map(slug),
    },
    import_boundary: {
      copies_private_memory: false,
      copies_credentials: false,
      raw_chat_history_imported: false,
      user_approval_required_for_persistent_install: true,
    },
  };
}

export function buildRoomPackageFromProjectManifest(manifest = {}, { roomId = '', title = '' } = {}) {
  const row = manifest?.kind === 'static_project_manifest_v1' ? manifest : parseProjectManifest(manifest);
  const policies = row.policies || {};
  const summaryBits = [
    ...(policies.overview || []).slice(0, 2),
    ...(policies.architecture || []).slice(0, 2),
    ...(policies.workflow || []).slice(0, 2),
  ].filter(Boolean);
  const manualSections = row.sections
    .filter((section) => ['overview', 'architecture', 'commands', 'conventions', 'workflow', 'forbidden_actions', 'review_checklist', 'tool_policy', 'memory_policy', 'agent_or_skill'].includes(section.category))
    .slice(0, 12)
    .map((section) => `## ${section.heading}\n${section.text || section.bullets.join('\n')}`)
    .join('\n\n')
    .slice(0, 8000);
  return sanitizeRoomPackage({
    package_id: `imported_${slug(row.filename || row.title || 'manifest')}`,
    title: title || `${row.title} Room`,
    description: summaryBits.join(' ') || `Room package imported from ${row.filename}.`,
    domain_label: row.domain_label || 'general_workbench',
    visibility: 'private_review',
    status: 'candidate',
    version: '0.1.0',
    agents: row.derived?.agents || [],
    default_depth: row.domain_label === 'code_review' ? 'team' : 'ask',
    memory_schema: {
      object_types: row.derived?.memory_object_types || [],
      retention_policy: 'room_local_by_default',
      private_memory_export: 'never_by_default',
    },
    prompt_policy: {
      token_budget: row.domain_label === 'code_review' ? 'medium' : 'adaptive',
      static_manifest_context: 'use_relevant_sections_only',
      source_manifest_type: row.manifest_type,
    },
    context_policy: {
      default_scope: 'room_local_plus_static_manifest',
      static_manifest_import: 'allowed_as_non_private_project_guidance',
      private_memory: 'least_privilege',
      cross_room_memory: 'ask_before_use',
    },
    approval_policy: {
      default: 'ask_before_persistent_room_install',
      requires_approval: ['memory_promotion', 'external_action', 'destructive_change'],
    },
    room_manual: manualSections,
    examples: [
      { user: 'Use the project guidance for this task.', room: 'Apply only relevant manifest sections, obey safety boundaries, and explain selected context.' },
    ],
    tags: row.derived?.tags || ['static_manifest'],
    source: { room_id: String(roomId || ''), manifest_filename: row.filename, manifest_type: row.manifest_type },
  });
}

export function buildStaticManifestContextBlock(manifest = {}, { maxSections = 6 } = {}) {
  const row = manifest?.kind === 'static_project_manifest_v1' ? manifest : parseProjectManifest(manifest);
  const preferred = ['overview', 'architecture', 'commands', 'conventions', 'workflow', 'forbidden_actions', 'review_checklist', 'tool_policy', 'memory_policy'];
  const sections = row.sections
    .filter((section) => preferred.includes(section.category))
    .slice(0, maxSections);
  const lines = [
    '<static_project_manifest>',
    `filename: ${row.filename}`,
    `type: ${row.manifest_type}`,
    'boundary: project guidance only; no private memory or credentials are imported',
  ];
  for (const section of sections) {
    const body = section.bullets.length ? section.bullets.map((x) => `- ${x}`).join('\n') : section.text;
    lines.push(`\n## ${section.heading}\n${body}`.slice(0, 1800));
  }
  lines.push('</static_project_manifest>');
  return lines.join('\n');
}

export function loadProjectManifestsFromDir({ rootDir = process.cwd(), filenames = DEFAULT_PROJECT_MANIFEST_FILENAMES } = {}) {
  const manifests = [];
  for (const filename of filenames) {
    const filePath = path.join(rootDir, filename);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    manifests.push(parseProjectManifest({ filename, content, source: 'filesystem_import' }));
  }
  return manifests;
}

export function buildProjectManifestImportBundle({ rootDir = process.cwd(), filenames = DEFAULT_PROJECT_MANIFEST_FILENAMES, roomId = '' } = {}) {
  const manifests = loadProjectManifestsFromDir({ rootDir, filenames });
  const roomPackages = manifests.map((manifest) => buildRoomPackageFromProjectManifest(manifest, { roomId }));
  return {
    kind: 'project_manifest_import_bundle_v1',
    root_dir: rootDir,
    discovered_files: manifests.map((m) => m.filename),
    manifests,
    room_package_candidates: roomPackages,
    paper4_static_manifest_treatment: manifests.map((manifest) => ({
      treatment_id: 'B1_static_project_manifest',
      manifest_type: manifest.manifest_type,
      filename: manifest.filename,
      description: buildStaticManifestContextBlock(manifest, { maxSections: 4 }),
      tags: manifest.derived?.tags || [],
    })),
  };
}
