import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomJourneyTrace } from '../src/application/room_journey_trace.js';
const testTmpRoot = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
fs.mkdirSync(testTmpRoot, { recursive: true });

function makeTestTempDir(prefix) {
  return fs.mkdtempSync(path.join(testTmpRoot, prefix));
}

import {
  buildConciergeRoutingObservation,
  deriveConciergeRoutingLabel,
  finalizeConciergeRoutingObservations,
  evaluatePortfolioPromotion,
  HeadlessRoomJourneyTransport,
  loadRoomJourneyScenario,
  loadRoomJourneySuite,
  runRoomJourneyScenario,
  runRoomJourneySuite,
  runtimeEventsForAssertion,
  scenarioArms,
} from '../src/evaluation/room_journey_runner.js';

function runtimeEvent(eventType, payload = {}, runId = 'run-1') {
  return {
    event_id: `${eventType}-${Math.random()}`,
    event_type: eventType,
    run_id: runId,
    occurred_at: new Date().toISOString(),
    payload,
  };
}

class FakeJourneyTransport {
  constructor({ chatId, traceRoot, models = ['gpt-5.5'] }) {
    this.chatId = chatId;
    this.traceRoot = traceRoot;
    this.models = models;
    this.events = [];
    this.turn = 0;
  }
  async initialize() { return { cursor: '' }; }
  async sendCommand(command) {
    if (command === '/memory idle') {
      appendRoomJourneyTrace({ chatId: this.chatId, traceRoot: this.traceRoot, eventType: 'memory.candidate_created', payload: { candidate_id: 'cand-1', memory_summary: '조용한 장소 선호', status: 'pending' } });
    }
    if (command.startsWith('/memory approve')) {
      appendRoomJourneyTrace({ chatId: this.chatId, traceRoot: this.traceRoot, eventType: 'memory.decision', payload: { candidate_id: 'cand-1', memory_id: 'mem-1', decision: 'approve', ok: true } });
      appendRoomJourneyTrace({ chatId: this.chatId, traceRoot: this.traceRoot, eventType: 'memory.committed', payload: { candidate_id: 'cand-1', memory_id: 'mem-1', type: 'preference', summary: '조용한 장소 선호' } });
    }
    return { ok: true, output: '', events: [] };
  }
  async sendMessage(text) {
    this.turn += 1;
    const runId = `run-${this.turn}`;
    this.models.forEach((model, index) => {
      const provider = index % 2 ? 'claude' : 'codex';
      const modelRole = index === 0 ? 'code_executor' : 'verifier_critic';
      const agentId = index === 0 ? 'builder' : `reviewer_${index}`;
      this.events.push(runtimeEvent('run.agent_start', { agent_id: agentId, provider, model, model_role: modelRole, execution_channel: 'local_cli' }, runId));
      this.events.push(runtimeEvent('run.agent_finish', { agent_id: agentId, provider, model, model_role: modelRole, execution_channel: 'local_cli', output_chars: 32 }, runId));
    });
    if (this.turn > 1) {
      appendRoomJourneyTrace({ chatId: this.chatId, traceRoot: this.traceRoot, eventType: 'context.projection_compiled', payload: { approved_memory_ids: ['mem-1'], selected_atom_ids: ['goal-1'] } });
    }
    this.events.push(runtimeEvent('run.finish', { summary: `완료: ${text}` }, runId));
    return { ok: true, output: `완료: ${text}`, run_id: runId, events: this.events.filter((event) => event.run_id === runId) };
  }
}

test('room journey scenario loader and suite expose natural user and portfolio scenarios', () => {
  const base = path.resolve('scenarios/room_journeys');
  const core = loadRoomJourneySuite(path.join(base, 'core_suite.json'));
  const portfolio = loadRoomJourneySuite(path.join(base, 'model_portfolio_suite.json'));
  const conciergeRouting = loadRoomJourneySuite(path.join(base, 'concierge_routing_suite.json'));
  assert.equal(core.scenario_files.length, 4);
  assert.equal(portfolio.scenario_files.length, 3);
  assert.equal(conciergeRouting.scenario_files.length, 4);
  const scenario = loadRoomJourneyScenario(portfolio.scenario_files[0]);
  assert.deepEqual(scenarioArms(scenario).map((arm) => arm.id), ['solo', 'builder_reviewer']);
});

test('latest routing and portfolio scenarios encode measurement-validity and topology-neutral promotion contracts', () => {
  const base = path.resolve('scenarios/room_journeys');
  const highImpact = loadRoomJourneyScenario(path.join(base, 'concierge_probe_complex_room_high_impact_decision.json'));
  assert.equal(highImpact.routing_experiment.measurement_policy.label_status, 'quarantine');
  assert.equal(highImpact.routing_experiment.measurement_policy.require_frozen_pre_target_snapshot, true);
  assert.deepEqual(highImpact.routing_experiment.required_context_step_ids, ['fact_cost', 'fact_recovery', 'fact_constraints']);

  for (const name of ['portfolio_builder_reviewer.json', 'portfolio_parallel_ideation.json', 'portfolio_evidence_panel.json']) {
    const scenario = loadRoomJourneyScenario(path.join(base, name));
    const ids = scenario.semantic_rubric.map((row) => row.id);
    assert.equal(ids.includes('collaboration_value'), false);
    assert.equal(ids.includes('independent_panel_value'), false);
    assert.equal(ids.includes('independent_review_value'), false);
    assert.ok(Array.isArray(scenario.process_evidence_rubric) && scenario.process_evidence_rubric.length > 0);
    assert.equal(scenario.experiment.promotion_gate.require_cost_evidence, true);
    assert.equal(scenario.experiment.promotion_gate.require_exact_model_identity, true);
  }
});

test('headless transport uses synthetic Room identity and captures local CLI runtime events without Telegram', async () => {
  const root = makeTestTempDir('room-journey-headless-');
  try {
    const sessions = new Map();
    const eventFile = path.join(root, 'runtime_events.jsonl');
    const botMessages = [];
    let sequence = 0;
    const bot = {
      mark() { return sequence; },
      messagesSince(mark, chatId) { return botMessages.filter((row) => row.sequence > mark && row.chat_id === chatId); },
      async sendMessage(chatId, text) {
        sequence += 1;
        botMessages.push({ sequence, method: 'sendMessage', chat_id: chatId, text });
        return { message_id: sequence, text };
      },
    };
    const runtimeCore = {
      chatSessionStore: {
        clear(chatId) { sessions.delete(String(chatId)); },
        get(chatId) { return sessions.get(String(chatId)) || { state: 'idle' }; },
        upsert(chatId, patchOrUpdater) {
          const current = this.get(chatId);
          const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(current) : patchOrUpdater;
          const next = { ...current, ...patch };
          sessions.set(String(chatId), next);
          return next;
        },
      },
      resolveCurrentJobIdForChat() { return 'job-headless'; },
      jobs: { jobDir() { return root; } },
    };
    const runtimeFactory = async () => ({
      bot,
      runtimeCore,
      chatRunManager: {
        isRunning() { return false; },
        async handleIncoming({ chatId, text }) {
          const events = [
            runtimeEvent('run.start', { user_text: text }),
            runtimeEvent('run.agent_start', { provider: 'codex', model: 'gpt-5.5', model_role: 'builder', execution_channel: 'local_cli' }),
            runtimeEvent('run.finish', { status: 'done', summary: `headless reply: ${text}` }),
          ];
          fs.writeFileSync(eventFile, events.map((row, index) => JSON.stringify({ ...row, event_sequence: index + 1, job_id: 'job-headless' })).join('\n') + '\n');
          await bot.sendMessage(chatId, `headless reply: ${text}`);
          return { status: 'started' };
        },
      },
      async handleRoomCommand({ chatId, text }) {
        if (text.startsWith('/rule ')) {
          runtimeCore.chatSessionStore.upsert(chatId, (session) => ({ ...session, runtime_rules: [{ id: 'rule-1', text: text.slice(6), source: 'user', enabled: true }] }));
        }
        await bot.sendMessage(chatId, 'command applied');
        return true;
      },
    });
    const transport = new HeadlessRoomJourneyTransport({
      threadId: 'synthetic-thread',
      chatId: 'synthetic-room',
      userId: 'synthetic-user',
      runtimeRoot: root,
      traceRoot: path.join(root, 'trace'),
      runtimeFactory,
      modelRoleMap: {
        policy_id: 'portfolio_benchmark_default',
        revision: 2,
        assignments: { source_grounder: { provider: 'claude', model: '' } },
        model_policy: {
          schema_version: 'ddalggak.room_model_role_policy/v1',
          policy_id: 'portfolio_benchmark_default',
          policy_scope: 'benchmark',
          policy_revision: 2,
          default_assignment: [{ role: 'source_grounder', provider: 'claude', model: '' }],
          governance: { room_override_mode: 'role_by_role_merge' },
        },
      },
    });
    await transport.initialize();
    const installedProfile = runtimeCore.chatSessionStore.get('synthetic-room').agent_room_profile;
    assert.equal(installedProfile.model_policy.policy_scope, 'room_experiment');
    assert.equal(installedProfile.model_policy.inherited_policy_id, 'portfolio_benchmark_default');
    assert.equal(installedProfile.model_policy.inherited_policy_revision, 2);
    assert.equal(installedProfile.model_policy.governance.room_policy_learning, 'proposal_then_trial_then_approval');
    const command = await transport.sendCommand('/rule structured output');
    const result = await transport.sendMessage('hello');
    assert.equal(command.ok, true);
    assert.equal(result.ok, true);
    assert.match(result.output, /headless reply/);
    assert.equal(transport.events.filter((row) => row.event_type === 'run.agent_start').length, 1);
    assert.equal(result.room_state.runtime_rules.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('plan-only journey writes a plan without initializing transport', async () => {
  const root = makeTestTempDir('room-journey-plan-');
  try {
    const scenario = { id: 'plan_case', title: 'Plan', steps: [{ id: 'one', action: 'send_message', text: 'hello' }] };
    const result = await runRoomJourneyScenario({
      scenario,
      outputRoot: root,
      execute: false,
      transport: { async initialize() { throw new Error('must not initialize'); } },
    });
    assert.equal(result.summary.status, 'planned');
    assert.ok(fs.existsSync(path.join(result.runDir, 'summary.json')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('executed journey records memory lifecycle, projection, runtime events, and semantic judgment', async () => {
  const root = makeTestTempDir('room-journey-run-');
  const traceRoot = path.join(root, 'trace');
  try {
    const scenario = {
      id: 'memory_case',
      title: 'Memory case',
      semantic_judge: { required: true },
      steps: [
        { id: 'state', action: 'send_message', text: '조용한 장소를 선호해' },
        { id: 'candidate', action: 'generate_memory_candidates' },
        { id: 'approve', action: 'approve_memory' },
        { id: 'reuse', action: 'send_message', text: '지난 조건으로 기준을 알려줘' },
      ],
      assertions: [
        { id: 'commit', type: 'memory_commit_count', min: 1 },
        { id: 'projected', type: 'approved_memory_projected' },
        { id: 'completed', type: 'step_ok', step_id: 'reuse' },
        { id: 'role_map', type: 'model_role_map_alignment', min: 1, quality_metric: false },
      ],
      semantic_rubric: [{ id: 'uptake', description: 'Uses approved preference' }],
    };
    const transport = new FakeJourneyTransport({ chatId: 'chat-1', traceRoot });
    const result = await runRoomJourneyScenario({
      scenario,
      outputRoot: path.join(root, 'runs'),
      execute: true,
      traceRoot,
      transport,
      options: {
        chatId: 'chat-1',
        judgeProvider: 'claude',
        judgeExecutor: async () => ({ ok: true, stdout: JSON.stringify({ passed: true, score: 0.92, summary: 'good', rubric: [], findings: [] }) }),
        modelRoleMap: { assignments: { code_executor: { provider: 'codex', model: 'gpt-5.5' } } },
      },
    });
    assert.equal(result.summary.status, 'passed');
    assert.equal(result.summary.metrics.semantic_score, 0.92);
    assert.equal(result.summary.metrics.semantic_judge_present, true);
    assert.equal(result.summary.metrics.execution_status, 'valid_execution');
    assert.equal(result.summary.trace_contract.raw_provider_prompts_saved, true);
    assert.equal(result.summary.trace_contract.sensitive_debug_artifacts_present, true);
    assert.ok(result.summary.assertions.find((row) => row.id === 'projected')?.passed);
    assert.ok(fs.existsSync(path.join(result.runDir, 'memory_commits.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'context_projections.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'provider_invocations.jsonl')));
    const cliRows = fs.readFileSync(path.join(result.runDir, 'cli_calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(cliRows.length >= 2);
    assert.ok(cliRows.every((row) => row.status === 'succeeded'));
    assert.ok(result.summary.assertions.find((row) => row.id === 'role_map')?.passed);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('step-scoped runtime assertions isolate target-turn events from earlier Room turns', () => {
  const intakeStart = runtimeEvent('run.agent_start', { agent_id: 'intake', provider: 'codex', model: 'gpt-5.4', model_role: 'source_grounder', execution_channel: 'local_cli' }, 'run-intake');
  const intakeFinish = runtimeEvent('run.agent_finish', { agent_id: 'intake', provider: 'codex', model: 'gpt-5.4', model_role: 'source_grounder', execution_channel: 'local_cli', role_output_valid: true }, 'run-intake');
  const targetStart = runtimeEvent('run.agent_start', { agent_id: 'researcher', provider: 'antigravity', model: 'ag-fast', model_role: 'source_grounder', execution_channel: 'local_cli' }, 'run-target');
  const targetFinish = runtimeEvent('run.agent_finish', { agent_id: 'researcher', provider: 'antigravity', model: 'ag-fast', model_role: 'source_grounder', execution_channel: 'local_cli', role_output_valid: true }, 'run-target');
  const context = {
    runtimeEvents: [intakeStart, intakeFinish, targetStart, targetFinish],
    stepsById: {
      provide_evidence: { result: { events: [intakeStart, intakeFinish] } },
      request_decision: { result: { events: [targetStart, targetFinish] } },
    },
  };
  const scoped = runtimeEventsForAssertion(context, { step_id: 'request_decision' });
  assert.equal(scoped.length, 2);
  assert.ok(scoped.every((event) => event.run_id === 'run-target'));
});

test('concierge routing observation records shadow predictions without shrinking persistent Room state', () => {
  const scenario = {
    id: 'routing_probe',
    routing_experiment: {
      target_step_id: 'probe',
      candidate_shapes: { solo: 'single_agent_with_retrieval' },
      minimum_semantic_score: 0.8,
      quality_tolerance: 0.05,
    },
  };
  const targetStart = runtimeEvent('run.agent_start', { provider: 'codex', model: 'gpt-5.4', model_role: 'concierge_router', execution_channel: 'local_cli' }, 'run-probe');
  const targetFinish = runtimeEvent('run.agent_finish', { provider: 'codex', model: 'gpt-5.4', model_role: 'concierge_router', execution_channel: 'local_cli', role_output_valid: true }, 'run-probe');
  const result = {
    summary: {
      scenario_id: 'routing_probe',
      arm: { id: 'solo', collaboration_profile: 'solo' },
      metrics: { semantic_score: 0.95, semantic_judge_present: true },
    },
    steps: [
      {
        step: { id: 'setup', action: 'send_message', text: '정식 출시일은 9월 18일이야.' },
        started_at: '2026-07-14T00:00:00.000Z',
        completed_at: '2026-07-14T00:00:01.000Z',
        result: { ok: true, room_state: { recent_room_turn_count: 6, room_memory_items: [{ memory_id: 'm1' }], runtime_rules: [{ id: 'r1' }] } },
      },
      {
        step: { id: 'probe', action: 'send_message', text: '정식 출시 목표일만 한 줄로 답해줘.' },
        started_at: '2026-07-14T00:00:02.000Z',
        completed_at: '2026-07-14T00:00:03.500Z',
        result: { ok: true, events: [targetStart, targetFinish], room_state: { recent_room_turn_count: 8, room_memory_items: [{ memory_id: 'm1' }], runtime_rules: [{ id: 'r1' }] } },
      },
    ],
    runtimeEvents: [targetStart, targetFinish],
  };
  const observation = buildConciergeRoutingObservation({ scenario, result });
  assert.equal(observation.execution_shape, 'single_agent_with_retrieval');
  assert.equal(observation.target_execution_valid, true);
  assert.equal(observation.room_complexity_before_target.recent_room_turn_count, 6);
  assert.equal(observation.room_complexity_before_target.room_memory_item_count, 1);
  assert.ok(observation.shadow_predictions.room_concierge.route);
  assert.ok(observation.shadow_predictions.room_turn_router.execution_shape);
});

test('concierge routing label selects the least complex valid shape within semantic tolerance', () => {
  const scenario = {
    id: 'routing_label_probe',
    routing_experiment: {
      target_step_id: 'probe',
      minimum_semantic_score: 0.8,
      quality_tolerance: 0.05,
      shape_complexity_order: ['state_update', 'single_agent_with_retrieval', 'builder_reviewer', 'evidence_panel'],
    },
  };
  const label = deriveConciergeRoutingLabel({
    scenario,
    observations: [
      { arm_id: 'solo', execution_shape: 'single_agent_with_retrieval', execution_shape_rank: 1, target_execution_valid: true, semantic_judge_present: true, semantic_score: 0.92, target_step_duration_ms: 1200, target_text: '목표일은?', room_complexity_before_target: {}, shadow_predictions: {} },
      { arm_id: 'builder', execution_shape: 'builder_reviewer', execution_shape_rank: 2, target_execution_valid: true, semantic_judge_present: true, semantic_score: 0.95, target_step_duration_ms: 5000, target_text: '목표일은?', room_complexity_before_target: {}, shadow_predictions: {} },
    ],
  });
  assert.equal(label.target_execution_shape, 'single_agent_with_retrieval');
  assert.equal(label.target_arm_id, 'solo');
  assert.equal(label.label_basis, 'minimal_sufficient_execution_shape_within_quality_tolerance_after_measurement_validity_gate');
});

test('concierge routing label is withheld when semantic evidence is insufficient', () => {
  const scenario = { id: 'routing_no_label', routing_experiment: { target_step_id: 'probe' } };
  const label = deriveConciergeRoutingLabel({
    scenario,
    observations: [
      { arm_id: 'solo', execution_shape: 'single_agent', execution_shape_rank: 2, target_execution_valid: true, semantic_judge_present: false, semantic_score: null },
      { arm_id: 'team', execution_shape: 'evidence_panel', execution_shape_rank: 7, target_execution_valid: false, semantic_judge_present: true, semantic_score: 0.9 },
    ],
  });
  assert.equal(label, null);
});

test('concierge routing observation separates candidate-specific collaboration state from label-safe pre-route input', () => {
  const scenario = {
    id: 'routing_leakage_probe',
    routing_experiment: { target_step_id: 'probe', candidate_shapes: { panel: 'evidence_panel' } },
    steps: [
      { id: 'setup', action: 'send_message', text: '기준 사실을 누적해줘.' },
      { id: 'probe', action: 'send_message', text: '결정해줘.' },
    ],
  };
  const finish = runtimeEvent('run.agent_finish', { provider: 'codex', model: 'gpt-5.4', model_role: 'delivery_synthesizer', execution_channel: 'local_cli', role_output_valid: true }, 'run-probe');
  const result = {
    summary: { arm: { id: 'panel' }, metrics: { semantic_score: 0.9, semantic_judge_present: true } },
    steps: [
      { step: scenario.steps[0], started_at: '2026-07-14T00:00:00.000Z', completed_at: '2026-07-14T00:00:01.000Z', result: { ok: true, room_state: { recent_room_turn_count: 2, collaboration_profile_id: 'evidence_panel' } } },
      { step: scenario.steps[1], started_at: '2026-07-14T00:00:02.000Z', completed_at: '2026-07-14T00:00:03.000Z', result: { ok: true, room_state: { recent_room_turn_count: 4, collaboration_profile_id: 'evidence_panel' } } },
    ],
    runtimeEvents: [finish],
    trace: [],
  };
  const observation = buildConciergeRoutingObservation({ scenario, result });
  assert.equal(observation.candidate_specific_pre_route_state.collaboration_profile_id, 'evidence_panel');
  assert.equal('collaboration_profile_id' in observation.pre_route_room_snapshot, false);
  assert.equal(observation.pre_route_input_snapshot.snapshot_mode, 'independent_arm_replay');
});

test('concierge routing measurement gate quarantines comparisons that require a frozen snapshot and verified context coverage', () => {
  const scenario = {
    id: 'routing_quarantine_probe',
    routing_experiment: {
      target_step_id: 'probe',
      required_context_step_ids: ['fact_1'],
      measurement_policy: {
        label_status: 'quarantine',
        require_context_parity: true,
        require_context_coverage_evidence: true,
        require_frozen_pre_target_snapshot: true,
      },
    },
  };
  const base = {
    target_execution_valid: true,
    semantic_judge_present: true,
    semantic_score: 0.95,
    pre_route_input_snapshot: { sha256: 'same', snapshot_mode: 'independent_arm_replay' },
    pre_route_room_snapshot_sha256: 'room-same',
    measurement_validity: { invalid_reasons: ['context_coverage_evidence_unverified', 'frozen_pre_target_snapshot_unavailable', 'label_quarantined_by_experiment_policy'] },
  };
  const observations = finalizeConciergeRoutingObservations({
    scenario,
    observations: [
      { ...base, arm_id: 'solo', execution_shape: 'single_agent_with_retrieval', execution_shape_rank: 3 },
      { ...base, arm_id: 'panel', execution_shape: 'evidence_panel', execution_shape_rank: 7 },
    ],
  });
  assert.equal(observations.every((row) => row.context_parity.valid), true);
  assert.equal(observations.every((row) => row.training_label_eligible === false), true);
  assert.equal(deriveConciergeRoutingLabel({ scenario, observations }), null);
});


test('step-scoped model-role alignment ignores earlier normal-turn provider assignments', async () => {
  const root = makeTestTempDir('room-journey-step-scoped-role-map-');
  try {
    let turn = 0;
    const transport = {
      chatId: 'step-scoped-room',
      events: [],
      async initialize() {},
      async sendCommand() { return { ok: true }; },
      async sendMessage(text) {
        turn += 1;
        const runId = `run-${turn}`;
        const provider = turn === 1 ? 'codex' : 'antigravity';
        const model = turn === 1 ? 'gpt-5.4' : 'ag-fast';
        const start = runtimeEvent('run.agent_start', { agent_id: 'researcher', provider, model, model_role: 'source_grounder', execution_channel: 'local_cli' }, runId);
        const finish = runtimeEvent('run.agent_finish', { agent_id: 'researcher', provider, model, model_role: 'source_grounder', execution_channel: 'local_cli', role_output_valid: true }, runId);
        this.events.push(start, finish);
        return { ok: true, output: `완료: ${text}`, run_id: runId, events: [start, finish], room_state: { recent_room_turn_count: turn * 2 } };
      },
    };
    const scenario = {
      id: 'step_scoped_role_map',
      experiment: {
        baseline: { id: 'evidence_panel', collaboration_profile: 'evidence_panel', model_policy: 'role_fit_distinct_models', input_kind: 'team_task' },
      },
      steps: [
        { id: 'intake', action: 'send_message', input_kind: 'normal', text: '사실을 반영해줘.' },
        { id: 'decision', action: 'send_message', text: '결정해줘.' },
      ],
      assertions: [
        { id: 'role_map', type: 'model_role_map_alignment', step_id: 'decision', min: 1 },
      ],
    };
    const result = await runRoomJourneyScenario({
      scenario,
      outputRoot: root,
      execute: true,
      transport,
      options: { modelRoleMap: { assignments: { source_grounder: { provider: 'antigravity', model: '' } } } },
    });
    assert.equal(result.summary.assertions.find((row) => row.id === 'role_map')?.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('routing suite writes observations and a conservative minimal-sufficient label', async () => {
  const root = makeTestTempDir('room-journey-routing-suite-');
  try {
    const scenarioFile = path.join(root, 'routing.json');
    fs.writeFileSync(scenarioFile, JSON.stringify({
      id: 'routing_case',
      routing_experiment: {
        target_step_id: 'probe',
        minimum_semantic_score: 0.8,
        quality_tolerance: 0.05,
        candidate_shapes: { solo: 'single_agent_with_retrieval', builder_reviewer: 'builder_reviewer' },
        shape_complexity_order: ['single_agent_with_retrieval', 'builder_reviewer'],
      },
      experiment: {
        baseline: { id: 'solo', collaboration_profile: 'solo', input_kind: 'normal' },
        challengers: [{ id: 'builder_reviewer', collaboration_profile: 'builder_reviewer', input_kind: 'team_task' }],
        promotion_gate: { min_quality_uplift: 0.05, require_semantic_evidence: true },
      },
      steps: [
        { id: 'setup', action: 'send_message', input_kind: 'normal', text: '출시일은 9월 18일이야.' },
        { id: 'probe', action: 'send_message', text: '출시일만 답해줘.' },
      ],
      assertions: [{ id: 'probe_ok', type: 'step_ok', step_id: 'probe' }],
      semantic_rubric: [{ id: 'correct', description: '출시일을 정확히 답한다.' }],
    }), 'utf8');
    const judgeExecutor = async () => ({ ok: true, stdout: JSON.stringify({ passed: true, score: 0.92, summary: 'good', rubric: [], findings: [] }) });
    const summary = await runRoomJourneySuite({
      scenarioFiles: [scenarioFile],
      outputRoot: path.join(root, 'runs'),
      execute: true,
      transportFactory: async ({ arm }) => new FakeJourneyTransport({
        chatId: `routing-${arm.id}`,
        traceRoot: path.join(root, 'trace'),
        models: arm.id === 'solo' ? ['gpt-5.5'] : ['gpt-5.5', 'ag-fast'],
      }),
      traceRoot: path.join(root, 'trace'),
      options: { judgeProvider: 'antigravity', judgeExecutor },
    });
    assert.equal(summary.concierge_routing_observation_count, 2);
    assert.equal(summary.concierge_routing_label_count, 1);
    assert.equal(summary.concierge_routing_experiments[0].selected_execution_shape, 'single_agent_with_retrieval');
    const labelRows = fs.readFileSync(path.join(root, 'runs', 'concierge_routing_labels.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(labelRows[0].target_execution_shape, 'single_agent_with_retrieval');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portfolio promotion requires measured uplift and optional semantic evidence', () => {
  const baseline = { quality_score: 0.70, required_fail: 0, duration_ms: 1000, cost_usd: 1, semantic_judge_present: true, execution_status: 'valid_execution' };
  const challenger = { quality_score: 0.84, required_fail: 0, duration_ms: 1800, cost_usd: 2.2, semantic_judge_present: true, execution_status: 'valid_execution' };
  const promoted = evaluatePortfolioPromotion({ baseline, challenger, gate: { min_quality_uplift: 0.08, max_cost_ratio: 3, max_latency_ratio: 3, require_semantic_evidence: true } });
  assert.equal(promoted.promote, true);
  const noJudge = evaluatePortfolioPromotion({ baseline: { ...baseline, semantic_judge_present: false }, challenger, gate: { min_quality_uplift: 0.08, require_semantic_evidence: true } });
  assert.equal(noJudge.promote, false);
  assert.ok(noJudge.reasons.includes('semantic_evidence_missing'));
});

test('portfolio promotion can require cost and exact resolved model identity evidence', () => {
  const baseline = { quality_score: 0.8, required_fail: 0, duration_ms: 1000, cost_usd: null, semantic_judge_present: true, execution_status: 'valid_execution', exact_model_identity_complete: true };
  const challenger = { quality_score: 0.95, required_fail: 0, duration_ms: 1500, cost_usd: null, semantic_judge_present: true, execution_status: 'valid_execution', exact_model_identity_complete: false };
  const result = evaluatePortfolioPromotion({ baseline, challenger, gate: { min_quality_uplift: 0.05, require_cost_evidence: true, require_exact_model_identity: true } });
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.promote, false);
  assert.ok(result.reasons.includes('cost_evidence_missing'));
  assert.ok(result.reasons.includes('exact_model_identity_missing'));
});

test('portfolio comparison refuses to score faster failures as quality or latency wins', () => {
  const result = evaluatePortfolioPromotion({
    baseline: { quality_score: 0.2, required_fail: 2, duration_ms: 4000, semantic_judge_present: true, execution_status: 'invalid_execution' },
    challenger: { quality_score: 0.3, required_fail: 1, duration_ms: 1000, semantic_judge_present: true, execution_status: 'invalid_execution' },
    gate: { min_quality_uplift: 0.05 },
  });
  assert.equal(result.status, 'invalid_execution');
  assert.equal(result.promote, false);
  assert.equal(result.quality_uplift, null);
  assert.equal(result.latency_ratio, null);
  assert.ok(result.reasons.includes('baseline_invalid_execution'));
  assert.ok(result.reasons.includes('challenger_invalid_execution'));
});



test('portfolio comparison is invalid when the collaboration graph did not materialize', () => {
  const result = evaluatePortfolioPromotion({
    baseline: {
      quality_score: 0.7,
      required_fail: 0,
      duration_ms: 1000,
      semantic_judge_present: true,
      execution_status: 'valid_execution',
      collaboration_execution_status: 'not_applicable',
    },
    challenger: {
      quality_score: 0.8,
      required_fail: 2,
      duration_ms: 1100,
      semantic_judge_present: true,
      execution_status: 'valid_execution',
      collaboration_execution_status: 'invalid_collaboration_execution',
      collaboration_assertion_failures: ['roles', 'lanes'],
    },
    gate: { min_quality_uplift: 0.05 },
  });
  assert.equal(result.status, 'invalid_collaboration_execution');
  assert.equal(result.promote, false);
  assert.equal(result.quality_uplift, null);
  assert.equal(result.latency_ratio, null);
  assert.deepEqual(result.reasons, ['challenger_collaboration_graph_not_materialized', 'roles', 'lanes']);
});

test('negative response assertions fail when the requested turn failed or returned an empty response', async () => {
  const root = makeTestTempDir('room-journey-empty-response-');
  try {
    const scenario = {
      id: 'empty_negative_case',
      steps: [{ id: 'request', action: 'send_message', text: 'hello' }],
      assertions: [{ id: 'not_stale', type: 'response_not_regex', step_id: 'request', pattern: 'stale' }],
    };
    const transport = {
      chatId: 'empty-room',
      events: [runtimeEvent('run.agent_start', { provider: 'codex', model: 'gpt-test', execution_channel: 'local_cli' })],
      async initialize() {},
      async sendMessage() { return { ok: false, output: '' }; },
    };
    const result = await runRoomJourneyScenario({ scenario, outputRoot: root, execute: true, transport });
    assert.equal(result.summary.status, 'failed');
    assert.equal(result.summary.assertions[0].passed, false);
    assert.equal(result.summary.assertions[0].observed.eligible, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('suite compares isolated solo and multi-model arms without counting architecture assertions as quality', async () => {
  const root = makeTestTempDir('room-journey-suite-');
  try {
    const scenarioFile = path.join(root, 'scenario.json');
    fs.writeFileSync(scenarioFile, JSON.stringify({
      id: 'portfolio_case',
      experiment: {
        baseline: { id: 'solo', collaboration_profile: 'solo' },
        challengers: [{ id: 'builder_reviewer', collaboration_profile: 'builder_reviewer' }],
        promotion_gate: { min_quality_uplift: 0.1, require_semantic_evidence: false },
      },
      steps: [{ id: 'request', action: 'send_message', text: 'artifact' }],
      assertions: [
        { id: 'done', type: 'step_ok', step_id: 'request' },
        { id: 'multi', type: 'distinct_model_node_count', arms: ['builder_reviewer'], min: 2, quality_metric: false },
      ],
    }), 'utf8');
    const summary = await runRoomJourneySuite({
      scenarioFiles: [scenarioFile],
      outputRoot: path.join(root, 'runs'),
      execute: true,
      transportFactory: async ({ arm }) => new FakeJourneyTransport({ chatId: `chat-${arm.id}`, traceRoot: path.join(root, 'trace'), models: arm.id === 'solo' ? ['gpt-5.5'] : ['gpt-5.5', 'claude-opus'] }),
      traceRoot: path.join(root, 'trace'),
    });
    assert.equal(summary.run_count, 2);
    assert.equal(summary.portfolio_comparisons.length, 1);
    assert.equal(summary.results.find((row) => row.arm.id === 'builder_reviewer').metrics.quality_assertion_count, 1);
    assert.equal(summary.portfolio_comparisons[0].promote, false);
    assert.ok(summary.portfolio_comparisons[0].reasons.includes('quality_uplift_below_gate'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless transient context clear removes recency fallbacks but preserves governed Room memory', async () => {
  const root = makeTestTempDir('room-journey-clear-transient-');
  try {
    const sessions = new Map();
    const jobDir = path.join(root, 'job');
    fs.mkdirSync(path.join(jobDir, 'local_memory', 'role_summaries'), { recursive: true });
    fs.mkdirSync(path.join(jobDir, 'shared'), { recursive: true });
    for (const relative of [
      'local_memory/turns.jsonl',
      'local_memory/room_turn_ledger.jsonl',
      'local_memory/summary.md',
      'local_memory/iteration_delta.md',
      'local_memory/role_summaries/researcher.md',
      'shared/room_turn_ledger.jsonl',
      'conversation.jsonl',
      'user_facts.jsonl',
    ]) {
      const target = path.join(jobDir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'transient\n', 'utf8');
    }
    sessions.set('synthetic-room', {
      state: 'idle',
      recent_room_turns: [{ role: 'user', text: 'recent preference' }],
      last_room_turn: { role: 'assistant', text: 'recent reply' },
      recent_agent_turns: [{ agent_id: 'researcher', text: 'recent agent' }],
      room_memory_items: [{ memory_id: 'mem-approved', status: 'active', summary: 'durable preference' }],
    });
    const runtimeCore = {
      chatSessionStore: {
        get(chatId) { return sessions.get(String(chatId)) || {}; },
        upsert(chatId, patchOrUpdater) {
          const current = this.get(chatId);
          const patch = typeof patchOrUpdater === 'function' ? patchOrUpdater(current) : patchOrUpdater;
          sessions.set(String(chatId), { ...current, ...patch });
          return sessions.get(String(chatId));
        },
      },
      resolveCurrentJobIdForChat() { return 'job-1'; },
      jobs: { jobDir() { return jobDir; } },
    };
    const transport = new HeadlessRoomJourneyTransport({
      threadId: 'thread',
      chatId: 'synthetic-room',
      userId: 'user',
      runtimeRoot: root,
      traceRoot: path.join(root, 'trace'),
      runtimeFactory: async () => ({
        bot: { mark() { return 0; }, messagesSince() { return []; } },
        runtimeCore,
        chatRunManager: { isRunning() { return false; } },
        async handleRoomCommand() { return true; },
      }),
    });

    await transport.initialize();
    const result = await transport.clearTransientConversationContext();
    const session = runtimeCore.chatSessionStore.get('synthetic-room');
    assert.equal(result.ok, true);
    assert.deepEqual(session.recent_room_turns, []);
    assert.equal(session.last_room_turn, null);
    assert.deepEqual(session.recent_agent_turns, []);
    assert.equal(session.room_memory_items?.[0]?.memory_id, 'mem-approved');
    assert.equal(fs.existsSync(path.join(jobDir, 'local_memory', 'turns.jsonl')), false);
    assert.equal(fs.existsSync(path.join(jobDir, 'local_memory', 'role_summaries')), false);
    assert.equal(fs.existsSync(path.join(jobDir, 'shared', 'room_turn_ledger.jsonl')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('solo portfolio baseline is not failed by challenger model-role-map alignment', async () => {
  const root = makeTestTempDir('room-journey-solo-role-map-');
  try {
    const scenario = {
      id: 'solo_role_map_case',
      steps: [{ id: 'request', action: 'send_message', text: 'artifact' }],
      assertions: [
        { id: 'done', type: 'step_ok', step_id: 'request' },
        { id: 'role_map', type: 'model_role_map_alignment', min: 1, quality_metric: false },
      ],
    };
    const arm = { id: 'solo', model_policy: 'strongest_suitable_single', setup_commands: [], metadata: {} };
    const transport = new FakeJourneyTransport({ chatId: 'solo-role-map', traceRoot: path.join(root, 'trace'), models: ['gpt-5.5'] });
    const result = await runRoomJourneyScenario({
      scenario,
      arm,
      outputRoot: root,
      execute: true,
      transport,
      options: {
        modelRoleMap: { assignments: { code_executor: { provider: 'claude', model: 'claude-review' } } },
      },
    });
    const alignment = result.summary.assertions.find((row) => row.id === 'role_map');
    assert.equal(alignment.passed, true);
    assert.equal(alignment.quality_metric, false);
    assert.deepEqual(alignment.observed, { skipped: true, reason: 'solo_baseline_uses_single_model_policy' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('headless transport prefers the full captured user-facing response over the clipped run summary', async () => {
  const root = makeTestTempDir('room-journey-full-output-');
  try {
    const eventFile = path.join(root, 'runtime_events.jsonl');
    const botMessages = [];
    let sequence = 0;
    const fullText = `FULL_RESPONSE:${'x'.repeat(1400)}`;
    const bot = {
      mark() { return sequence; },
      messagesSince(mark, chatId) { return botMessages.filter((row) => row.sequence > mark && row.chat_id === chatId); },
      async sendMessage(chatId, text) { sequence += 1; botMessages.push({ sequence, method: 'sendMessage', chat_id: chatId, text }); return { message_id: sequence, text }; },
    };
    const runtimeCore = {
      chatSessionStore: { clear() {}, get() { return { state: 'idle' }; }, upsert(_id, patch) { return typeof patch === 'function' ? patch({ state: 'idle' }) : patch; } },
      resolveCurrentJobIdForChat() { return 'job-full-output'; },
      jobs: { jobDir() { return root; } },
    };
    const runtimeFactory = async () => ({
      bot,
      runtimeCore,
      getLastRunResult() { return { replyText: fullText }; },
      chatRunManager: {
        isRunning() { return false; },
        async handleIncoming({ chatId }) {
          const events = [runtimeEvent('run.finish', { status: 'done', summary: 'CLIPPED_SUMMARY' })];
          fs.writeFileSync(eventFile, events.map((row, index) => JSON.stringify({ ...row, event_sequence: index + 1, job_id: 'job-full-output' })).join('\n') + '\n');
          await bot.sendMessage(chatId, 'INTERNAL_PROGRESS');
          await bot.sendMessage(chatId, fullText);
          return { status: 'started' };
        },
      },
      async handleRoomCommand() { return true; },
    });
    const transport = new HeadlessRoomJourneyTransport({ threadId: 't', chatId: 'c', userId: 'u', runtimeRoot: root, traceRoot: path.join(root, 'trace'), runtimeFactory });
    const result = await transport.sendMessage('hello');
    assert.equal(result.output, fullText);
    assert.equal(result.full_user_response, fullText);
    assert.equal(result.run_summary, 'CLIPPED_SUMMARY');
    assert.match(result.orchestration_transcript, /INTERNAL_PROGRESS/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portfolio execution distinguishes recovered CLI failures from terminal failures', async () => {
  const root = makeTestTempDir('room-journey-recovered-cli-');
  try {
    const scenario = {
      id: 'recovered_cli_case',
      steps: [{ id: 'request', action: 'send_message', text: 'review this' }],
      assertions: [
        { id: 'no_terminal_failure', type: 'cli_failure_count', max: 0, quality_metric: false },
        { id: 'one_recovered_failure', type: 'cli_recovered_failure_count', min: 1, max: 1, quality_metric: false },
      ],
    };
    const events = [
      runtimeEvent('run.agent_start', { agent_id: 'reviewer', provider: 'claude', model_role: 'verifier_critic', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_error', { agent_id: 'reviewer', provider: 'claude', model_role: 'verifier_critic', execution_channel: 'local_cli', error: '[timeout] killed after 300000ms' }),
      runtimeEvent('run.agent_start', { agent_id: 'reviewer', provider: 'claude', model_role: 'verifier_critic', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_finish', { agent_id: 'reviewer', provider: 'claude', model: 'claude-haiku', model_role: 'verifier_critic', execution_channel: 'local_cli' }),
    ];
    const transport = { chatId: 'recovered-room', events, async initialize() {}, async sendMessage() { return { ok: true, output: 'review complete', events }; } };
    const result = await runRoomJourneyScenario({ scenario, outputRoot: root, execute: true, transport });
    assert.equal(result.summary.metrics.execution_status, 'valid_degraded_execution');
    assert.equal(result.summary.metrics.cli_failure_count, 0);
    assert.equal(result.summary.metrics.cli_recovered_failure_count, 1);
    assert.equal(result.summary.status, 'passed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portfolio promotion scores degraded execution but does not promote it by default', () => {
  const result = evaluatePortfolioPromotion({
    baseline: { quality_score: 0.7, required_fail: 0, duration_ms: 1000, semantic_judge_present: true, execution_status: 'valid_execution' },
    challenger: { quality_score: 0.9, required_fail: 0, duration_ms: 1200, semantic_judge_present: true, execution_status: 'valid_degraded_execution', collaboration_execution_status: 'valid_collaboration_execution' },
    gate: { min_quality_uplift: 0.05, max_latency_ratio: 3 },
  });
  assert.equal(result.status, 'not_promoted');
  assert.ok(Math.abs(result.quality_uplift - 0.2) < 1e-9);
  assert.ok(result.reasons.includes('challenger_degraded_execution'));
});

test('portfolio model identity uses successful resolved models instead of requested default aliases', async () => {
  const root = makeTestTempDir('room-journey-resolved-model-');
  try {
    const scenario = {
      id: 'resolved_model_identity_case',
      steps: [{ id: 'request', action: 'send_message', text: 'analyze this' }],
      assertions: [{ id: 'one_model', type: 'distinct_model_node_count', max: 1, quality_metric: false }],
    };
    const events = [
      runtimeEvent('run.agent_start', { agent_id: 'researcher', provider: 'codex', model: 'default', requested_model: 'default', model_role: 'source_grounder', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_finish', { agent_id: 'researcher', provider: 'codex', model: 'default', requested_model: 'gpt-5.4', resolved_model: 'default', model_role: 'source_grounder', execution_channel: 'local_cli', role_output_valid: true }),
      runtimeEvent('run.agent_start', { agent_id: 'reviewer', provider: 'codex', model: '@provider_default', requested_model: 'gpt-5.4', model_role: 'verifier_critic', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_finish', { agent_id: 'reviewer', provider: 'codex', model: 'gpt-5.4', requested_model: 'gpt-5.4', resolved_model: 'gpt-5.4', model_role: 'verifier_critic', execution_channel: 'local_cli', role_output_valid: true }),
    ];
    const transport = {
      chatId: 'resolved-model-room',
      events,
      async initialize() {},
      async sendMessage() { return { ok: true, output: 'done', events }; },
    };
    const result = await runRoomJourneyScenario({ scenario, outputRoot: root, execute: true, transport });
    assert.equal(result.summary.metrics.model_node_count, 1);
    assert.equal(result.summary.metrics.exact_model_identity_complete, true);
    assert.deepEqual(result.summary.metrics.resolved_models, ['gpt-5.4']);
    assert.equal(result.summary.assertions.find((row) => row.id === 'one_model')?.passed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('evidence panel treats source intake as a normal turn and reserves the full panel for the decision turn', () => {
  const scenario = loadRoomJourneyScenario(path.resolve('scenarios/room_journeys/portfolio_evidence_panel.json'));
  const provideEvidence = scenario.steps.find((step) => step.id === 'provide_evidence');
  const decision = scenario.steps.find((step) => step.id === 'request_decision');
  const challenger = scenarioArms(scenario).find((arm) => arm.id === 'evidence_panel');
  assert.equal(provideEvidence.input_kind, 'normal');
  assert.equal(decision.input_kind, undefined);
  assert.equal(challenger.input_kind, 'team_task');
});


test('portfolio metrics do not count provider-success outputs that failed the role task contract', async () => {
  const root = makeTestTempDir('room-journey-invalid-role-output-');
  try {
    const scenario = {
      id: 'invalid_role_output_case',
      steps: [{ id: 'request', action: 'send_message', text: 'compare options' }],
      assertions: [
        { id: 'valid_roles', type: 'successful_provider_role_count', min: 1, quality_metric: false },
      ],
    };
    const events = [
      runtimeEvent('run.agent_start', { agent_id: 'researcher', provider: 'antigravity', model_role: 'source_grounder', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_error', { agent_id: 'researcher', provider: 'antigravity', model_role: 'source_grounder', execution_channel: 'local_cli', provider_execution_success: true, role_output_valid: false, role_output_validation_reason: 'missing_assigned_task_refusal', error: 'role output invalid: missing_assigned_task_refusal' }),
      runtimeEvent('run.agent_start', { agent_id: 'synthesizer', provider: 'codex', model: 'gpt-5.4', requested_model: 'gpt-5.4', resolved_model: 'gpt-5.4', model_role: 'delivery_synthesizer', execution_channel: 'local_cli' }),
      runtimeEvent('run.agent_finish', { agent_id: 'synthesizer', provider: 'codex', model: 'gpt-5.4', requested_model: 'gpt-5.4', resolved_model: 'gpt-5.4', model_role: 'delivery_synthesizer', execution_channel: 'local_cli', role_output_valid: true }),
    ];
    const transport = { chatId: 'invalid-role-room', events, async initialize() {}, async sendMessage() { return { ok: true, output: 'final', events }; } };
    const result = await runRoomJourneyScenario({ scenario, outputRoot: root, execute: true, transport });
    assert.deepEqual(result.summary.assertions.find((row) => row.id === 'valid_roles')?.observed, ['delivery_synthesizer']);
    assert.equal(result.summary.metrics.cli_success_count, 1);
    assert.equal(result.summary.metrics.cli_failure_count, 1);
    const cliRows = fs.readFileSync(path.join(result.runDir, 'cli_calls.jsonl'), 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(cliRows.some((row) => row.role_output_valid === false && row.provider_execution_success === true));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
