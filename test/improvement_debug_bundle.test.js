import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createImprovementDebugBundle,
  evaluateImprovementGate,
  formatEvalGatePreview,
  inferReviewRisk,
  isForbiddenChangedPath,
} from '../src/application/improvement_debug_bundle.js';

test('createImprovementDebugBundle writes sanitizer and reproduction artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'improve-debug-'));
  const bundleRoot = path.join(tmp, '.self_improve', 'jobs', 'job_debug');
  const bundle = {
    bundle_root: bundleRoot,
    debug_dir: path.join(bundleRoot, 'debug'),
    llm_trace_dir: path.join(bundleRoot, 'llm_traces'),
    manifest: { job_id: 'job_debug', instruction: 'debug bundle smoke' },
  };
  const created = createImprovementDebugBundle({
    bundle,
    workspaceRoot: tmp,
    jobId: 'job_debug',
    targetConfig: { target: 'ddalggak', test_commands: ['node --test'], canary_commands: ['echo canary'] },
    jobPayload: { instruction: 'debug bundle smoke' },
    reports: [{ payload: { resource_kind: 'test_report', status: 'failed', phase: 'tests_failed', summary: 'boom' }, text: 'stderr boom' }],
    diff: { changed_files: ['src/application/demo.js'] },
  });
  assert.equal(fs.existsSync(created.failure_summary_path), true);
  assert.equal(fs.existsSync(created.reproduction_path), true);
  assert.equal(fs.existsSync(created.environment_sanitized_path), true);
  assert.equal(fs.existsSync(created.review_input_path), true);
  assert.match(fs.readFileSync(created.failure_summary_path, 'utf8'), /boom/);
  assert.match(fs.readFileSync(created.reproduction_path, 'utf8'), /node --test/);
  assert.match(fs.readFileSync(created.review_input_path, 'utf8'), /Scoped review input/);
});

test('evaluateImprovementGate passes with successful tests and canary', () => {
  const gate = evaluateImprovementGate({
    reports: [
      { payload: { resource_kind: 'code_diff', status: 'applied' } },
      { payload: { resource_kind: 'test_report', status: 'passed' } },
      { payload: { resource_kind: 'canary_result', status: 'passed' } },
    ],
    diff: { changed_files: ['src/application/improvement_orchestrator.js'] },
    targetConfig: { max_changed_files: 5 },
  });
  assert.equal(gate.status, 'passed');
  assert.equal(gate.diff_size_ok, true);
  assert.match(formatEvalGatePreview(gate), /status: passed/);
});

test('evaluateImprovementGate blocks forbidden paths and high review risk', () => {
  const gate = evaluateImprovementGate({
    reports: [
      { payload: { resource_kind: 'test_report', status: 'passed' } },
      { payload: { resource_kind: 'canary_result', status: 'passed' } },
      { payload: { resource_kind: 'review_report', status: 'completed', payload: { risk: 'high' } }, text: 'Risk: high' },
    ],
    diff: { changed_files: ['.env.production', 'src/app.js'] },
    targetConfig: { max_changed_files: 10, require_review: true },
  });
  assert.equal(gate.status, 'blocked');
  assert.equal(gate.forbidden_paths_changed, true);
  assert.equal(gate.review_risk, 'high');
  assert.equal(isForbiddenChangedPath('.env.production'), true);
});

test('inferReviewRisk reads reviewer output conventions', () => {
  assert.equal(inferReviewRisk({ stdout: 'Risk: low\nRecommend promote.' }), 'low');
  assert.equal(inferReviewRisk({ stdout: 'Risk: medium\nNeeds review.' }), 'medium');
  assert.equal(inferReviewRisk({ stderr: 'High risk, do not promote.' }), 'high');
});

test('evaluateImprovementGate uses the newest report and nested review payloads', () => {
  const gate = evaluateImprovementGate({
    reports: [
      { payload: { resource_kind: 'test_report', status: 'failed', summary: 'old failure' } },
      { payload: { resource_kind: 'review_report', status: 'completed', payload: { risk: 'high' } }, text: 'Risk: high' },
      { payload: { resource_kind: 'test_report', status: 'passed', summary: 'new pass' } },
      { payload: { resource_kind: 'canary_result', status: 'passed' } },
      { payload: { resource_kind: 'review_report', status: 'completed', payload: { risk: 'low' } }, text: 'Risk: low' },
    ],
    diff: { changed_files: ['src/application/improvement_debug_bundle.js'] },
    targetConfig: { max_changed_files: 5, require_review: true },
  });
  assert.equal(gate.status, 'passed');
  assert.equal(gate.test_status, 'passed');
  assert.equal(gate.review_risk, 'low');
});

test('evaluateImprovementGate prefers report timestamps when API order is newest-first', () => {
  const gate = evaluateImprovementGate({
    reports: [
      { created_at: '2026-04-25T01:00:00Z', payload: { resource_kind: 'test_report', status: 'passed' } },
      { created_at: '2026-04-25T00:00:00Z', payload: { resource_kind: 'test_report', status: 'failed' } },
      { created_at: '2026-04-25T01:00:01Z', payload: { resource_kind: 'canary_result', status: 'passed' } },
    ],
    diff: { changed_files: ['src/application/improvement_debug_bundle.js'] },
    targetConfig: { max_changed_files: 5 },
  });
  assert.equal(gate.status, 'passed');
  assert.equal(gate.test_status, 'passed');
});
