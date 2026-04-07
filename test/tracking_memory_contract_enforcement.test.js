import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Jobs } from '../src/jobs.js';
import { Tracking } from '../src/tracking.js';

function withTempTracking(fn) {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-tracking-'));
  const jobs = new Jobs();
  jobs.baseDir = baseDir;
  jobs.runsDir = baseDir;
  fs.mkdirSync(baseDir, { recursive: true });
  const tracking = new Tracking(jobs);
  try {
    return fn({ jobs, tracking, baseDir });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

test('appendWithContract reroutes reviewer writes away from implementation-only surfaces and records the event', () => {
  withTempTracking(({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'memory contract enforcement' });
    tracking.init(job.jobId, {
      profile_id: 'implementation_memory_plan',
      display_name: 'Implementation KB',
      docs: [
        { doc_id: 'plan', surface_id: 'mission_brief', file_name: 'mission_brief.md', load_policy: 'always', write_policy: 'shared', target_roles: ['builder', 'reviewer'] },
        { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
        { doc_id: 'research', surface_id: 'critic_log', file_name: 'critic_log.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['reviewer'] },
        { doc_id: 'decisions', surface_id: 'final_answer', file_name: 'final_answer.md', load_policy: 'always', write_policy: 'final', target_roles: ['synthesizer'] },
      ],
    });

    const event = tracking.appendWithContract(job.jobId, 'implementation_notes', 'reviewer findings', {
      provider: 'gemini',
      roleId: 'reviewer',
      purpose: 'review',
      fallbackDoc: 'research',
      source: 'test',
    });

    assert.equal(event.status, 'rerouted');
    assert.equal(event.resolved_doc, 'critic_log.md');
    const criticLog = tracking.read(job.jobId, 'critic_log');
    assert.match(criticLog, /reviewer findings/);

    const events = tracking.readRecentWriteEvents(job.jobId, 5);
    assert.equal(events.length, 1);
    assert.equal(events[0].resolved_doc, 'critic_log.md');
    assert.equal(events[0].requested_doc, 'implementation_notes');
  });
});


test('appendWithContract strict rejection records the event and does not fallback-write blocked content', () => {
  withTempTracking(({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'strict rejection' });
    tracking.init(job.jobId, {
      profile_id: 'implementation_memory_plan',
      display_name: 'Implementation KB',
      docs: [
        { doc_id: 'plan', surface_id: 'mission_brief', file_name: 'mission_brief.md', load_policy: 'always', write_policy: 'shared', target_roles: ['builder', 'reviewer'] },
        { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
        { doc_id: 'research', surface_id: 'critic_log', file_name: 'critic_log.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['reviewer'] },
      ],
    });

        let capturedError = null;
    try {
      tracking.appendWithContract(job.jobId, 'implementation_notes', 'blocked write', {
        provider: 'chatgpt',
        roleId: 'synthesizer',
        purpose: 'implementation',
        fallbackDoc: 'progress',
        strict: true,
        source: 'test',
      });
    } catch (error) {
      capturedError = error;
    }
    assert.match(String(capturedError?.message || ''), /memory write rejected/i);
    assert.equal(capturedError?.memory_write_event?.status, 'rejected');

    const resolvedProgress = tracking.resolveDocName(job.jobId, 'progress');
    const progressPath = path.join(job.dir, resolvedProgress);
    const progressDoc = fs.existsSync(progressPath) ? fs.readFileSync(progressPath, 'utf8') : '';
    assert.doesNotMatch(progressDoc, /blocked write/);

    const events = tracking.readRecentWriteEvents(job.jobId, 5);
    assert.equal(events.length, 1);
    assert.equal(events[0].status, 'rejected');
    assert.equal(events[0].policy_blocked, true);
    assert.equal(events[0].target_surface_id, '');
  });
});


test('append passes metadata to append hooks for system writes', () => {
  withTempTracking(({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'append hook metadata' });
    tracking.init(job.jobId, {
      profile_id: 'implementation_memory_plan',
      display_name: 'Implementation KB',
      docs: [
        { doc_id: 'decisions', surface_id: 'final_answer', file_name: 'final_answer.md', load_policy: 'always', write_policy: 'final', target_roles: ['synthesizer'] },
      ],
    });

    let payload = null;
    tracking.setAppendHook((row) => { payload = row; });
    tracking.append(job.jobId, 'decisions', 'system decision note', {
      provider: 'chatgpt',
      roleId: 'operator',
      purpose: 'final',
      source: 'system',
      eventType: 'routing_decision',
      actorKind: 'planner',
      pipelineStage: 'routing',
      semanticKind: 'decisions',
    });

    assert.equal(payload?.docName, 'final_answer.md');
    assert.equal(payload?.provider, 'chatgpt');
    assert.equal(payload?.roleId, 'operator');
    assert.equal(payload?.purpose, 'final');
    assert.equal(payload?.source, 'system');
    assert.equal(payload?.eventType, 'routing_decision');
    assert.equal(payload?.actorKind, 'planner');
    assert.equal(payload?.pipelineStage, 'routing');
    assert.equal(payload?.semanticKind, 'decisions');
  });
});

test('append derives purpose from profile semantic slots when doc name is non-semantic', () => {
  withTempTracking(({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'profile semantic fallback' });
    tracking.init(job.jobId, {
      profile_id: 'custom_profile',
      display_name: 'Custom KB',
      docs: [
        { doc_id: 'decisions', surface_id: 'executive_log', file_name: 'journal.md', semantic_slots: ['decisions'], target_roles: ['synthesizer'] },
      ],
    });

    let payload = null;
    tracking.setAppendHook((row) => { payload = row; });
    tracking.append(job.jobId, 'journal', 'final signoff note', {
      source: 'system',
      actorKind: 'system',
      eventType: 'signoff_summary',
    });

    assert.equal(payload?.docName, 'journal.md');
    assert.equal(payload?.purpose, 'final');
    assert.equal(payload?.semanticKind, 'decisions');
    assert.equal(payload?.eventType, 'signoff_summary');
  });
});

test('append logs append hook failures instead of swallowing them silently', async () => {
  await withTempTracking(async ({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'append hook failure logging' });
    tracking.init(job.jobId, {
      profile_id: 'implementation_memory_plan',
      display_name: 'Implementation KB',
      docs: [
        { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
      ],
    });

    tracking.setAppendHook(() => {
      throw new Error('hook exploded');
    });

    tracking.append(job.jobId, 'progress', 'builder note', {
      provider: 'codex',
      roleId: 'builder',
      purpose: 'implementation',
      source: 'system',
    });

    const jobLog = fs.readFileSync(path.join(job.dir, 'job.log'), 'utf8');
    assert.match(jobLog, /append hook failure: hook exploded/i);
  });
});


test('loadProfile reuses cached profile until the profile file changes on disk', () => {
  withTempTracking(({ jobs, tracking }) => {
    const job = jobs.createJob({ title: 'profile cache reuse' });
    tracking.init(job.jobId, {
      profile_id: 'implementation_memory_plan',
      display_name: 'Implementation KB',
      docs: [
        { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
      ],
    });

    const profilePath = path.join(job.dir, 'shared', 'knowledge_base_profile.json');
    const originalReadFileSync = fs.readFileSync;
    let profileReadCount = 0;
    fs.readFileSync = function patchedRead(filePath, ...args) {
      if (String(filePath) === profilePath) profileReadCount += 1;
      return originalReadFileSync.call(this, filePath, ...args);
    };

    try {
      const first = tracking.loadProfile(job.jobId);
      const second = tracking.loadProfile(job.jobId);
      assert.equal(first?.docs?.length, 1);
      assert.equal(second?.docs?.length, 1);
      assert.equal(profileReadCount, 0);

      const updated = {
        profile_id: 'implementation_memory_plan',
        display_name: 'Implementation KB',
        docs: [
          { doc_id: 'progress', surface_id: 'implementation_notes', file_name: 'implementation_notes.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['builder'] },
          { doc_id: 'research', surface_id: 'critic_log', file_name: 'critic_log.md', load_policy: 'on_demand', write_policy: 'append_only', target_roles: ['reviewer'] },
        ],
      };
      fs.writeFileSync(profilePath, JSON.stringify(updated, null, 2), 'utf8');
      const now = new Date(Date.now() + 1500);
      fs.utimesSync(profilePath, now, now);

      const third = tracking.loadProfile(job.jobId);
      assert.equal(third?.docs?.length, 2);
      assert.equal(profileReadCount, 1);
    } finally {
      fs.readFileSync = originalReadFileSync;
    }
  });
});
