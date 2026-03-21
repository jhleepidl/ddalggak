import path from 'node:path';

import {
  normalizeKnowledgeBaseProfile,
  normalizeMemoryPolicy,
  getKnowledgeDocEntry,
} from './profile.js';

export const KNOWLEDGE_BASE_PROFILE_FILE = 'knowledge_base_profile.json';
export const KNOWLEDGE_BASE_CONTRACT_FILE = 'knowledge_base_contract.md';

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function cleanText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

export function listStableKnowledgeMemoryFiles({ sharedDir = '' } = {}) {
  const prefix = cleanText(sharedDir);
  const withDir = (fileName) => (prefix ? path.join(prefix, fileName) : fileName);
  return [
    {
      file_name: KNOWLEDGE_BASE_CONTRACT_FILE,
      path: withDir(KNOWLEDGE_BASE_CONTRACT_FILE),
      mode: 'read_only',
      purpose: 'Stable contract that explains which files exist, their semantic slots, and how agents should read/write them.',
    },
    {
      file_name: KNOWLEDGE_BASE_PROFILE_FILE,
      path: withDir(KNOWLEDGE_BASE_PROFILE_FILE),
      mode: 'system',
      purpose: 'Machine-readable canonical KB manifest used for alias resolution and runtime compatibility.',
    },
  ];
}

function recommendRoleBucket({ provider = '', roleId = '' } = {}) {
  const providerKey = cleanText(provider, { lower: true });
  const roleKey = cleanText(roleId, { lower: true });
  if (providerKey === 'codex' || ['builder', 'coder', 'developer'].includes(roleKey)) return 'implementation';
  if (providerKey === 'gemini' || ['researcher', 'reviewer', 'judge'].includes(roleKey)) return 'analysis';
  if (providerKey === 'chatgpt' || ['synthesizer', 'operator', 'chair'].includes(roleKey)) return 'coordination';
  return 'general';
}

export function recommendKnowledgeAccess({ profile = null, provider = '', roleId = '' } = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const bucket = recommendRoleBucket({ provider, roleId });
  const roleKey = cleanText(roleId, { lower: true });
  const docIdsByBucket = {
    implementation: {
      read: ['plan', 'research', 'progress', 'decisions', 'artifacts'],
      write: ['progress', 'artifacts', 'decisions'],
      primary: ['plan', 'progress'],
    },
    analysis: {
      read: ['plan', 'research', 'progress', 'decisions'],
      write: ['research', 'decisions', 'progress'],
      primary: ['plan', 'research'],
    },
    coordination: {
      read: ['plan', 'research', 'progress', 'decisions', 'artifacts'],
      write: ['plan', 'decisions'],
      primary: ['plan', 'decisions'],
    },
    general: {
      read: ['plan', 'research', 'progress', 'decisions', 'artifacts'],
      write: ['progress', 'decisions'],
      primary: ['plan', 'research'],
    },
  };
  const desired = docIdsByBucket[bucket] || docIdsByBucket.general;
  const resolve = (docIds = []) => docIds
    .map((docId) => getKnowledgeDocEntry(normalized, docId))
    .filter((doc) => {
      if (!doc) return false;
      const targets = asArray(doc.target_roles).map((entry) => cleanText(entry, { lower: true })).filter(Boolean);
      if (!roleKey || targets.length == 0) return true;
      return targets.includes(roleKey);
    });
  return {
    bucket,
    read_docs: resolve(desired.read),
    write_docs: resolve(desired.write),
    primary_docs: resolve(desired.primary),
  };
}

export function renderKnowledgeBaseContractMarkdown(profile = null) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const memoryPolicy = normalizeMemoryPolicy(normalized.memory_policy, { docs: normalized.docs });
  const lines = [
    '# Knowledge Base Contract',
    '',
    '이 파일은 job별 knowledge base의 고정 계약이다.',
    '- semantic slot(plan/research/progress/decisions/artifacts)은 안정적으로 유지된다.',
    '- concrete file name은 job/team 목적에 따라 달라질 수 있다.',
    '- agent는 아래 표에 있는 file name만 사용하고, 임의의 새 tracking 파일명을 만들지 않는다.',
    '- track_append/read는 semantic slot 별 alias도 허용되지만, 사람/agent에게 보여줄 때는 concrete file name을 우선 사용한다.',
    '',
    `- profile_id: ${normalized.profile_id}`,
    `- display_name: ${normalized.display_name}`,
    normalized.selection_reason ? `- selection_reason: ${normalized.selection_reason}` : '',
    '',
    '## Stable memories',
    `- ${KNOWLEDGE_BASE_CONTRACT_FILE}: read_only KB contract`,
    `- ${KNOWLEDGE_BASE_PROFILE_FILE}: system manifest (do not edit manually)`,
    '',
    '## Memory policy',
    `- stable_semantic_slots: ${memoryPolicy.stable_semantic_slots.join(', ') || '(none)'}`,
    `- mutable_semantic_slots: ${memoryPolicy.mutable_semantic_slots.join(', ') || '(none)'}`,
    `- migration_strategy: ${memoryPolicy.migration_strategy}`,
    `- preserve_history: ${memoryPolicy.preserve_history ? 'true' : 'false'}`,
    '',
    '## Semantic slots → concrete files',
    ...normalized.docs.map((doc) => [
      `### ${doc.doc_id}`,
      `- file_name: ${doc.file_name}`,
      `- title: ${doc.title}`,
      `- purpose: ${doc.purpose}`,
      doc.legacy_names.length > 0 ? `- aliases: ${doc.legacy_names.join(', ')}` : '',
      doc.target_roles.length > 0 ? `- target_roles: ${doc.target_roles.join(', ')}` : '',
      doc.write_hint ? `- write_hint: ${doc.write_hint}` : '',
      doc.section_hints.length > 0 ? `- section_hints: ${doc.section_hints.join(', ')}` : '',
      '',
    ].filter(Boolean).join('\n')),
  ].filter(Boolean);
  return lines.join('\n');
}

function formatDocBullet(doc = {}, { includeAliases = true } = {}) {
  const aliases = includeAliases && asArray(doc.legacy_names).length > 0
    ? ` | aliases=${doc.legacy_names.join(', ')}`
    : '';
  return `- ${doc.file_name} (slot=${doc.doc_id}): ${doc.purpose}${aliases}`;
}

export function buildAgentKnowledgeBaseGuidance({
  profile = null,
  sharedDir = '',
  provider = '',
  roleId = '',
  agentId = '',
} = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const access = recommendKnowledgeAccess({ profile: normalized, provider, roleId });
  const memoryPolicy = normalizeMemoryPolicy(normalized.memory_policy, { docs: normalized.docs });
  const stableFiles = listStableKnowledgeMemoryFiles({ sharedDir });
  const sharedPrefix = cleanText(sharedDir);
  const concretePath = (fileName) => (sharedPrefix ? path.join(sharedPrefix, fileName) : fileName);
  const providerKey = cleanText(provider, { lower: true });
  const canWriteTrackingFilesDirectly = providerKey === 'codex';
  const dedupeDocs = (docs = []) => {
    const seen = new Set();
    const out = [];
    for (const doc of asArray(docs)) {
      const key = cleanText(doc?.file_name, { lower: true });
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
    }
    return out;
  };
  const lines = [
    '[KNOWLEDGE BASE CONTRACT]',
    `profile=${normalized.profile_id} (${normalized.display_name})`,
    agentId ? `agent=${agentId}` : '',
    roleId ? `role=${roleId}` : '',
    provider ? `provider=${provider}` : '',
    '규칙:',
    '- 아래에 명시된 concrete tracking file만 참조하라.',
    '- plan.md/research.md/progress.md/decisions.md/artifacts.md는 semantic alias일 뿐이며, 사람에게 설명하거나 파일명을 언급할 때는 concrete file_name을 사용하라.',
    '- shared tracking 파일은 run/shared 안에만 존재한다. CODEX_WORKSPACE_ROOT 또는 repo 루트에 같은 이름 파일을 새로 만들지 마라.',
    '- 목록에 없는 tracking 파일명을 추측하거나 invent 하지 마라.',
    '- stable memory file은 읽기 전용이다. knowledge_base_profile.json / knowledge_base_contract.md를 수정 대상으로 삼지 마라.',
    canWriteTrackingFilesDirectly
      ? '- Codex만 tracking 문서를 직접 수정할 수 있다. 수정이 필요하면 아래 주요 작성 대상에만 append/update 하라.'
      : '- 이 provider는 tracking 문서를 직접 수정하지 않는다. write_file/create_file/save_file 같은 도구를 호출하지 말고, 필요한 내용은 응답 본문으로만 반환하라. 오케스트레이터가 적절한 memory 파일에 반영한다.',
    `- 안정적으로 보존되는 semantic slot: ${memoryPolicy.stable_semantic_slots.join(', ') || '(none)'}.`,
    `- 변경 가능 slot: ${memoryPolicy.mutable_semantic_slots.join(', ') || '(none)'}.`,
    '',
    '추천 읽기 순서:',
    ...dedupeDocs(access.read_docs).map((doc) => formatDocBullet({ ...doc, file_name: concretePath(doc.file_name) }, { includeAliases: false })),
    '',
    '주요 작성 대상:',
    ...(canWriteTrackingFilesDirectly
      ? dedupeDocs(access.write_docs).map((doc) => formatDocBullet({ ...doc, file_name: concretePath(doc.file_name) }, { includeAliases: false }))
      : ['- (direct file writes disabled for this provider)']),
    '',
    '전체 semantic slot 매핑:',
    ...dedupeDocs(normalized.docs).map((doc) => formatDocBullet({ ...doc, file_name: concretePath(doc.file_name) })),
    '',
    '고정 메모리 파일:',
    ...stableFiles.map((file) => `- ${file.path} (${file.mode}): ${file.purpose}`),
  ].filter(Boolean);
  return lines.join('\n');
}
