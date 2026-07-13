import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { beginRuntimeActivity, getRuntimeActivityState, withRuntimeActivity } from '../src/application/runtime_activity_registry.js';

test('runtime activity leases expose provider CLI work as busy and clear after completion', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-runtime-activity-'));
  try {
    const lease = beginRuntimeActivity({ provider: 'codex', jobId: 'job-1', dir });
    const busy = getRuntimeActivityState({ dir });
    assert.equal(busy.busy, true);
    assert.equal(busy.active_runs, 1);
    assert.equal(busy.activities[0].provider, 'codex');
    lease.release();
    const idle = getRuntimeActivityState({ dir });
    assert.equal(idle.busy, false);
    assert.equal(idle.active_runs, 0);
    assert.equal(Number.isFinite(idle.idle_for_ms), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withRuntimeActivity always releases the lease after errors', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-runtime-activity-'));
  try {
    await assert.rejects(
      withRuntimeActivity({ provider: 'claude', dir }, async () => { throw new Error('boom'); }),
      /boom/,
    );
    assert.equal(getRuntimeActivityState({ dir }).busy, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
