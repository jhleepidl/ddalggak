import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildWorkflowRuntimeExecutionPatch } from '../src/application/workflow_execution_contract.js';
import { normalizeRuntimeExecutionPolicy } from '../src/application/runtime_execution_policy.js';
import { appendExecutionPolicyResolution, appendAgentActivityEvent, appendAgentHandoffEvent } from '../src/application/agent_activity_stream.js';

const loopContract = {
  kind: 'team_workflow_contract_v1',
  workflow_kind: 'bounded_continuous_loop',
  required_passes: ['plan', 'implement_or_diagnose', 'verify', 'review', 'stop_condition_evaluation'],
  min_iterations: 2,
  max_iterations: 5,
  approval_boundary: true,
};

function tmpRun() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-loop-policy-'));
}

test('bounded loop workflow patch installs task-loop execution policy', () => {
  const patch = buildWorkflowRuntimeExecutionPatch(loopContract, {});
  const policy = normalizeRuntimeExecutionPolicy(patch);
  assert.equal(policy.execution_mode, 'task_loop');
  assert.equal(policy.workspace_write, 'allowed_in_workspace');
  assert.equal(policy.artifact_delivery, 'allowed_when_task_requires');
  assert.equal(policy.legacy_manual_fallback, 'disabled');
  assert.equal(policy.continuous_improvement.enabled, true);
  assert.equal(policy.workflow_contract.enforcement_level, 'hard_loop_contract');
});

test('agent activity and policy resolution streams persist local audit records', () => {
  const jobDir = tmpRun();
  appendExecutionPolicyResolution({
    jobDir,
    source: 'test',
    agentId: 'builder',
    roleId: 'builder',
    runtimeExecutionPolicy: buildWorkflowRuntimeExecutionPatch(loopContract, {}),
    requirements: { task_loop_workspace_write_allowed: true },
    decision: 'direct_workspace_execution_allowed',
  });
  appendAgentActivityEvent({ jobDir, event: 'agent_start', agentId: 'builder', roleId: 'builder', provider: 'codex' });
  appendAgentHandoffEvent({ jobDir, fromAgent: 'builder', toAgent: 'reviewer', summary: 'patch ready for review' });

  const policyRows = fs.readFileSync(path.join(jobDir, 'local_memory', 'execution_policy_resolutions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const activityRows = fs.readFileSync(path.join(jobDir, 'local_memory', 'agent_activity.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  const handoffRows = fs.readFileSync(path.join(jobDir, 'local_memory', 'agent_handoffs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(policyRows[0].execution_mode, 'task_loop');
  assert.equal(policyRows[0].workspace_write, 'allowed_in_workspace');
  assert.equal(activityRows[0].event, 'agent_start');
  assert.equal(handoffRows[0].from_agent, 'builder');
});
