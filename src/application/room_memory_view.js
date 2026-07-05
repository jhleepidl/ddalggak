function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 500) {
  const text = clean(value);
  const n = Math.max(60, Math.floor(Number(max) || 500));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeStatus(value = '') {
  const key = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['approved', 'accepted', 'active', 'materialized'].includes(key)) return 'active';
  if (['reject', 'rejected', 'declined', 'denied'].includes(key)) return 'rejected';
  if (['archive', 'archived'].includes(key)) return 'archived';
  if (['candidate', 'pending', 'review', 'needs_review', 'review_required', ''].includes(key)) return 'pending';
  return key;
}

function normalizeCompanionId(value = '') {
  return clean(value).toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9가-힣_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function candidateToMemoryItem(candidate = {}, { userId = '', decisionReason = '' } = {}) {
  const c = asObject(candidate);
  const candidateId = clean(c.candidate_id || c.candidateId || c.event_id || c.id) || `rim_${tinyHash(JSON.stringify(c))}`;
  const summary = clip(c.memory_summary || c.memorySummary || c.summary || c.source_quote || c.sourceQuote || '', 700);
  if (!summary) return null;
  const targets = asArray(c.target_companion_ids || c.targetCompanionIds).map(normalizeCompanionId).filter(Boolean).slice(0, 8);
  const type = clean(c.observation_type || c.observationType || c.type || 'memory_observation') || 'memory_observation';
  return {
    kind: 'room_memory_item_v1',
    memory_id: clean(c.memory_id || c.memoryId) || `mem_${tinyHash(`${candidateId}\n${summary}`)}`,
    status: 'active',
    scope: targets.length ? 'companion' : 'room',
    owner_companion_ids: targets,
    type,
    title: clip(c.title || type.replace(/_/g, ' '), 90),
    summary,
    content: summary,
    source_candidate_id: candidateId,
    source_turn_id: clean(c.source_turn_id || c.sourceTurnId) || undefined,
    source_quote: clip(c.source_quote || c.sourceQuote || '', 700) || undefined,
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : undefined,
    sensitivity: clean(c.sensitivity || 'medium') || 'medium',
    provenance: {
      source: 'idle_room_memory_structuring',
      source_event_id: clean(c.event_id || c.source_event_id || c.sourceEventId) || undefined,
      source_turn_id: clean(c.source_turn_id || c.sourceTurnId) || undefined,
      approved_by: clean(userId || 'telegram_user') || 'telegram_user',
      decision_reason: clip(decisionReason, 500) || undefined,
    },
    review: {
      approved_by_user: true,
      approved_at: new Date().toISOString(),
      canonical_write_enabled: false,
      note: 'Activated as room-local memory. GoC remains the preferred surface for browsing, editing, and long-term governance.',
    },
    created_at: clean(c.created_at || c.createdAt) || new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_used_at: undefined,
    usage_count: 0,
  };
}

export function normalizeRoomMemoryItem(item = {}) {
  const row = asObject(item);
  const summary = clip(row.summary || row.content || row.text || row.memory_summary || '', 700);
  if (!summary) return null;
  return {
    kind: 'room_memory_item_v1',
    memory_id: clean(row.memory_id || row.memoryId || row.id) || `mem_${tinyHash(summary)}`,
    status: normalizeStatus(row.status || 'active'),
    scope: clean(row.scope || 'room') || 'room',
    owner_companion_ids: asArray(row.owner_companion_ids || row.ownerCompanionIds || row.target_companion_ids).map(normalizeCompanionId).filter(Boolean).slice(0, 8),
    type: clean(row.type || row.observation_type || 'memory') || 'memory',
    title: clip(row.title || row.type || row.observation_type || 'memory', 90),
    summary,
    content: clip(row.content || row.summary || summary, 1200),
    source_candidate_id: clean(row.source_candidate_id || row.sourceCandidateId) || undefined,
    source_turn_id: clean(row.source_turn_id || row.sourceTurnId || row.provenance?.source_turn_id) || undefined,
    source_quote: clip(row.source_quote || row.sourceQuote || '', 700) || undefined,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : undefined,
    sensitivity: clean(row.sensitivity || 'medium') || 'medium',
    provenance: asObject(row.provenance),
    review: asObject(row.review),
    created_at: clean(row.created_at || row.createdAt) || undefined,
    updated_at: clean(row.updated_at || row.updatedAt) || undefined,
    last_used_at: clean(row.last_used_at || row.lastUsedAt) || undefined,
    usage_count: Number.isFinite(Number(row.usage_count || row.usageCount)) ? Number(row.usage_count || row.usageCount) : 0,
  };
}

export function normalizeRoomMemoryCandidate(candidate = {}) {
  const row = asObject(candidate);
  const summary = clip(row.memory_summary || row.memorySummary || row.summary || row.source_quote || row.sourceQuote || '', 700);
  if (!summary) return null;
  return {
    kind: 'room_memory_candidate_v1',
    candidate_id: clean(row.candidate_id || row.candidateId || row.event_id || row.id) || `rim_${tinyHash(summary)}`,
    status: normalizeStatus(row.status || 'pending'),
    observation_type: clean(row.observation_type || row.observationType || row.type || 'memory_observation') || 'memory_observation',
    memory_summary: summary,
    source_turn_id: clean(row.source_turn_id || row.sourceTurnId) || undefined,
    source_quote: clip(row.source_quote || row.sourceQuote || '', 700) || undefined,
    target_companion_ids: asArray(row.target_companion_ids || row.targetCompanionIds).map(normalizeCompanionId).filter(Boolean).slice(0, 8),
    review_required: row.review_required !== false,
    canonical_write_enabled: false,
    created_at: clean(row.created_at || row.createdAt) || undefined,
    updated_at: clean(row.updated_at || row.updatedAt) || undefined,
    rationale: clip(row.rationale || '', 500) || undefined,
    payload: asObject(row.payload),
  };
}

export function deriveRoomMemoryView({ session = {}, companionState = null, includeRejected = false } = {}) {
  const activeItems = asArray(session.room_memory_items || session.roomMemoryItems)
    .map(normalizeRoomMemoryItem)
    .filter(Boolean)
    .filter((item) => includeRejected || item.status === 'active');
  const rawCandidates = [
    ...asArray(session.room_idle_memory_candidates || session.roomIdleMemoryCandidates),
    ...asArray(companionState?.idle_memory_observations),
  ];
  const candidateMap = new Map();
  for (const candidate of rawCandidates) {
    const c = normalizeRoomMemoryCandidate(candidate);
    if (!c) continue;
    const prev = candidateMap.get(c.candidate_id);
    if (!prev || (prev.status === 'pending' && c.status !== 'pending')) candidateMap.set(c.candidate_id, c);
  }
  const activeCandidateIds = new Set(activeItems.map((item) => item.source_candidate_id).filter(Boolean));
  const candidates = [...candidateMap.values()].filter((c) => !activeCandidateIds.has(c.candidate_id));
  const pendingCandidates = candidates.filter((c) => c.status === 'pending');
  const groups = new Map();
  for (const item of activeItems) {
    const owners = item.owner_companion_ids.length ? item.owner_companion_ids : ['room'];
    for (const owner of owners) {
      if (!groups.has(owner)) groups.set(owner, []);
      groups.get(owner).push(item);
    }
  }
  const typeCounts = {};
  const ownerCounts = {};
  for (const item of activeItems) {
    typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
    const owners = item.owner_companion_ids.length ? item.owner_companion_ids : ['room'];
    for (const owner of owners) ownerCounts[owner] = (ownerCounts[owner] || 0) + 1;
  }
  return {
    kind: 'room_memory_view_v1',
    active_items: activeItems,
    candidates,
    pending_candidates: pendingCandidates,
    groups: [...groups.entries()].map(([owner_id, items]) => ({ owner_id, items })),
    stats: {
      active_count: activeItems.length,
      candidate_count: candidates.length,
      pending_candidate_count: pendingCandidates.length,
      type_counts: typeCounts,
      owner_counts: ownerCounts,
    },
  };
}

function selectFromDisplayed(rows = [], target = 'latest') {
  const displayed = asArray(rows).slice(-12);
  const raw = clean(target || 'latest').toLowerCase();
  if (raw === 'latest' || raw === 'last' || !raw) {
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (normalizeStatus(rows[i].status || 'pending') === 'pending') return { row: rows[i], index: i, display_index: displayed.indexOf(rows[i]) };
    }
    return null;
  }
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1 || n > displayed.length) return null;
  const row = displayed[n - 1];
  if (!row || normalizeStatus(row.status || 'pending') !== 'pending') return null;
  return { row, index: rows.indexOf(row), display_index: n - 1 };
}

export function updateRoomMemoryCandidateDecision({ chatSessionStore = null, chatId = '', target = 'latest', decision = '', userId = '', reason = '' } = {}) {
  const normalizedDecision = clean(decision).toLowerCase();
  const accept = ['approve', 'accept', 'approved', 'accepted', 'active'].includes(normalizedDecision);
  const reject = ['reject', 'rejected', 'deny', 'denied'].includes(normalizedDecision);
  if (!accept && !reject) return { ok: false, reason: 'invalid_decision' };
  const store = chatSessionStore;
  const session = store?.get?.(chatId) || {};
  const candidates = asArray(session.room_idle_memory_candidates || session.roomIdleMemoryCandidates).map(normalizeRoomMemoryCandidate).filter(Boolean);
  const selected = selectFromDisplayed(candidates, target);
  if (!selected) return { ok: false, reason: 'candidate_not_found' };
  const status = accept ? 'active' : 'rejected';
  const decidedAt = new Date().toISOString();
  const updatedCandidate = {
    ...selected.row,
    status: accept ? 'accepted' : 'rejected',
    decided_at: decidedAt,
    decided_by: clean(userId || 'telegram_user') || 'telegram_user',
    decision_reason: clip(reason, 500) || undefined,
    updated_at: decidedAt,
  };
  let memoryItem = null;
  if (accept) memoryItem = candidateToMemoryItem(updatedCandidate, { userId, decisionReason: reason });
  if (store?.upsert) {
    store.upsert(chatId, (current = {}) => {
      const existingCandidates = asArray(current.room_idle_memory_candidates || current.roomIdleMemoryCandidates).map(normalizeRoomMemoryCandidate).filter(Boolean);
      const nextCandidates = existingCandidates.map((row) => (row.candidate_id === selected.row.candidate_id ? updatedCandidate : row));
      const items = asArray(current.room_memory_items || current.roomMemoryItems).map(normalizeRoomMemoryItem).filter(Boolean);
      const itemMap = new Map(items.map((item) => [item.memory_id, item]));
      if (memoryItem) itemMap.set(memoryItem.memory_id, memoryItem);
      return {
        ...current,
        room_idle_memory_candidates: nextCandidates,
        room_memory_items: [...itemMap.values()].slice(-80),
        room_memory_updated_at: decidedAt,
      };
    });
  }
  return { ok: true, status, candidate: updatedCandidate, memory_item: memoryItem };
}

export function formatRoomMemoryListForTelegram(view = {}) {
  const v = view?.kind ? view : deriveRoomMemoryView({ session: view || {} });
  const items = asArray(v.active_items);
  const pending = asArray(v.pending_candidates);
  const lines = [
    '🧠 Room Memory',
    `- active: ${items.length}`,
    `- pending proposals: ${pending.length}`,
  ];
  if (!items.length) {
    lines.push('', '저장된 active room memory가 아직 없습니다.', '후보를 만들려면 /memory idle, 후보를 보려면 /memory proposals 를 사용하세요.');
  } else {
    const groups = asArray(v.groups);
    for (const group of groups) {
      lines.push('', `## ${group.owner_id || 'room'}`);
      for (const item of asArray(group.items).slice(0, 8)) {
        lines.push(`- [${item.type}] ${item.summary}`);
        const meta = [item.memory_id, item.sensitivity ? `sensitivity=${item.sensitivity}` : '', item.source_turn_id ? `source=${item.source_turn_id}` : ''].filter(Boolean).join(' · ');
        if (meta) lines.push(`  ${meta}`);
      }
    }
  }
  lines.push('', '자세히: /memory explain <memory_id>', '후보: /memory proposals', 'GoC에서는 Memory Browser에서 surface/status/owner별로 브라우징하세요.');
  return lines.join('\n');
}

export function formatRoomMemoryProposalsForTelegram(view = {}) {
  const v = view?.kind ? view : deriveRoomMemoryView({ session: view || {} });
  const rows = asArray(v.candidates).slice(-12);
  const pending = rows.filter((row) => row.status === 'pending').length;
  const lines = ['🧠 Room Memory Proposals', `pending: ${pending}; shown: ${rows.length}`];
  if (!rows.length) {
    lines.push('', '현재 후보가 없습니다. /memory idle 로 idle-time structuring을 실행할 수 있습니다.');
  } else {
    rows.forEach((row, index) => {
      lines.push('', `${index + 1}. [${row.status}] ${row.observation_type}`);
      lines.push(`   ${row.memory_summary}`);
      if (row.target_companion_ids.length) lines.push(`   target: ${row.target_companion_ids.join(', ')}`);
      if (row.source_quote) lines.push(`   source: ${clip(row.source_quote, 180)}`);
    });
  }
  lines.push('', '처리:', '- /memory approve latest 또는 /memory approve <number>', '- /memory reject latest [reason] 또는 /memory reject <number> [reason]');
  return lines.join('\n');
}

export function formatRoomMemoryDecisionForTelegram(result = {}) {
  if (!result?.ok) return `memory decision failed: ${result?.reason || 'unknown'}`;
  const item = result.memory_item;
  const lines = [`✅ room memory ${result.status === 'active' ? 'approved' : 'rejected'}`];
  lines.push(`candidate: ${result.candidate?.candidate_id || '-'}`);
  if (item) {
    lines.push(`memory_id: ${item.memory_id}`);
    lines.push(`summary: ${item.summary}`);
    lines.push('note: Telegram은 구조화 텍스트 요약만 보여주고, GoC에서 편집/브라우징하는 것이 기본입니다.');
  }
  return lines.join('\n');
}

export function formatRoomMemoryExplainForTelegram({ session = {}, id = '' } = {}) {
  const target = clean(id);
  if (!target) return 'Usage: /memory explain <memory_id|candidate_id>';
  const view = deriveRoomMemoryView({ session, includeRejected: true });
  const item = view.active_items.find((row) => row.memory_id === target || row.source_candidate_id === target);
  if (item) {
    const lines = ['🧠 Room Memory Detail', `memory_id: ${item.memory_id}`, `status: ${item.status}`, `scope: ${item.scope}`, `type: ${item.type}`, `summary: ${item.summary}`];
    if (item.owner_companion_ids.length) lines.push(`owners: ${item.owner_companion_ids.join(', ')}`);
    if (item.source_quote) lines.push(`source_quote: ${item.source_quote}`);
    if (item.provenance?.approved_by) lines.push(`approved_by: ${item.provenance.approved_by}`);
    if (item.review?.approved_at) lines.push(`approved_at: ${item.review.approved_at}`);
    lines.push('canonical_write_enabled: false');
    return lines.join('\n');
  }
  const candidate = view.candidates.find((row) => row.candidate_id === target);
  if (candidate) {
    return ['🧠 Room Memory Candidate Detail', `candidate_id: ${candidate.candidate_id}`, `status: ${candidate.status}`, `type: ${candidate.observation_type}`, `summary: ${candidate.memory_summary}`, candidate.source_quote ? `source_quote: ${candidate.source_quote}` : '', 'canonical_write_enabled: false'].filter(Boolean).join('\n');
  }
  return `memory not found: ${target}`;
}
