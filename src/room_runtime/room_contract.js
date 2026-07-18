import { cleanText, sha256 } from './fs_utils.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueText(values = [], { limit = 64, max = 2000 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = cleanText(typeof value === 'string' ? value : value?.text || value?.label || value?.id || '');
    if (!text) continue;
    const clipped = text.slice(0, max);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= limit) break;
  }
  return out;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function normalizeSource(value, classification = 'authoritative', index = 0) {
  if (typeof value === 'string') {
    const text = cleanText(value).slice(0, 2000);
    return text ? { source_id: `source-${index + 1}`, label: text, classification } : null;
  }
  const row = asObject(value);
  const label = cleanText(row.label || row.title || row.name || row.uri || row.url || row.id || '').slice(0, 2000);
  if (!label) return null;
  return {
    source_id: cleanText(row.source_id || row.id || `source-${index + 1}`).slice(0, 160),
    label,
    classification: cleanText(row.classification || classification).toLowerCase().slice(0, 80) || classification,
    ...(cleanText(row.uri || row.url || '') ? { uri: cleanText(row.uri || row.url).slice(0, 4000) } : {}),
    ...(cleanText(row.reason || '') ? { reason: cleanText(row.reason).slice(0, 2000) } : {}),
  };
}

function normalizeCorrection(value, index = 0) {
  const row = typeof value === 'string' ? { text: value } : asObject(value);
  const text = cleanText(row.text || row.correction_text || row.summary || '').slice(0, 2400);
  if (!text) return null;
  return {
    correction_id: cleanText(row.correction_id || row.id || `correction-${index + 1}`).slice(0, 160),
    text,
    status: cleanText(row.status || 'active').toLowerCase().slice(0, 80),
    scope: cleanText(row.scope || 'room').toLowerCase().slice(0, 80),
    source: cleanText(row.source || 'room_continuity').slice(0, 160),
  };
}

function normalizeArtifact(value, index = 0) {
  const row = typeof value === 'string' ? { path: value } : asObject(value);
  const location = cleanText(row.path || row.uri || row.location || row.name || '').slice(0, 4000);
  if (!location) return null;
  return {
    artifact_id: cleanText(row.artifact_id || row.id || `artifact-${index + 1}`).slice(0, 160),
    location,
    kind: cleanText(row.kind || 'file').toLowerCase().slice(0, 100),
    ...(cleanText(row.description || '') ? { description: cleanText(row.description).slice(0, 2000) } : {}),
  };
}

function contractContent(contract = {}) {
  const row = asObject(contract);
  const { contract_hash, contract_revision, created_at, updated_at, ...content } = row;
  return content;
}

export function hashRoomContract(contract = {}) {
  return sha256(stableJson(contractContent(contract)));
}

export function normalizeRoomContract(value = {}) {
  const row = asObject(value);
  const authoritative = asArray(row.sources?.authoritative || row.authoritative_sources)
    .map((item, index) => normalizeSource(item, 'authoritative', index)).filter(Boolean);
  const excluded = asArray(row.sources?.excluded || row.excluded_sources)
    .map((item, index) => normalizeSource(item, 'excluded', index)).filter(Boolean);
  const normalized = {
    schema_version: 'ai_rooms.room_contract/v1',
    room_id: cleanText(row.room_id).slice(0, 160),
    goal: cleanText(row.goal || row.objective).slice(0, 8000),
    objective: cleanText(row.objective || row.goal).slice(0, 8000),
    completion_contract: uniqueText(row.completion_contract || row.completion_criteria, { limit: 32, max: 2400 }),
    constraints: uniqueText(row.constraints || row.rules, { limit: 64, max: 2400 }),
    sources: { authoritative, excluded },
    corrections: asArray(row.corrections).map(normalizeCorrection).filter(Boolean).slice(0, 64),
    current_checkpoint: asObject(row.current_checkpoint),
    unresolved_blockers: uniqueText(row.unresolved_blockers, { limit: 64, max: 2400 }),
    requested_artifacts: asArray(row.requested_artifacts || row.artifacts).map(normalizeArtifact).filter(Boolean).slice(0, 64),
    approval_policy: {
      mode: cleanText(row.approval_policy?.mode || 'bounded').toLowerCase().slice(0, 80),
      require_for: uniqueText(row.approval_policy?.require_for, { limit: 32, max: 300 }),
    },
    provider_policy: asObject(row.provider_policy),
    continuity: {
      next_action: cleanText(row.continuity?.next_action || row.next_action).slice(0, 2400),
      branches: uniqueText(row.continuity?.branches || row.branches, { limit: 16, max: 1000 }),
      pending_review_count: Math.max(0, Number(row.continuity?.pending_review_count || 0) || 0),
    },
    created_at: cleanText(row.created_at) || new Date().toISOString(),
    updated_at: cleanText(row.updated_at) || new Date().toISOString(),
    contract_revision: Math.max(1, Number(row.contract_revision || 1) || 1),
  };
  normalized.contract_hash = hashRoomContract(normalized);
  return normalized;
}

export function buildRoomContract({
  roomId = '',
  objective = '',
  roomContext = null,
  previousContract = null,
  completionContract = [],
  requestedArtifacts = [],
  providerPolicy = {},
  approvalPolicy = {},
} = {}) {
  const context = asObject(roomContext);
  const previous = previousContract ? normalizeRoomContract(previousContract) : null;
  const goal = cleanText(context.goal || previous?.goal || objective);
  const authoritativeSources = asArray(context.source_policy?.included_sources || context.authoritative_sources || previous?.sources?.authoritative);
  const excludedSources = asArray(context.source_policy?.excluded_sources || context.excluded_sources || previous?.sources?.excluded);
  const explicitCompletion = uniqueText(completionContract, { limit: 32, max: 2400 });
  const defaultCompletion = [
    'The requested objective is completed in the canonical Room workspace or a concrete blocker is recorded.',
    'Relevant validation is executed and its result is recorded; unverified claims are identified explicitly.',
    'The next action and any unresolved blocker are preserved in a provider-neutral checkpoint.',
  ];
  const candidate = normalizeRoomContract({
    room_id: roomId,
    goal: goal || cleanText(objective),
    objective,
    completion_contract: explicitCompletion.length ? explicitCompletion : previous?.completion_contract?.length ? previous.completion_contract : defaultCompletion,
    constraints: uniqueText([...(previous?.constraints || []), ...asArray(context.rules)], { limit: 64, max: 2400 }),
    sources: { authoritative: authoritativeSources, excluded: excludedSources },
    corrections: asArray(context.corrections).length ? context.corrections : previous?.corrections || [],
    current_checkpoint: previous?.current_checkpoint || {},
    unresolved_blockers: previous?.unresolved_blockers || [],
    requested_artifacts: requestedArtifacts.length ? requestedArtifacts : previous?.requested_artifacts || [],
    approval_policy: { ...previous?.approval_policy, ...approvalPolicy },
    provider_policy: { ...previous?.provider_policy, ...providerPolicy },
    continuity: {
      next_action: context.next_action || previous?.continuity?.next_action || '',
      branches: context.branches || previous?.continuity?.branches || [],
      pending_review_count: Number(context.pending?.reviews || 0) + Number(context.pending?.memory_exchanges || 0),
    },
    created_at: previous?.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    contract_revision: previous?.contract_revision || 1,
  });
  const previousHash = previous?.contract_hash || '';
  if (previous && previousHash !== candidate.contract_hash) {
    candidate.contract_revision = previous.contract_revision + 1;
    candidate.contract_hash = hashRoomContract(candidate);
  }
  return candidate;
}

export function formatRoomContractSummary(contract = {}) {
  const row = normalizeRoomContract(contract);
  const lines = [
    `📜 Room Contract v${row.contract_revision}`,
    `hash: ${row.contract_hash.slice(0, 16)}`,
    `목표: ${row.goal || '-'}`,
    `현재 실행 목표: ${row.objective || '-'}`,
    `완료 조건: ${row.completion_contract.length}개`,
    `규칙: ${row.constraints.length}개 · 정정: ${row.corrections.length}개`,
    `근거: ${row.sources.authoritative.length}개 · 제외: ${row.sources.excluded.length}개`,
    `요청 산출물: ${row.requested_artifacts.length}개`,
    `다음 행동: ${row.continuity.next_action || '-'}`,
  ];
  if (row.unresolved_blockers.length) lines.push(`미해결 blocker: ${row.unresolved_blockers.length}개`);
  return lines.join('\n');
}
