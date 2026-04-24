import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordLlmTrace, readLlmTraceIndex, summarizeLlmTraceIndex } from '../src/application/llm_trace_recorder.js';

test('recordLlmTrace writes request response prompt stdout stderr and redacts env secrets', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-trace-'));
  const oldEnv = { ...process.env };
  try {
    process.env.LLM_TRACE_ENABLED = 'true';
    process.env.LLM_TRACE_SAVE_PROMPTS = 'true';
    process.env.LLM_TRACE_SAVE_OUTPUTS = 'true';
    process.env.LLM_TRACE_SAVE_STDERR = 'true';
    process.env.LLM_TRACE_REDACT_SECRETS = 'true';
    process.env.TEST_API_KEY = 'super-secret-value-12345';
    const trace = recordLlmTrace({
      traceDir: tmp,
      jobId: 'jobA',
      provider: 'gemini',
      surface: 'unit_test',
      model: 'test-model',
      prompt: 'hello super-secret-value-12345',
      result: { ok: true, exitCode: 0, stdout: 'done super-secret-value-12345', stderr: '', durationMs: 12 },
    });
    assert.ok(trace?.trace_id);
    const entries = readLlmTraceIndex({ traceDir: tmp });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].provider, 'gemini');
    const prompt = fs.readFileSync(path.join(trace.trace_root, 'prompt.txt'), 'utf8');
    const stdout = fs.readFileSync(path.join(trace.trace_root, 'stdout.txt'), 'utf8');
    assert.match(prompt, /\[REDACTED_ENV_SECRET\]/);
    assert.match(stdout, /\[REDACTED_ENV_SECRET\]/);
    const summary = summarizeLlmTraceIndex({ traceDir: tmp });
    assert.equal(summary.total_traces, 1);
    assert.equal(summary.ok_traces, 1);
  } finally {
    process.env = oldEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
