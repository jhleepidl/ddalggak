import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildRunTraceRecord } from '../src/shared/openharness_contracts.js';
import { OpenHarnessRunEventOutbox } from '../src/runtime_capabilities/run_event_outbox.js';
import { GocRunEventSink, LocalRunEventSink } from '../src/runtime_capabilities/run_event_sink.js';

class JobsStub {
  constructor(root) { this.root = root; }
  jobDir(jobId) {
    const dir = path.join(this.root, jobId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
}

test('runtime outbox is idempotent and preserves sequence across retry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-outbox-'));
  const jobs = new JobsStub(root);
  let calls = 0;
  let fail = true;
  const client = {
    async ingestOpenHarnessRuntimeEvents(events) {
      calls += 1;
      assert.equal(events.length, 1);
      if (fail) throw new Error('goc unavailable');
      return { accepted: 1, duplicates: 0 };
    },
  };
  const outbox = new OpenHarnessRunEventOutbox({ jobs, client, autoFlush: false });
  const event = buildRunTraceRecord('run.start', { run_id: 'run_1' }, { jobId: 'job_1', runId: 'run_1', eventSequence: 1 });
  outbox.enqueue(event, { jobId: 'job_1' });
  outbox.enqueue(event, { jobId: 'job_1' });
  assert.equal(outbox.pending('job_1').length, 1);
  const first = await outbox.flush({ jobId: 'job_1' });
  assert.equal(first.failed, 1);
  assert.equal(outbox.pending('job_1').length, 1);
  fail = false;
  const second = await outbox.flush({ jobId: 'job_1' });
  assert.equal(second.delivered, 1);
  assert.equal(outbox.pending('job_1').length, 0);
  await outbox.flush({ jobId: 'job_1' });
  assert.equal(calls, 2);
});

test('GocRunEventSink commits locally before a failing GoC projection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-local-first-'));
  const jobs = new JobsStub(root);
  const local = new LocalRunEventSink({ jobs, runtimePolicy: { audit_flags: { timeline_enabled: true } } });
  const sink = new GocRunEventSink({
    fallbackSink: local,
    runtimePolicy: { audit_flags: { timeline_enabled: true } },
    executionGraph: {
      isEnabled() { return true; },
      async startRun() { throw new Error('projection unavailable'); },
    },
  });
  await sink.startRun({ run_id: 'run_local_first' }, { jobId: 'job_1' });
  const rows = fs.readFileSync(path.join(root, 'job_1', 'runtime_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, 'run.start');
  assert.equal(rows[0].event_sequence, 1);
});

test('LocalRunEventSink resumes sequence from persisted runtime events after recreation', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-sequence-resume-'));
  const jobs = new JobsStub(root);
  const policy = { audit_flags: { timeline_enabled: true } };
  const first = new LocalRunEventSink({ jobs, runtimePolicy: policy });
  await first.startRun({ run_id: 'run_resume' }, { jobId: 'job_1' });

  const second = new LocalRunEventSink({ jobs, runtimePolicy: policy });
  await second.recordAgentEvent('participant.contribution', { run_id: 'run_resume', agent_id: 'builder' }, { jobId: 'job_1' });

  const rows = fs.readFileSync(path.join(root, 'job_1', 'runtime_events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.event_sequence), [1, 2]);
});
