import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessAgentRoleOutputValidity,
  buildAssignedTaskPromptBlock,
  deriveReviewerCorrectionContract,
  inferDeliverableMode,
  materializeProviderContextCapsule,
  resolveProviderExecutionWorkspace,
} from '../src/application/telegram_chat_execution.js';

const testTmpRoot = path.join(os.homedir(), 'tmp', 'ddalggak-tests');
fs.mkdirSync(testTmpRoot, { recursive: true });

test('headless provider isolation moves Claude outside the repository workspace while Codex keeps the run workspace', () => {
  const previousIsolation = process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION;
  const previousRoot = process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT;
  const isolationRoot = fs.mkdtempSync(path.join(testTmpRoot, 'provider-isolation-'));
  try {
    process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION = '1';
    process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT = isolationRoot;

    const claudeWorkspace = resolveProviderExecutionWorkspace('job:ambient/context', 'claude', 'researcher__lane_1');
    const codexWorkspace = resolveProviderExecutionWorkspace('job:ambient/context', 'codex');

    assert.equal(claudeWorkspace.startsWith(path.resolve(isolationRoot) + path.sep), true);
    assert.equal(path.basename(claudeWorkspace), 'researcher__lane_1');
    assert.equal(path.basename(path.dirname(claudeWorkspace)), 'job_ambient_context');
    assert.equal(fs.existsSync(claudeWorkspace), true);
    const secondLaneWorkspace = resolveProviderExecutionWorkspace('job:ambient/context', 'claude', 'researcher__lane_2');
    assert.notEqual(secondLaneWorkspace, claudeWorkspace);
    assert.equal(codexWorkspace.startsWith(path.resolve(isolationRoot) + path.sep), false);
  } finally {
    if (previousIsolation === undefined) delete process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION;
    else process.env.DDALGGAK_HEADLESS_PROVIDER_ISOLATION = previousIsolation;
    if (previousRoot === undefined) delete process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT;
    else process.env.DDALGGAK_HEADLESS_PROVIDER_WORKSPACE_ROOT = previousRoot;
    fs.rmSync(isolationRoot, { recursive: true, force: true });
  }
});


test('isolated provider context capsule contains the authoritative task and only projected context', () => {
  const root = fs.mkdtempSync(path.join(testTmpRoot, 'provider-capsule-'));
  try {
    const capsule = materializeProviderContextCapsule({
      workspaceRoot: root,
      provider: 'antigravity',
      jobId: 'job-capsule',
      userRequest: '세 가지 온보딩 안을 비교하고 하나를 추천해줘.',
      agentGoal: '독립적인 risk 관점의 안을 제시한다.',
      roleId: 'researcher',
      laneId: 'lane_3',
      deliverableMode: 'chat_text',
      contextText: '승인된 Room 규칙: 한국어로 답한다.',
    });
    assert.equal(capsule.metadata.task_present, true);
    assert.equal(capsule.metadata.provider, 'antigravity');
    assert.match(fs.readFileSync(path.join(root, 'task.md'), 'utf8'), /세 가지 온보딩 안/);
    assert.match(fs.readFileSync(path.join(root, 'task.md'), 'utf8'), /lane_3/);
    assert.match(fs.readFileSync(path.join(root, 'context.md'), 'utf8'), /승인된 Room 규칙/);
    assert.doesNotMatch(fs.readFileSync(path.join(root, 'context.md'), 'utf8'), /repository branch|benchmark bug/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('assigned task contract keeps collaboration topology separate from deliverable mode', () => {
  const request = '우리 팀의 배포 전 점검표 초안을 체크박스 형식으로 만들어줘.';
  const mode = inferDeliverableMode(request, {});
  assert.equal(mode, 'operational_checklist');
  const block = buildAssignedTaskPromptBlock({
    userRequest: request,
    agentGoal: '초안을 작성한다.',
    roleId: 'builder',
    deliverableMode: mode,
  });
  assert.match(block, /Latest user request:/);
  assert.match(block, /operational_checklist/);
  assert.match(block, /Do not treat the absence of a file artifact as a blocker/);
});

test('role output validity rejects provider-success responses that only report a missing assigned task', () => {
  const invalid = assessAgentRoleOutputValidity({
    output: 'The [ASSIGNED TASK] section is empty. Please provide the task or topic.',
    userRequest: '세 가지 안을 비교해줘.',
    roleId: 'researcher',
  });
  assert.equal(invalid.valid, false);
  assert.equal(invalid.reason, 'missing_assigned_task_refusal');
  const contextRefusal = assessAgentRoleOutputValidity({
    output: 'The referenced shared context path is outside my permitted working directory, so I cannot access it.',
    userRequest: '세 가지 안을 비교해줘.',
    roleId: 'researcher',
  });
  assert.equal(contextRefusal.valid, false);
  assert.equal(contextRefusal.reason, 'required_context_access_refusal');
  const valid = assessAgentRoleOutputValidity({
    output: '세 가지 안을 가정, 사용자 가치, 위험 기준으로 비교했습니다.',
    userRequest: '세 가지 안을 비교해줘.',
    roleId: 'researcher',
  });
  assert.equal(valid.valid, true);
});

test('reviewer correction contract marks fabricated constraints as blocker corrections for synthesis', () => {
  const contract = deriveReviewerCorrectionContract(
    '상위 답변의 “산출물 생성 금지”는 환각된 제약입니다. 파일 쓰기 금지와 채팅 본문 전달 금지는 다릅니다.',
    { reviewerAgentId: 'reviewer', userRequest: '체크리스트를 작성해줘.' },
  );
  assert.equal(contract.findings[0].finding_type, 'false_constraint');
  assert.equal(contract.findings[0].invalidate_upstream_claim, true);
  assert.match(contract.findings[0].required_correction, /fabricated restriction/i);
});
