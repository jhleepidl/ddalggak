import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { LocalContextEngine } from '../src/runtime_capabilities/context_engines/local_engine.js';
import { updateRoleSummary } from '../src/application/summary_memory.js';

function makeJobRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-local-engine-'));
}

function makeJobs(root) {
  return {
    jobDir(jobId) {
      const dir = path.join(root, jobId);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    },
    tailConversation() {
      return [];
    },
  };
}

test('local context engine loads role summary by roleId even when agentId is custom', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-role-summary';
  updateRoleSummary({
    jobDir: jobs.jobDir(jobId),
    roleId: 'builder',
    agentId: 'notebook_builder',
    goal: 'polish notebook flow',
    output: 'refined notebook cells and tightened ordering',
    provider: 'codex',
    model: 'gpt-5-codex',
  });

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Notebook Builder',
    roleId: 'builder',
    goal: 'keep improving the notebook',
  });

  assert.match(prepared.contextText, /ROLE SUMMARY/);
  assert.match(prepared.contextText, /polish notebook flow/);
  assert.ok((prepared.meta?.roleSummaryChars || 0) > 0);
});

test('local context engine derives builder focus and budget from roleId when agentId is custom', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-role-focus';

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Notebook Builder',
    roleId: 'builder',
    goal: 'improve workbook UX',
  });

  assert.match(prepared.contextText, /실행 가능한 코드\/노트북 산출물/);
  assert.equal(prepared.meta?.budgetTokens, 1400);
});

test('local context engine filters stale iteration delta before the latest correction boundary', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-correction-boundary';
  const jobDir = jobs.jobDir(jobId);

  updateRoleSummary({
    jobDir,
    roleId: 'researcher',
    agentId: 'mode_systems_researcher',
    goal: 'old arena framing',
    output: '리그 오브 레전드 아레나 모드 전적 검색 및 증강 추천 프로그램 개발 제안',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  await engine.recordMeta({
    jobId,
    stepKind: 'router',
    userMessageText: '칼바람 아수라장 모드는 아레나 모드와 다른 모드야. ARAM Mayhem이라고. 혼동하지 않도록 주의해.',
    meta: {},
    runMeta: {},
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  updateRoleSummary({
    jobDir,
    roleId: 'researcher',
    agentId: 'mode_systems_researcher',
    goal: 'correct mayhem framing',
    output: '칼바람 아수라장(ARAM Mayhem) 전용 보조 프로그램 명세와 리스크 요약',
    provider: 'gemini',
    model: 'gemini-2.5-pro',
  });

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Companion App Builder',
    roleId: 'builder',
    goal: '최신 정정에 맞춰 구현 진행',
  });

  const text = String(prepared.contextText || '');
  assert.match(text, /ACTIVE DIRECTIVES/);
  assert.match(text, /ARAM Mayhem/);
  assert.match(text, /칼바람 아수라장\(ARAM Mayhem\) 전용 보조 프로그램 명세/);
  assert.doesNotMatch(text, /리그 오브 레전드 아레나 모드 전적 검색 및 증강 추천 프로그램 개발 제안/);
});

test('local context engine places current task packet above stale summaries for builder context', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-task-packet';
  const jobDir = jobs.jobDir(jobId);

  updateRoleSummary({
    jobDir,
    roleId: 'builder',
    agentId: 'builder',
    goal: 'old telegram runner framing',
    output: '텔레그램 봇 형태로 실행한다는 오래된 구현 요약',
    provider: 'codex',
    model: 'gpt-5-codex',
  });

  await engine.recordMeta({
    jobId,
    stepKind: 'router',
    userMessageText: '/chat 텔레그램이 아니라 .exe 오버레이 프로그램으로 만들어줘.',
    meta: {},
    runMeta: {},
  });

  const prepared = await engine.prepareStepContext({
    jobId,
    agentId: 'Companion App Builder',
    roleId: 'builder',
    goal: '최신 요구에 맞게 companion app 구현',
  });

  const context = String(prepared.contextText || '');
  assert.match(context, /CURRENT TASK PACKET/);
  assert.match(context, /Latest user request: ".*\.exe 오버레이 프로그램/);
  assert.ok(context.indexOf('[CURRENT TASK PACKET]') < context.indexOf('[ROLE SUMMARY]'));
});

test('local context engine recordMeta writes a single compact context log entry', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-context-meta';

  await engine.recordMeta({
    jobId,
    stepKind: 'agent',
    agentId: 'Overlay Builder',
    roleId: 'builder',
    goal: 'produce an executable package',
    meta: { compiledChars: 1234 },
    runMeta: {
      runtimeTeamSnapshot: {
        source: 'team_builder',
        participants: [{ id: 'researcher' }, { id: 'builder' }, { id: 'reviewer' }],
      },
      task_interpretation: {
        archetype: 'implementation',
        wants_code: true,
      },
    },
  });

  const logPath = path.join(jobs.jobDir(jobId), 'local_memory', 'context_meta.jsonl');
  const rows = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].run_meta.runtimeTeamSnapshot.participant_ids, ['researcher', 'builder', 'reviewer']);
  assert.equal(rows[0].run_meta.task_interpretation.archetype, 'implementation');
});

test('local context engine skips noisy assistant telemetry when updating rolling summary and turns', async () => {
  const root = makeJobRoot();
  const jobs = makeJobs(root);
  const engine = new LocalContextEngine({ jobs });
  const jobId = 'job-noisy-summary';
  jobs.jobDir(jobId);

  await engine.onRunEnd({
    jobId,
    lastUserText: '실행 가능한 .exe 파일까지 만들어줘.',
    lastAssistantText: `현재까지 결과 요약:\n- builder: 완료했습니다.`,
    runMeta: {},
  });

  const summary = fs.readFileSync(path.join(jobs.jobDir(jobId), 'local_memory', 'summary.md'), 'utf8');
  const turns = fs.readFileSync(path.join(jobs.jobDir(jobId), 'local_memory', 'turns.jsonl'), 'utf8');
  assert.doesNotMatch(summary, /현재까지 결과 요약/);
  assert.doesNotMatch(turns, /현재까지 결과 요약/);
  assert.match(turns, /실행 가능한 \.exe 파일/);
});
