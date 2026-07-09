function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return cleanText(value).toLowerCase();
}

function clipText(value = '', maxLen = 160) {
  const text = cleanText(value).replace(/\s+/g, ' ');
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1).trim()}…`;
}

function parseTs(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? ms : null;
}

function hoursBetween(fromMs, toMs) {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) return null;
  return Math.round(((toMs - fromMs) / 3600000) * 10) / 10;
}

function median(values = []) {
  const rows = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!rows.length) return null;
  const mid = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[mid] : Math.round(((rows[mid - 1] + rows[mid]) / 2) * 10) / 10;
}

const GOVERNANCE_SOURCES = {
  memory_candidate: { label: 'room memory candidates', review_command: '/memory proposals' },
  correction_merge: { label: 'correction merge proposals', review_command: '/correct proposals' },
  memory_exchange: { label: 'companion memory exchange', review_command: '/council proposals' },
  agent_specialization: { label: 'agent roster specialization', review_command: '/room agents approve|reject' },
};

function normalizeDecisionStatus(status = '') {
  const value = cleanLower(status);
  if (['approved', 'accepted', 'active', 'approve', 'accept'].includes(value)) return 'approved';
  if (['rejected', 'denied', 'reject', 'deny'].includes(value)) return 'rejected';
  return 'pending';
}

function itemFrom({ source, itemId, status, createdAt, decidedAt, summary }) {
  const created = parseTs(createdAt);
  const normalizedStatus = normalizeDecisionStatus(status);
  const decided = normalizedStatus === 'pending' ? null : parseTs(decidedAt);
  return {
    source,
    item_id: cleanText(itemId) || undefined,
    status: normalizedStatus,
    created_at_ms: created,
    decided_at_ms: decided,
    summary: clipText(summary, 140) || undefined,
  };
}

function collectCompanionPairItems(companionEvents = []) {
  const events = asArray(companionEvents)
    .map(asObject)
    .filter((event) => cleanText(event.event_type))
    .sort((a, b) => (parseTs(a.ts) || 0) - (parseTs(b.ts) || 0));
  const open = new Map();
  const items = [];
  const specs = [
    { source: 'correction_merge', created: 'merge_proposal_created', decision: 'merge_proposal_decision' },
    { source: 'memory_exchange', created: 'companion_memory_exchange_proposed', decision: 'companion_memory_exchange_decision' },
  ];
  const createdTypeToSource = new Map(specs.map((spec) => [spec.created, spec.source]));
  const decisionTypeToSource = new Map(specs.map((spec) => [spec.decision, spec.source]));
  for (const event of events) {
    const type = cleanText(event.event_type);
    if (createdTypeToSource.has(type)) {
      const source = createdTypeToSource.get(type);
      const key = cleanText(event.event_id) || `${source}_${parseTs(event.ts) || items.length}`;
      open.set(`${source}:${key}`, {
        source,
        item_id: key,
        created_at: event.ts,
        summary: event.summary || event.memory_summary || asObject(event.payload).summary || '',
        source_event_id: cleanText(event.source_event_id) || undefined,
      });
      continue;
    }
    if (decisionTypeToSource.has(type)) {
      const source = decisionTypeToSource.get(type);
      const proposalKey = cleanText(event.proposal_event_id) || '';
      const sourceKey = cleanText(event.source_event_id) || '';
      let matchKey = proposalKey && open.has(`${source}:${proposalKey}`) ? `${source}:${proposalKey}` : '';
      if (!matchKey && sourceKey) {
        for (const [key, row] of open) {
          if (key.startsWith(`${source}:`) && row.source_event_id === sourceKey) {
            matchKey = key;
            break;
          }
        }
      }
      if (!matchKey) {
        const sourceKeys = [...open.keys()].filter((key) => key.startsWith(`${source}:`));
        matchKey = sourceKeys[sourceKeys.length - 1] || '';
      }
      const status = normalizeDecisionStatus(event.decision || event.status);
      if (matchKey) {
        const row = open.get(matchKey);
        open.delete(matchKey);
        items.push(itemFrom({
          source,
          itemId: row.item_id,
          status: status === 'pending' ? 'approved' : status,
          createdAt: row.created_at,
          decidedAt: event.decided_at || event.ts,
          summary: row.summary,
        }));
      } else {
        items.push(itemFrom({
          source,
          itemId: proposalKey || sourceKey || undefined,
          status: status === 'pending' ? 'approved' : status,
          createdAt: event.ts,
          decidedAt: event.decided_at || event.ts,
          summary: event.summary || '',
        }));
      }
    }
  }
  for (const row of open.values()) {
    items.push(itemFrom({ source: row.source, itemId: row.item_id, status: 'pending', createdAt: row.created_at, summary: row.summary }));
  }
  return items;
}

function collectMemoryCandidateItems(memoryView = null) {
  const view = asObject(memoryView);
  const items = [];
  for (const candidate of asArray(view.candidates)) {
    const row = asObject(candidate);
    items.push(itemFrom({
      source: 'memory_candidate',
      itemId: row.candidate_id,
      status: row.status,
      createdAt: row.created_at,
      decidedAt: row.updated_at,
      summary: row.memory_summary,
    }));
  }
  for (const item of asArray(view.active_items)) {
    const row = asObject(item);
    if (!cleanText(row.source_candidate_id)) continue;
    items.push(itemFrom({
      source: 'memory_candidate',
      itemId: row.source_candidate_id,
      status: 'approved',
      createdAt: row.created_at,
      decidedAt: asObject(row.review).approved_at || row.updated_at || row.created_at,
      summary: row.summary,
    }));
  }
  return items;
}

function collectAgentSpecializationItems({ usageEvents = [], pendingAgentSpecialization = null } = {}) {
  const events = asArray(usageEvents)
    .map(asObject)
    .filter((event) => /^room_agent_specialization_(proposed|approved|rejected)$/.test(cleanText(event.event_type)))
    .sort((a, b) => (parseTs(a.ts) || 0) - (parseTs(b.ts) || 0));
  const items = [];
  let open = null;
  for (const event of events) {
    const type = cleanText(event.event_type);
    if (type === 'room_agent_specialization_proposed') {
      if (open) items.push(itemFrom({ ...open, status: 'pending' }));
      open = { source: 'agent_specialization', itemId: `agent_spec_${parseTs(event.ts) || items.length}`, createdAt: event.ts, summary: 'agent roster specialization proposal' };
      continue;
    }
    const status = type === 'room_agent_specialization_approved' ? 'approved' : 'rejected';
    if (open) {
      items.push(itemFrom({ ...open, status, decidedAt: event.ts }));
      open = null;
    } else {
      items.push(itemFrom({ source: 'agent_specialization', itemId: `agent_spec_${parseTs(event.ts) || items.length}`, status, createdAt: event.ts, decidedAt: event.ts, summary: 'agent roster specialization decision' }));
    }
  }
  const pending = asObject(pendingAgentSpecialization);
  if (open) {
    items.push(itemFrom({ ...open, status: 'pending' }));
  } else if (cleanLower(pending.status) === 'proposal_ready') {
    items.push(itemFrom({
      source: 'agent_specialization',
      itemId: 'agent_spec_pending',
      status: 'pending',
      createdAt: pending.generated_at,
      summary: 'agent roster specialization proposal',
    }));
  }
  return items;
}

export function collectRoomGovernanceItems({ companionEvents = [], memoryView = null, usageEvents = [], pendingAgentSpecialization = null } = {}) {
  const items = [
    ...collectMemoryCandidateItems(memoryView),
    ...collectCompanionPairItems(companionEvents),
    ...collectAgentSpecializationItems({ usageEvents, pendingAgentSpecialization }),
  ];
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.source}:${item.item_id || ''}:${item.created_at_ms || ''}`;
    if (item.item_id && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeItems(items = [], nowMs = Date.now()) {
  const proposed = items.length;
  const approved = items.filter((item) => item.status === 'approved').length;
  const rejected = items.filter((item) => item.status === 'rejected').length;
  const pendingItems = items.filter((item) => item.status === 'pending');
  const decided = approved + rejected;
  const latencies = items
    .filter((item) => item.status !== 'pending')
    .map((item) => hoursBetween(item.created_at_ms, item.decided_at_ms))
    .filter((value) => Number.isFinite(value));
  const oldestPending = pendingItems
    .filter((item) => Number.isFinite(item.created_at_ms))
    .sort((a, b) => a.created_at_ms - b.created_at_ms)[0] || null;
  return {
    proposed,
    approved,
    rejected,
    decided,
    pending: pendingItems.length,
    review_rate: proposed ? Math.round((decided / proposed) * 100) / 100 : null,
    median_hours_to_decision: median(latencies),
    oldest_pending_age_hours: oldestPending ? hoursBetween(oldestPending.created_at_ms, nowMs) : null,
    oldest_pending_item_id: oldestPending?.item_id,
  };
}

export function buildRoomGovernanceMetrics({
  companionEvents = [],
  memoryView = null,
  usageEvents = [],
  pendingAgentSpecialization = null,
  now = new Date().toISOString(),
} = {}) {
  const nowMs = parseTs(now) ?? Date.now();
  const items = collectRoomGovernanceItems({ companionEvents, memoryView, usageEvents, pendingAgentSpecialization });
  const bySource = {};
  for (const source of Object.keys(GOVERNANCE_SOURCES)) {
    bySource[source] = summarizeItems(items.filter((item) => item.source === source), nowMs);
  }
  const totals = summarizeItems(items, nowMs);
  const weekAgoMs = nowMs - 7 * 24 * 3600000;
  const createdLast7d = items.filter((item) => Number.isFinite(item.created_at_ms) && item.created_at_ms >= weekAgoMs).length;
  const decidedLast7d = items.filter((item) => Number.isFinite(item.decided_at_ms) && item.decided_at_ms >= weekAgoMs).length;
  const decisionsPerDay = decidedLast7d / 7;
  const backlogClearDays = totals.pending > 0 && decisionsPerDay > 0
    ? Math.round((totals.pending / decisionsPerDay) * 10) / 10
    : (totals.pending > 0 ? null : 0);
  const shadowRecommendationViews = asArray(usageEvents)
    .map(asObject)
    .filter((event) => ['room_topology_replay_evaluated', 'room_preference_scorer_view'].includes(cleanText(event.event_type))).length;
  const reasons = [];
  let status = 'healthy';
  if (!totals.proposed) {
    status = 'no_governance_items';
  } else {
    if (totals.pending > 0 && backlogClearDays === null) {
      status = 'review_stalled';
      reasons.push('pending proposals exist but no decisions were made in the last 7 days');
    } else if ((totals.oldest_pending_age_hours ?? 0) > 72) {
      status = 'review_backlog';
      reasons.push('oldest pending proposal is older than 72h');
    } else if (totals.review_rate !== null && totals.review_rate < 0.5) {
      status = 'review_backlog';
      reasons.push('less than half of all proposals have ever been decided');
    }
    if (createdLast7d > decidedLast7d * 3 && createdLast7d >= 6) {
      reasons.push('proposal creation outpaces decisions by more than 3x this week');
      if (status === 'healthy') status = 'review_backlog';
    }
  }
  return {
    kind: 'room_governance_metrics_v1',
    generated_at: new Date(nowMs).toISOString(),
    status,
    reasons,
    totals,
    by_source: bySource,
    throughput_7d: {
      created: createdLast7d,
      decided: decidedLast7d,
      backlog_clear_days_at_current_pace: backlogClearDays,
    },
    shadow_recommendation_views: shadowRecommendationViews,
    pending_items: items
      .filter((item) => item.status === 'pending')
      .sort((a, b) => (a.created_at_ms || Infinity) - (b.created_at_ms || Infinity))
      .slice(0, 8)
      .map((item) => ({
        source: item.source,
        item_id: item.item_id,
        age_hours: hoursBetween(item.created_at_ms, nowMs),
        summary: item.summary,
        review_command: GOVERNANCE_SOURCES[item.source]?.review_command || '/inbox',
      })),
    privacy: {
      raw_transcript_exported: false,
      summaries_only: true,
    },
  };
}

export function formatRoomGovernanceDigestForTelegram(metrics = {}) {
  const row = asObject(metrics);
  const totals = asObject(row.totals);
  const throughput = asObject(row.throughput_7d);
  const statusIcon = { healthy: '✅', no_governance_items: 'ℹ️', review_backlog: '⚠️', review_stalled: '🛑' }[row.status] || 'ℹ️';
  const lines = [
    '🗞️ Room governance digest',
    '',
    `${statusIcon} status: ${row.status || 'unknown'}`,
  ];
  for (const reason of asArray(row.reasons).slice(0, 3)) lines.push(`- ${reason}`);
  if (row.status === 'no_governance_items') {
    lines.push('', '이 room에는 아직 리뷰할 proposal이 없습니다.');
    return lines.join('\n');
  }
  lines.push(
    '',
    `전체: proposed=${totals.proposed} · approved=${totals.approved} · rejected=${totals.rejected} · pending=${totals.pending}`,
    `리뷰율: ${totals.review_rate === null ? '-' : `${Math.round(totals.review_rate * 100)}%`} · 결정까지 중앙값: ${totals.median_hours_to_decision === null ? '-' : `${totals.median_hours_to_decision}h`}`,
    `최근 7일: 생성 ${throughput.created} / 결정 ${throughput.decided}${throughput.backlog_clear_days_at_current_pace === null ? ' · 현재 속도로는 backlog가 줄지 않습니다' : (totals.pending ? ` · 현재 속도로 backlog 소진까지 ~${throughput.backlog_clear_days_at_current_pace}일` : '')}`,
  );
  const bySource = asObject(row.by_source);
  const sourceLines = Object.entries(bySource)
    .filter(([, stats]) => asObject(stats).proposed > 0)
    .map(([source, stats]) => `- ${GOVERNANCE_SOURCES[source]?.label || source}: pending=${asObject(stats).pending}/${asObject(stats).proposed}${asObject(stats).oldest_pending_age_hours ? ` (최고 대기 ${asObject(stats).oldest_pending_age_hours}h)` : ''}`);
  if (sourceLines.length) lines.push('', '소스별:', ...sourceLines);
  const pendingItems = asArray(row.pending_items);
  if (pendingItems.length) {
    lines.push('', '오래된 pending 순:');
    for (const item of pendingItems.slice(0, 5)) {
      lines.push(`- [${item.source}] ${item.summary || item.item_id || 'proposal'}${Number.isFinite(item.age_hours) ? ` · ${item.age_hours}h` : ''}`);
      lines.push(`  → ${item.review_command}`);
    }
  }
  if (Number(row.shadow_recommendation_views || 0) > 0) {
    lines.push('', `shadow 추천 조회 ${row.shadow_recommendation_views}회 (topology replay/preference scorer — 승인 대상 아님)`);
  }
  lines.push('', '이 다이제스트는 결정론적 계측입니다. LLM 호출/외부 전송 없음, summary-only.');
  return lines.join('\n');
}

export function shouldSendRoomGovernanceDigest({
  session = {},
  metrics = {},
  now = new Date().toISOString(),
  minHours = 20,
  env = process.env,
} = {}) {
  const enabled = cleanLower(env?.DDALGGAK_ROOM_GOVERNANCE_DIGEST_ENABLED ?? '1');
  if (['0', 'false', 'no', 'off'].includes(enabled)) return { send: false, reason: 'disabled' };
  const totals = asObject(asObject(metrics).totals);
  if (!Number(totals.pending || 0)) return { send: false, reason: 'no_pending_items' };
  const nowMs = parseTs(now) ?? Date.now();
  const lastMs = parseTs(asObject(session).last_governance_digest_at);
  const minMs = Math.max(1, Number(env?.DDALGGAK_ROOM_GOVERNANCE_DIGEST_MIN_HOURS || minHours)) * 3600000;
  if (Number.isFinite(lastMs) && nowMs - lastMs < minMs) return { send: false, reason: 'cooldown' };
  return { send: true, reason: 'pending_backlog_and_due' };
}
