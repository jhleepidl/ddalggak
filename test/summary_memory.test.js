import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readIterationDelta, readRoleSummary, updateRoleSummary } from '../src/application/summary_memory.js';

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-summary-memory-'));
}

test('updateRoleSummary persists role summary and iteration delta in local memory', () => {
  const dir = makeTmpDir();
  const rec = updateRoleSummary({
    jobDir: dir,
    roleId: 'builder',
    agentId: 'codex',
    goal: 'Patch the notebook flow',
    output: 'Updated notebook.ipynb and tightened the exercise ordering.',
    provider: 'codex',
    model: 'gpt-5-codex',
  });
  assert.ok(rec?.ok);
  const roleText = readRoleSummary({ jobDir: dir, roleId: 'builder' });
  const deltaText = readIterationDelta({ jobDir: dir });
  assert.match(roleText, /Patch the notebook flow/);
  assert.match(roleText, /Updated notebook\.ipynb/);
  assert.match(deltaText, /delta:/);
  assert.ok(fs.existsSync(path.join(dir, 'local_memory', 'role_summaries', 'builder.md')));
  assert.ok(fs.existsSync(path.join(dir, 'local_memory', 'iteration_delta.md')));
});


test('updateRoleSummary avoids underscore-only alias files for non-latin agent ids', () => {
  const dir = makeTmpDir();
  updateRoleSummary({
    jobDir: dir,
    roleId: 'builder',
    agentId: '오버레이 빌더',
    goal: 'Patch the desktop packaging flow',
    output: 'Updated the Windows launcher packaging notes.',
    provider: 'codex',
    model: 'gpt-5-codex',
  });
  const files = fs.readdirSync(path.join(dir, 'local_memory', 'role_summaries')).sort();
  assert.ok(files.includes('builder.md'));
  assert.equal(files.some((name) => /^_+\.md$/.test(name)), false);
});
