import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  getAgentMemoryGrant,
  loadMemoryTopology,
  planMemoryTopology,
  readMemoryTopologyEvents,
} from '../src/application/memory_topology.js';
import { runIdleMemoryMaintenance } from '../src/application/idle_compaction.js';

function makeJobDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-memory-topology-'));
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
}

test('memory topology starts flat for low-pressure single-agent runs', () => {
  const jobDir = makeJobDir();
  try {
    writeJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), [
      { role: 'user', text: '간단히 요약해줘.' },
    ]);
    const topology = planMemoryTopology({ jobDir, roleId: 'builder', agentId: 'builder', persist: true });
    assert.equal(topology.mode, 'ephemeral');
    assert.deepEqual(getAgentMemoryGrant(topology, { roleId: 'builder', agentId: 'builder' }).read, ['conversation_tail']);
    assert.ok(fs.existsSync(path.join(jobDir, 'local_memory', 'memory_topology.json')));
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('memory topology escalates to team-scoped grants under multi-agent write pressure', () => {
  const jobDir = makeJobDir();
  try {
    writeJsonl(path.join(jobDir, 'local_memory', 'turns.jsonl'), Array.from({ length: 16 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i}` })));
    writeJsonl(path.join(jobDir, 'memory_write_events.jsonl'), [
      { role_id: 'builder', resolved_doc: 'progress.md' },
      { role_id: 'reviewer', resolved_doc: 'research.md' },
    ]);
    const topology = planMemoryTopology({
      jobDir,
      runMeta: { runtimeTeamSnapshot: { participants: [{ id: 'builder', role: 'builder' }, { id: 'reviewer', role: 'reviewer' }, { id: 'synthesizer', role: 'synthesizer' }] } },
      roleId: 'reviewer',
      agentId: 'reviewer',
      persist: true,
    });
    assert.equal(topology.mode, 'team_scoped');
    const reviewer = getAgentMemoryGrant(topology, { roleId: 'reviewer', agentId: 'reviewer' });
    assert.ok(reviewer.read.includes('review'));
    assert.ok(reviewer.write.includes('review'));
    assert.ok(readMemoryTopologyEvents({ jobDir }).length >= 1);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test('idle memory maintenance refreshes topology without destructive changes', () => {
  const jobDir = makeJobDir();
  try {
    writeJsonl(path.join(jobDir, 'conversation.jsonl'), Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: i === 12 ? '아니라 이전 정정을 유지해.' : `message ${i}` })));
    const result = runIdleMemoryMaintenance({ jobDir, force: true, maxChars: 3000 });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.ok(result.topology?.mode);
    assert.equal(result.state?.last_candidate_written, true);
    const stored = loadMemoryTopology({ jobDir });
    assert.equal(stored.mode, result.topology.mode);
    assert.equal(result.candidate?.destructive_changes, false);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
