function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 1000, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function uniqueStrings(values = [], { max = 32, lower = false } = {}) {
  const out = []; const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 200, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key); out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

const TOPOLOGY_CATALOG = [
  {
    id: 'sequential_handoff',
    title: 'Sequential handoff',
    best_for: ['well-specified tasks', 'small artifacts', 'low coordination risk'],
    risk: 'slow if every stage waits unnecessarily',
    graph: ['planner -> executor -> synthesizer'],
  },
  {
    id: 'reviewer_gated_pipeline',
    title: 'Reviewer-gated pipeline',
    best_for: ['code changes', 'research claims', 'artifact delivery', 'safety-sensitive decisions'],
    risk: 'review bottleneck; over-review for low-risk tasks',
    graph: ['planner -> builder -> reviewer -> verifier -> delivery'],
  },
  {
    id: 'visible_companion_council',
    title: 'Visible companion council',
    best_for: ['ambiguous preferences', 'tradeoff-heavy planning', 'user-facing decisions'],
    risk: 'can become verbose unless summarized into a room decision',
    graph: ['role companions -> council transcript -> room decision'],
  },
  {
    id: 'bounded_parallel_wccu_group',
    title: 'Bounded parallel group with witness checks',
    best_for: ['parallel research/build subtasks', 'workspace contention', 'multi-agent memory updates'],
    risk: 'requires explicit read/write witnesses and review-required handling',
    graph: ['agent A snapshot', 'agent B snapshot', 'WCCU-style verifier', 'policy lanes'],
  },
  {
    id: 'orchestrator_star',
    title: 'Orchestrator star',
    best_for: ['heterogeneous skill routing', 'many small specialists', 'tool-heavy tasks'],
    risk: 'orchestrator can become single point of failure',
    graph: ['orchestrator <-> specialist agents', 'orchestrator -> delivery'],
  },
];

function scoreTopology(topology, signals = {}) {
  let score = 0;
  const text = cleanText([signals.goal, signals.room_purpose, ...(signals.skills || []), ...(signals.memory_schema || [])].join(' '), { lower: true, maxLen: 3000 });
  if (topology.id === 'reviewer_gated_pipeline' && /code|patch|test|paper|claim|논문|코드|패치|검증|테스트/.test(text)) score += 4;
  if (topology.id === 'visible_companion_council' && /ambiguous|tradeoff|preference|선호|고민|결정|비교/.test(text)) score += 3;
  if (topology.id === 'bounded_parallel_wccu_group' && /loop|parallel|multi|agent|workspace|memory|동시|여러|메모리/.test(text)) score += 4;
  if (topology.id === 'orchestrator_star' && /skill|tool|api|search|browser|crawler|자동화|탐색/.test(text)) score += 3;
  if (topology.id === 'sequential_handoff') score += 1;
  if (signals.default_depth === 'loop' && topology.id !== 'sequential_handoff') score += 1;
  return score;
}

export function buildRoomTopologyLearningCard({ roomPackage = null, profile = null, events = [] } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const signals = {
    goal: prof.current_goal || pkg.description || '',
    room_purpose: prof.room_purpose || pkg.description || '',
    skills: pkg.skills || prof.installed_skills || [],
    memory_schema: asObject(pkg.memory_schema).object_types || asObject(prof.memory_schema).object_types || [],
    default_depth: pkg.default_depth || prof.default_depth || '',
    events_count: asArray(events).length,
  };
  const candidates = TOPOLOGY_CATALOG.map((topology) => ({ ...topology, score: scoreTopology(topology, signals) }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const primary = candidates[0] || TOPOLOGY_CATALOG[0];
  return {
    kind: 'room_topology_learning_card_v1',
    primary_topology: primary.id,
    candidates,
    learning_policy: {
      immediate_finetune: 'not recommended until trace labels are reliable',
      first_step: 'collect topology traces and outcome labels',
      model_role: 'train or tune a small router/evaluator after deterministic metrics and user feedback exist',
      durable_change_policy: 'trial mode first; durable topology changes require user or GoC approval',
    },
    dataset_schema: {
      special_tokens: ['<ROOM_INTENT>', '<PACKAGE>', '<MEMORY_GRAPH>', '<SKILL_SET>', '<TOPOLOGY>', '<WITNESS>', '<OUTCOME>', '<HUMAN_FEEDBACK>'],
      labels: ['topology_choice', 'skill_bundle_choice', 'memory_projection_quality', 'safe_commit_policy', 'user_acceptance'],
      metrics: ['task_completion', 'artifact_success', 'test_passed', 'correction_rate', 'stop_rate', 'review_required_rate', 'unsafe_claim_rate', 'latency', 'token_cost'],
    },
    guardrails: [
      'Do not let a trained router directly mutate room state.',
      'Use WCCU-style witnesses for memory, skill, topology, and package updates.',
      'Keep raw transcripts out of training exports unless explicitly approved and redacted.',
      'Evaluate candidate topology by replaying fixed traces, not by self-judgment alone.',
    ],
  };
}


function numberOrZero(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function hasAny(text = '', patterns = []) {
  const hay = cleanText(text, { lower: true, maxLen: 6000 });
  return patterns.some((pattern) => pattern.test(hay));
}

function flattenEventText(event = {}) {
  const row = asObject(event);
  const extra = asObject(row.extra);
  return cleanText([
    row.event_type,
    row.type,
    row.command,
    row.goal,
    row.recommendation,
    extra.intent,
    extra.reason,
    extra.outcome,
    extra.status,
    extra.primary_topology,
    extra.phase,
    ...(asArray(extra.roles)),
    ...(asArray(extra.agents)),
    ...(asArray(extra.tags)),
  ].join(' '), { lower: true, maxLen: 6000 });
}

function collectAgentTelemetryRows(events = []) {
  const rows = [];
  for (const event of asArray(events)) {
    const row = asObject(event);
    const extra = asObject(row.extra);
    const candidates = [row.agent_telemetry, row.agentTelemetry, extra.agent_telemetry, extra.agentTelemetry, extra.agent_calls, extra.agentCalls];
    for (const value of candidates) {
      if (Array.isArray(value)) rows.push(...value.map(asObject));
      else if (value && typeof value === 'object') rows.push(asObject(value));
    }
  }
  return rows;
}

export function deriveTopologyReplaySignals(events = [], { roomPackage = null, profile = null } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const rows = asArray(events).map(asObject);
  const texts = rows.map(flattenEventText);
  const allText = texts.join(' ');
  const telemetry = collectAgentTelemetryRows(rows);
  const totalTokens = telemetry.reduce((sum, row) => sum + numberOrZero(row.total_tokens ?? row.tokens ?? row.token_count), 0);
  const latencies = telemetry.map((row) => numberOrZero(row.latency_ms ?? row.duration_ms ?? row.elapsed_ms)).filter(Boolean);
  const contributionRows = telemetry.map((row) => numberOrZero(row.contribution_score ?? row.quality_score ?? row.acceptance_score)).filter(Boolean);
  const eventCount = rows.length;
  const approvals = texts.filter((t) => /approve|approved|accept|accepted|commit|committed|승인|적용/.test(t)).length;
  const rejections = texts.filter((t) => /reject|rejected|deny|rollback|stale|거절|취소|롤백/.test(t)).length;
  const corrections = texts.filter((t) => /correct|correction|revise|fix|rerun|오류|수정|재작성|다시/.test(t)).length;
  const stops = texts.filter((t) => /stop|blocked|abort|unsafe|위험|중단|차단/.test(t)).length;
  const reviewEvents = texts.filter((t) => /review|verify|verifier|critic|evidence|claim|검토|검증|근거/.test(t)).length;
  const buildEvents = texts.filter((t) => /code|patch|test|artifact|build|implementation|코드|패치|테스트|구현/.test(t)).length;
  const sourceEvents = texts.filter((t) => /source|ground|browse|search|citation|evidence|출처|검색|브라우징|근거/.test(t)).length;
  const memoryEvents = texts.filter((t) => /memory|preference|profile|room_memory|goc|graph|메모리|선호/.test(t)).length;
  const parallelHints = texts.filter((t) => /parallel|bounded|wccu|council|multi|roster|agent|동시|여러|협업/.test(t)).length;
  const lowRiskHints = texts.filter((t) => /ask|direct|quick|small|simple|간단|짧게/.test(t)).length;
  const avgLatencyMs = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const avgContribution = contributionRows.length ? Number((contributionRows.reduce((a, b) => a + b, 0) / contributionRows.length).toFixed(3)) : 0;
  return {
    trace_count: eventCount,
    approvals,
    rejections,
    corrections,
    stops,
    review_events: reviewEvents,
    build_events: buildEvents,
    source_events: sourceEvents,
    memory_events: memoryEvents,
    parallel_hints: parallelHints,
    low_risk_hints: lowRiskHints,
    observed_agent_call_count: telemetry.length,
    observed_total_tokens: totalTokens,
    observed_avg_latency_ms: avgLatencyMs,
    observed_avg_contribution_score: avgContribution,
    room_goal_text: cleanText([prof.current_goal, prof.room_purpose, pkg.description, ...(pkg.skills || [])].join(' '), { lower: true, maxLen: 3000 }),
    needs_review: reviewEvents + stops + corrections > 0 || hasAny(allText, [/claim/, /safety/, /verifier/, /검증/, /근거/]),
    needs_build: buildEvents > 0 || hasAny(allText, [/code/, /patch/, /artifact/, /구현/, /테스트/]),
    needs_sources: sourceEvents > 0 || hasAny(allText, [/source/, /browse/, /citation/, /출처/, /검색/]),
    needs_memory_care: memoryEvents > 0 || hasAny(allText, [/memory/, /preference/, /goc/, /메모리/, /선호/]),
    needs_parallelism: parallelHints > 0 || hasAny(allText, [/parallel/, /multi-agent/, /wccu/, /동시/]),
    likely_simple: lowRiskHints > Math.max(1, reviewEvents + buildEvents + parallelHints),
  };
}

function replayScoreTopology(topology, signals = {}, baseScore = 0) {
  const id = topology.id;
  let quality = Number(baseScore || 0);
  let safety = 0;
  let latencyCost = 1;
  let tokenCost = 1;
  const reasons = [];
  if (signals.trace_count <= 0) reasons.push('no replay trace yet; ranking uses room/package priors only');

  if (id === 'reviewer_gated_pipeline') {
    if (signals.needs_review) { quality += 3; safety += 3; reasons.push('recent trace contains review/correction/evidence pressure'); }
    if (signals.needs_build) { quality += 2; reasons.push('builder→reviewer pipeline fits code/artifact work'); }
    latencyCost += 2; tokenCost += 2;
  } else if (id === 'bounded_parallel_wccu_group') {
    if (signals.needs_parallelism) { quality += 4; reasons.push('parallel/multi-agent hints favor bounded witness-checked group work'); }
    if (signals.needs_memory_care) { quality += 2; safety += 2; reasons.push('memory/preference updates benefit from explicit witnesses'); }
    latencyCost += 2; tokenCost += 3;
  } else if (id === 'visible_companion_council') {
    if (signals.needs_memory_care) { quality += 2; reasons.push('preference-heavy room decisions benefit from visible tradeoff council'); }
    if (signals.corrections > 0) { quality += 1; reasons.push('corrections suggest surfacing alternatives before committing'); }
    latencyCost += 1; tokenCost += 2;
  } else if (id === 'orchestrator_star') {
    if (signals.needs_sources || signals.needs_build) { quality += 2; reasons.push('heterogeneous source/build/tool phases fit specialist routing'); }
    if (signals.observed_agent_call_count >= 3) { quality += 1; reasons.push('existing traces already contain multiple agent/model calls'); }
    latencyCost += 1; tokenCost += 2;
  } else if (id === 'sequential_handoff') {
    if (signals.likely_simple) { quality += 3; reasons.push('simple/low-risk traces favor sequential handoff'); }
    if (signals.needs_review || signals.needs_parallelism) { quality -= 2; reasons.push('review or parallel pressure can make pure sequence brittle'); }
  }

  const correctionPenalty = Math.min(3, signals.corrections * 0.35 + signals.rejections * 0.3 + signals.stops * 0.5);
  const acceptanceBoost = Math.min(2, signals.approvals * 0.2 + signals.observed_avg_contribution_score);
  const costPenalty = (latencyCost * 0.25) + (tokenCost * 0.2);
  const rankingScore = Number((quality + safety + acceptanceBoost - correctionPenalty - costPenalty).toFixed(3));
  return {
    topology_id: id,
    title: topology.title,
    base_score: Number(baseScore || 0),
    replay_score: rankingScore,
    expected_quality_gain: Number(quality.toFixed(3)),
    expected_safety_gain: Number(safety.toFixed(3)),
    estimated_latency_weight: latencyCost,
    estimated_token_weight: tokenCost,
    correction_pressure: Number(correctionPenalty.toFixed(3)),
    acceptance_signal: Number(acceptanceBoost.toFixed(3)),
    proposal_kind: 'room_topology_trial',
    recommended_action: rankingScore > 3 ? 'propose_trial_in_goc' : 'collect_more_trace',
    graph: topology.graph,
    risk: topology.risk,
    reasons: reasons.slice(0, 4),
  };
}

export function evaluateTopologyReplay({ events = [], roomPackage = null, profile = null, candidates = null } = {}) {
  const card = buildRoomTopologyLearningCard({ roomPackage, profile, events });
  const catalog = asArray(candidates).length ? asArray(candidates) : card.candidates;
  const signals = deriveTopologyReplaySignals(events, { roomPackage, profile });
  const ranked = catalog.map((topology) => replayScoreTopology(topology, signals, topology.score || 0))
    .sort((a, b) => b.replay_score - a.replay_score || a.topology_id.localeCompare(b.topology_id));
  const top = ranked[0] || null;
  return {
    kind: 'room_topology_replay_evaluator_v1',
    status: signals.trace_count > 0 ? 'shadow_replay_ranked' : 'insufficient_trace_shadow',
    trace_count: signals.trace_count,
    signals,
    ranked_candidates: ranked,
    top_candidate: top,
    proposal_path: {
      may_create_proposal: Boolean(top && top.recommended_action === 'propose_trial_in_goc'),
      proposal_kind: 'room_topology_trial',
      durable_change_requires: 'proposal -> reversible trial -> user_or_goc_approval',
      direct_room_state_mutation: false,
    },
    guardrails: [
      'Replay evaluator is a room-level scorer, not base-model RLHF.',
      'A topology score may open a proposal/trial; it must not directly mutate durable room state.',
      'Verifier, safety, and required agents stay protected from token-cost-only pruning.',
      'Use fixed traces plus outcome labels; do not treat self-judgment as ground truth.',
    ],
  };
}

export function formatTopologyReplayEvaluationForTelegram(report = {}) {
  const row = asObject(report);
  const ranked = asArray(row.ranked_candidates);
  const signals = asObject(row.signals);
  const path = asObject(row.proposal_path);
  return [
    '🧪 Room topology replay evaluator',
    '',
    `status: ${row.status || 'unknown'}`,
    `trace count: ${row.trace_count || 0}`,
    `top candidate: ${asObject(row.top_candidate).topology_id || '(none)'}`,
    '',
    'Replay signals:',
    `- review/build/source/memory/parallel: ${signals.review_events || 0}/${signals.build_events || 0}/${signals.source_events || 0}/${signals.memory_events || 0}/${signals.parallel_hints || 0}`,
    `- approvals/rejections/corrections/stops: ${signals.approvals || 0}/${signals.rejections || 0}/${signals.corrections || 0}/${signals.stops || 0}`,
    `- agent calls/tokens/avg latency: ${signals.observed_agent_call_count || 0}/${signals.observed_total_tokens || 0}/${signals.observed_avg_latency_ms || 0}ms`,
    '',
    'Ranked topology trials:',
    ...ranked.slice(0, 5).map((item, idx) => `${idx + 1}. ${item.topology_id} · replay=${item.replay_score} · ${item.recommended_action}`),
    '',
    'Why top candidates ranked this way:',
    ...ranked.slice(0, 3).flatMap((item) => [`- ${item.topology_id}:`, ...asArray(item.reasons).slice(0, 3).map((reason) => `  · ${reason}`)]),
    '',
    'Proposal path:',
    `- may create proposal: ${path.may_create_proposal ? 'yes' : 'not yet'}`,
    `- durable change: ${path.durable_change_requires || 'proposal/trial/user-or-GoC approval'}`,
    `- direct mutation: ${path.direct_room_state_mutation ? 'yes' : 'no'}`,
    '',
    'Guardrails:',
    ...asArray(row.guardrails).map((item) => `- ${item}`),
  ].join('\n');
}

export function formatRoomTopologyLearningCardForTelegram(card = {}) {
  const row = asObject(card);
  const candidates = asArray(row.candidates);
  const policy = asObject(row.learning_policy);
  const schema = asObject(row.dataset_schema);
  return [
    '🧭 Room topology learning',
    '',
    `primary candidate: ${row.primary_topology || '(none)'}`,
    '',
    'Topology candidates:',
    ...candidates.slice(0, 5).map((item) => `- ${item.id} · score=${item.score} · ${item.title}`),
    '',
    'Fine-tuning stance:',
    `- immediate fine-tune: ${policy.immediate_finetune}`,
    `- first step: ${policy.first_step}`,
    `- model role: ${policy.model_role}`,
    `- durable changes: ${policy.durable_change_policy}`,
    '',
    'Training/export schema:',
    `- special tokens: ${asArray(schema.special_tokens).join(' ')}`,
    `- labels: ${asArray(schema.labels).join(', ')}`,
    `- metrics: ${asArray(schema.metrics).join(', ')}`,
    '',
    'Guardrails:',
    ...asArray(row.guardrails).map((item) => `- ${item}`),
  ].join('\n');
}
