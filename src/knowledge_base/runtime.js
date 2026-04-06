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

function docMatchesName(doc = {}, rawName = '') {
  const cleanName = cleanText(rawName, { lower: true });
  if (!cleanName) return false;
  const candidates = [
    doc?.doc_id,
    doc?.surface_id,
    doc?.surfaceId,
    doc?.file_name,
    doc?.fileName,
    ...(Array.isArray(doc?.legacy_names) ? doc.legacy_names : []),
  ].map((entry) => cleanText(entry, { lower: true })).filter(Boolean);
  return candidates.includes(cleanName);
}

function dedupeDocs(docs = []) {
  const seen = new Set();
  const out = [];
  for (const doc of asArray(docs)) {
    const key = cleanText(doc?.file_name, { lower: true });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(doc);
  }
  return out;
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

function sortDocsByPreference(docs = [], preferredDocIds = []) {
  const preferred = new Map(asArray(preferredDocIds).map((entry, index) => [cleanText(entry, { lower: true }), index]));
  const rankForDoc = (doc = {}) => {
    const candidates = [doc?.doc_id, doc?.surface_id, doc?.surfaceId, doc?.file_name, doc?.fileName]
      .map((entry) => cleanText(entry, { lower: true }))
      .filter(Boolean);
    for (const key of candidates) {
      if (preferred.has(key)) return preferred.get(key);
    }
    return 999;
  };
  return [...asArray(docs)].sort((left, right) => {
    const leftRank = rankForDoc(left);
    const rightRank = rankForDoc(right);
    if (leftRank !== rightRank) return leftRank - rightRank;
    const leftLoad = cleanText(left?.load_policy || left?.loadPolicy || 'on_demand', { lower: true });
    const rightLoad = cleanText(right?.load_policy || right?.loadPolicy || 'on_demand', { lower: true });
    if (leftLoad !== rightLoad) return leftLoad === 'always' ? -1 : 1;
    return cleanText(left?.file_name).localeCompare(cleanText(right?.file_name));
  });
}

function canRoleAccessDoc(doc = {}, roleKey = '', { allowUntargeted = true } = {}) {
  const targets = asArray(doc.target_roles).map((entry) => cleanText(entry, { lower: true })).filter(Boolean);
  if (!roleKey) return allowUntargeted || targets.length === 0;
  if (targets.length === 0) return allowUntargeted;
  return targets.includes(roleKey);
}

function isWritablePolicy(writePolicy = '') {
  const policy = cleanText(writePolicy, { lower: true });
  return !['read_only', 'readonly', 'none'].includes(policy);
}

export function buildRoleMemoryContract({ profile = null, provider = '', roleId = '', maxReadDocs = 8 } = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const bucket = recommendRoleBucket({ provider, roleId });
  const roleKey = cleanText(roleId, { lower: true });
  const docIdsByBucket = {
    implementation: {
      preferred_reads: ['plan', 'progress', 'research', 'decisions', 'artifacts'],
      preferred_writes: ['progress', 'artifacts', 'decisions', 'research'],
      primary: ['plan', 'progress'],
    },
    analysis: {
      preferred_reads: ['plan', 'research', 'progress', 'decisions'],
      preferred_writes: ['research', 'decisions', 'progress'],
      primary: ['plan', 'research'],
    },
    coordination: {
      preferred_reads: ['plan', 'decisions', 'research', 'progress', 'artifacts'],
      preferred_writes: ['decisions', 'plan', 'artifacts'],
      primary: ['plan', 'decisions'],
    },
    general: {
      preferred_reads: ['plan', 'research', 'progress', 'decisions', 'artifacts'],
      preferred_writes: ['progress', 'decisions', 'research'],
      primary: ['plan', 'research'],
    },
  };
  const desired = docIdsByBucket[bucket] || docIdsByBucket.general;
  const readableDocs = sortDocsByPreference(
    normalized.docs.filter((doc) => {
      const loadPolicy = cleanText(doc.load_policy || doc.loadPolicy || 'on_demand', { lower: true });
      const targeted = canRoleAccessDoc(doc, roleKey, { allowUntargeted: true });
      return targeted || loadPolicy === 'always';
    }),
    desired.preferred_reads,
  ).slice(0, Math.max(1, maxReadDocs));
  const writableDocs = sortDocsByPreference(
    normalized.docs.filter((doc) => isWritablePolicy(doc.write_policy || doc.writePolicy) && canRoleAccessDoc(doc, roleKey, { allowUntargeted: true })),
    desired.preferred_writes,
  );
  const primaryDocs = sortDocsByPreference(
    readableDocs.filter((doc) => desired.primary.includes(cleanText(doc.doc_id, { lower: true })) || desired.primary.includes(cleanText(doc.surface_id || '', { lower: true }))),
    desired.primary,
  );
  const publishDocs = writableDocs.filter((doc) => ['final', 'index'].includes(cleanText(doc.write_policy || doc.writePolicy, { lower: true })));
  return {
    bucket,
    role_id: roleKey,
    read_docs: readableDocs,
    primary_docs: primaryDocs.length > 0 ? primaryDocs : readableDocs.slice(0, 2),
    write_docs: writableDocs,
    publish_docs: publishDocs,
    can_write_directly: cleanText(provider, { lower: true }) === 'codex',
  };
}

export function pickRoleWriteTarget({ profile = null, provider = '', roleId = '', purpose = 'worklog' } = {}) {
  const contract = buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs: 8 });
  const purposeKey = cleanText(purpose, { lower: true }) || 'worklog';
  const preferredByPurpose = {
    research: ['research', 'defect_log', 'evidence_ledger', 'working_memory'],
    implementation: ['implementation_notes', 'repair_log', 'progress', 'working_memory'],
    review: ['critic_log', 'defect_log', 'review_findings', 'research', 'progress'],
    final: ['final_answer', 'decisions'],
    artifact: ['artifact_index', 'artifacts'],
    worklog: ['progress', 'working_memory', 'implementation_notes', 'critic_log'],
  };
  const preferred = preferredByPurpose[purposeKey] || preferredByPurpose.worklog;
  const candidate = sortDocsByPreference(contract.write_docs, preferred)[0] || null;
  return {
    contract,
    target_doc: candidate,
  };
}

export function resolveRoleWriteDecision({
  profile = null,
  provider = '',
  roleId = '',
  requestedDoc = '',
  purpose = 'worklog',
  fallbackDoc = 'progress',
} = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const contract = buildRoleMemoryContract({ profile: normalized, provider, roleId, maxReadDocs: 8 });
  const requested = cleanText(requestedDoc, { lower: true });
  const requestedEntry = requested ? (getKnowledgeDocEntry(normalized, requested) || normalized.docs.find((doc) => docMatchesName(doc, requested))) : null;
  const allowedRequested = requestedEntry
    ? contract.write_docs.find((doc) => cleanText(doc.file_name, { lower: true }) === cleanText(requestedEntry.file_name, { lower: true })) || null
    : null;
  if (allowedRequested) {
    return {
      contract,
      status: 'allowed',
      reason: 'requested_surface_allowed',
      requested_doc: requestedEntry,
      target_doc: allowedRequested,
      fallback_used: false,
    };
  }
  const preferred = pickRoleWriteTarget({ profile: normalized, provider, roleId, purpose });
  if (preferred.target_doc) {
    return {
      contract,
      status: requestedEntry ? 'rerouted' : 'resolved_default',
      reason: requestedEntry ? 'requested_surface_not_writable_for_role' : 'requested_surface_missing_or_unknown',
      requested_doc: requestedEntry,
      target_doc: preferred.target_doc,
      fallback_used: true,
    };
  }
  const fallbackEntry = fallbackDoc ? (getKnowledgeDocEntry(normalized, fallbackDoc) || normalized.docs.find((doc) => docMatchesName(doc, fallbackDoc))) : null;
  if (fallbackEntry && isWritablePolicy(fallbackEntry.write_policy || fallbackEntry.writePolicy)) {
    return {
      contract,
      status: 'rerouted',
      reason: 'role_has_no_primary_target_using_fallback',
      requested_doc: requestedEntry,
      target_doc: fallbackEntry,
      fallback_used: true,
    };
  }
  return {
    contract,
    status: 'rejected',
    reason: requestedEntry ? 'requested_surface_not_writable_and_no_fallback' : 'unknown_surface_and_no_fallback',
    requested_doc: requestedEntry,
    target_doc: null,
    fallback_used: false,
  };
}

export function recommendKnowledgeAccess({ profile = null, provider = '', roleId = '' } = {}) {
  const contract = buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs: 8 });
  return {
    bucket: contract.bucket,
    read_docs: contract.read_docs,
    write_docs: contract.write_docs,
    primary_docs: contract.primary_docs,
    publish_docs: contract.publish_docs,
    can_write_directly: contract.can_write_directly,
  };
}


export function summarizeRoleMemoryEnforcement({ profile = null, provider = '', roleId = '' } = {}) {
  const contract = buildRoleMemoryContract({ profile, provider, roleId, maxReadDocs: 8 });
  const surfaceIds = (docs = []) => dedupeDocs(docs)
    .map((doc) => cleanText(doc?.surface_id || doc?.surfaceId || doc?.doc_id, { lower: true }))
    .filter(Boolean);
  const publishSurfaceIds = surfaceIds(contract.publish_docs);
  return {
    role_id: cleanText(roleId, { lower: true }),
    provider: cleanText(provider, { lower: true }),
    read_scope_mode: 'role_scoped_local_only',
    write_scope_mode: 'role_scoped_reroute',
    publish_scope_mode: 'declared_publish_only',
    final_publish_rule: 'final_owner_declared_surface_required',
    artifact_publish_rule: 'declared_artifact_surface_required',
    read_surface_ids: surfaceIds(contract.read_docs),
    write_surface_ids: surfaceIds(contract.write_docs),
    publish_surface_ids: publishSurfaceIds,
    can_publish_final_answer: publishSurfaceIds.includes('final_answer'),
    can_publish_artifact_index: publishSurfaceIds.includes('artifact_index'),
  };
}

export function canRolePublishSurface({ profile = null, provider = '', roleId = '', surfaceId = '' } = {}) {
  const target = cleanText(surfaceId, { lower: true }).replace(/\.md$/i, '');
  if (!target) return false;
  const summary = summarizeRoleMemoryEnforcement({ profile, provider, roleId });
  return Array.isArray(summary.publish_surface_ids) && summary.publish_surface_ids.includes(target);
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
  detailLevel = 'standard',
} = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const access = recommendKnowledgeAccess({ profile: normalized, provider, roleId });
  const memoryPolicy = normalizeMemoryPolicy(normalized.memory_policy, { docs: normalized.docs });
  const stableFiles = listStableKnowledgeMemoryFiles({ sharedDir });
  const sharedPrefix = cleanText(sharedDir);
  const concretePath = (fileName) => (sharedPrefix ? path.join(sharedPrefix, fileName) : fileName);
  const providerKey = cleanText(provider, { lower: true });
  const canWriteTrackingFilesDirectly = access.can_write_directly === true || providerKey === 'codex';
  const compactMode = cleanText(detailLevel, { lower: true }) === 'compact';
  const readDocs = dedupeDocs(access.read_docs).map((doc) => ({ ...doc, file_name: concretePath(doc.file_name) }));
  const writeDocs = dedupeDocs(access.write_docs).map((doc) => ({ ...doc, file_name: concretePath(doc.file_name) }));
  const publishDocs = dedupeDocs(access.publish_docs).map((doc) => ({ ...doc, file_name: concretePath(doc.file_name) }));
  const lines = [
    '[KNOWLEDGE BASE CONTRACT]',
    `profile=${normalized.profile_id} (${normalized.display_name})`,
    agentId ? `agent=${agentId}` : '',
    roleId ? `role=${roleId}` : '',
    provider ? `provider=${provider}` : '',
    '규칙:',
    '- concrete tracking file_name만 사용하라. 임의의 tracking 파일을 만들지 마라.',
    '- 목록에 없는 tracking 파일명을 추측하거나 invent 하지 마라.',
    '- shared tracking 파일은 run/shared 안에만 존재한다. workspace 루트에 동명 파일을 만들지 마라.',
    '- knowledge_base_profile.json / knowledge_base_contract.md 는 읽기 전용이다.',
    canWriteTrackingFilesDirectly
      ? '- 직접 수정이 필요하면 아래 주요 작성 대상에만 append/update 하라.'
      : '- write_file/create_file/save_file 같은 도구를 호출하지 말고 필요한 내용은 응답 본문으로만 반환하라.',
    !canWriteTrackingFilesDirectly
      ? '- 이 provider는 tracking 문서를 직접 수정하지 않는다.'
      : '',
    `- stable slots: ${memoryPolicy.stable_semantic_slots.join(', ') || '(none)'}`,
    `- mutable slots: ${memoryPolicy.mutable_semantic_slots.join(', ') || '(none)'}`,
    '',
    '추천 읽기 순서:',
    ...readDocs.map((doc) => formatDocBullet(doc, { includeAliases: false })),
    '',
    '주요 작성 대상:',
    ...(canWriteTrackingFilesDirectly
      ? writeDocs.map((doc) => formatDocBullet(doc, { includeAliases: false }))
      : ['- (direct file writes disabled for this provider)']),
    publishDocs.length > 0 ? '' : '',
    publishDocs.length > 0 ? '승격/발행 대상:' : '',
    ...publishDocs.map((doc) => formatDocBullet(doc, { includeAliases: false })),
  ].filter(Boolean);
  if (!compactMode) {
    lines.push(
      '',
      '역할별 관련 semantic slot 매핑:',
      ...dedupeDocs([...access.read_docs, ...access.write_docs, ...(access.publish_docs || [])]).map((doc) => formatDocBullet({ ...doc, file_name: concretePath(doc.file_name) })),
      '',
      '고정 메모리 파일:',
      ...stableFiles.map((file) => `- ${file.path} (${file.mode}): ${file.purpose}`),
    );
  }
  return lines.filter(Boolean).join('\n');
}


export function buildRoleSurfaceAclSummary({ profile = null, agents = [], participants = [], maxRoles = 8 } = {}) {
  const normalized = normalizeKnowledgeBaseProfile(profile || {});
  const candidates = [];
  for (const agent of asArray(agents)) {
    candidates.push({ role_id: cleanText(agent?.role, { lower: true }), provider: cleanText(agent?.provider, { lower: true }) });
  }
  for (const participant of asArray(participants)) {
    candidates.push({ role_id: cleanText(participant?.role || participant?.role_id || participant?.roleId, { lower: true }), provider: cleanText(participant?.provider, { lower: true }) });
  }
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const roleId = cleanText(candidate?.role_id, { lower: true });
    if (!roleId || seen.has(roleId)) continue;
    seen.add(roleId);
    out.push(summarizeRoleMemoryEnforcement({ profile: normalized, provider: candidate?.provider || '', roleId }));
    if (out.length >= Math.max(1, Number(maxRoles) || 8)) break;
  }
  return out;
}
