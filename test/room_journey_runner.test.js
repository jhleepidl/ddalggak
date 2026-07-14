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
  evaluatePortfolioPromotion,
  HeadlessRoomJourneyTransport,
  loadRoomJourneyScenario,
  loadRoomJourneySuite,
  runRoomJourneyScenario,
  runRoomJourneySuite,
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
  assert.equal(core.scenario_files.length, 4);
  assert.equal(portfolio.scenario_files.length, 3);
  const scenario = loadRoomJourneyScenario(portfolio.scenario_files[0]);
  assert.deepEqual(scenarioArms(scenario).map((arm) => arm.id), ['solo', 'builder_reviewer']);
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

test('portfolio promotion requires measured uplift and optional semantic evidence', () => {
  const baseline = { quality_score: 0.70, required_fail: 0, duration_ms: 1000, cost_usd: 1, semantic_judge_present: true, execution_status: 'valid_execution' };
  const challenger = { quality_score: 0.84, required_fail: 0, duration_ms: 1800, cost_usd: 2.2, semantic_judge_present: true, execution_status: 'valid_execution' };
  const promoted = evaluatePortfolioPromotion({ baseline, challenger, gate: { min_quality_uplift: 0.08, max_cost_ratio: 3, max_latency_ratio: 3, require_semantic_evidence: true } });
  assert.equal(promoted.promote, true);
  const noJudge = evaluatePortfolioPromotion({ baseline: { ...baseline, semantic_judge_present: false }, challenger, gate: { min_quality_uplift: 0.08, require_semantic_evidence: true } });
  assert.equal(noJudge.promote, false);
  assert.ok(noJudge.reasons.includes('semantic_evidence_missing'));
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
      chatRunManager: {
        isRunning() { return false; },
        async handleIncoming({ chatId }) {
          const events = [runtimeEvent('run.finish', { status: 'done', summary: 'CLIPPED_SUMMARY' })];
          fs.writeFileSync(eventFile, events.map((row, index) => JSON.stringify({ ...row, event_sequence: index + 1, job_id: 'job-full-output' })).join('\n') + '\n');
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
