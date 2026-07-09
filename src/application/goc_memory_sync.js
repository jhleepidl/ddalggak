function cleanText(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return cleanText(value).toLowerCase();
}

function asLowerArray(value) {
  return Array.isArray(value)
    ? value.map((entry) => cleanLower(entry)).filter(Boolean)
    : [];
}

const gocMemorySurfaceSyncByJob = new Map();
const GOC_MEMORY_SURFACE_CACHE_MAX = 256;

export function inferTrackingAppendPurpose(docName = '', explicitPurpose = '') {
  const cleanPurpose = cleanLower(explicitPurpose);
  if (cleanPurpose) return cleanPurpose;
  const key = cleanLower(docName).replace(/\.md$/i, '');
  if (['research', 'evidence_ledger', 'positions_and_evidence', 'defect_log', 'critic_log', 'review_findings'].includes(key)) return 'research';
  if (['implementation_notes', 'repair_log', 'progress', 'working_memory', 'change_log', 'repair_journal', 'analysis_journal', 'run_log', 'plan', 'mission_brief'].includes(key)) return 'implementation';
  if (['final_answer', 'decisions', 'recommendation_memo', 'verdict_and_rationale', 'conclusions_and_next_steps'].includes(key)) return 'final';
  if (['artifact_index', 'artifacts', 'artifact_manifest', 'artifact_register', 'submission_packet', 'repair_artifacts', 'supporting_materials'].includes(key)) return 'artifact';
  return 'worklog';
}

export function deriveKnowledgeBaseMemorySurfaceSpec(doc = {}) {
  const surfaceId = cleanLower(doc?.surface_id || doc?.surfaceId || doc?.doc_id);
  if (!surfaceId) return null;
  const semanticSlots = Array.isArray(doc?.semantic_slots) ? doc.semantic_slots : [];
  const targetRoles = asLowerArray(doc?.target_roles);
  const writePolicy = cleanLower(doc?.write_policy || doc?.writePolicy);
  return {
    surface_id: surfaceId,
    title: cleanText(doc?.title || doc?.doc_id || surfaceId || 'Memory Surface'),
    semantic_kind: cleanLower(semanticSlots[0] || doc?.doc_id || 'memory') || 'memory',
    visibility_scope: targetRoles.length > 1 ? 'team' : (targetRoles.length === 1 ? 'private' : 'shared'),
    write_mode: writePolicy || 'append_only',
    policy: {
      target_roles: targetRoles,
      semantic_slots: semanticSlots,
      source_doc_id: cleanText(doc?.doc_id) || undefined,
      file_name: cleanText(doc?.file_name) || undefined,
    },
  };
}

export function deriveTrackingMemorySurfaceSpec({ tracking = null, jobId = '', docName = '' } = {}) {
  const resolvedDocName = cleanLower(docName);
  const profile = tracking && typeof tracking.loadProfile === 'function' ? tracking.loadProfile(jobId) : null;
  const entry = Array.isArray(profile?.docs)
    ? profile.docs.find((doc) => cleanLower(doc?.file_name) === resolvedDocName) || null
    : null;
  const spec = deriveKnowledgeBaseMemorySurfaceSpec({
    ...(entry || {}),
    file_name: cleanText(entry?.file_name || docName) || undefined,
    doc_id: cleanText(entry?.doc_id || resolvedDocName.replace(/\.md$/i, '')) || undefined,
    title: cleanText(entry?.title || entry?.doc_id || resolvedDocName.replace(/\.md$/i, '')) || undefined,
    semantic_slots: Array.isArray(entry?.semantic_slots) ? entry.semantic_slots : [inferTrackingAppendPurpose(docName)],
  });
  if (!spec?.surface_id) return null;
  return {
    ...spec,
    policy: {
      ...(spec.policy || {}),
      origin: 'ddalggak_tracking_append',
    },
    label: cleanText(entry?.title || entry?.doc_id || spec.surface_id) || spec.surface_id,
  };
}

export function buildGocMemoryNodePayload({
  clip = (value) => String(value || ''),
  jobId = '',
  markdown = '',
  provider = '',
  roleId = '',
  purpose = '',
  source = '',
  eventType = '',
  actorKind = '',
  pipelineStage = '',
  semanticKind = '',
  requestedDoc = '',
  resolvedDoc = '',
  requestedSurfaceId = '',
  targetSurfaceId = '',
  memoryWriteStatus = '',
  defaultConfidence = 0.8,
  nodeTypeHint = '',
} = {}) {
  const cleanTargetSurfaceId = cleanLower(targetSurfaceId || requestedSurfaceId);
  if (!cleanTargetSurfaceId) return null;
  const cleanProvider = cleanLower(provider || 'chatgpt');
  const cleanRoleId = cleanLower(roleId || 'operator');
  const cleanPurpose = cleanLower(purpose) || undefined;
  const cleanSemanticKind = cleanLower(semanticKind) || undefined;
  const cleanEventType = cleanLower(eventType) || undefined;
  const cleanActorKind = cleanLower(actorKind) || undefined;
  const cleanPipelineStage = cleanLower(pipelineStage) || undefined;
  const cleanMarkdown = cleanText(markdown);
  const cleanRequestedDoc = cleanText(requestedDoc) || undefined;
  const cleanResolvedDoc = cleanText(resolvedDoc) || cleanRequestedDoc;
  const cleanRequestedSurfaceId = cleanLower(requestedSurfaceId) || undefined;
  const cleanStatus = cleanLower(memoryWriteStatus) || undefined;
  const decisionLike = ['final', 'decision'].includes(cleanLower(nodeTypeHint || cleanPurpose))
    || ['decisions', 'final_answer', 'artifact_index'].includes(cleanTargetSurfaceId);
  const nodeType = nodeTypeHint
    ? cleanLower(nodeTypeHint)
    : (decisionLike ? 'decision' : (cleanPurpose === 'artifact' ? 'artifact' : 'note'));
  return {
    surface_id: cleanTargetSurfaceId,
    node_type: nodeType,
    owner_agent_id: `${cleanProvider || 'agent'}:${cleanRoleId || 'operator'}`,
    owner_role_id: cleanRoleId || undefined,
    content: {
      text: clip(cleanMarkdown, 8000),
      summary: clip(cleanMarkdown, 500),
      purpose: cleanPurpose,
      semantic_kind: cleanSemanticKind,
      event_type: cleanEventType,
      actor_kind: cleanActorKind,
      pipeline_stage: cleanPipelineStage,
      requested_doc: cleanRequestedDoc,
      resolved_doc: cleanResolvedDoc,
    },
    provenance: {
      source_id: `ddalggak:${cleanText(jobId)}`,
      job_id: cleanText(jobId) || undefined,
      provider: cleanProvider || undefined,
      role_id: cleanRoleId || undefined,
      requested_surface_id: cleanRequestedSurfaceId,
      target_surface_id: cleanTargetSurfaceId || undefined,
      memory_write_status: cleanStatus,
      source: cleanLower(source) || undefined,
      event_type: cleanEventType,
      actor_kind: cleanActorKind,
      pipeline_stage: cleanPipelineStage,
      semantic_kind: cleanSemanticKind,
      confidence: Number.isFinite(Number(defaultConfidence)) ? Number(defaultConfidence) : 0.8,
    },
    trust_tier: cleanProvider === 'codex' ? 'derived' : 'reported',
    status: ['final_answer', 'decisions', 'artifact_index'].includes(cleanTargetSurfaceId) ? 'published' : 'draft',
    created_run_id: cleanText(jobId) || undefined,
  };
}


function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function clipText(value = '', maxLen = 700) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  const n = Math.max(40, Math.floor(Number(maxLen) || 700));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeMemoryId(value = '') {
  return cleanLower(value).replace(/[^a-z0-9._:-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 120);
}

function compactOwnerList(value = []) {
  return asArray(value).map((entry) => cleanLower(entry).replace(/^@+/, '').replace(/[^a-z0-9가-힣_-]+/g, '_')).filter(Boolean).slice(0, 12);
}

export function deriveTelegramRoomMemorySurfaceSpec({ memoryItem = null, chatId = '' } = {}) {
  const item = memoryItem && typeof memoryItem === 'object' ? memoryItem : {};
  const scope = cleanLower(item.scope || 'room') || 'room';
  return {
    surface_id: 'telegram_approved_room_memory',
    title: 'Telegram-approved room memory',
    semantic_kind: 'room_memory',
    visibility_scope: scope === 'companion' ? 'team' : 'shared',
    write_mode: 'user_approved_append_or_upsert',
    policy: {
      origin: 'telegram_memory_approval',
      source_runtime: 'ddalggak',
      room_local: true,
      private_memory_export: 'summary_only_by_default',
      raw_transcript_exported: false,
      telegram_chat_fingerprint: chatId ? tinyHash(chatId) : undefined,
      target_roles: compactOwnerList(item.owner_companion_ids || item.target_companion_ids),
      lifecycle: ['candidate', 'telegram_approved', 'goc_upserted', 'goc_review_or_edit'],
    },
  };
}

export function buildTelegramApprovedRoomMemoryNodePayload({ memoryItem = null, chatId = '', userId = '', runId = '' } = {}) {
  const item = memoryItem && typeof memoryItem === 'object' ? memoryItem : {};
  const memoryId = safeMemoryId(item.memory_id || item.memoryId || item.id || '');
  const summary = clipText(item.summary || item.content || item.text || '', 900);
  if (!memoryId || !summary) return null;
  const owners = compactOwnerList(item.owner_companion_ids || item.ownerCompanionIds || item.target_companion_ids);
  const approvedAt = cleanText(item.review?.approved_at || item.updated_at || item.updatedAt || new Date().toISOString());
  const type = cleanLower(item.type || 'memory') || 'memory';
  return {
    surface_id: 'telegram_approved_room_memory',
    node_type: type === 'preference' ? 'preference' : 'room_memory',
    owner_agent_id: owners[0] ? `room:${owners[0]}` : 'room:shared',
    owner_role_id: owners[0] || 'room',
    content: {
      memory_id: memoryId,
      title: clipText(item.title || type.replace(/_/g, ' '), 120),
      summary,
      text: summary,
      memory_type: type,
      scope: cleanLower(item.scope || (owners.length ? 'companion' : 'room')) || 'room',
      owner_companion_ids: owners,
      sensitivity: cleanLower(item.sensitivity || 'medium') || 'medium',
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      source_candidate_id: cleanText(item.source_candidate_id || item.sourceCandidateId) || undefined,
      approved_at: approvedAt,
      raw_transcript_exported: false,
    },
    provenance: {
      source: 'telegram_approved_room_memory',
      source_id: `ddalggak:telegram_memory:${memoryId}`,
      source_memory_id: memoryId,
      source_candidate_id: cleanText(item.source_candidate_id || item.sourceCandidateId) || undefined,
      source_turn_id: cleanText(item.source_turn_id || item.sourceTurnId || item.provenance?.source_turn_id) || undefined,
      approved_by: cleanText(userId || item.provenance?.approved_by || 'telegram_user') || 'telegram_user',
      approved_at: approvedAt,
      telegram_chat_fingerprint: chatId ? tinyHash(chatId) : undefined,
      raw_transcript_exported: false,
      private_memory_payload: 'summary_only',
      lifecycle: 'telegram_approved_then_goc_upserted',
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : 0.8,
    },
    trust_tier: 'reported',
    status: 'published',
    created_run_id: cleanText(runId) || undefined,
  };
}

export async function syncTelegramApprovedRoomMemoryToGoc({ client = null, threadId = '', memoryItem = null, chatId = '', userId = '', runId = '', logger = null } = {}) {
  const cleanThreadId = cleanText(threadId);
  const surface = deriveTelegramRoomMemorySurfaceSpec({ memoryItem, chatId });
  const node = buildTelegramApprovedRoomMemoryNodePayload({ memoryItem, chatId, userId, runId });
  if (!client || !cleanThreadId || !node) {
    return {
      ok: false,
      synced: false,
      reason: !client ? 'missing_goc_client' : (!cleanThreadId ? 'missing_thread_id' : 'invalid_memory_item'),
      surface,
      node,
    };
  }
  try {
    const surfaceResult = await client.createMemorySurface(cleanThreadId, surface);
    const nodeResult = await client.createMemoryNode(cleanThreadId, node);
    return {
      ok: true,
      synced: true,
      surface_id: surface.surface_id,
      memory_id: node.content.memory_id,
      node_id: nodeResult?.node?.id || nodeResult?.id || '',
      upserted: Boolean(nodeResult?.upserted || nodeResult?.node?.upserted),
      surface_result: surfaceResult,
      node_result: nodeResult,
      privacy: {
        raw_transcript_exported: false,
        private_memory_payload: 'summary_only',
      },
    };
  } catch (error) {
    try { logger?.warn?.({ error, threadId: cleanThreadId, memory_id: node.content.memory_id }, 'GoC room memory sync failed'); } catch {}
    return { ok: false, synced: false, reason: String(error?.message || error || 'goc_sync_failed'), surface_id: surface.surface_id, memory_id: node.content.memory_id };
  }
}


function rememberSurfaceSignature(cacheKey, signature) {
  if (gocMemorySurfaceSyncByJob.has(cacheKey)) {
    gocMemorySurfaceSyncByJob.delete(cacheKey);
  }
  gocMemorySurfaceSyncByJob.set(cacheKey, signature);
  while (gocMemorySurfaceSyncByJob.size > GOC_MEMORY_SURFACE_CACHE_MAX) {
    const oldestKey = gocMemorySurfaceSyncByJob.keys().next().value;
    if (!oldestKey) break;
    gocMemorySurfaceSyncByJob.delete(oldestKey);
  }
}

function buildSurfaceSignature({ docs = [], deriveSpec }) {
  return JSON.stringify(
    docs
      .map((doc) => deriveSpec(doc))
      .filter(Boolean)
      .map((spec) => ({
        surface_id: spec.surface_id,
        title: cleanText(spec.title || spec.label),
        semantic_kind: cleanLower(spec.semantic_kind),
        visibility_scope: cleanLower(spec.visibility_scope),
        write_mode: cleanLower(spec.write_mode),
        target_roles: Array.isArray(spec.policy?.target_roles) ? spec.policy.target_roles : [],
      }))
  );
}

export async function ensureKnowledgeBaseMemorySurfacesInGoc({
  jobId = '',
  client = null,
  threadId = '',
  docs = [],
  deriveSpec,
} = {}) {
  const cleanJobId = cleanText(jobId);
  const cleanThreadId = cleanText(threadId);
  if (!cleanJobId || !client || !cleanThreadId || !Array.isArray(docs) || docs.length === 0 || typeof deriveSpec !== 'function') {
    return { synced: false, count: 0 };
  }
  const signature = buildSurfaceSignature({ docs, deriveSpec });
  const cacheKey = `${cleanJobId}::${cleanThreadId}`;
  if (gocMemorySurfaceSyncByJob.get(cacheKey) === signature) {
    rememberSurfaceSignature(cacheKey, signature);
    return { synced: true, count: docs.length, cached: true };
  }
  for (const doc of docs) {
    const spec = deriveSpec(doc);
    if (!spec?.surface_id) continue;
    await client.createMemorySurface(cleanThreadId, spec);
  }
  rememberSurfaceSignature(cacheKey, signature);
  return { synced: true, count: docs.length, cached: false };
}
