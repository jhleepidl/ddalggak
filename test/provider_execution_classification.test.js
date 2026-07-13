import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderExecutionResult } from '../src/evaluation/provider_execution_classification.js';

test('classifies Codex ChatGPT-account model access denial as non-quality execution error', () => {
  const result = classifyProviderExecutionResult({
    ok: false,
    exitCode: 1,
    stderr: `ERROR: {"status":400,"error":{"message":"The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."}}`,
  });
  assert.equal(result.category, 'model_access_denied');
  assert.equal(result.retryable, false);
  assert.equal(result.scope, 'model');
  assert.equal(result.quality_eligible, false);
});

test('classifies an unrecognized non-zero provider exit as a retryable execution error', () => {
  const result = classifyProviderExecutionResult({ ok: false, exitCode: 1, stderr: 'task command failed' });
  assert.equal(result.category, 'provider_execution_failed');
  assert.equal(result.retryable, true);
  assert.equal(result.quality_eligible, false);
});

test('does not classify an old successful run that lacks provider metadata', () => {
  assert.equal(classifyProviderExecutionResult({}), null);
});

test('generic execution failure keeps only an error-like line and not benchmark prompt text', () => {
  const result = classifyProviderExecutionResult({
    ok: false,
    exitCode: 9,
    stderr: ['Canonical task contract: confidential benchmark text', 'worker stopped', 'fatal: provider subprocess failed'].join('\n'),
  });
  assert.equal(result.message, 'fatal: provider subprocess failed');
  assert.doesNotMatch(result.message, /confidential benchmark/);
});


test('preserves snake-case exit codes from stored benchmark artifacts', () => {
  const result = classifyProviderExecutionResult({
    ok: false,
    exit_code: 1,
    stderr: "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
  });
  assert.equal(result.exit_code, 1);
});


test('classification reason retains the provider error line without copying benchmark prompt content', () => {
  const result = classifyProviderExecutionResult({
    ok: false,
    exitCode: 1,
    stderr: [
      'user',
      'Canonical task contract: confidential benchmark task text',
      "ERROR: The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.",
    ].join('\n'),
  });
  assert.match(result.message, /not supported/);
  assert.doesNotMatch(result.message, /confidential benchmark task/);
});

test('authentication failures stay retryable and do not permanently disqualify a model', () => {
  const result = classifyProviderExecutionResult({
    ok: false,
    exitCode: 1,
    stderr: 'Authentication required. Please log in.',
  });
  assert.equal(result.category, 'authentication_required');
  assert.equal(result.retryable, true);
  assert.equal(result.lifecycle_action, 'retry_after_credentials_change');
});
