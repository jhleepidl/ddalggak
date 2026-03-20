import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { planVerificationCommands, executeToolProxyAction } from '../src/application/tool_proxy_runtime.js';
import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';

test('planVerificationCommands infers npm test for JS workspace', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-proxy-js-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'echo ok' } }, null, 2));
    const planned = planVerificationCommands({ action: { inputs: { intent: 'run_tests' } }, workspaceRoot: dir });
    assert.deepEqual(planned.commands, ['npm run test']);
    assert.equal(planned.intent, 'run_tests');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('executeToolProxyAction rejects unsafe explicit commands', async () => {
  const result = await executeToolProxyAction({
    action: {
      label: 'unsafe',
      inputs: { commands: ['rm -rf .'] },
    },
    workspaceRoot: process.cwd(),
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /unsafe_commands/);
});

test('executeToolProxyAction logs successful verification output to tracking', async () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-proxy-tracking-'));
  const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-proxy-workspace-'));
  process.env.RUNS_DIR = runsDir;
  try {
    fs.writeFileSync(path.join(workspaceDir, 'package.json'), JSON.stringify({
      name: 'tool-proxy-fixture',
      version: '1.0.0',
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2));
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'tool proxy tracking' });
    tracking.init(job.jobId);
    const result = await executeToolProxyAction({
      action: {
        label: 'verification',
        inputs: { commands: ['npm run test'] },
      },
      jobId: job.jobId,
      workspaceRoot: workspaceDir,
      tracking,
    });
    assert.equal(result.ok, true);
    assert.match(tracking.read(job.jobId, 'progress.md'), /Tool proxy verification/);
  } finally {
    process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
});


test('executeToolProxyAction honors verification approval policy', async () => {
  const denied = await executeToolProxyAction({
    action: { label: 'verification', inputs: { commands: ['npm run test'] } },
    workspaceRoot: process.cwd(),
    runtimeExecutionPolicy: { approval_matrix: { verification: 'deny' } },
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.route_signals, ['verification_blocked', 'approval_denied']);

  const ask = await executeToolProxyAction({
    action: { label: 'verification', inputs: { commands: ['npm run test'] } },
    workspaceRoot: process.cwd(),
    runtimeExecutionPolicy: { approval_matrix: { verification: 'ask' } },
  });
  assert.equal(ask.ok, false);
  assert.deepEqual(ask.route_signals, ['verification_requires_approval']);
});
