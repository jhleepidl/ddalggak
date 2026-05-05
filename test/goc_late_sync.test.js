import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Jobs } from '../src/jobs.js';
import {
  enqueueGocLateSync,
  flushGocLateSyncQueue,
  gocLateSyncMode,
  readGocLateSyncQueue,
} from '../src/application/goc_late_sync.js';

test('GoC late sync queues local events and flushes them out of band', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-goc-late-'));
  const prevRuns = process.env.RUNS_DIR;
  const prevMode = process.env.GOC_SYNC_MODE;
  process.env.RUNS_DIR = tempDir;
  process.env.GOC_SYNC_MODE = 'late';
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'late sync test' });
    const queued = enqueueGocLateSync({
      jobs,
      jobId: job.jobId,
      kind: 'tracking_append',
      payload: { docName: 'progress.md', markdown: 'hello' },
    });
    assert.equal(queued.queued, true);
    assert.equal(gocLateSyncMode(), 'late');
    assert.equal(readGocLateSyncQueue(jobs, job.jobId).length, 1);

    const handled = [];
    const result = await flushGocLateSyncQueue({
      jobs,
      jobId: job.jobId,
      handler: async (row) => { handled.push(row); },
    });
    assert.equal(result.processed, 1);
    assert.equal(result.failed, 0);
    assert.equal(readGocLateSyncQueue(jobs, job.jobId).length, 0);
    assert.equal(handled[0].kind, 'tracking_append');
  } finally {
    if (typeof prevRuns === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRuns;
    if (typeof prevMode === 'undefined') delete process.env.GOC_SYNC_MODE;
    else process.env.GOC_SYNC_MODE = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GoC late sync keeps failed events for retry', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-goc-late-retry-'));
  const prevRuns = process.env.RUNS_DIR;
  const prevMode = process.env.GOC_SYNC_MODE;
  process.env.RUNS_DIR = tempDir;
  process.env.GOC_SYNC_MODE = 'late';
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'late sync retry test' });
    enqueueGocLateSync({ jobs, jobId: job.jobId, kind: 'tracking_append', payload: { docName: 'progress.md' } });
    const result = await flushGocLateSyncQueue({
      jobs,
      jobId: job.jobId,
      handler: async () => { throw new Error('temporary GoC failure'); },
    });
    assert.equal(result.processed, 0);
    assert.equal(result.failed, 1);
    const remaining = readGocLateSyncQueue(jobs, job.jobId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].attempts, 1);
    assert.match(remaining[0].last_error, /temporary GoC failure/);
  } finally {
    if (typeof prevRuns === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRuns;
    if (typeof prevMode === 'undefined') delete process.env.GOC_SYNC_MODE;
    else process.env.GOC_SYNC_MODE = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('GoC late sync can flush selected kinds without dropping deferred rows', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-goc-late-filter-'));
  const prevRuns = process.env.RUNS_DIR;
  const prevMode = process.env.GOC_SYNC_MODE;
  process.env.RUNS_DIR = tempDir;
  process.env.GOC_SYNC_MODE = 'late';
  try {
    const jobs = new Jobs();
    const job = jobs.createJob({ title: 'late sync filter test' });
    enqueueGocLateSync({ jobs, jobId: job.jobId, kind: 'memory_demand', payload: { runId: 'run-1' } });
    enqueueGocLateSync({ jobs, jobId: job.jobId, kind: 'tracking_append', payload: { docName: 'progress.md' } });

    const handled = [];
    const result = await flushGocLateSyncQueue({
      jobs,
      jobId: job.jobId,
      shouldProcess: (row) => row.kind === 'memory_demand',
      handler: async (row) => { handled.push(row.kind); },
    });
    assert.deepEqual(handled, ['memory_demand']);
    assert.equal(result.processed, 1);
    const remaining = readGocLateSyncQueue(jobs, job.jobId);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].kind, 'tracking_append');
  } finally {
    if (typeof prevRuns === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRuns;
    if (typeof prevMode === 'undefined') delete process.env.GOC_SYNC_MODE;
    else process.env.GOC_SYNC_MODE = prevMode;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
