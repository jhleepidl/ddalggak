import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSkeletonAdvisoryRequest, parseSkeletonAdvisoryLabels } from '../src/application/skeleton_advisory_dsl.js';
import { scoreSkeletonAdvisory } from '../src/application/skeleton_advisory_scorer.js';
import { buildTeamSelectionPortfolio } from '../src/application/team_configuration.js';

function runtimeWith(caps = []) {
  const obj = {};
  for (const cap of caps) obj[cap] = true;
  return { capabilities: obj, availableToolIds: caps, agents: [], enabledAgentIds: [] };
}

test('skeleton advisory request emits descriptor-rich execution-ready skeleton tokens', () => {
  const request = buildSkeletonAdvisoryRequest({
    request: 'Fix a repo bug and verify the patch before delivery',
    stress: { verification_need: 0.9, workspace_mutation: 0.8, artifact_pressure: 0.7 },
    candidate: { candidate_id: 'c1', roles: ['builder', 'tester', 'reviewer'] },
  });
  assert.equal(request.kind, 'ddalggak_skeleton_advisory_request_v1');
  assert.ok(request.tokens.includes('MODE=candidate_scoring'));
  assert.ok(request.tokens.includes('OUTPUT_SCHEMA=candidate_labels'));
  assert.ok(request.tokens.includes('TASK=code_patch'));
  assert.ok(request.tokens.includes('ROLE=builder'));
  assert.ok(request.tokens.includes('ROLE=reviewer'));
  assert.ok(request.tokens.some((tok) => tok.startsWith('EDGE=builder>reviewer:')));
  assert.ok(request.tokens.includes('P_VERIFY=high'));
});

test('skeleton advisory parser accepts canonical candidate labels', () => {
  const parsed = parseSkeletonAdvisoryLabels('Y_UTIL=good Y_DEBT=med Y_FRONTIER_NEEDED=no Y_ADD_REVIEWER=yes Y_ADD_RESEARCHER=no Y_ADD_ARTIFACT_VERIFIER=no Y_ADD_ARBITER=no');
  assert.equal(parsed.labels.Y_UTIL, 'good');
  assert.equal(parsed.labels.Y_ADD_REVIEWER, 'yes');
  assert.deepEqual(parsed.diagnostics.missing_keys, []);
});

test('mock advisory scorer can run in shadow mode without external model', () => {
  const row = scoreSkeletonAdvisory({
    request: 'Fix a patch and review it',
    stress: { verification_need: 0.9, workspace_mutation: 0.8 },
    candidate: { candidate_id: 'c2', roles: ['builder'] },
    config: { mode: 'shadow', mock: true },
  });
  assert.equal(row.status, 'ok');
  assert.equal(row.labels.Y_ADD_REVIEWER, 'yes');
  assert.ok(row.request.tokens.includes('MODE=candidate_scoring'));
});

test('team portfolio attaches learned advisory in shadow mode without changing command flow', () => {
  const oldMock = process.env.TEAM_COMPAT_SCORER_MOCK;
  const oldMode = process.env.TEAM_COMPAT_ADVISORY_MODE;
  process.env.TEAM_COMPAT_SCORER_MOCK = '1';
  process.env.TEAM_COMPAT_ADVISORY_MODE = 'shadow';
  try {
    const portfolio = buildTeamSelectionPortfolio({
      taskText: '코드 패치를 구현하고 테스트와 리뷰까지 해줘.',
      runtime: runtimeWith(['workspace_read', 'workspace_write']),
      maxCandidates: 5,
    });
    assert.equal(portfolio.skeleton_advisory_summary.enabled, true);
    assert.equal(portfolio.skeleton_advisory_summary.mode, 'shadow');
    assert.ok(portfolio.candidates.some((c) => c.skeleton_advisory?.status === 'ok'));
    assert.ok(portfolio.trace.advisory_summary);
  } finally {
    if (oldMock === undefined) delete process.env.TEAM_COMPAT_SCORER_MOCK; else process.env.TEAM_COMPAT_SCORER_MOCK = oldMock;
    if (oldMode === undefined) delete process.env.TEAM_COMPAT_ADVISORY_MODE; else process.env.TEAM_COMPAT_ADVISORY_MODE = oldMode;
  }
});

test('user-requested team intent is encoded in skeleton advisory tokens', () => {
  const request = buildSkeletonAdvisoryRequest({
    request: '간단한 문장 수정이지만 writer와 reviewer 팀으로 검토해줘.',
    stress: { overall: 0.1, verification_need: 0.1 },
    candidate: { candidate_id: 'c-user-team', roles: ['builder', 'reviewer'] },
  });
  assert.ok(request.tokens.includes('U_TEAM=explicit'));
  assert.ok(request.tokens.includes('U_TEAM_STYLE=review'));
  assert.ok(request.tokens.includes('U_ROLE=reviewer'));
  assert.equal(request.user_orchestration_intent.team_intent, 'explicit');
});

test('team portfolio preserves an explicit low-pressure user team request', () => {
  const oldMock = process.env.TEAM_COMPAT_SCORER_MOCK;
  const oldMode = process.env.TEAM_COMPAT_ADVISORY_MODE;
  process.env.TEAM_COMPAT_SCORER_MOCK = '1';
  process.env.TEAM_COMPAT_ADVISORY_MODE = 'shadow';
  try {
    const portfolio = buildTeamSelectionPortfolio({
      taskText: '간단한 글 다듬기인데 여러 관점의 팀으로 리뷰해줘.',
      runtime: runtimeWith(['workspace_read']),
      maxCandidates: 6,
    });
    assert.equal(portfolio.user_orchestration_intent.team_intent, 'explicit');
    assert.ok(portfolio.candidates.some((c) => c.source.includes('user_orchestration_intent') || c.user_orchestration_intent?.team_intent === 'explicit'));
    assert.ok(portfolio.candidates.some((c) => c.score?.user_intent_match === true));
    assert.ok(portfolio.trace.user_orchestration_intent);
  } finally {
    if (oldMock === undefined) delete process.env.TEAM_COMPAT_SCORER_MOCK; else process.env.TEAM_COMPAT_SCORER_MOCK = oldMock;
    if (oldMode === undefined) delete process.env.TEAM_COMPAT_ADVISORY_MODE; else process.env.TEAM_COMPAT_ADVISORY_MODE = oldMode;
  }
});

test('branch retry with memory import is encoded as attempt and MEM tokens', () => {
  const request = buildSkeletonAdvisoryRequest({
    request: '이 결과는 마음에 안 들어. 같은 주제 메모리를 가져와서 논문작성팀에게 다시 맡겨줘. 이전 결과는 무시해.',
    stress: { overall: 0.2, context_pressure: 0.6 },
    candidate: { candidate_id: 'c-paper-branch', roles: ['researcher', 'synthesizer', 'reviewer'] },
  });
  assert.ok(request.tokens.includes('RUN_MODE=branch'));
  assert.ok(request.tokens.includes('TARGET_TEAM=paper'));
  assert.ok(request.tokens.includes('PREV_RESULT=exclude'));
  assert.ok(request.tokens.includes('MEM_IMPORT=explicit'));
  assert.ok(request.tokens.includes('MEM_PROFILE=paper'));
  assert.equal(request.task_attempt_plan.run_mode, 'branch');
  assert.equal(request.memory_import_intent.projection_profile, 'paper');
});

test('team portfolio creates GoC branch candidate for paper-team retry and memory projection', () => {
  const oldMock = process.env.TEAM_COMPAT_SCORER_MOCK;
  const oldMode = process.env.TEAM_COMPAT_ADVISORY_MODE;
  process.env.TEAM_COMPAT_SCORER_MOCK = '1';
  process.env.TEAM_COMPAT_ADVISORY_MODE = 'shadow';
  try {
    const portfolio = buildTeamSelectionPortfolio({
      taskText: '이전 결과가 별로야. 같은 주제 메모리를 가져와서 논문작성팀에게 다시 맡겨줘. 이전 결과는 제외해.',
      runtime: runtimeWith(['workspace_read']),
      maxCandidates: 6,
    });
    assert.equal(portfolio.task_attempt_plan.run_mode, 'branch');
    assert.equal(portfolio.task_attempt_plan.target_team, 'paper');
    assert.equal(portfolio.memory_import_intent.import_intent, 'explicit');
    assert.ok(portfolio.candidates.some((c) => c.source.includes('task_attempt_branch') && c.target_team === 'paper'));
    assert.ok(portfolio.trace.task_attempt_plan);
    assert.ok(portfolio.trace.memory_import_intent);
  } finally {
    if (oldMock === undefined) delete process.env.TEAM_COMPAT_SCORER_MOCK; else process.env.TEAM_COMPAT_SCORER_MOCK = oldMock;
    if (oldMode === undefined) delete process.env.TEAM_COMPAT_ADVISORY_MODE; else process.env.TEAM_COMPAT_ADVISORY_MODE = oldMode;
  }
});

test('research campaign work mode is encoded as bounded-cycle advisory tokens', () => {
  const request = buildSkeletonAdvisoryRequest({
    request: 'Work Mode: Research Campaign. agent team selection에 대한 survey paper를 단계별로 작성해줘.',
    stress: { current_info_need: 0.8, context_pressure: 0.8, verification_need: 0.7 },
    candidate: { candidate_id: 'c-research-campaign', roles: ['operator', 'researcher', 'synthesizer', 'reviewer', 'builder'] },
  });
  assert.ok(request.tokens.includes('WORK_MODE=research_campaign'));
  assert.ok(request.tokens.includes('LOOP_BUDGET=staged'));
  assert.ok(request.tokens.includes('STOP_CONDITION=user_checkpoint'));
  assert.ok(request.tokens.includes('REVIEW_POLICY=stage_gate'));
  assert.ok(request.tokens.includes('MEMORY_MODE=structured'));
  assert.ok(request.tokens.includes('GOC_MODE=required'));
  assert.equal(request.task_attempt_plan.work_mode.work_mode, 'research_campaign');
  assert.equal(request.task_attempt_plan.cycle_policy.cycle_shape, 'staged_checkpoints');
});

test('team portfolio creates a Work Mode research campaign candidate and trace metadata', () => {
  const oldMock = process.env.TEAM_COMPAT_SCORER_MOCK;
  const oldMode = process.env.TEAM_COMPAT_ADVISORY_MODE;
  process.env.TEAM_COMPAT_SCORER_MOCK = '1';
  process.env.TEAM_COMPAT_ADVISORY_MODE = 'shadow';
  try {
    const portfolio = buildTeamSelectionPortfolio({
      taskText: 'Work Mode: Research Campaign. agent team selection에 대한 survey paper를 staged checkpoints로 작성해줘.',
      runtime: runtimeWith(['workspace_read']),
      maxCandidates: 6,
    });
    assert.equal(portfolio.work_mode.work_mode, 'research_campaign');
    assert.equal(portfolio.task_attempt_plan.work_mode.goc_mode, 'required');
    assert.equal(portfolio.task_attempt_plan.context_policy.loop_budget, 'staged');
    assert.ok(portfolio.candidates.some((c) => c.source.includes('work_mode') && c.score?.work_mode_match === true));
    assert.equal(portfolio.trace.work_mode.work_mode, 'research_campaign');
  } finally {
    if (oldMock === undefined) delete process.env.TEAM_COMPAT_SCORER_MOCK; else process.env.TEAM_COMPAT_SCORER_MOCK = oldMock;
    if (oldMode === undefined) delete process.env.TEAM_COMPAT_ADVISORY_MODE; else process.env.TEAM_COMPAT_ADVISORY_MODE = oldMode;
  }
});
