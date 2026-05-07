import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractTeamCreationSignals } from '../src/application/team_signal_extractor.js';
import { buildTeamWorkflowContract } from '../src/application/team_workflow_contract.js';
import { verifyExecutionAgainstWorkflowContract } from '../src/application/execution_contract_verifier.js';
import { selectAdaptiveExecutionMode } from '../src/application/execution_mode_adaptation.js';
import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';
import { addSemanticIndexItems, searchSemanticIndex } from '../src/application/semantic_index.js';

test('team signal extractor recognizes loop/review/approval workflow from indirect user request', () => {
  const request = '이 작업을 계속 점검하고 개선하는 loop로 돌려줘. 매 개선마다 구현을 review해. 큰 변경이나 위험한 작업은 승인을 받아. 중단 조건은 Novel하고 충분히 완성된 사이트가 나오면 중단해.';
  const signals = extractTeamCreationSignals({ request, goal: request, message: request });
  assert.equal(signals.source_signals.indirect_user_request, true);
  assert.equal(signals.workflow_intent.continuous_loop, true);
  assert.equal(signals.workflow_intent.review_required, true);
  assert.equal(signals.workflow_intent.approval_boundary, true);
  assert.equal(signals.workflow_intent.stop_condition_present, true);
  assert.ok(signals.recommended_roles.includes('builder'));
  assert.ok(signals.recommended_roles.includes('reviewer'));
});

test('workflow contract converts loop request into bounded continuous loop contract', () => {
  const request = '계속 점검하고 개선하는 loop로 돌리고 매 개선마다 review해줘. 큰 변경은 승인 받아.';
  const signals = extractTeamCreationSignals({ request });
  const contract = buildTeamWorkflowContract({ signals, goal: request });
  assert.equal(contract.workflow_kind, 'bounded_continuous_loop');
  assert.equal(contract.review_each_iteration, true);
  assert.equal(contract.approval_boundary, true);
  assert.ok(contract.required_passes.includes('stop_condition_evaluation'));
  assert.ok(contract.min_iterations >= 2);
});

test('adaptive execution chooses multi motif for bounded loop even without explicit multi-agent wording', () => {
  const request = '국내 주식투자 웹사이트를 계속 점검하고 개선하는 loop로 돌려줘. 매 개선마다 review하고 큰 변경은 승인 받아.';
  const selection = selectAdaptiveExecutionMode({
    goal: request,
    message: request,
    taskInterpretation: {
      goal: request,
      task_type: 'implementation',
      deliverable_type: 'website',
      candidate_capability_slots: [
        { role_id: 'builder', purpose: 'implement' },
        { role_id: 'reviewer', purpose: 'review' },
      ],
    },
    runtimePolicy: { execution_mode_policy: { default_mode: 'single_compiled', allow_direct_multi_start: true } },
  });
  assert.equal(selection.mode, 'multi_motif');
  assert.ok(selection.reasons.includes('workflow_contract_bounded_loop'));
  assert.equal(selection.team_workflow_contract.workflow_kind, 'bounded_continuous_loop');
  assert.ok(selection.shaped_candidate_capability_slots.some((slot) => slot.role_id === 'reviewer'));
});

test('runtime orchestration selects a bounded loop team for loop/review request', () => {
  const request = '아예 처음부터 구현해줘. 계속 점검하고 개선하는 loop고, 매 개선마다 시스템 구현을 review해. 큰 변경은 승인 받아.';
  const registry = {
    agents: [
      { id: 'operator', role_type: 'operator', provider: 'gemini', model: 'gemini', prompt: 'operate' },
      { id: 'researcher', role_type: 'researcher', provider: 'gemini', model: 'gemini', prompt: 'research' },
      { id: 'builder', role_type: 'builder', provider: 'codex', model: 'codex', prompt: 'build' },
      { id: 'reviewer', role_type: 'reviewer', provider: 'gemini', model: 'gemini', prompt: 'review' },
      { id: 'synthesizer', role_type: 'synthesizer', provider: 'gemini', model: 'gemini', prompt: 'synthesize' },
    ],
  };
  const orchestration = buildRuntimeOrchestration({
    mode: 'run',
    goal: request,
    message: request,
    registry,
    runtimePolicy: { execution_mode_policy: { default_mode: 'single_compiled', allow_direct_multi_start: true } },
    maxAgents: 5,
  });
  assert.equal(orchestration.planner_metadata.execution_mode, 'multi_motif');
  assert.equal(orchestration.planner_metadata.team_workflow_contract.workflow_kind, 'bounded_continuous_loop');
  assert.ok(orchestration.runtime_agents.length >= 3);
  assert.ok(orchestration.runtime_agents.some((agent) => agent.role_id === 'reviewer'));
});

test('execution contract verifier flags loop routed as single path', () => {
  const contract = {
    workflow_kind: 'bounded_continuous_loop',
    min_iterations: 2,
    required_passes: ['implement_or_diagnose', 'review', 'stop_condition_evaluation'],
    approval_boundary: true,
    approval_required_for: ['large_change'],
  };
  const check = verifyExecutionAgainstWorkflowContract({
    contract,
    plannerMetadata: { execution_mode: 'single_compiled' },
    execution: { runtime_agents: [{ role_id: 'builder' }], iteration_count: 1 },
    executionInsights: { planned_agent_count: 1, observed_agent_count: 1 },
  });
  assert.equal(check.ok, false);
  assert.ok(check.violations.includes('loop_contract_routed_as_single_compiled'));
  assert.ok(check.violations.includes('review_pass_missing'));
});

test('semantic index sidecar stores and searches memory/skill items with source refs', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-index-'));
  addSemanticIndexItems({
    jobDir,
    items: [
      { itemType: 'memory', sourceRef: 'local_memory/summary.md', title: '뉴스 기반 주식 추천 memory', text: '최신 뉴스와 국내 주식 가격 영향을 분석한다.', metadata: { shape: 'source_knowledge_base' } },
      { itemType: 'skill', sourceRef: 'skills/news_stock_radar', title: '뉴스 주식 레이더 skill', text: '뉴스를 분석하고 관련 종목 후보를 점수화한다.', metadata: { capability: 'financial_news_analysis' } },
    ],
  });
  const result = searchSemanticIndex({ jobDir, query: '뉴스 종목 분석', itemTypes: ['skill', 'memory'] });
  assert.equal(result.items.length >= 1, true);
  assert.ok(result.items.some((item) => item.item_type === 'skill'));
});
