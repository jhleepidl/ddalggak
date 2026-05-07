import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';
import { deriveInitialKnowledgeBaseDesign, resolveKnowledgeDocName } from '../src/knowledge_base/profile.js';
import { buildChatGPTNextStepPrompt, orchestratorNotes } from '../src/prompts.js';
import { planMemoryTopology } from '../src/application/memory_topology.js';

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


test('orchestrator notes deduplicate adaptive compact tracking files by concrete file name', () => {
  const design = deriveInitialKnowledgeBaseDesign({ goal: '여행 일정을 기억하고 도와줘' });
  const notes = orchestratorNotes({ goal: '여행 일정을 기억하고 도와줘', knowledgeBaseProfile: design.profile });
  const coreLines = notes.split('\n').filter((line) => /^- core_memory\.md:/.test(line));
  assert.equal(coreLines.length, 1);
  assert.match(coreLines[0], /semantic slots: plan, research, progress, decisions, artifacts/);
});


test('Tracking files section is regenerated from current memory topology instead of appended', () => {
  const prevRunsDir = process.env.RUNS_DIR;
  const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-tracking-view-'));
  process.env.RUNS_DIR = runsDir;
  try {
    const jobs = new Jobs();
    const tracking = new Tracking(jobs);
    const job = jobs.createJob({ title: 'tracking view test' });
    const design = deriveInitialKnowledgeBaseDesign({ goal: 'tracking view test' });
    tracking.init(job.jobId, design.profile);
    tracking.append(job.jobId, 'plan', orchestratorNotes({ goal: 'tracking view test', knowledgeBaseProfile: design.profile }), { timestamp: false, syncToGoc: false });

    planMemoryTopology({ jobDir: job.dir, persist: true, forceMode: 'team_scoped', eventReason: 'test_promote' });
    const corePath = path.join(job.dir, 'shared', 'core_memory.md');
    const core = fs.readFileSync(corePath, 'utf8');
    assert.equal((core.match(/^## Tracking files$/gm) || []).length, 1);
    assert.equal((core.match(/^- core_memory\.md:/gm) || []).length, 1);
    assert.match(core, /Generated from current memory topology \(team_scoped/);
    assert.match(core, /^- research\.md:/m);
    assert.match(core, /^- progress\.md:/m);
    assert.match(core, /^- review_findings\.md:/m);
    assert.match(core, /^- decisions\.md:/m);

    planMemoryTopology({ jobDir: job.dir, persist: true, forceMode: 'compact_single', eventReason: 'test_compact' });
    const compactCore = fs.readFileSync(corePath, 'utf8');
    assert.equal((compactCore.match(/^## Tracking files$/gm) || []).length, 1);
    assert.equal((compactCore.match(/^- core_memory\.md:/gm) || []).length, 1);
    assert.match(compactCore, /Generated from current memory topology \(compact_single/);
    assert.doesNotMatch(compactCore, /^- review_findings\.md:/m);
  } finally {
    if (typeof prevRunsDir === 'undefined') delete process.env.RUNS_DIR;
    else process.env.RUNS_DIR = prevRunsDir;
    fs.rmSync(runsDir, { recursive: true, force: true });
  }
});


test('orchestrator prompts without an explicit profile no longer seed legacy plan/research/progress paths', () => {
  const notes = orchestratorNotes({ goal: 'continue implementation' });
  assert.match(notes, /core_memory\.md/);
  assert.doesNotMatch(notes, /plan\.md/);
  assert.doesNotMatch(notes, /research\.md/);
  assert.doesNotMatch(notes, /progress\.md/);

  const prompt = buildChatGPTNextStepPrompt({
    jobId: 'job-1',
    goal: 'continue implementation',
    question: 'next',
    contextDocsText: '',
    convoText: '',
  });
  assert.match(prompt, /core_memory\.md/);
  assert.doesNotMatch(prompt, /plan\.md/);
  assert.doesNotMatch(prompt, /research\.md/);
  assert.doesNotMatch(prompt, /progress\.md/);
  assert.doesNotMatch(prompt, /artifacts\.md/);
});
