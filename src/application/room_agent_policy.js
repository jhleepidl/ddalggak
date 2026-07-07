function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function cleanText(value = '', { maxLen = 800, lower = false } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}
function uniqueStrings(values = [], { max = 64, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = cleanText(raw, { maxLen: 180, lower });
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

export const AGENT_ACTIVATION_STATES = ['required', 'active', 'on_demand', 'shadow', 'disabled'];

const REQUIRED_ROLE_RE = /(verifier|risk|safety|guard|compliance|claim_checker|contradiction|authority|security)/i;
const CRITIC_ROLE_RE = /(critic|reviewer|checker|auditor|evaluator|continuity|novelty)/i;
const BUILDER_ROLE_RE = /(builder|implementation|executor|runner|patch|experiment|synthesizer|writer|planner|researcher|scout|estimator|tracker|curator|designer)/i;

function inferModelRoleHint(agent = '', roomPackage = {}) {
  const key = cleanText(agent, { lower: true });
  const pkgText = cleanText([roomPackage.package_id, roomPackage.domain_label, roomPackage.title, ...(roomPackage.tags || [])].join(' '), { lower: true });
  if (/verifier|critic|reviewer|risk|safety|claim|contradiction|checker/.test(key)) return 'verifier_critic';
  if (/code|builder|implementation|patch|test|runner|repo/.test(key) || /code|implementation|repo/.test(pkgText)) return 'code_executor';
  if (/research|source|scout|paper|market|evidence|claim|finder/.test(key) || /research|finance|evidence|paper/.test(pkgText)) return 'source_grounder';
  if (/synthesizer|delivery|writer|answer/.test(key)) return 'delivery_synthesizer';
  if (/planner|router|concierge/.test(key)) return 'concierge_router';
  return 'general_reasoning';
}

function isRiskSensitivePackage(roomPackage = {}, profile = {}) {
  const text = cleanText([
    roomPackage.package_id,
    roomPackage.domain_label,
    roomPackage.title,
    roomPackage.description,
    profile.domain_label,
    profile.current_goal,
    ...(roomPackage.tags || []),
    ...(asArray(profile?.room_package_composition?.intent_card?.risk_profile)),
  ].join(' '), { lower: true, maxLen: 4000 });
  return /(finance|stock|portfolio|health|nutrition|legal|medical|deploy|credential|research|claim|safety|risk|security|주식|투자|건강|배포|논문|주장|검증)/i.test(text);
}

function defaultStateForAgent(agent = '', index = 0, { roomPackage = {}, profile = {}, total = 0 } = {}) {
  const key = cleanText(agent, { lower: true });
  const depth = cleanText(roomPackage.default_depth || profile.default_depth || '', { lower: true });
  const riskSensitive = isRiskSensitivePackage(roomPackage, profile);
  if (REQUIRED_ROLE_RE.test(key)) return 'required';
  if (riskSensitive && CRITIC_ROLE_RE.test(key)) return 'required';
  if (/delivery_synthesizer|synthesizer|answer_synthesizer|paper_synthesizer|brief_synthesizer/.test(key)) return 'active';
  const activeBudget = depth === 'ask' ? 2 : depth === 'loop' ? 4 : 3;
  if (index < activeBudget && BUILDER_ROLE_RE.test(key)) return 'active';
  if (CRITIC_ROLE_RE.test(key)) return 'on_demand';
  if (index < activeBudget) return 'active';
  if (total > 6 && index >= 6) return 'shadow';
  return 'on_demand';
}

function reasonForState(agent = '', state = 'active', { roomPackage = {}, profile = {} } = {}) {
  const key = cleanText(agent, { lower: true });
  if (state === 'required') return REQUIRED_ROLE_RE.test(key) ? 'safety_or_verification_boundary' : 'risk_sensitive_room_guardrail';
  if (state === 'active') return 'expected_recurring_work_contribution';
  if (state === 'on_demand') return 'use_when_task_requires_this_specialty';
  if (state === 'shadow') return 'observe_utility_before_durable_activation';
  if (state === 'disabled') return 'excluded_by_room_specialization_or_user_decision';
  return 'adaptive_roster_state';
}

export function normalizeAgentActivationPolicy(policy = {}, { agents = [], roomPackage = {}, profile = {} } = {}) {
  const existing = asObject(policy);
  const rosterByAgent = new Map();
  for (const row of asArray(existing.roster)) {
    const item = asObject(row);
    const agent = cleanText(item.agent || item.role || '', { lower: true, maxLen: 160 });
    if (!agent) continue;
    const state = AGENT_ACTIVATION_STATES.includes(item.state) ? item.state : 'on_demand';
    rosterByAgent.set(agent, {
      agent,
      state,
      rationale: cleanText(item.rationale || reasonForState(agent, state, { roomPackage, profile }), { maxLen: 300 }),
      model_role_hint: cleanText(item.model_role_hint || inferModelRoleHint(agent, roomPackage), { maxLen: 120 }),
      can_auto_prune: state !== 'required',
      last_changed_at: item.last_changed_at || null,
    });
  }
  const agentList = uniqueStrings([...(agents || []), ...asArray(existing.roster).map((row) => asObject(row).agent || asObject(row).role)], { max: 64, lower: true });
  for (const [idx, agent] of agentList.entries()) {
    if (rosterByAgent.has(agent)) continue;
    const state = defaultStateForAgent(agent, idx, { roomPackage, profile, total: agentList.length });
    rosterByAgent.set(agent, {
      agent,
      state,
      rationale: reasonForState(agent, state, { roomPackage, profile }),
      model_role_hint: inferModelRoleHint(agent, roomPackage),
      can_auto_prune: state !== 'required',
      last_changed_at: null,
    });
  }
  const roster = [...rosterByAgent.values()];
  return {
    schema_version: 'ddalggak.room_agent_activation_policy/v1',
    strategy: existing.strategy || 'cost_aware_outcome_aware_agent_roster',
    optimization_target: existing.optimization_target || 'better_task_outcome_per_token_not_fewer_tokens_alone',
    roster,
    state_counts: AGENT_ACTIVATION_STATES.reduce((acc, state) => {
      acc[state] = roster.filter((row) => row.state === state).length;
      return acc;
    }, {}),
    metrics: {
      primary: ['task_success', 'artifact_completion', 'user_acceptance', 'correction_reduction', 'safety_gain'],
      cost: ['token_cost', 'latency_cost', 'model_cost'],
      diagnostics: ['unique_contribution', 'redundancy_penalty', 'failure_prevention', 'manual_configuration_burden'],
      warning: 'token_cost alone must not disable safety-critical or verification agents',
      ...asObject(existing.metrics),
    },
    governance: {
      collect_telemetry: 'automatic_with_audit_log',
      low_risk_status_downgrade: 'trial_mode_first',
      durable_roster_change: 'user_or_goc_approval_required',
      required_agent_downgrade: 'explicit_user_or_goc_approval_required',
      rollback: 'must_be_available_for_trial_and_durable_changes',
      ...asObject(existing.governance),
    },
  };
}

export function buildDefaultAgentActivationPolicy(roomPackage = {}, { profile = {} } = {}) {
  const pkg = asObject(roomPackage);
  const prof = asObject(profile);
  const agents = uniqueStrings([...(pkg.agents || []), ...(prof.default_agents || [])], { max: 64, lower: true });
  return normalizeAgentActivationPolicy(pkg.agent_activation_policy || prof.agent_activation_policy || {}, { agents, roomPackage: pkg, profile: prof });
}

function stringifyEvent(event = {}) {
  return cleanText([event.event_type, event.command, event.goal, JSON.stringify(event.extra || {}), JSON.stringify(event.profile || event.room || {})].join(' '), { lower: true, maxLen: 5000 });
}

export function deriveAgentTelemetry({ events = [], policy = {}, roomPackage = {}, profile = {} } = {}) {
  const normalized = normalizeAgentActivationPolicy(policy, { agents: asArray(roomPackage.agents || profile.default_agents), roomPackage, profile });
  const rows = asArray(events).slice(-200);
  const eventText = rows.map(stringifyEvent);
  const totalEvents = rows.length;
  return normalized.roster.map((agentRow) => {
    const agent = agentRow.agent;
    const simpleAgent = agent.replace(/_/g, ' ');
    const mentions = eventText.filter((text) => text.includes(agent) || text.includes(simpleAgent)).length;
    const verifySignals = eventText.filter((text) => /(verify|review|risk|safety|claim|source|approval|검증|리뷰|승인|근거)/i.test(text)).length;
    const artifactSignals = eventText.filter((text) => /(artifact|patch|test|build|file|bundle|code|실험|테스트|코드|파일|번들)/i.test(text)).length;
    const interventionSignals = eventText.filter((text) => /(reject|correction|stop|retry|rollback|아냐|아니|다시|중단|거절|정정)/i.test(text)).length;
    const isRequired = agentRow.state === 'required';
    const estimatedCostWeight = agentRow.state === 'active' ? 1 : agentRow.state === 'required' ? 0.9 : agentRow.state === 'on_demand' ? 0.35 : agentRow.state === 'shadow' ? 0.1 : 0;
    const contributionSignal = mentions + (/(verifier|reviewer|critic|risk|claim|safety|guard)/i.test(agent) ? Math.min(verifySignals, 3) : 0) + (/(builder|runner|experiment|implementation|synthesizer|writer)/i.test(agent) ? Math.min(artifactSignals, 3) : 0);
    return {
      agent,
      state: agentRow.state,
      model_role_hint: agentRow.model_role_hint,
      total_events: totalEvents,
      explicit_mentions: mentions,
      contribution_signal: contributionSignal,
      verify_signals: verifySignals,
      artifact_signals: artifactSignals,
      intervention_signals: interventionSignals,
      estimated_cost_weight: Number(estimatedCostWeight.toFixed(2)),
      required: isRequired,
      telemetry_quality: totalEvents >= 8 ? 'usable_shadow_signal' : 'insufficient_trace',
    };
  });
}

function transitionState(state = 'active', direction = 'downgrade') {
  if (direction === 'promote') {
    if (state === 'disabled') return 'shadow';
    if (state === 'shadow') return 'on_demand';
    if (state === 'on_demand') return 'active';
    return state;
  }
  if (state === 'required') return 'required';
  if (state === 'active') return 'on_demand';
  if (state === 'on_demand') return 'shadow';
  if (state === 'shadow') return 'disabled';
  return 'disabled';
}

export function proposeAgentRosterSpecialization({ events = [], policy = {}, roomPackage = {}, profile = {}, minEvents = 8 } = {}) {
  const currentPolicy = normalizeAgentActivationPolicy(policy, { agents: asArray(roomPackage.agents || profile.default_agents), roomPackage, profile });
  const telemetry = deriveAgentTelemetry({ events, policy: currentPolicy, roomPackage, profile });
  const actions = [];
  for (const row of telemetry) {
    if (row.required) continue;
    if (row.total_events < minEvents) continue;
    if (['active', 'on_demand'].includes(row.state) && row.contribution_signal === 0 && row.intervention_signals <= 1) {
      actions.push({
        agent: row.agent,
        from: row.state,
        to: transitionState(row.state, 'downgrade'),
        reason: 'low_observed_contribution_under_current_room_traces',
        estimated_benefit: 'lower_default_token_and_latency_cost',
        risk: 'may_miss_specialized_review_or_context_when_task_shifts',
      });
    } else if (row.state === 'shadow' && row.contribution_signal >= 3) {
      actions.push({
        agent: row.agent,
        from: row.state,
        to: transitionState(row.state, 'promote'),
        reason: 'shadow_agent_has_repeated_relevant_signals',
        estimated_benefit: 'better_task_coverage_for_recurring_work',
        risk: 'higher_token_and_latency_cost',
      });
    }
  }
  const proposedRoster = currentPolicy.roster.map((agentRow) => {
    const action = actions.find((item) => item.agent === agentRow.agent);
    if (!action) return agentRow;
    return {
      ...agentRow,
      state: action.to,
      rationale: `${action.reason}; previous=${action.from}`,
      can_auto_prune: agentRow.state !== 'required',
      last_changed_at: new Date().toISOString(),
    };
  });
  const proposedPolicy = normalizeAgentActivationPolicy({ ...currentPolicy, roster: proposedRoster }, { agents: proposedRoster.map((row) => row.agent), roomPackage, profile });
  const estimatedTokenSavingWeight = actions
    .filter((item) => ['active', 'on_demand'].includes(item.from) && ['on_demand', 'shadow', 'disabled'].includes(item.to))
    .length;
  return {
    schema_version: 'ddalggak.room_agent_specialization_proposal/v1',
    generated_at: new Date().toISOString(),
    status: actions.length ? 'proposal_ready' : 'no_safe_change_found',
    summary: actions.length
      ? 'cost-aware roster specialization candidates found'
      : 'not enough evidence for a safe durable roster change',
    current_policy: currentPolicy,
    proposed_policy: proposedPolicy,
    telemetry,
    actions,
    estimated_token_saving_hint: estimatedTokenSavingWeight ? `${estimatedTokenSavingWeight} default agent step(s) can move out of the always-on path` : 'none',
    guardrail: {
      token_cost_only: 'insufficient_for_pruning',
      required_agents_never_auto_disabled: true,
      durable_change_requires: 'user_or_goc_approval',
      recommended_path: actions.length ? 'trial_then_approve' : 'collect_more_traces',
    },
  };
}

function formatRosterGroup(policy = {}, state = 'active') {
  const rows = asArray(policy.roster).filter((row) => row.state === state);
  if (!rows.length) return [`${state}: -`];
  return [`${state}:`, ...rows.map((row) => `- ${row.agent} · model=${row.model_role_hint || '-'} · ${row.rationale || ''}`)];
}

export function formatAgentActivationPolicyForTelegram(policy = {}, { telemetry = [] } = {}) {
  const normalized = normalizeAgentActivationPolicy(policy, { agents: asArray(policy.roster).map((row) => row.agent) });
  const lines = [
    '🤖 Room agent activation policy',
    '',
    `strategy: ${normalized.strategy}`,
    `optimization: ${normalized.optimization_target}`,
    '',
    ...formatRosterGroup(normalized, 'required'),
    '',
    ...formatRosterGroup(normalized, 'active'),
    '',
    ...formatRosterGroup(normalized, 'on_demand'),
    '',
    ...formatRosterGroup(normalized, 'shadow'),
    '',
    ...formatRosterGroup(normalized, 'disabled'),
  ];
  if (asArray(telemetry).length) {
    lines.push('', 'Recent telemetry:');
    for (const row of asArray(telemetry).slice(0, 12)) {
      lines.push(`- ${row.agent}: state=${row.state}, contribution=${row.contribution_signal}, mentions=${row.explicit_mentions}, quality=${row.telemetry_quality}`);
    }
  }
  lines.push('', 'Policy:', '- token cost is an optimization signal, not the sole pruning objective', '- durable roster changes require trial + user/GoC approval');
  return lines.join('\n');
}

export function formatAgentSpecializationProposalForTelegram(proposal = {}) {
  const row = asObject(proposal);
  const lines = [
    '🧪 Room agent specialization proposal',
    '',
    `status: ${row.status || 'unknown'}`,
    `summary: ${row.summary || '-'}`,
    `token saving hint: ${row.estimated_token_saving_hint || '-'}`,
    '',
  ];
  const actions = asArray(row.actions);
  if (actions.length) {
    lines.push('Proposed roster changes:');
    for (const action of actions) {
      lines.push(`- ${action.agent}: ${action.from} → ${action.to}`);
      lines.push(`  reason: ${action.reason}`);
      lines.push(`  benefit: ${action.estimated_benefit}`);
      lines.push(`  risk: ${action.risk}`);
    }
  } else {
    lines.push('No safe durable roster change yet. Keep collecting traces or run a trial manually.');
  }
  lines.push('', 'Guardrail:', '- token_cost_only = insufficient_for_pruning', '- required agents are not auto-disabled', '- durable change requires /room agents approve latest or GoC approval');
  return lines.join('\n');
}
