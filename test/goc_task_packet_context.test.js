import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GocContextEngine } from '../src/runtime_capabilities/context_engines/goc_engine.js';
import { updateCurrentTaskPacket } from '../src/application/task_packet.js';

function makeJobDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-goc-task-packet-'));
  const jobDir = path.join(root, 'job-1');
  fs.mkdirSync(path.join(jobDir, 'local_memory'), { recursive: true });
  fs.mkdirSync(path.join(jobDir, 'shared'), { recursive: true });
  return { root, jobDir };
}

function jobsFor(jobDir) {
  return {
    jobDir() {
      return jobDir;
    },
  };
}

function fakeClient() {
  return {
    async getCompiledContextWithMeta(contextSetId, _opts = {}) {
      return {
        text: `[COMPILED ${contextSetId}]\nlegacy shared context`,
        token_estimate: 25,
        active_node_ids: ['n1', 'n2'],
        context_version: 'v-test',
        node_type_breakdown: { 'message:user': 1, artifact: 1 },
      };
    },
    async cloneContextSet() {
      return { id: 'lens-1' };
    },
    async unfoldPlan() {
      return { added_node_ids: [] };
    },
    async applyUnfoldPlan() {
      return { added_node_ids: [] };
    },
    async activateNodes() {
      return true;
    },
    async deactivateNodes() {
      return true;
    },
    async listNodes() {
      return [];
    },
  };
}

test('goc step context prepends current task packet ahead of compiled shared/lens context', async () => {
  const { root, jobDir } = makeJobDir();
  try {
    updateCurrentTaskPacket({
      jobDir,
      currentUserText: '/chat ARAM Mayhem companion app을 만들고 exe까지 전달해줘.',
      persist: true,
    });

    const engine = new GocContextEngine({
      client: fakeClient(),
      jobs: jobsFor(jobDir),
      runtime: {},
    });

    const prepared = await engine.prepareStepContext({
      jobId: 'job-1',
      agentId: 'coder',
      roleId: 'builder',
      goal: '게임 companion app 구현',
      runMeta: {
        threadId: 'thread-1',
        sharedContextSetId: 'ctx-shared-1',
      },
    });

    assert.match(prepared.contextText, /CURRENT TASK PACKET/);
    assert.match(prepared.contextText, /ARAM Mayhem companion app/);
    assert.match(prepared.contextText, /COMPILED ctx-shared-1|COMPILED lens-1/);
    assert.ok(prepared.contextText.indexOf('[CURRENT TASK PACKET]') < prepared.contextText.indexOf('[COMPILED'));
    assert.equal(prepared.meta.compiledChars, prepared.contextText.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('goc context falls back to task packet instead of empty legacy context when shared context is unavailable', async () => {
  const { root, jobDir } = makeJobDir();
  try {
    updateCurrentTaskPacket({
      jobDir,
      currentUserText: '/chat npm install도 하고 가능하면 exe로 줘.',
      persist: true,
    });

    const engine = new GocContextEngine({
      client: null,
      jobs: jobsFor(jobDir),
      runtime: {},
    });

    const prepared = await engine.prepareStepContext({
      jobId: 'job-1',
      agentId: 'coder',
      roleId: 'builder',
      goal: 'deliver the app',
      runMeta: {
        threadId: 'thread-1',
      },
    });

    assert.match(prepared.contextText, /CURRENT TASK PACKET/);
    assert.match(prepared.contextText, /npm install/);
    assert.equal(prepared.meta.contextFallback, 'task_packet_only');
    assert.ok(prepared.meta.compiledChars > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
