import test from 'node:test';
import assert from 'node:assert/strict';

import { createGocTrackingIo } from '../src/application/telegram_goc_tracking_io.js';

function makeHarness({ memoryMode = 'goc', appendError = null } = {}) {
  const calls = {
    append: [],
    appendWithContract: [],
    ensureJobThread: [],
    createMemoryNode: [],
    ensureSurfaces: [],
    logs: [],
  };
  let invalidations = [];
  const client = {
    createMemoryNode(threadId, payload) {
      calls.createMemoryNode.push({ threadId, payload });
      return { id: 'node-1', threadId, payload };
    },
  };
  const io = createGocTrackingIo({
    clip: (value, max) => String(value || '').slice(0, max),
    jobs: { log(jobId, message) { calls.logs.push({ jobId, message }); } },
    tracking: {
      append(jobId, doc, markdown) {
        calls.append.push({ jobId, doc, markdown });
      },
      appendWithContract(jobId, requestedDoc, markdown, options) {
        calls.appendWithContract.push({ jobId, requestedDoc, markdown, options });
        if (appendError) throw appendError;
        return {
          status: 'accepted',
          requested_doc: requestedDoc,
          resolved_doc: requestedDoc === 'plan' ? 'plan' : 'progress',
          requested_surface_id: 'team_notes',
          target_surface_id: 'team_notes',
        };
      },
    },
    runDir: (jobId) => `/tmp/${jobId}`,
    memoryModeWithFallback: () => memoryMode,
    requireGocClient: () => client,
    ensureJobThread: async (resolvedClient, payload) => {
      calls.ensureJobThread.push({ resolvedClient, payload });
      return { threadId: 'thread-1' };
    },
    ensureKnowledgeBaseMemorySurfacesInGoc: async (jobId, payload) => {
      calls.ensureSurfaces.push({ jobId, payload });
    },
    buildGocMemoryNodePayload: (payload) => ({ ...payload, built: true }),
    invalidateRoleScopedContextCache: (payload) => { invalidations.push(payload); },
  });
  return { io, calls, invalidations };
}

test('appendRoleAwareTrackingWithStatus records accepted writes and mirrors to GoC', async () => {
  const { io, calls } = makeHarness();

  const result = io.appendRoleAwareTrackingWithStatus('job-1', '## note', {
    provider: 'chatgpt',
    roleId: 'operator',
    purpose: 'worklog',
    requestedDoc: 'plan',
  });

  assert.equal(result.blocked, false);
  assert.equal(result.writeEvent?.resolved_doc, 'plan');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(calls.appendWithContract.length, 1);
  assert.equal(calls.ensureJobThread.length, 1);
  assert.equal(calls.ensureSurfaces.length, 1);
  assert.equal(calls.createMemoryNode.length, 1);
  assert.equal(calls.createMemoryNode[0].payload.targetSurfaceId, 'team_notes');
});

test('appendRoleAwareTrackingWithStatus audits blocked writes without throwing', () => {
  const error = new Error('blocked by policy');
  error.memory_write_event = {
    status: 'rejected',
    requested_surface_id: 'final_answer',
    reason: 'policy_blocked',
  };
  const { io, calls } = makeHarness({ appendError: error });

  const result = io.appendRoleAwareTrackingWithStatus('job-2', '## blocked', {
    provider: 'chatgpt',
    roleId: 'planner',
    purpose: 'final',
    requestedDoc: 'final',
  });

  assert.equal(result.blocked, true);
  assert.equal(result.writeEvent?.reason, 'policy_blocked');
  assert.equal(calls.append.length, 1);
  assert.match(calls.append[0].markdown, /memory_write_blocked/);
  assert.equal(calls.createMemoryNode.length, 0);
});

test('syncRoleAwareMemoryWriteToGoc skips mirroring when memory mode is not goc', async () => {
  const { io, calls } = makeHarness({ memoryMode: 'local' });

  const result = await io.syncRoleAwareMemoryWriteToGoc('job-3', '## noop', {
    provider: 'chatgpt',
    roleId: 'operator',
    purpose: 'worklog',
    writeEvent: { target_surface_id: 'team_notes', status: 'accepted' },
  });

  assert.equal(result, null);
  assert.equal(calls.ensureJobThread.length, 0);
  assert.equal(calls.createMemoryNode.length, 0);
});


test('syncRoleAwareMemoryWriteToGoc invalidates role-scoped context cache after successful mirror', async () => {
  const { io, invalidations } = makeHarness();

  await io.syncRoleAwareMemoryWriteToGoc('job-4', '## synced', {
    provider: 'chatgpt',
    roleId: 'operator',
    purpose: 'worklog',
    writeEvent: { target_surface_id: 'team_notes', status: 'accepted' },
  });

  assert.equal(invalidations.length, 1);
  assert.equal(invalidations[0].threadId, 'thread-1');
  assert.equal(invalidations[0].jobId, 'job-4');
});
