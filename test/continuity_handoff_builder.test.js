import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildContinuityHandoff, redactContinuityText } from '../src/evaluation/continuity_handoff_builder.js';

test('continuity handoff redacts common secret patterns', () => {
  const text = 'api_key=secret-value\nAuthorization: Bearer abc.def.ghi\n123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabc';
  const redacted = redactContinuityText(text);
  assert.doesNotMatch(redacted, /secret-value/);
  assert.doesNotMatch(redacted, /abc\.def\.ghi/);
  assert.doesNotMatch(redacted, /123456789:/);
});

test('continuity handoff copies run evidence, excludes env/git/cache, and writes scorecard', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'continuity-handoff-'));
  const run = path.join(root, 'run-a');
  fs.mkdirSync(path.join(run, '.git'), { recursive: true });
  fs.mkdirSync(path.join(run, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(run, '.env'), 'TOKEN=hidden\n');
  fs.writeFileSync(path.join(run, 'state.json'), JSON.stringify({
    run_id: 'run-a', scenario_id: 'restart_continuation', track: 'ai_rooms', status: 'completed', score: 1,
    manual_rubric: [{ id: 'goal', required: true, result: 'pass' }],
    semantic_judgment: { result: { passed: true, score: 0.9 } },
  }));
  fs.writeFileSync(path.join(run, 'RUNBOOK.md'), 'api_key=very-secret\n');
  const result = await buildContinuityHandoff({ runDirs: [run], outDir: path.join(root, 'out'), createArchive: false, probe: false });
  assert.ok(fs.existsSync(path.join(result.output_dir, 'HANDOFF.md')));
  assert.ok(fs.existsSync(path.join(result.output_dir, 'HANDOFF_MANIFEST.json')));
  assert.ok(fs.existsSync(path.join(result.output_dir, 'scorecard.csv')));
  const copiedRoot = path.join(result.output_dir, 'runs', 'run-a');
  assert.equal(fs.existsSync(path.join(copiedRoot, '.env')), false);
  assert.equal(fs.existsSync(path.join(copiedRoot, '.git')), false);
  assert.equal(fs.existsSync(path.join(copiedRoot, 'node_modules')), false);
  assert.doesNotMatch(fs.readFileSync(path.join(copiedRoot, 'RUNBOOK.md'), 'utf8'), /very-secret/);
  assert.match(fs.readFileSync(path.join(result.output_dir, 'scorecard.csv'), 'utf8'), /restart_continuation/);
});
