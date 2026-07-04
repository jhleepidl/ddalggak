import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clip(value = '', max = 500) {
  const text = clean(value);
  const n = Math.max(60, Math.floor(Number(max) || 500));
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}

function ensureDir(dir = '') {
  if (!dir) return '';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function localMemoryDir(jobDir = '') {
  const cleanJobDir = clean(jobDir);
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'local_memory')) : '';
}

function sharedDir(jobDir = '') {
  const cleanJobDir = clean(jobDir);
  return cleanJobDir ? ensureDir(path.join(cleanJobDir, 'shared')) : '';
}

function appendJsonl(filePath = '', row = {}) {
  if (!filePath || !row || typeof row !== 'object') return false;
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  return true;
}

function readJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter((row) => row && typeof row === 'object');
  } catch {
    return [];
  }
}

function tinyHash(value = '') {
  const key = String(value || '');
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36);
}

export const DEFAULT_ROOM_COMPANIONS = Object.freeze({
  research: Object.freeze({
    id: 'research',
    label: 'Research Companion',
    purpose: 'Research framing, prior art, experiment analysis, and docs alignment.',
    agent_mode: 'balanced',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'project_docs', mode: 'read', strictness: 'source_required' }),
      Object.freeze({ source: 'experiment_summaries', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'accepted_decisions', mode: 'read', strictness: 'source_required' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces', 'unreviewed_other_room_raw_chat']),
    clarification_policy: 'assume_low_risk_ask_high_risk',
    branch_policy: 'branch_for_speculation',
    action_policy: 'patch_allowed_external_actions_confirmed',
  }),
  implementation: Object.freeze({
    id: 'implementation',
    label: 'Implementation Companion',
    purpose: 'Code patches, targeted tests, source-bundle hygiene, and implementation handoff.',
    agent_mode: 'implementation',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'project_docs', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'implementation_status', mode: 'read', strictness: 'source_required' }),
      Object.freeze({ source: 'test_results', mode: 'read', strictness: 'balanced' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces']),
    clarification_policy: 'assume_low_risk_ask_high_risk',
    branch_policy: 'branch_for_speculation',
    action_policy: 'patch_allowed_external_actions_confirmed',
  }),
  product: Object.freeze({
    id: 'product',
    label: 'Product Companion',
    purpose: 'User experience, entrypoint, companion UX, and fuzzy memory tolerance.',
    agent_mode: 'product',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'product_docs', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'accepted_decisions', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'user_value_notes', mode: 'read', strictness: 'balanced' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces', 'implementation_debug_logs']),
    clarification_policy: 'assume_low_risk_ask_high_risk',
    branch_policy: 'branch_for_speculation',
    action_policy: 'draft_and_patch_only',
  }),
  critic: Object.freeze({
    id: 'critic',
    label: 'Critic Companion',
    purpose: 'Risk, novelty, overclaim, boundary, and failure-mode review before the room acts.',
    agent_mode: 'strict',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'accepted_decisions', mode: 'read', strictness: 'source_required' }),
      Object.freeze({ source: 'risk_notes', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'rejected_directions', mode: 'read', strictness: 'source_required' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces', 'unreviewed_memory_exchange']),
    clarification_policy: 'ask_before_medium_or_high_risk_claims',
    branch_policy: 'branch_for_speculation',
    action_policy: 'review_and_veto_only',
  }),
  personal: Object.freeze({
    id: 'personal',
    label: 'Personal Context Companion',
    purpose: 'User preferences, working rhythm, durable dislikes, and lightweight personal continuity.',
    agent_mode: 'balanced',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'user_preferences', mode: 'read', strictness: 'source_required' }),
      Object.freeze({ source: 'accepted_decisions', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'room_usage_events', mode: 'read', strictness: 'balanced' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces', 'sensitive_memory', 'other_room_personal_memory']),
    clarification_policy: 'ask_before_sensitive_personal_context',
    branch_policy: 'suggest_branch_for_private_or_sensitive_context',
    action_policy: 'preference_support_only',
  }),
  concierge: Object.freeze({
    id: 'concierge',
    label: 'Best Companion / Concierge',
    purpose: 'Route ambiguous requests to the right companion and safe context bundle.',
    agent_mode: 'router',
    memory_connections: Object.freeze([
      Object.freeze({ source: 'companion_profiles', mode: 'read', strictness: 'balanced' }),
      Object.freeze({ source: 'project_docs_index', mode: 'read', strictness: 'balanced' }),
    ]),
    excluded_by_default: Object.freeze(['private_raw_traces', 'sensitive_memory']),
    clarification_policy: 'ask_before_sensitive_context',
    branch_policy: 'suggest_branch_for_speculation',
    action_policy: 'route_or_draft_only',
  }),
});

export function normalizeCompanionId(value = '') {
  const key = clean(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!key) return '';
  if (key === 'best' || key === 'router' || key === 'friend' || key === 'companion') return 'concierge';
  if (key === 'impl' || key === 'code' || key === 'coding') return 'implementation';
  if (key === 'ux' || key === 'product_design') return 'product';
  if (key === 'risk' || key === 'reviewer' || key === 'skeptic' || key === 'sceptic') return 'critic';
  if (key === 'me' || key === 'personal_context' || key === 'preference' || key === 'preferences') return 'personal';
  return key;
}

export function normalizeAgentMode(value = '') {
  const key = clean(value).toLowerCase();
  if (['fast', 'balanced', 'strict', 'implementation', 'product', 'router'].includes(key)) return key;
  return 'balanced';
}

export function normalizeContextMode(value = '') {
  const key = clean(value).toLowerCase().replace(/_/g, '-');
  if (['project-only', 'clean-slate', 'exclude', 'reset', 'default'].includes(key)) return key;
  if (key === 'project') return 'project-only';
  if (key === 'clean' || key === 'fresh') return 'clean-slate';
  return '';
}

export function normalizeMergeProposalStatus(value = '') {
  const key = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['accepted', 'approved', 'approve', 'accept'].includes(key)) return 'accepted';
  if (['rejected', 'reject', 'denied', 'deny', 'declined', 'decline'].includes(key)) return 'rejected';
  if (['pending', 'open', 'review', 'needs_review', 'review_required'].includes(key)) return 'pending';
  return key || 'pending';
}

export function normalizeMergeProposalDecision(value = '') {
  const key = clean(value).toLowerCase().replace(/[\s-]+/g, '_');
  if (['approve', 'approved', 'accept', 'accepted'].includes(key)) return 'approve';
  if (['reject', 'rejected', 'deny', 'denied', 'decline', 'declined'].includes(key)) return 'reject';
  return '';
}

export function listRoomCompanions() {
  return Object.values(DEFAULT_ROOM_COMPANIONS).map((profile) => ({
    ...profile,
    memory_connections: [...profile.memory_connections],
    excluded_by_default: [...profile.excluded_by_default],
  }));
}

export function getRoomCompanionProfile(id = 'research') {
  const key = normalizeCompanionId(id) || 'research';
  const profile = DEFAULT_ROOM_COMPANIONS[key] || DEFAULT_ROOM_COMPANIONS.research;
  return {
    ...profile,
    memory_connections: [...profile.memory_connections],
    excluded_by_default: [...profile.excluded_by_default],
  };
}

export function normalizeRoomCompanionEvent(row = {}) {
  if (!row || typeof row !== 'object') return null;
  const eventType = clean(row.event_type || row.eventType || row.type).toLowerCase();
  if (![
    'companion_selected',
    'context_override',
    'agent_mode_changed',
    'user_correction',
    'merge_proposal_created',
    'merge_proposal_decision',
    'merge_materialization_candidate_created',
    'companion_council_started',
    'companion_council_turn',
    'companion_council_decision',
    'companion_memory_exchange_proposed',
    'companion_memory_exchange_decision',
    'room_idle_memory_observation_proposed',
  ].includes(eventType)) return null;
  const ts = clean(row.ts || row.created_at || row.createdAt) || new Date().toISOString();
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const normalized = {
    kind: 'room_companion_event_v1',
    event_id: clean(row.event_id || row.eventId || row.id) || `room_companion_event_${tinyHash(`${eventType}\n${ts}\n${clean(row.companion_id || row.companionId || payload.companion_id || payload.companionId)}\n${clean(row.context_mode || row.contextMode || row.mode || payload.context_mode || payload.contextMode || payload.mode)}\n${JSON.stringify(row.excluded_sources || row.excludedSources || payload.excluded_sources || payload.excludedSources || row.excluded_source || row.excludedSource || payload.excluded_source || payload.excludedSource || '')}\n${clean(row.correction_text || row.correctionText || payload.correction_text || payload.correctionText)}\n${JSON.stringify(payload)}`)}`,
    ts,
    event_type: eventType,
    chat_id: clean(row.chat_id || row.chatId) || undefined,
    user_id: clean(row.user_id || row.userId) || undefined,
    job_id: clean(row.job_id || row.jobId) || undefined,
    command: clean(row.command) || undefined,
    source: clean(row.source) || 'room_companions',
    council_id: clean(row.council_id || row.councilId || payload.council_id || payload.councilId) || undefined,
    council_question: clip(row.council_question || row.councilQuestion || payload.council_question || payload.councilQuestion || row.question || payload.question || '', 700) || undefined,
    turn_index: Number.isFinite(Number(row.turn_index ?? row.turnIndex ?? payload.turn_index ?? payload.turnIndex)) ? Number(row.turn_index ?? row.turnIndex ?? payload.turn_index ?? payload.turnIndex) : undefined,
    companion_id: normalizeCompanionId(row.companion_id || row.companionId || payload.companion_id || payload.companionId) || undefined,
    from_companion_id: normalizeCompanionId(row.from_companion_id || row.fromCompanionId || payload.from_companion_id || payload.fromCompanionId) || undefined,
    to_companion_id: normalizeCompanionId(row.to_companion_id || row.toCompanionId || payload.to_companion_id || payload.toCompanionId) || undefined,
    agent_mode: normalizeAgentMode(row.agent_mode || row.agentMode || payload.agent_mode || payload.agentMode || ''),
    context_mode: normalizeContextMode(row.context_mode || row.contextMode || row.mode || payload.context_mode || payload.contextMode || payload.mode || ''),
    excluded_sources: Array.isArray(row.excluded_sources || row.excludedSources || payload.excluded_sources || payload.excludedSources)
      ? (row.excluded_sources || row.excludedSources || payload.excluded_sources || payload.excludedSources).map(clean).filter(Boolean).slice(-12)
      : clean(row.excluded_source || row.excludedSource || payload.excluded_source || payload.excludedSource) ? [clean(row.excluded_source || row.excludedSource || payload.excluded_source || payload.excludedSource)] : [],
    duration: clean(row.duration || payload.duration) || 'room_session',
    correction_text: clip(row.correction_text || row.correctionText || payload.correction_text || payload.correctionText || '', 700) || undefined,
    scope: clean(row.scope || payload.scope) || undefined,
    promotion_status: clean(row.promotion_status || row.promotionStatus || payload.promotion_status || payload.promotionStatus) || undefined,
    summary: clip(row.summary || payload.summary || '', 500) || undefined,
    memory_summary: clip(row.memory_summary || row.memorySummary || payload.memory_summary || payload.memorySummary || '', 700) || undefined,
    exchange_reason: clip(row.exchange_reason || row.exchangeReason || payload.exchange_reason || payload.exchangeReason || row.reason || payload.reason || '', 500) || undefined,
    status: (eventType.startsWith('merge_proposal') || eventType === 'merge_materialization_candidate_created' || eventType.startsWith('companion_memory_exchange') || eventType === 'room_idle_memory_observation_proposed')
      ? normalizeMergeProposalStatus(row.status || payload.status || row.decision || payload.decision || (eventType === 'merge_materialization_candidate_created' ? 'candidate' : ''))
      : clean(row.status || payload.status) || undefined,
    proposal_kind: clean(row.proposal_kind || row.proposalKind || payload.proposal_kind || payload.proposalKind) || undefined,
    source_event_id: clean(row.source_event_id || row.sourceEventId || payload.source_event_id || payload.sourceEventId) || undefined,
    proposal_event_id: clean(row.proposal_event_id || row.proposalEventId || payload.proposal_event_id || payload.proposalEventId) || undefined,
    target_scope: clean(row.target_scope || row.targetScope || payload.target_scope || payload.targetScope) || undefined,
    change_type: clean(row.change_type || row.changeType || payload.change_type || payload.changeType) || undefined,
    decision: normalizeMergeProposalDecision(row.decision || payload.decision || row.status || payload.status || ''),
    decided_by: clean(row.decided_by || row.decidedBy || payload.decided_by || payload.decidedBy) || undefined,
    decided_at: clean(row.decided_at || row.decidedAt || payload.decided_at || payload.decidedAt) || undefined,
    decision_reason: clip(row.decision_reason || row.decisionReason || payload.decision_reason || payload.decisionReason || row.reason || payload.reason || '', 500) || undefined,
    materialization_id: clean(row.materialization_id || row.materializationId || payload.materialization_id || payload.materializationId) || undefined,
    branch_id: clean(row.branch_id || row.branchId || payload.branch_id || payload.branchId || payload.branch_change?.branch_id) || undefined,
    merge_request_id: clean(row.merge_request_id || row.mergeRequestId || payload.merge_request_id || payload.mergeRequestId || payload.merge_request?.merge_request_id) || undefined,
    rationale: clip(row.rationale || payload.rationale || '', 500) || undefined,
    payload,
  };
  return normalized;
}

export function normalizeRoomCompanionEvents(raw = []) {
  const rows = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const event = normalizeRoomCompanionEvent(row);
    if (!event || seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    out.push(event);
  }
  return out.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).slice(-200);
}

export function appendRoomCompanionEvent({ jobDir = '', chatSessionStore = null, chatId = '', userId = '', jobId = '', event = null } = {}) {
  const normalized = normalizeRoomCompanionEvents([{ ...(event || {}), chat_id: chatId || event?.chat_id, user_id: userId || event?.user_id, job_id: jobId || event?.job_id }])[0];
  if (!normalized) return null;
  const cleanJobDir = clean(jobDir);
  if (cleanJobDir) {
    appendJsonl(path.join(localMemoryDir(cleanJobDir), 'room_companion_events.jsonl'), normalized);
    appendJsonl(path.join(sharedDir(cleanJobDir), 'room_companion_events.jsonl'), normalized);
  }
  if (chatSessionStore && typeof chatSessionStore.upsert === 'function') {
    chatSessionStore.upsert(chatId || normalized.chat_id || '', (session = {}) => {
      const existing = normalizeRoomCompanionEvents(session.room_companion_events || session.roomCompanionEvents || []);
      const events = normalizeRoomCompanionEvents([...existing, normalized]).slice(-80);
      return {
        ...session,
        room_companion_events: events,
        room_companion_state: deriveRoomCompanionState({ events, session: { ...session, room_companion_events: events } }),
      };
    });
  }
  return normalized;
}

export function readRoomCompanionEvents({ jobDir = '', session = null, limit = 80 } = {}) {
  const maxRows = Math.max(1, Math.floor(Number(limit) || 80));
  const rows = [];
  const seen = new Set();
  const pushRows = (items = []) => {
    for (const event of normalizeRoomCompanionEvents(items)) {
      const key = event.event_id || `${event.event_type}:${event.ts}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      rows.push(event);
    }
  };
  const cleanJobDir = clean(jobDir);
  if (cleanJobDir) {
    pushRows(readJsonl(path.join(localMemoryDir(cleanJobDir), 'room_companion_events.jsonl')));
    pushRows(readJsonl(path.join(sharedDir(cleanJobDir), 'room_companion_events.jsonl')));
  }
  if (session && typeof session === 'object') pushRows(session.room_companion_events || session.roomCompanionEvents || []);
  return rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || ''))).slice(-maxRows);
}

function dedupeList(items = [], max = 12) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const text = clean(item);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out.slice(-Math.max(1, Math.floor(Number(max) || 12)));
}

export function deriveRoomCompanionState({ events = [], session = null } = {}) {
  const rows = normalizeRoomCompanionEvents([
    ...(Array.isArray(events) ? events : []),
    ...(Array.isArray(session?.room_companion_events || session?.roomCompanionEvents) ? (session.room_companion_events || session.roomCompanionEvents) : []),
  ]);
  let activeCompanionId = normalizeCompanionId(session?.active_companion_id || session?.activeCompanionId || session?.room_companion_state?.active_companion?.id) || 'research';
  let agentMode = normalizeAgentMode(session?.agent_mode || session?.room_companion_state?.agent_mode || getRoomCompanionProfile(activeCompanionId).agent_mode);
  let contextMode = normalizeContextMode(session?.room_companion_state?.context_controls?.mode || '') || 'default';
  let cleanSlate = false;
  let excludedSources = [];
  let recentCorrections = [];
  let mergeProposals = [];
  let materializationCandidates = [];
  let recentCouncils = [];
  let memoryExchangeProposals = [];
  let idleMemoryObservations = [];

  for (const event of rows) {
    if (event.event_type === 'companion_selected' && event.companion_id) {
      activeCompanionId = event.companion_id;
      agentMode = normalizeAgentMode(getRoomCompanionProfile(activeCompanionId).agent_mode);
    } else if (event.event_type === 'agent_mode_changed') {
      agentMode = normalizeAgentMode(event.agent_mode);
    } else if (event.event_type === 'context_override') {
      if (event.context_mode === 'reset' || event.context_mode === 'default') {
        contextMode = 'default';
        cleanSlate = false;
        excludedSources = [];
      } else if (event.context_mode === 'clean-slate') {
        contextMode = 'clean-slate';
        cleanSlate = true;
        excludedSources = [];
      } else if (event.context_mode === 'project-only') {
        contextMode = 'project-only';
        cleanSlate = false;
      } else if (event.context_mode === 'exclude') {
        contextMode = contextMode === 'default' ? 'default' : contextMode;
        excludedSources = dedupeList([...excludedSources, ...event.excluded_sources], 16);
      }
    } else if (event.event_type === 'user_correction' && event.correction_text) {
      recentCorrections = [
        ...recentCorrections,
        {
          text: event.correction_text,
          scope: event.scope || 'room',
          promotion_status: event.promotion_status || 'candidate',
          event_id: event.event_id,
          ts: event.ts,
        },
      ].slice(-8);
    } else if (event.event_type === 'merge_proposal_created') {
      mergeProposals = [
        ...mergeProposals,
        {
          summary: event.summary || 'merge proposal',
          status: normalizeMergeProposalStatus(event.status || 'pending'),
          proposal_kind: event.proposal_kind || 'memory',
          source_event_id: event.source_event_id,
          target_scope: event.target_scope || 'project_candidate',
          change_type: event.change_type || 'correction_policy',
          rationale: event.rationale,
          payload: event.payload || {},
          event_id: event.event_id,
          ts: event.ts,
        },
      ].slice(-8);
    } else if (event.event_type === 'merge_proposal_decision') {
      const decision = normalizeMergeProposalDecision(event.decision || event.status || '');
      const status = decision === 'reject' ? 'rejected' : decision === 'approve' ? 'accepted' : normalizeMergeProposalStatus(event.status || 'pending');
      const proposalEventId = clean(event.proposal_event_id);
      const sourceEventId = clean(event.source_event_id);
      let matchIndex = -1;
      for (let i = mergeProposals.length - 1; i >= 0; i -= 1) {
        const proposal = mergeProposals[i];
        if (proposalEventId && clean(proposal.event_id) === proposalEventId) {
          matchIndex = i;
          break;
        }
        if (!proposalEventId && sourceEventId && clean(proposal.source_event_id) === sourceEventId) {
          matchIndex = i;
          break;
        }
      }
      const patch = {
        status,
        decision: decision || undefined,
        decided_at: event.decided_at || event.ts,
        decided_by: event.decided_by || event.user_id,
        decision_reason: event.decision_reason || event.rationale,
        decision_event_id: event.event_id,
      };
      if (matchIndex >= 0) {
        mergeProposals = mergeProposals.map((proposal, index) => (index === matchIndex ? { ...proposal, ...patch } : proposal)).slice(-8);
      } else {
        mergeProposals = [
          ...mergeProposals,
          {
            summary: event.summary || `Merge proposal ${status}`,
            proposal_kind: event.proposal_kind || 'memory',
            source_event_id: event.source_event_id,
            target_scope: event.target_scope || 'project_candidate',
            change_type: event.change_type || 'correction_policy',
            rationale: event.rationale,
            payload: event.payload || {},
            event_id: proposalEventId || event.event_id,
            ts: event.ts,
            ...patch,
          },
        ].slice(-8);
      }
    } else if (event.event_type === 'merge_materialization_candidate_created') {
      materializationCandidates = [
        ...materializationCandidates,
        {
          materialization_id: event.materialization_id || event.payload?.materialization_id || `materialization:${event.proposal_event_id || event.source_event_id || event.event_id}`,
          summary: event.summary || event.payload?.branch_change?.summary || 'Memory materialization candidate',
          status: normalizeMergeProposalStatus(event.status || 'candidate'),
          proposal_kind: event.proposal_kind || 'memory',
          source_event_id: event.source_event_id,
          proposal_event_id: event.proposal_event_id,
          target_scope: event.target_scope || 'project_candidate',
          change_type: event.change_type || 'companion_correction_policy',
          branch_id: event.branch_id || event.payload?.branch_change?.branch_id,
          merge_request_id: event.merge_request_id || event.payload?.merge_request?.merge_request_id,
          canonical_write_enabled: Boolean(event.payload?.canonical_write_enabled),
          payload: event.payload || {},
          event_id: event.event_id,
          ts: event.ts,
        },
      ].slice(-8);
    } else if (event.event_type === 'companion_council_decision') {
      recentCouncils = [
        ...recentCouncils,
        {
          council_id: event.council_id || event.payload?.council_id || event.event_id,
          question: event.council_question || event.payload?.question || '',
          summary: event.summary || event.payload?.decision || 'Room decision recorded',
          companions: Array.isArray(event.payload?.companions) ? event.payload.companions : [],
          turns: Array.isArray(event.payload?.turns) ? event.payload.turns : [],
          event_id: event.event_id,
          ts: event.ts,
        },
      ].slice(-8);
    } else if (event.event_type === 'companion_memory_exchange_proposed') {
      memoryExchangeProposals = [
        ...memoryExchangeProposals,
        {
          summary: event.summary || event.memory_summary || 'Companion memory exchange proposal',
          memory_summary: event.memory_summary || event.payload?.memory_summary || event.summary || '',
          status: normalizeMergeProposalStatus(event.status || 'pending'),
          from_companion_id: event.from_companion_id || event.payload?.from_companion_id,
          to_companion_id: event.to_companion_id || event.payload?.to_companion_id,
          exchange_reason: event.exchange_reason || event.payload?.exchange_reason || event.rationale,
          council_id: event.council_id || event.payload?.council_id,
          payload: event.payload || {},
          event_id: event.event_id,
          ts: event.ts,
        },
      ].slice(-8);
    } else if (event.event_type === 'room_idle_memory_observation_proposed') {
      const candidateId = clean(event.payload?.candidate_id || event.payload?.candidateId || event.event_id);
      if (!idleMemoryObservations.some((row) => clean(row.candidate_id || row.event_id) === candidateId)) {
        idleMemoryObservations = [
          ...idleMemoryObservations,
          {
            candidate_id: candidateId,
            summary: event.summary || event.memory_summary || event.payload?.memory_summary || 'Idle memory observation candidate',
            memory_summary: event.memory_summary || event.payload?.memory_summary || event.summary || '',
            observation_type: event.payload?.observation_type || event.payload?.observationType || 'room_memory_observation',
            status: normalizeMergeProposalStatus(event.status || 'pending'),
            target_companion_ids: Array.isArray(event.payload?.target_companion_ids) ? event.payload.target_companion_ids : [],
            source_turn_id: event.payload?.source_turn_id || event.payload?.sourceTurnId,
            source_quote: event.payload?.source_quote || event.payload?.sourceQuote,
            generated_during_idle: event.payload?.generated_during_idle !== false,
            canonical_write_enabled: Boolean(event.payload?.canonical_write_enabled),
            rationale: event.rationale || event.payload?.rationale,
            payload: event.payload || {},
            event_id: event.event_id,
            ts: event.ts,
          },
        ].slice(-12);
      }
    } else if (event.event_type === 'companion_memory_exchange_decision') {
      const decision = normalizeMergeProposalDecision(event.decision || event.status || '');
      const status = decision === 'reject' ? 'rejected' : decision === 'approve' ? 'accepted' : normalizeMergeProposalStatus(event.status || 'pending');
      const targetEventId = clean(event.proposal_event_id || event.source_event_id || event.payload?.proposal_event_id || event.payload?.source_event_id);
      const patch = {
        status,
        decision: decision || undefined,
        decided_at: event.decided_at || event.ts,
        decided_by: event.decided_by || event.user_id,
        decision_reason: event.decision_reason || event.rationale,
        decision_event_id: event.event_id,
      };
      let matchIndex = -1;
      for (let i = memoryExchangeProposals.length - 1; i >= 0; i -= 1) {
        if (targetEventId && clean(memoryExchangeProposals[i].event_id) === targetEventId) {
          matchIndex = i;
          break;
        }
      }
      if (matchIndex >= 0) {
        memoryExchangeProposals = memoryExchangeProposals.map((proposal, index) => (index === matchIndex ? { ...proposal, ...patch } : proposal)).slice(-8);
      } else {
        memoryExchangeProposals = [
          ...memoryExchangeProposals,
          {
            summary: event.summary || `Memory exchange ${status}`,
            memory_summary: event.memory_summary || event.payload?.memory_summary || '',
            from_companion_id: event.from_companion_id || event.payload?.from_companion_id,
            to_companion_id: event.to_companion_id || event.payload?.to_companion_id,
            exchange_reason: event.exchange_reason || event.payload?.exchange_reason || event.rationale,
            event_id: targetEventId || event.event_id,
            ts: event.ts,
            payload: event.payload || {},
            ...patch,
          },
        ].slice(-8);
      }
    }
  }

  const activeCompanion = getRoomCompanionProfile(activeCompanionId);
  return {
    kind: 'room_companion_state_v1',
    active_companion: activeCompanion,
    context_controls: {
      mode: contextMode,
      clean_slate: cleanSlate,
      excluded_sources: excludedSources,
    },
    agent_mode: agentMode,
    recent_corrections: recentCorrections,
    merge_proposals: mergeProposals,
    materialization_candidates: materializationCandidates,
    recent_councils: recentCouncils,
    memory_exchange_proposals: memoryExchangeProposals,
    idle_memory_observations: idleMemoryObservations,
    request_repair_policy: agentMode === 'strict'
      ? 'Ask before acting on medium/high-risk ambiguity; never use excluded sources.'
      : 'Low-risk ambiguity: proceed with explicit assumptions. High-risk ambiguity: ask before acting. Never use excluded sources.',
    event_count: rows.length,
    updated_at: rows.length ? rows[rows.length - 1].ts : undefined,
  };
}


export function classifyRoomCorrectionIntent(text = '') {
  const raw = clean(text);
  const lower = raw.toLowerCase();
  const temporaryPatterns = [
    '이번', '이번엔', '지금은', '지금만', '이 턴', '이번 작업', '이번 패치', 'this time', 'for now', 'only this', 'this turn', 'temporary',
  ];
  const durablePatterns = [
    '앞으로', '항상', '절대', '다시는', '반복', '계속', '다음부터', 'whenever', 'from now', 'next time', 'always', 'never', 'do not', "don't", 'means', 'when i say', 'if i say',
  ];
  const hardPatterns = [
    '절대', 'never', 'do not', "don't", 'must not', '금지', '하지 마', '하지말', '용납',
  ];
  const isTemporary = temporaryPatterns.some((p) => lower.includes(p));
  const isDurable = !isTemporary && durablePatterns.some((p) => lower.includes(p));
  const isHard = hardPatterns.some((p) => lower.includes(p));
  return {
    text: raw,
    correction_scope: isDurable ? 'project_candidate' : 'room',
    promotion_status: isDurable ? 'proposal_recommended' : 'candidate',
    should_create_merge_proposal: Boolean(raw && isDurable),
    target_scope: isHard ? 'project_workflow_rule_candidate' : 'project_preference_candidate',
    durability: isDurable ? 'durable_likely' : 'room_local_or_task_specific',
    risk_level: isHard ? 'high' : isDurable ? 'medium' : 'low',
    rationale: isTemporary
      ? 'Looks task-specific or temporary; keep it room-local unless the user promotes it.'
      : isDurable
        ? 'Looks like a durable correction; create a reviewable merge proposal, but do not silently promote it.'
        : 'No durable signal detected; keep it as a room-local correction.',
  };
}

export function hasMergeProposalForCorrection(state = {}, correctionEventId = '') {
  const id = clean(correctionEventId);
  if (!id) return false;
  return (Array.isArray(state?.merge_proposals) ? state.merge_proposals : []).some((proposal) => clean(proposal.source_event_id) === id && normalizeMergeProposalStatus(proposal.status || 'pending') !== 'rejected');
}

export function buildCorrectionMergeProposalEvent({ correction = null, correctionText = '', state = null, force = false } = {}) {
  const text = correctionText || correction?.text || correction?.correction_text || '';
  const intent = classifyRoomCorrectionIntent(text);
  if (!force && !intent.should_create_merge_proposal) return null;
  const sourceEventId = correction?.event_id || correction?.eventId || '';
  if (hasMergeProposalForCorrection(state, sourceEventId)) return null;
  return {
    event_type: 'merge_proposal_created',
    proposal_kind: 'memory',
    change_type: 'companion_correction_policy',
    target_scope: intent.target_scope,
    source_event_id: sourceEventId || undefined,
    status: 'pending',
    summary: clip(`Promote correction: ${intent.text}`, 480),
    rationale: intent.rationale,
    payload: {
      correction_text: intent.text,
      correction_durability: intent.durability,
      correction_risk_level: intent.risk_level,
      review_required: true,
      silent_promotion: false,
    },
  };
}

export function selectRoomCompanionMergeProposal({ state = null, target = 'latest', includeDecided = false } = {}) {
  const proposals = Array.isArray(state?.merge_proposals) ? state.merge_proposals : [];
  if (!proposals.length) return null;
  const displayed = proposals.slice(-8);
  const rawTarget = clean(target || 'latest').toLowerCase();
  if (rawTarget === 'latest' || rawTarget === 'last' || !rawTarget) {
    for (let i = proposals.length - 1; i >= 0; i -= 1) {
      const proposal = proposals[i];
      if (includeDecided || normalizeMergeProposalStatus(proposal.status || 'pending') === 'pending') {
        return { proposal, index: i, display_index: displayed.indexOf(proposal) };
      }
    }
    return null;
  }
  const displayIndex = Math.max(0, Number(rawTarget) - 1);
  if (!Number.isFinite(displayIndex) || displayIndex < 0 || displayIndex >= displayed.length) return null;
  const proposal = displayed[displayIndex];
  if (!includeDecided && normalizeMergeProposalStatus(proposal.status || 'pending') !== 'pending') return null;
  return { proposal, index: proposals.indexOf(proposal), display_index: displayIndex };
}

export function buildRoomCompanionMergeProposalDecisionEvent({ proposal = null, state = null, target = 'latest', decision = 'approve', reason = '', decidedBy = '', userId = '' } = {}) {
  const normalizedDecision = normalizeMergeProposalDecision(decision);
  if (!normalizedDecision) return null;
  const resolved = proposal ? { proposal } : selectRoomCompanionMergeProposal({ state, target, includeDecided: false });
  const selected = resolved?.proposal;
  if (!selected || normalizeMergeProposalStatus(selected.status || 'pending') !== 'pending') return null;
  const status = normalizedDecision === 'reject' ? 'rejected' : 'accepted';
  const actor = clean(decidedBy || userId);
  const reasonText = clip(reason || (normalizedDecision === 'reject'
    ? 'User explicitly rejected this companion merge proposal.'
    : 'User explicitly approved this companion merge proposal.'), 500);
  return {
    event_type: 'merge_proposal_decision',
    proposal_kind: selected.proposal_kind || 'memory',
    change_type: selected.change_type || 'companion_correction_policy',
    target_scope: selected.target_scope || 'project_candidate',
    source_event_id: selected.source_event_id,
    proposal_event_id: selected.event_id,
    status,
    decision: normalizedDecision,
    decided_by: actor || undefined,
    decision_reason: reasonText,
    summary: clip(`${status === 'accepted' ? 'Accept' : 'Reject'} proposal: ${selected.summary || 'merge proposal'}`, 480),
    rationale: reasonText,
    payload: {
      proposal_event_id: selected.event_id,
      proposal_summary: selected.summary || 'merge proposal',
      decision: normalizedDecision,
      decision_status: status,
      review_required: true,
      silent_promotion: false,
      materialized_project_write: false,
    },
  };
}


function materializationCandidateIdForProposal(proposal = {}) {
  const key = clean(proposal.event_id || proposal.proposal_event_id || proposal.source_event_id || proposal.summary || 'proposal');
  return `companion_materialization_${tinyHash(key)}`;
}

export function hasMaterializationCandidateForProposal(state = {}, proposalEventId = '') {
  const id = clean(proposalEventId);
  if (!id) return false;
  return (Array.isArray(state?.materialization_candidates) ? state.materialization_candidates : []).some((candidate) => clean(candidate.proposal_event_id) === id);
}

export function buildRoomCompanionMaterializationCandidateEvent({ proposal = null, state = null, proposalEventId = '', userId = '' } = {}) {
  const proposals = Array.isArray(state?.merge_proposals) ? state.merge_proposals : [];
  const id = clean(proposalEventId || proposal?.event_id || proposal?.proposal_event_id || '');
  const selected = proposal || [...proposals].reverse().find((row) => {
    if (normalizeMergeProposalStatus(row.status || 'pending') !== 'accepted') return false;
    if (!id) return true;
    return clean(row.event_id) === id || clean(row.proposal_event_id) === id;
  });
  if (!selected || normalizeMergeProposalStatus(selected.status || 'pending') !== 'accepted') return null;
  if (hasMaterializationCandidateForProposal(state, selected.event_id || selected.proposal_event_id)) return null;
  const materializationId = materializationCandidateIdForProposal(selected);
  const branchId = `branch:companion_correction:${tinyHash(selected.event_id || selected.source_event_id || selected.summary)}`;
  const changeId = `room_change:${tinyHash(`${selected.source_event_id || ''}:${selected.summary || ''}`)}:companion_memory`;
  const targetScope = selected.target_scope || 'project_candidate';
  const correctionText = selected.payload?.correction_text || selected.correction_text || clean(String(selected.summary || '').replace(/^Promote correction:\s*/i, ''));
  const branchChange = {
    kind: 'branchable_room_change_v1',
    change_id: changeId,
    branch_id: branchId,
    change_type: selected.change_type || 'companion_correction_policy',
    target: `project_memory/${targetScope}`,
    scope: targetScope,
    summary: selected.summary || 'Accepted companion correction for project-memory review.',
    value: {
      correction_text: correctionText,
      source_correction_event_id: selected.source_event_id || undefined,
      source_proposal_event_id: selected.event_id || undefined,
      accepted_at: selected.decided_at || selected.ts || undefined,
      accepted_by: selected.decided_by || userId || undefined,
    },
    evidence_refs: dedupeList([selected.source_event_id, selected.event_id, selected.decision_event_id], 8),
    risk_tags: ['companion_correction', 'project_memory', 'reviewed_merge_candidate'],
    depends_on: [],
    conflicts_with: [],
    status: 'review_candidate',
    canonical_write_enabled: false,
  };
  const mergeRequest = {
    kind: 'branchable_room_merge_request_v1',
    merge_request_id: `mr:${changeId}`,
    source_branch_id: branchId,
    target_branch_id: 'project_memory_main',
    candidate_changes: [changeId],
    merge_mode: 'reviewed_partial',
    requires_review: true,
    recommended_policy: 'B3_governed_partial_merge',
    status: 'pending_materialization_review',
  };
  return {
    event_type: 'merge_materialization_candidate_created',
    proposal_kind: selected.proposal_kind || 'memory',
    change_type: selected.change_type || 'companion_correction_policy',
    target_scope: targetScope,
    source_event_id: selected.source_event_id,
    proposal_event_id: selected.event_id || selected.proposal_event_id,
    status: 'candidate',
    materialization_id: materializationId,
    branch_id: branchId,
    merge_request_id: mergeRequest.merge_request_id,
    summary: clip(`Materialization candidate: ${selected.summary || 'accepted companion merge proposal'}`, 480),
    rationale: 'Accepted companion merge proposal was converted into a branchable RoomChange candidate. Canonical project-memory write remains disabled until a separate materialization review.',
    payload: {
      kind: 'room_companion_materialization_candidate_v1',
      materialization_id: materializationId,
      source_proposal_event_id: selected.event_id || selected.proposal_event_id,
      source_correction_event_id: selected.source_event_id,
      materialization_boundary: 'branch_overlay_shadow_only',
      canonical_write_enabled: false,
      materialized_project_write: false,
      raw_memory_retained: true,
      generated_code_execution: false,
      branch_change: branchChange,
      merge_request: mergeRequest,
      loop_projection_hint: {
        policy: 'room_native_recompile_after_branch_merge',
        scope: 'active_room_loop',
        action: 'recompile_loop_projection_after_reviewed_branch_merge',
        direct_loop_state_mutation: false,
      },
      safety: {
        safe_automatic_steps: ['branch_change_candidate', 'merge_request_preview', 'projection_hint'],
        approval_required_for: ['canonical_project_memory_write', 'cross_room_memory_share', 'loop_state_mutation', 'raw_memory_deletion'],
      },
    },
  };
}

export function formatRoomCompanionMaterializationCandidatesForTelegram(state = null) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const candidates = Array.isArray(s.materialization_candidates) ? s.materialization_candidates.slice(-8) : [];
  if (!candidates.length) return 'No companion materialization candidates yet. Approve a proposal first with /correct approve latest.';
  const lines = ['Companion materialization candidates'];
  candidates.forEach((candidate, index) => {
    const payload = candidate.payload || {};
    const branchChange = payload.branch_change || {};
    const mergeRequest = payload.merge_request || {};
    lines.push('', `${index + 1}. ${candidate.summary || 'materialization candidate'}`);
    lines.push(`   status: ${candidate.status || 'candidate'}`);
    lines.push(`   materialization_boundary: ${payload.materialization_boundary || 'branch_overlay_shadow_only'}`);
    lines.push(`   branch_change: ${branchChange.change_id || '-'}`);
    lines.push(`   merge_request: ${mergeRequest.merge_request_id || candidate.merge_request_id || '-'}`);
    lines.push(`   target_scope: ${candidate.target_scope || 'project_candidate'}`);
    lines.push(`   canonical_write_enabled: ${payload.canonical_write_enabled ? 'true' : 'false'}`);
  });
  lines.push('', 'Next: review the branchable RoomChange before enabling any canonical project-memory write path. This preview does not mutate project memory.');
  return lines.join('\n');
}

export function formatRoomCompanionMergeProposalsForTelegram(state = null) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const proposals = Array.isArray(s.merge_proposals) ? s.merge_proposals.slice(-8) : [];
  if (!proposals.length) return 'No companion merge proposals.';
  const counts = proposals.reduce((acc, proposal) => {
    const status = normalizeMergeProposalStatus(proposal.status || 'pending');
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const lines = [
    'Companion merge proposals',
    `pending: ${counts.pending || 0}; accepted: ${counts.accepted || 0}; rejected: ${counts.rejected || 0}`,
  ];
  proposals.forEach((proposal, index) => {
    lines.push('', `${index + 1}. ${proposal.summary || 'merge proposal'}`);
    lines.push(`   status: ${normalizeMergeProposalStatus(proposal.status || 'pending')}`);
    lines.push(`   target_scope: ${proposal.target_scope || 'project_candidate'}`);
    if (proposal.source_event_id) lines.push(`   source_correction: ${proposal.source_event_id}`);
    if (proposal.decided_at) lines.push(`   decided_at: ${proposal.decided_at}`);
    if (proposal.decided_by) lines.push(`   decided_by: ${proposal.decided_by}`);
    if (proposal.decision_reason) lines.push(`   decision_reason: ${proposal.decision_reason}`);
    if (proposal.rationale && !proposal.decision_reason) lines.push(`   rationale: ${proposal.rationale}`);
  });
  lines.push(
    '',
    '명시 승인/거절:',
    '- /correct approve latest 또는 /correct approve <number>',
    '- /correct reject latest [reason] 또는 /correct reject <number> [reason]',
    '',
    '승인/거절은 companion event log에 기록됩니다. accepted proposal은 branchable materialization candidate로만 연결되며, 별도 review 없이는 canonical project write를 하지 않습니다.',
  );
  return lines.join('\n');
}

export function formatRoomCompanionListForTelegram() {
  const lines = [
    '🏠 DdalGgak Companion Room',
    'Telegram은 단순 transport가 아니라 이 evolving companion room의 front door입니다.',
    '각 companion은 role-specific memory boundary를 갖고, 필요할 때 visible backchannel에서 조율합니다.',
    '',
    'Companion roster:',
  ];
  for (const profile of listRoomCompanions()) {
    lines.push('', `${profile.id} — ${profile.label}`, `  role: ${profile.purpose}`);
    lines.push(`  memory boundary: ${(profile.memory_connections || []).map((conn) => `${conn.source}:${conn.mode}/${conn.strictness}`).join(', ') || '-'}`);
    lines.push(`  excluded by default: ${(profile.excluded_by_default || []).join(', ') || '-'}`);
  }
  lines.push(
    '',
    'Room-governed commands:',
    '- /c <message> — ask the room through the active companion/concierge',
    '- /council ask <message> — companion들이 먼저 visible backchannel에서 짧게 조율',
    '- /council log — 최근 council transcript 보기',
    '- /council proposals — companion 간 memory exchange proposal 보기',
    '- /council approve latest|<number> 또는 /council reject latest|<number> [reason]',
    '- /companion switch <id> · /companion profile',
    '- /context project-only|clean-slate|exclude <source>|reset',
    '- /correct <correction> · /correct proposals',
  );
  return lines.join('\n');
}

export function formatRoomCompanionProfileForTelegram(state = null) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const profile = s.active_companion || getRoomCompanionProfile('research');
  const lines = [
    `${profile.label} (${profile.id})`,
    `purpose: ${profile.purpose}`,
    `agent_mode: ${s.agent_mode || profile.agent_mode || 'balanced'}`,
    `clarification_policy: ${profile.clarification_policy || '-'}`,
    `action_policy: ${profile.action_policy || '-'}`,
    `branch_policy: ${profile.branch_policy || '-'}`,
    '',
    'memory connections:',
    ...profile.memory_connections.map((conn) => `- ${conn.source}: ${conn.mode}; strictness=${conn.strictness}`),
    '',
    `excluded by default: ${(profile.excluded_by_default || []).join(', ') || '-'}`,
    '',
    'context controls:',
    `- mode: ${s.context_controls?.mode || 'default'}`,
    `- clean_slate: ${s.context_controls?.clean_slate ? 'true' : 'false'}`,
    `- excluded_sources: ${(s.context_controls?.excluded_sources || []).join(', ') || '-'}`,
  ];
  const corrections = Array.isArray(s.recent_corrections) ? s.recent_corrections.slice(-5) : [];
  if (corrections.length) {
    lines.push('', 'recent corrections:');
    corrections.forEach((correction, index) => lines.push(`${index + 1}. ${correction.text} (${correction.promotion_status || 'candidate'})`));
  }
  const proposals = Array.isArray(s.merge_proposals) ? s.merge_proposals.slice(-5) : [];
  if (proposals.length) {
    lines.push('', 'merge proposals:');
    proposals.forEach((proposal, index) => lines.push(`${index + 1}. ${proposal.summary || 'merge proposal'} (${proposal.status || 'pending'}; ${proposal.target_scope || 'project_candidate'})`));
  }
  return lines.join('\n');
}


function normalizeCouncilRole(value = '') {
  return clean(value).toLowerCase().replace(/^@+/, '').replace(/[^a-z0-9가-힣_-]+/g, '_').replace(/^_+|_+$/g, '');
}

function companionIdForRoomRole(role = '') {
  const key = normalizeCouncilRole(role);
  if (!key) return '';
  const tokens = new Set(key.split(/[_-]+/).filter(Boolean));
  if (tokens.has('risk') || tokens.has('critic') || tokens.has('reviewer') || tokens.has('verifier') || tokens.has('검토') || tokens.has('리뷰어')) return 'critic';
  if (tokens.has('builder') || tokens.has('implementation') || tokens.has('implementer') || tokens.has('code') || tokens.has('developer')) return 'implementation';
  if (tokens.has('product') || tokens.has('ux') || tokens.has('planner') || tokens.has('synthesizer') || tokens.has('manager')) return 'product';
  if (tokens.has('personal') || tokens.has('preference') || tokens.has('context') || tokens.has('history') || tokens.has('tracker')) return 'personal';
  if (tokens.has('research') || tokens.has('researcher') || tokens.has('scout') || tokens.has('analyst') || tokens.has('paper') || tokens.has('market')) return 'research';
  return '';
}

export function selectRoomCouncilCompanions({ question = '', state = null, roomProfile = null, maxCompanions = 4 } = {}) {
  const ordered = [];
  const add = (id) => {
    const cleanId = normalizeCompanionId(id);
    if (cleanId && DEFAULT_ROOM_COMPANIONS[cleanId] && !ordered.includes(cleanId)) ordered.push(cleanId);
  };
  const activeId = normalizeCompanionId(state?.active_companion?.id || '') || '';
  if (activeId && activeId !== 'concierge') add(activeId);
  const roomRoles = Array.isArray(roomProfile?.default_agents || roomProfile?.defaultAgents || roomProfile?.agent_roles)
    ? (roomProfile.default_agents || roomProfile.defaultAgents || roomProfile.agent_roles)
    : [];
  for (const role of roomRoles) add(companionIdForRoomRole(role));
  add('critic');
  add('concierge');
  if (ordered.length < 2) add('product');
  return ordered
    .slice(0, Math.max(2, Math.min(5, Number(maxCompanions) || 4)))
    .map(getRoomCompanionProfile);
}

function buildCouncilTurnSummary({ companion = null, question = '', roomLabel = '', roomProfile = null } = {}) {
  const profile = companion || getRoomCompanionProfile('concierge');
  const room = roomLabel || 'this Telegram doorway room';
  const memoryBoundary = (profile.memory_connections || []).map((conn) => `${conn.source}:${conn.mode}/${conn.strictness}`).join(', ') || 'room-scoped memory only';
  const roles = Array.isArray(roomProfile?.default_agents) && roomProfile.default_agents.length ? roomProfile.default_agents.join(', ') : 'adaptive room roster';
  return `${profile.label}: ${room}의 현재 room roles(${roles})와 ${memoryBoundary} boundary 안에서만 근거·선호·위험을 점검합니다. 이 turn은 고정 prompt 분류가 아니라 visible coordination note이며, 실제 memory 변경은 /inbox approval이 필요합니다.`;
}

function buildCouncilDecision({ question = '', turns = [], roomProfile = null } = {}) {
  const roomName = clean(roomProfile?.name || roomProfile?.room_name || roomProfile?.current_goal || roomProfile?.goal || '') || 'this room';
  const companionLabels = (Array.isArray(turns) ? turns : []).map((turn) => turn.label).filter(Boolean).join(', ') || 'selected companions';
  return `${roomName}: ${companionLabels}가 room boundary 안에서 조율했습니다. 다음 응답은 최신 사용자 요청을 기준으로 하되, room profile·승인된 memory·pending /inbox decisions를 분리해서 다루세요.`;
}

export function buildCompanionCouncilSession({ question = '', state = null, roomProfile = null, chatId = '', userId = '' } = {}) {
  const q = clip(question, 900);
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const roomLabel = clean(roomProfile?.name || roomProfile?.room_name || roomProfile?.current_goal || roomProfile?.goal || '') || 'this Telegram doorway room';
  const councilId = `council_${tinyHash(`${chatId}\n${userId}\n${q}\n${new Date().toISOString().slice(0, 16)}`)}`;
  const companions = selectRoomCouncilCompanions({ question: q, state: s, roomProfile });
  const turns = companions.map((companion, index) => ({
    companion_id: companion.id,
    label: companion.label,
    summary: buildCouncilTurnSummary({ companion, question: q, roomLabel, roomProfile }),
    turn_index: index + 1,
  }));
  const decision = buildCouncilDecision({ question: q, turns, roomProfile });
  const latestIdleCandidate = (Array.isArray(s.idle_memory_observations) ? s.idle_memory_observations : [])
    .slice().reverse().find((row) => normalizeMergeProposalStatus(row.status || 'pending') === 'pending');
  const exchangeProposal = latestIdleCandidate ? {
    from_companion_id: Array.isArray(latestIdleCandidate.target_companion_ids) && latestIdleCandidate.target_companion_ids.includes('personal') ? 'personal' : 'concierge',
    to_companion_id: Array.isArray(latestIdleCandidate.target_companion_ids) && latestIdleCandidate.target_companion_ids.includes('critic') ? 'critic' : 'concierge',
    summary: clip(`Review cross-companion sharing for idle memory candidate: ${latestIdleCandidate.memory_summary || latestIdleCandidate.summary}`, 500),
    memory_summary: clip(latestIdleCandidate.memory_summary || latestIdleCandidate.summary || '', 700),
    exchange_reason: 'A pending idle-structured memory observation may be useful to another companion. User approval is required before cross-companion sharing.',
  } : null;
  const now = new Date().toISOString();
  const events = [
    {
      event_type: 'companion_council_started',
      council_id: councilId,
      council_question: q,
      status: 'started',
      summary: `Council opened for: ${clip(q, 160)}`,
      source: 'telegram_council_command',
      payload: { council_id: councilId, question: q, companions: companions.map((c) => c.id), room_label: roomLabel },
    },
    ...turns.map((turn) => ({
      event_type: 'companion_council_turn',
      council_id: councilId,
      council_question: q,
      companion_id: turn.companion_id,
      turn_index: turn.turn_index,
      summary: turn.summary,
      source: 'telegram_council_command',
      payload: { council_id: councilId, question: q, ...turn },
    })),
    {
      event_type: 'companion_council_decision',
      council_id: councilId,
      council_question: q,
      status: 'accepted',
      summary: decision,
      source: 'telegram_council_command',
      payload: { council_id: councilId, question: q, decision, companions: companions.map((c) => c.id), turns, created_at: now },
    },
  ];
  if (exchangeProposal) {
    events.push({
      event_type: 'companion_memory_exchange_proposed',
      council_id: councilId,
      council_question: q,
      from_companion_id: exchangeProposal.from_companion_id,
      to_companion_id: exchangeProposal.to_companion_id,
      status: 'pending',
      summary: exchangeProposal.summary,
      memory_summary: exchangeProposal.memory_summary,
      exchange_reason: exchangeProposal.exchange_reason,
      source: 'telegram_council_command',
      payload: { council_id: councilId, question: q, ...exchangeProposal, approval_required: true },
    });
  }
  const lines = [
    '🧭 Companion Council',
    'visible backchannel · 사용자가 볼 수 있는 room-level coordination입니다.',
    '',
    `Question: ${q || '(empty)'}`,
  ];
  for (const turn of turns) {
    lines.push('', `${turn.label}:`, turn.summary);
  }
  lines.push('', 'Room decision:', decision);
  if (exchangeProposal) {
    lines.push(
      '',
      '📥 Memory exchange proposal created',
      `${getRoomCompanionProfile(exchangeProposal.from_companion_id).label} → ${getRoomCompanionProfile(exchangeProposal.to_companion_id).label}`,
      exchangeProposal.summary,
      'Approve/reject: /council approve latest · /council reject latest <reason>',
    );
  }
  lines.push('', '다음: /council log · /inbox · /c <next action>');
  return { council_id: councilId, companions, turns, decision, exchange_proposal: exchangeProposal, events, text: lines.join('\n') };
}

export function formatRoomCompanionCouncilLogForTelegram(state = null) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const councils = Array.isArray(s.recent_councils) ? s.recent_councils.slice(-5) : [];
  if (!councils.length) return 'No companion council transcript yet. Try: /council ask <message>';
  const lines = ['🧭 Recent Companion Councils'];
  councils.forEach((council, index) => {
    lines.push('', `${index + 1}. ${council.question || '(no question)'}`);
    lines.push(`   decision: ${council.summary || '-'}`);
    const labels = (Array.isArray(council.companions) ? council.companions : []).map((id) => getRoomCompanionProfile(id).label).join(', ');
    if (labels) lines.push(`   companions: ${labels}`);
  });
  return lines.join('\n');
}

export function formatRoomCompanionMemoryExchangeProposalsForTelegram(state = null) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const proposals = Array.isArray(s.memory_exchange_proposals) ? s.memory_exchange_proposals.slice(-8) : [];
  if (!proposals.length) return 'No companion memory exchange proposals yet.';
  const pending = proposals.filter((p) => normalizeMergeProposalStatus(p.status || 'pending') === 'pending').length;
  const lines = ['Companion memory exchange proposals', `pending: ${pending}; total shown: ${proposals.length}`];
  proposals.forEach((proposal, index) => {
    const from = getRoomCompanionProfile(proposal.from_companion_id || 'personal');
    const to = getRoomCompanionProfile(proposal.to_companion_id || 'critic');
    lines.push('', `${index + 1}. ${proposal.summary || proposal.memory_summary || 'memory exchange proposal'}`);
    lines.push(`   status: ${normalizeMergeProposalStatus(proposal.status || 'pending')}`);
    lines.push(`   route: ${from.label} → ${to.label}`);
    if (proposal.exchange_reason) lines.push(`   reason: ${proposal.exchange_reason}`);
    if (proposal.decided_at) lines.push(`   decided_at: ${proposal.decided_at}`);
    if (proposal.decision_reason) lines.push(`   decision_reason: ${proposal.decision_reason}`);
  });
  lines.push('', '처리:', '- /council approve latest 또는 /council approve <number>', '- /council reject latest [reason] 또는 /council reject <number> [reason]');
  return lines.join('\n');
}

export function selectRoomCompanionMemoryExchangeProposal({ state = null, target = 'latest', includeDecided = false } = {}) {
  const proposals = Array.isArray(state?.memory_exchange_proposals) ? state.memory_exchange_proposals : [];
  if (!proposals.length) return null;
  const displayed = proposals.slice(-8);
  const rawTarget = clean(target || 'latest').toLowerCase();
  if (rawTarget === 'latest' || rawTarget === 'last' || !rawTarget) {
    for (let i = proposals.length - 1; i >= 0; i -= 1) {
      const proposal = proposals[i];
      if (includeDecided || normalizeMergeProposalStatus(proposal.status || 'pending') === 'pending') return { proposal, index: i, display_index: displayed.indexOf(proposal) };
    }
    return null;
  }
  const n = Number.parseInt(rawTarget, 10);
  if (!Number.isFinite(n) || n < 1 || n > displayed.length) return null;
  const proposal = displayed[n - 1];
  if (!proposal) return null;
  if (!includeDecided && normalizeMergeProposalStatus(proposal.status || 'pending') !== 'pending') return null;
  return { proposal, index: proposals.indexOf(proposal), display_index: n - 1 };
}

export function buildRoomCompanionMemoryExchangeDecisionEvent({ proposal = null, decision = '', reason = '', userId = '' } = {}) {
  const normalizedDecision = normalizeMergeProposalDecision(decision);
  if (!proposal || !normalizedDecision) return null;
  const status = normalizedDecision === 'approve' ? 'accepted' : 'rejected';
  return {
    event_type: 'companion_memory_exchange_decision',
    proposal_event_id: proposal.event_id,
    council_id: proposal.council_id,
    from_companion_id: proposal.from_companion_id,
    to_companion_id: proposal.to_companion_id,
    status,
    decision: normalizedDecision,
    decided_by: userId || 'telegram_user',
    decided_at: new Date().toISOString(),
    decision_reason: clip(reason, 500) || undefined,
    summary: `${status}: ${proposal.summary || proposal.memory_summary || 'memory exchange proposal'}`,
    memory_summary: proposal.memory_summary,
    exchange_reason: proposal.exchange_reason,
    source: 'telegram_council_command',
    payload: {
      proposal_event_id: proposal.event_id,
      decision: normalizedDecision,
      status,
      reason: clip(reason, 500) || undefined,
      approval_boundary: 'cross_companion_memory_exchange',
      canonical_write_enabled: false,
    },
  };
}

export function formatRoomCompanionProjectionBlock({ state = null, maxChars = 1200 } = {}) {
  const s = state && typeof state === 'object' ? state : deriveRoomCompanionState({});
  const profile = s.active_companion || getRoomCompanionProfile('research');
  const lines = [
    '[ACTIVE AI COMPANION]',
    `id: ${profile.id}`,
    `label: ${profile.label}`,
    `purpose: ${profile.purpose}`,
    `agent_mode: ${s.agent_mode || profile.agent_mode || 'balanced'}`,
    `action_policy: ${profile.action_policy || 'draft_or_ask'}`,
    `clarification_policy: ${profile.clarification_policy || 'assume_low_risk_ask_high_risk'}`,
    `memory_connections: ${(profile.memory_connections || []).map((conn) => `${conn.source}:${conn.mode}/${conn.strictness}`).join(', ') || '-'}`,
    `excluded_by_default: ${(profile.excluded_by_default || []).join(', ') || '-'}`,
    '[CONTEXT CONTROLS]',
    `mode: ${s.context_controls?.mode || 'default'}`,
    `clean_slate: ${s.context_controls?.clean_slate ? 'true' : 'false'}`,
    `excluded_sources: ${(s.context_controls?.excluded_sources || []).join(', ') || '-'}`,
    `request_repair_policy: ${s.request_repair_policy}`,
  ];
  const corrections = Array.isArray(s.recent_corrections) ? s.recent_corrections.slice(-5) : [];
  if (corrections.length) {
    lines.push('[RECENT USER CORRECTIONS]');
    for (const correction of corrections) {
      lines.push(`- ${clip(correction.text, 220)} (scope=${correction.scope || 'room'}; promotion_status=${correction.promotion_status || 'candidate'})`);
    }
    lines.push('correction_policy: Apply explicit corrections in this room and avoid repeating the same avoidable mistake. Do not silently promote candidate corrections to project-shared memory.');
  }
  const proposals = Array.isArray(s.merge_proposals) ? s.merge_proposals.slice(-5) : [];
  const pendingProposals = proposals.filter((proposal) => normalizeMergeProposalStatus(proposal.status || 'pending') === 'pending');
  if (pendingProposals.length) {
    lines.push('[REVIEWABLE MEMORY MERGE PROPOSALS]');
    for (const proposal of pendingProposals) {
      lines.push(`- ${clip(proposal.summary || 'merge proposal', 220)} (status=pending; target_scope=${proposal.target_scope || 'project_candidate'})`);
    }
    lines.push(`merge_policy: Treat these as pending proposals only (${pendingProposals.length} pending proposals). Do not assume they are accepted project-shared memory until explicitly approved.`);
  }
  const materializationCandidates = Array.isArray(s.materialization_candidates) ? s.materialization_candidates.slice(-5) : [];
  if (materializationCandidates.length) {
    lines.push('[MEMORY MATERIALIZATION CANDIDATES]');
    for (const candidate of materializationCandidates) {
      const payload = candidate.payload || {};
      lines.push(`- ${clip(candidate.summary || 'materialization candidate', 220)} (boundary=${payload.materialization_boundary || 'branch_overlay_shadow_only'}; canonical_write_enabled=${payload.canonical_write_enabled ? 'true' : 'false'})`);
      if (payload.merge_request?.recommended_policy) lines.push(`  merge_policy: ${payload.merge_request.recommended_policy}`);
    }
    lines.push('materialization_policy: These are branchable RoomChange previews only. Do not mutate canonical project memory, cross-room memory, or loop state without an explicit materialization review.');
  }
  const idleCandidates = Array.isArray(s.idle_memory_observations) ? s.idle_memory_observations.slice(-5) : [];
  const pendingIdleCandidates = idleCandidates.filter((candidate) => normalizeMergeProposalStatus(candidate.status || 'pending') === 'pending');
  if (pendingIdleCandidates.length) {
    lines.push('[IDLE STRUCTURED MEMORY CANDIDATES]');
    for (const candidate of pendingIdleCandidates) {
      lines.push(`- ${clip(candidate.memory_summary || candidate.summary || 'idle memory observation', 220)} (status=pending; type=${candidate.observation_type || 'observation'}; canonical_write_enabled=false)`);
    }
    lines.push('idle_memory_policy: These were generated while the room was idle. Treat them as reviewable observations only; do not use them as accepted durable memory until approved/materialized.');
  }

  const decidedProposals = proposals.filter((proposal) => normalizeMergeProposalStatus(proposal.status || 'pending') !== 'pending');
  if (decidedProposals.length) {
    lines.push('[REVIEWED MEMORY MERGE DECISIONS]');
    for (const proposal of decidedProposals) {
      const status = normalizeMergeProposalStatus(proposal.status || 'pending');
      lines.push(`- ${clip(proposal.summary || 'merge proposal', 220)} (status=${status}; target_scope=${proposal.target_scope || 'project_candidate'}; decided_at=${proposal.decided_at || '-'})`);
      if (proposal.decision_reason) lines.push(`  decision_reason: ${clip(proposal.decision_reason, 220)}`);
    }
    lines.push('review_policy: Accepted decisions are explicit user-reviewed companion guidance in this room substrate; rejected decisions must not be treated as durable project-shared memory. Do not perform a separate project memory write unless a materialization step exists.');
  }
  return clip(lines.join('\n'), Math.max(420, Math.floor(Number(maxChars) || 1200)));
}
