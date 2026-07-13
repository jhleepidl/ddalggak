import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createContinuityRunState,
  createContinuityTestPlan,
  judgeContinuityRun,
  loadContinuityRun,
  loadContinuityScenario,
  loadContinuitySuite,
} from '../src/evaluation/continuity_scenario_runner.js';

test('continuity core suite is data-driven and every scenario has generic actions and rubric', () => {
  const suite = loadContinuitySuite('scenarios/continuity/core_suite.json');
  assert.equal(suite.scenario_files.length, 6);
  const allowed = new Set(['send_message','inspect','restart_service','switch_model','replace_source','branch']);
  for (const file of suite.scenario_files) {
    const scenario = loadContinuityScenario(file);
    assert.ok(scenario.steps.length >= 4);
    assert.ok(scenario.rubric.length >= 3);
    assert.ok(scenario.steps.every((step) => allowed.has(step.action)));
  }
});

test('continuity test plan creates resumable runbooks and scorecards without executing providers', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-plan-'));
  const plan = await createContinuityTestPlan({
    suiteFile: 'scenarios/continuity/core_suite.json',
    outputRoot: root,
    track: 'baseline',
    probe: false,
  });
  assert.equal(plan.runs.length, 6);
  for (const row of plan.runs) {
    assert.ok(fs.existsSync(path.join(row.run_dir, 'RUNBOOK.md')));
    assert.ok(fs.existsSync(path.join(row.run_dir, 'state.json')));
    assert.ok(fs.existsSync(path.join(row.run_dir, 'scorecard.csv')));
    const loaded = loadContinuityRun(row.run_dir);
    assert.equal(loaded.state.track, 'baseline');
    assert.equal(loaded.state.status, 'planned');
  }
});

test('continuity semantic judge persists structured result and keeps raw output separate', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-judge-'));
  const scenario = loadContinuityScenario('scenarios/continuity/restart_continuation.json');
  const { runDir, state } = createContinuityRunState({ scenario, outputRoot: root });
  state.steps[0].observed_output = '목표와 제약을 정리했다.';
  state.manual_rubric = scenario.rubric.map((item) => ({ ...item, result: 'pass', note: '' }));
  const result = await judgeContinuityRun({
    scenario, state, runDir, provider: 'claude',
    executor: async () => ({ ok: true, exitCode: 0, stdout: JSON.stringify({ passed: true, score: 0.9, summary: 'continued', rubric: [], findings: [] }) }),
  });
  assert.equal(result.result.passed, true);
  assert.equal(result.result.score, 0.9);
  assert.ok(fs.existsSync(path.join(runDir, 'judge_prompt.txt')));
  assert.ok(fs.existsSync(path.join(runDir, 'judge_output.txt')));
  assert.equal(loadContinuityRun(runDir).state.semantic_judgment.result.summary, 'continued');
});
