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
