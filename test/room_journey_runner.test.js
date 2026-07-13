import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomJourneyTrace } from '../src/application/room_journey_trace.js';
import {
  evaluatePortfolioPromotion,
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
      this.events.push(runtimeEvent('run.agent_start', { provider: index % 2 ? 'claude' : 'codex', model, model_role: index === 0 ? 'builder' : 'reviewer' }, runId));
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
  assert.equal(core.scenario_files.length, 3);
  assert.equal(portfolio.scenario_files.length, 3);
  const scenario = loadRoomJourneyScenario(portfolio.scenario_files[0]);
  assert.deepEqual(scenarioArms(scenario).map((arm) => arm.id), ['solo', 'builder_reviewer']);
});

test('plan-only journey writes a plan without initializing transport', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-journey-plan-'));
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-journey-run-'));
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
      },
    });
    assert.equal(result.summary.status, 'passed');
    assert.equal(result.summary.metrics.semantic_score, 0.92);
    assert.equal(result.summary.metrics.semantic_judge_present, true);
    assert.ok(result.summary.assertions.find((row) => row.id === 'projected')?.passed);
    assert.ok(fs.existsSync(path.join(result.runDir, 'memory_commits.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'context_projections.jsonl')));
    assert.ok(fs.existsSync(path.join(result.runDir, 'provider_invocations.jsonl')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('portfolio promotion requires measured uplift and optional semantic evidence', () => {
  const baseline = { quality_score: 0.70, required_fail: 0, duration_ms: 1000, cost_usd: 1, semantic_judge_present: true };
  const challenger = { quality_score: 0.84, required_fail: 0, duration_ms: 1800, cost_usd: 2.2, semantic_judge_present: true };
  const promoted = evaluatePortfolioPromotion({ baseline, challenger, gate: { min_quality_uplift: 0.08, max_cost_ratio: 3, max_latency_ratio: 3, require_semantic_evidence: true } });
  assert.equal(promoted.promote, true);
  const noJudge = evaluatePortfolioPromotion({ baseline: { ...baseline, semantic_judge_present: false }, challenger, gate: { min_quality_uplift: 0.08, require_semantic_evidence: true } });
  assert.equal(noJudge.promote, false);
  assert.ok(noJudge.reasons.includes('semantic_evidence_missing'));
});

test('suite compares isolated solo and multi-model arms without counting architecture assertions as quality', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'room-journey-suite-'));
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
        { id: 'multi', type: 'distinct_model_count', arms: ['builder_reviewer'], min: 2, quality_metric: false },
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
