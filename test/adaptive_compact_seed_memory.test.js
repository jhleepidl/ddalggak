import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';
import { deriveInitialKnowledgeBaseDesign, resolveKnowledgeDocName } from '../src/knowledge_base/profile.js';

test('initial adaptive compact seed maps semantic memory slots to one core file', () => {
  const design = deriveInitialKnowledgeBaseDesign({ goal: '여행 일정을 기억하고 도와줘' });
  assert.equal(design.profile.profile_id, 'adaptive_compact_seed');
  assert.equal(resolveKnowledgeDocName(design.profile, 'plan'), 'core_memory.md');
  assert.equal(resolveKnowledgeDocName(design.profile, 'research'), 'core_memory.md');
  assert.equal(resolveKnowledgeDocName(design.profile, 'progress'), 'core_memory.md');
  assert.equal(resolveKnowledgeDocName(design.profile, 'artifacts'), 'core_memory.md');
  assert.equal(new Set(design.profile.docs.map((doc) => doc.file_name)).size, 1);
});

test('Tracking compact seed starts with a single shared memory document and can append all slots there', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-compact-seed-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'compact seed test' });
    const design = deriveInitialKnowledgeBaseDesign({ goal: 'compact seed test' });
    tracking.init(job.jobId, design.profile);

    tracking.append(job.jobId, 'plan', 'goal line', { syncToGoc: false });
    tracking.append(job.jobId, 'research', 'fact line', { syncToGoc: false });
    tracking.append(job.jobId, 'progress', 'progress line', { syncToGoc: false });
    tracking.append(job.jobId, 'artifacts', 'artifact line', { syncToGoc: false });

    const sharedFiles = fs.readdirSync(path.join(job.dir, 'shared')).filter((name) => name.endsWith('.md')).sort();
    assert.deepEqual(sharedFiles, ['core_memory.md', 'knowledge_base_contract.md']);
    const core = fs.readFileSync(path.join(job.dir, 'shared', 'core_memory.md'), 'utf8');
    assert.match(core, /goal line/);
    assert.match(core, /fact line/);
    assert.match(core, /progress line/);
    assert.match(core, /artifact line/);
  } finally {
    if (typeof prevRunsDir === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});

test('Tracking syncToGoc=false suppresses append hook for bootstrap/local-only writes', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-sync-skip-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    let hookCalls = 0;
    const tracking = new Tracking(jobs, { appendHook: () => { hookCalls += 1; } });
    const job = jobs.createJob({ title: 'sync skip test' });
    const design = deriveInitialKnowledgeBaseDesign({ goal: 'sync skip test' });
    tracking.init(job.jobId, design.profile);

    tracking.append(job.jobId, 'plan', 'local only', { syncToGoc: false });
    assert.equal(hookCalls, 0);
    tracking.append(job.jobId, 'plan', 'sync this');
    assert.equal(hookCalls, 1);
  } finally {
    if (typeof prevRunsDir === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});
