import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTraceHandoffBundle } from '../scripts/trace_handoff_bundle.js';
import { runTraceDoctor } from '../scripts/trace_doctor.js';

function write(filePath, content = '') {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

test('buildTraceHandoffBundle copies recent trace files and run context', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-handoff-'));
  const jobId = 'job_123';
  const traceDir = path.join(root, 'runs', jobId, 'llm_traces');
  const traceId = '1700000000000_codex_abcd';
  write(path.join(traceDir, 'index.jsonl'), `${JSON.stringify({ trace_id: traceId, provider: 'codex', ok: true, prompt_path: `${traceId}/prompt.txt` })}\n`);
  write(path.join(traceDir, traceId, 'request.json'), JSON.stringify({ trace_id: traceId, provider: 'codex' }));
  write(path.join(traceDir, traceId, 'response.json'), JSON.stringify({ trace_id: traceId, ok: true }));
  write(path.join(traceDir, traceId, 'prompt.txt'), 'prompt body');
  write(path.join(traceDir, traceId, 'stdout.txt'), 'stdout body');
  write(path.join(root, 'runs', jobId, 'conversation.jsonl'), '{"role":"user"}\n');
  write(path.join(root, 'runs', jobId, 'runtime_events.jsonl'), '{"event":"x"}\n');

  const out = path.join(root, 'handoff');
  const result = buildTraceHandoffBundle({ cwd: root, jobId, out });
  assert.equal(result.manifest.total_traces, 1);
  assert.equal(result.manifest.included_traces, 1);
  assert.ok(fs.existsSync(path.join(out, 'HANDOFF_MANIFEST.json')));
  assert.ok(fs.existsSync(path.join(out, 'llm_traces', 'index.jsonl')));
  assert.equal(fs.readFileSync(path.join(out, 'llm_traces', traceId, 'prompt.txt'), 'utf8'), 'prompt body');
  assert.equal(fs.readFileSync(path.join(out, 'run_context', 'conversation_tail.jsonl'), 'utf8'), '{"role":"user"}\n');
});

test('runTraceDoctor reports missing trace env as not ok', () => {
  const previous = process.env.LLM_TRACE_ENABLED;
  delete process.env.LLM_TRACE_ENABLED;
  const result = runTraceDoctor({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'trace-doctor-')) });
  assert.equal(result.ok, false);
  assert.match(result.output, /LLM_TRACE_ENABLED=true/);
  if (previous === undefined) delete process.env.LLM_TRACE_ENABLED;
  else process.env.LLM_TRACE_ENABLED = previous;
});

test('buildTraceHandoffBundle resolves job trace before stale LLM_TRACE_DIR env and copies explicit paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-handoff-precedence-'));
  const jobId = 'job_job_scoped';
  const staleTraceDir = path.join(root, 'runs', 'stale', 'llm_traces');
  const traceDir = path.join(root, 'runs', jobId, 'llm_traces');
  const traceId = 'trace_explicit_paths';
  const externalDir = path.join(root, 'external-trace-files', traceId);
  write(path.join(staleTraceDir, 'index.jsonl'), `${JSON.stringify({ trace_id: 'stale_trace' })}\n`);
  write(path.join(traceDir, 'index.jsonl'), `${JSON.stringify({ provider: 'codex', prompt_path: path.join(externalDir, 'prompt.txt'), request_path: path.join(externalDir, 'request.json') })}\n`);
  write(path.join(externalDir, 'prompt.txt'), 'job scoped prompt');
  write(path.join(externalDir, 'request.json'), JSON.stringify({ ok: true }));

  const previous = process.env.LLM_TRACE_DIR;
  process.env.LLM_TRACE_DIR = staleTraceDir;
  try {
    const out = path.join(root, 'handoff');
    const result = buildTraceHandoffBundle({ cwd: root, jobId, out });
    assert.equal(result.manifest.total_traces, 1);
    assert.equal(result.manifest.trace_ids.length, 0);
    assert.equal(fs.readFileSync(path.join(out, 'llm_traces', traceId, 'prompt.txt'), 'utf8'), 'job scoped prompt');
  } finally {
    if (previous === undefined) delete process.env.LLM_TRACE_DIR;
    else process.env.LLM_TRACE_DIR = previous;
  }
});
