import crypto from 'node:crypto';

function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clip(value = '', max = 600) {
  const text = clean(value);
  const n = Math.max(80, Number(max) || 600);
  return text.length <= n ? text : `${text.slice(0, n - 1).trim()}…`;
}
function id(prefix = 'loop') { return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`; }
function uniq(values = [], max = 24) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = clean(raw);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

export const LOOP_TOPOLOGY_TEMPLATES = Object.freeze({
  solo: {
    topology_id: 'solo',
    label: 'Solo',
    stages: [
      { stage_id: 'plan', label: 'Plan', roles: ['operator'], visibility: 'milestone' },
      { stage_id: 'execute', label: 'Execute', roles: ['builder', 'researcher'], visibility: 'milestone' },
      { stage_id: 'verify', label: 'Verify', roles: ['verifier', 'reviewer'], visibility: 'milestone' },
      { stage_id: 'finalize', label: 'Finalize', roles: ['synthesizer'], visibility: 'milestone' },
    ],
  },
  review_loop: {
    topology_id: 'review_loop',
    label: 'Review Loop',
    stages: [
      { stage_id: 'plan', label: 'Plan', roles: ['operator'], visibility: 'milestone' },
      { stage_id: 'draft', label: 'Draft or Implement', roles: ['builder', 'researcher', 'proposer'], visibility: 'milestone' },
      { stage_id: 'review', label: 'Independent Review', roles: ['reviewer', 'verifier', 'challenger'], visibility: 'milestone' },
      { stage_id: 'revise', label: 'Revision', roles: ['builder', 'researcher', 'proposer'], visibility: 'milestone' },
      { stage_id: 'verify', label: 'Final Verification', roles: ['verifier', 'reviewer'], visibility: 'milestone' },
      { stage_id: 'finalize', label: 'Synthesis', roles: ['synthesizer'], visibility: 'milestone' },
    ],
  },
  deliberation: {
    topology_id: 'deliberation',
    label: 'Deliberate and Adjudicate',
    stages: [
      { stage_id: 'plan', label: 'Plan', roles: ['operator'], visibility: 'milestone' },
      { stage_id: 'independent_proposals', label: 'Independent Proposals', roles: ['proposer', 'researcher', 'builder'], visibility: 'milestone', isolation_required: true },
      { stage_id: 'cross_review', label: 'Cross Review', roles: ['reviewer', 'challenger'], visibility: 'milestone' },
      { stage_id: 'rebuttal', label: 'Rebuttal', roles: ['proposer', 'researcher', 'builder'], visibility: 'milestone' },
      { stage_id: 'adjudicate', label: 'Adjudication', roles: ['adjudicator', 'reviewer'], visibility: 'milestone' },
      { stage_id: 'finalize', label: 'Synthesis', roles: ['synthesizer'], visibility: 'milestone' },
    ],
  },
});

export function normalizeLoopVisibility(value = '') {
  const key = clean(value).toLowerCase();
  if (['debug', 'detailed', 'full'].includes(key)) return 'debug';
  if (['standard', 'normal'].includes(key)) return 'standard';
  return 'quiet';
}

export function chooseLoopTopology({ workflowContract = null, requestedTopology = '', taskText = '' } = {}) {
  const requested = clean(requestedTopology).toLowerCase();
  if (LOOP_TOPOLOGY_TEMPLATES[requested]) return requested;
  const contract = asObject(workflowContract);
  const workflowKind = clean(contract.workflow_kind || contract.workflowKind).toLowerCase();
  const text = clean(taskText).toLowerCase();
  if (workflowKind === 'explore_then_synthesize' || /토론|논쟁|대안|찬반|여러 관점|deliberat|debate|adjudicat/.test(text)) return 'deliberation';
  if (workflowKind === 'bounded_continuous_loop' || workflowKind === 'review_gated_pipeline' || contract.review_each_iteration === true) return 'review_loop';
  return 'solo';
}

export function buildLoopRunSpec({
  loopId = '', roomId = '', chatId = '', objective = '', workflowContract = null,
  requestedTopology = '', progressVisibility = '', modelPolicy = null, budgetPolicy = null,
  activeConstraints = [], source = 'loop_execution_kernel',
} = {}) {
  const contract = asObject(workflowContract);
  const topologyId = chooseLoopTopology({ workflowContract: contract, requestedTopology, taskText: objective });
  const template = LOOP_TOPOLOGY_TEMPLATES[topologyId];
  const maxRounds = Math.max(1, Number(contract.max_iterations || contract.maxIterations || asObject(budgetPolicy).max_iterations || 1) || 1);
  const minRounds = Math.min(maxRounds, Math.max(1, Number(contract.min_iterations || contract.minIterations || 1) || 1));
  return {
    kind: 'loop_run_spec_v1',
    loop_id: clean(loopId) || id('loop_run'),
    room_id: clean(roomId || chatId) || undefined,
    chat_id: clean(chatId) || undefined,
    objective: clip(objective, 1200),
    source: clean(source) || 'loop_execution_kernel',
    topology: {
      topology_id: template.topology_id,
      label: template.label,
      stages: template.stages.map((stage, index) => ({ ...stage, stage_index: index })),
    },
    workflow_contract: contract,
    model_policy: asObject(modelPolicy),
    budget_policy: {
      max_rounds: maxRounds,
      min_rounds: minRounds,
      max_failures: Math.max(1, Number(asObject(budgetPolicy).max_failures || 3) || 3),
      max_model_calls: Number(asObject(budgetPolicy).max_model_calls || 0) || null,
      max_latency_ms: Number(asObject(budgetPolicy).max_latency_ms || 0) || null,
      max_cost_usd: Number(asObject(budgetPolicy).max_cost_usd || 0) || null,
    },
    stop_policy: {
      require_no_blocking_objections: topologyId !== 'solo',
      require_final_verification: true,
      stop_conditions: uniq(contract.stop_conditions || ['user_stop', 'iteration_budget_exceeded', 'three_consecutive_failures']),
    },
    progress_policy: {
      visibility: normalizeLoopVisibility(progressVisibility || contract.progress_visibility || 'quiet'),
      heartbeat_after_ms: 90_000,
      notify_events: ['run_started', 'stage_started', 'blocking_issue_found', 'approval_required', 'run_redirected', 'run_recovered', 'run_completed', 'run_failed'],
    },
    memory_policy: {
      raw_trace: 'append_only',
      prompt_surface: 'compacted_working_projection',
      durable_promotion: 'proposal_only',
      compact_after_events: 80,
      compact_after_bytes: 48_000,
      keep_recent_events: 24,
      archive_after_completion: true,
    },
    active_constraints: uniq(activeConstraints, 24),
    created_at: new Date().toISOString(),
  };
}

export function createLoopRunState(spec = {}) {
  const normalized = spec?.kind === 'loop_run_spec_v1' ? structuredClone(spec) : buildLoopRunSpec(spec);
  const firstStage = normalized.topology.stages[0] || null;
  const now = new Date().toISOString();
  return {
    kind: 'loop_run_state_v1',
    loop_id: normalized.loop_id,
    spec: normalized,
    status: 'running',
    current_stage_id: firstStage?.stage_id || null,
    current_stage_index: firstStage?.stage_index ?? -1,
    current_round: 1,
    completed_stage_ids: [],
    active_agents: [],
    counters: { model_calls: 0, agent_starts: 0, agent_completions: 0, failures: 0, revisions: 0, blocking_issues: 0, resolved_issues: 0 },
    blocking_issue_ids: [],
    milestones: [],
    trace_refs: [],
    progress_visibility: normalized.progress_policy.visibility,
    latest_summary: '',
    next_action: firstStage ? `start:${firstStage.stage_id}` : 'complete',
    created_at: now,
    updated_at: now,
  };
}

export function createLoopKernelEvent({ loopId = '', eventType = '', actor = '', roleId = '', stageId = '', summary = '', payload = {}, source = 'loop_execution_kernel' } = {}) {
  const type = clean(eventType);
  if (!clean(loopId) || !type) throw new Error('loopId and eventType are required');
  return {
    kind: 'loop_kernel_event_v1',
    event_id: id('loop_evt'),
    loop_id: clean(loopId),
    event_type: type,
    actor: clean(actor) || undefined,
    role_id: clean(roleId).toLowerCase() || undefined,
    stage_id: clean(stageId) || undefined,
    summary: clip(summary, 1200) || undefined,
    payload: asObject(payload),
    source: clean(source) || 'loop_execution_kernel',
    ts: new Date().toISOString(),
  };
}

function stageForRole(state, roleId = '') {
  const role = clean(roleId).toLowerCase();
  if (!role) return null;
  const stages = asArray(state?.spec?.topology?.stages);
  const currentIndex = Number(state.current_stage_index || 0);
  return stages.slice(Math.max(0, currentIndex)).find((stage) => asArray(stage.roles).map((item) => clean(item).toLowerCase()).includes(role))
    || stages.find((stage) => asArray(stage.roles).map((item) => clean(item).toLowerCase()).includes(role))
    || null;
}

function addMilestone(state, event, label = '') {
  const row = {
    event_id: event.event_id,
    ts: event.ts,
    event_type: event.event_type,
    stage_id: event.stage_id || state.current_stage_id || undefined,
    label: clip(label || event.summary || event.event_type, 320),
  };
  state.milestones = [...asArray(state.milestones), row].slice(-40);
}

function advanceStage(state, completedStageId = '') {
  const stages = asArray(state?.spec?.topology?.stages);
  const currentId = clean(completedStageId || state.current_stage_id);
  if (currentId && !state.completed_stage_ids.includes(currentId)) state.completed_stage_ids.push(currentId);
  const currentIndex = Math.max(-1, stages.findIndex((stage) => stage.stage_id === currentId));
  const next = stages[currentIndex + 1] || null;
  if (next) {
    state.current_stage_id = next.stage_id;
    state.current_stage_index = next.stage_index;
    state.next_action = `start:${next.stage_id}`;
    return;
  }
  state.next_action = 'evaluate_stop';
}

export function reduceLoopRunState(currentState = null, event = {}) {
  const state = currentState ? structuredClone(currentState) : createLoopRunState(event.payload?.spec || {});
  const type = clean(event.event_type);
  state.updated_at = event.ts || new Date().toISOString();
  if (event.summary) state.latest_summary = clip(event.summary, 1200);
  if (event.payload?.trace_ref && !state.trace_refs.includes(event.payload.trace_ref)) state.trace_refs.push(event.payload.trace_ref);
  state.trace_refs = state.trace_refs.slice(-80);

  if (type === 'run_started') {
    state.status = 'running';
    addMilestone(state, event, event.summary || 'Loop started');
  } else if (type === 'stage_started') {
    const stageId = clean(event.stage_id || event.payload?.stage_id);
    const stages = asArray(state?.spec?.topology?.stages);
    const index = stages.findIndex((stage) => stage.stage_id === stageId);
    if (index >= 0) {
      state.current_stage_id = stageId;
      state.current_stage_index = index;
      state.next_action = `complete:${stageId}`;
    }
    addMilestone(state, event, event.summary || `Started ${stageId}`);
  } else if (type === 'agent_started') {
    const actor = clean(event.actor || event.payload?.agent_id);
    const role = clean(event.role_id || event.payload?.role_id).toLowerCase();
    if (actor && !state.active_agents.some((row) => row.agent_id === actor)) state.active_agents.push({ agent_id: actor, role_id: role || undefined, started_at: event.ts });
    state.active_agents = state.active_agents.slice(-16);
    state.counters.agent_starts += 1;
    state.counters.model_calls += 1;
    const inferredStage = stageForRole(state, role);
    if (inferredStage && inferredStage.stage_id !== state.current_stage_id) {
      state.current_stage_id = inferredStage.stage_id;
      state.current_stage_index = inferredStage.stage_index;
    }
  } else if (type === 'agent_completed') {
    const actor = clean(event.actor || event.payload?.agent_id);
    state.active_agents = state.active_agents.filter((row) => row.agent_id !== actor);
    state.counters.agent_completions += 1;
    if (event.payload?.revision === true) state.counters.revisions += 1;
    if (event.payload?.final_synthesis === true) {
      advanceStage(state, state.current_stage_id);
      addMilestone(state, event, event.summary || 'Final synthesis completed');
      if (event.payload?.complete_run === true) {
        state.status = 'completed';
        state.next_action = 'complete';
      }
    }
  } else if (type === 'iteration_started') {
    const round = Math.max(1, Number(event.payload?.iteration || event.payload?.round || state.current_round || 1) || 1);
    state.current_round = round;
    if (!['cancelled', 'failed'].includes(clean(state.status).toLowerCase())) state.status = 'running';
    state.next_action = `continue:${state.current_stage_id}`;
    addMilestone(state, event, event.summary || `Iteration ${round} started`);
  } else if (type === 'iteration_completed') {
    const round = Math.max(1, Number(event.payload?.iteration || event.payload?.round || state.current_round || 1) || 1);
    const iterationStatus = clean(event.payload?.status).toLowerCase();
    state.current_round = round;
    if (iterationStatus === 'completed') {
      state.status = 'completed';
      state.next_action = 'complete';
    } else if (iterationStatus === 'awaiting_approval') {
      state.status = 'awaiting_approval';
      state.next_action = 'await_approval';
    } else if (iterationStatus === 'paused') {
      state.status = 'paused';
      state.next_action = 'await_user';
    } else if (iterationStatus === 'stopped') {
      state.status = 'cancelled';
      state.next_action = 'complete';
    } else {
      state.status = 'running';
      state.next_action = 'start_next_iteration';
    }
    addMilestone(state, event, event.summary || `Iteration ${round} completed`);
  } else if (type === 'approval_required') {
    state.status = 'awaiting_approval';
    state.next_action = 'await_approval';
    addMilestone(state, event, event.summary || 'User approval required');
  } else if (type === 'stage_completed') {
    advanceStage(state, event.stage_id || event.payload?.stage_id);
    addMilestone(state, event, event.summary || `Completed ${event.stage_id || ''}`);
  } else if (type === 'blocking_issue_found') {
    const issueId = clean(event.payload?.issue_id) || id('issue');
    if (!state.blocking_issue_ids.includes(issueId)) state.blocking_issue_ids.push(issueId);
    state.counters.blocking_issues += 1;
    state.status = 'blocked';
    state.next_action = 'resolve_blocking_issue';
    addMilestone(state, event, event.summary || 'Blocking issue found');
  } else if (type === 'blocking_issue_resolved') {
    const issueId = clean(event.payload?.issue_id);
    if (issueId) state.blocking_issue_ids = state.blocking_issue_ids.filter((item) => item !== issueId);
    state.counters.resolved_issues += 1;
    if (state.blocking_issue_ids.length === 0 && state.status === 'blocked') state.status = 'running';
    state.next_action = state.blocking_issue_ids.length ? 'resolve_blocking_issue' : `continue:${state.current_stage_id}`;
    addMilestone(state, event, event.summary || 'Blocking issue resolved');
  } else if (type === 'agent_failed' || type === 'run_failed') {
    state.counters.failures += 1;
    if (type === 'run_failed' || state.counters.failures >= Number(state.spec?.budget_policy?.max_failures || 3)) state.status = 'failed';
    addMilestone(state, event, event.summary || 'Execution failure');
  } else if (type === 'user_control') {
    const control = clean(event.payload?.control || event.payload?.interrupt_type).toLowerCase();
    if (control === 'pause') state.status = 'paused';
    else if (['resume', 'approve'].includes(control)) state.status = 'running';
    else if (['cancel', 'reject'].includes(control)) state.status = 'cancelled';
    else if (control === 'redirect') {
      const objective = clip(event.payload?.objective || event.payload?.text, 1200);
      if (objective) state.spec.objective = objective;
      state.status = 'running';
      state.current_stage_id = state.spec.topology.stages[0]?.stage_id || state.current_stage_id;
      state.current_stage_index = 0;
      state.completed_stage_ids = [];
      state.next_action = `start:${state.current_stage_id}`;
      addMilestone(state, event, event.summary || 'Loop redirected');
    } else if (control === 'visibility') {
      state.progress_visibility = normalizeLoopVisibility(event.payload?.visibility);
    }
  } else if (type === 'memory_compacted') {
    addMilestone(state, event, event.summary || 'Working memory compacted');
  } else if (type === 'run_completed') {
    state.status = 'completed';
    state.next_action = 'complete';
    addMilestone(state, event, event.summary || 'Loop completed');
  }
  return state;
}

export function evaluateLoopStopConditions(state = {}) {
  const status = clean(state.status).toLowerCase();
  if (['completed', 'cancelled', 'failed'].includes(status)) return { should_stop: true, reason: status };
  if (status === 'paused') return { should_stop: true, reason: 'paused', resumable: true };
  if (status === 'awaiting_approval') return { should_stop: true, reason: 'awaiting_approval', resumable: true };
  const budget = asObject(state?.spec?.budget_policy);
  if (Number(state.current_round || 1) > Number(budget.max_rounds || 1)) return { should_stop: true, reason: 'round_budget_exceeded' };
  if (Number(state.counters?.failures || 0) >= Number(budget.max_failures || 3)) return { should_stop: true, reason: 'failure_budget_exceeded' };
  if (asArray(state.blocking_issue_ids).length > 0) return { should_stop: false, blocked: true, reason: 'blocking_issues_open' };
  if (state.next_action === 'evaluate_stop') {
    const minimumMet = Number(state.current_round || 1) >= Number(budget.min_rounds || 1);
    return minimumMet ? { should_stop: true, reason: 'workflow_complete' } : { should_stop: false, reason: 'minimum_rounds_not_met' };
  }
  return { should_stop: false, reason: 'continue' };
}

export default {
  LOOP_TOPOLOGY_TEMPLATES,
  normalizeLoopVisibility,
  chooseLoopTopology,
  buildLoopRunSpec,
  createLoopRunState,
  createLoopKernelEvent,
  reduceLoopRunState,
  evaluateLoopStopConditions,
};
