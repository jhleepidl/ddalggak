import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'scripts', 'verify_source_bundle_hygiene.js');

function runCheck(target) {
  return spawnSync(process.execPath, [script, target], { encoding: 'utf8' });
}

test('source bundle hygiene accepts a clean source tree', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-clean-'));
  try {
    fs.mkdirSync(path.join(root, 'ddalggak', 'src', 'shared'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ddalggak', 'src', 'index.js'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'ddalggak', 'src', 'shared', 'openharness_contracts.js'), 'export {};\n');
    fs.writeFileSync(path.join(root, 'ddalggak', 'src', 'shared', 'team_structure_v2.js'), 'export {};\n');
    fs.mkdirSync(path.join(root, 'ddalggak', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'goc', 'backend', 'app', 'data'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ddalggak', 'config', 'recipe_catalog.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'goc', 'backend', 'app', 'data', 'recipe_catalog.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'ddalggak', 'config', 'collaboration_profiles.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'goc', 'backend', 'app', 'data', 'collaboration_profiles.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'docs', 'RECIPE_CATALOG_AND_STARTER_KITS.md'), '# Recipes\n');
    fs.writeFileSync(path.join(root, 'docs', 'GENERAL_TASK_RECIPES_AND_COLLABORATION_PROFILES.md'), '# General tasks\n');
    fs.mkdirSync(path.join(root, 'aaai_intervention_fidelity'), { recursive: true });
    fs.mkdirSync(path.join(root, 'purpose_context'), { recursive: true });
    fs.writeFileSync(path.join(root, 'aaai_intervention_fidelity', '.env.example'), 'OPENAI_API_KEY=\n');
    fs.writeFileSync(path.join(root, 'purpose_context', '.env.example'), 'OPENAI_API_KEY=\n');
    for (const rel of [
      'ddalggak/src/application/loop_execution_kernel.js',
      'ddalggak/src/application/loop_run_store.js',
      'ddalggak/src/application/loop_memory_manager.js',
      'docs/architecture/LOOP_EXECUTION_KERNEL_AND_MEMORY_LIFECYCLE.md',
      'docs/operations/LOOP_DOGFOOD_RUNBOOK.md',
    ]) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, rel.endsWith('.js') ? 'export {};\n' : '# Required\n');
    }
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});



test('source bundle hygiene allows only the public benchmark workspace README', () => {
  const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-public-readme-'));
  try {
    const readme = path.join(cleanRoot, 'route_validity', 'data', 'public', 'README.md');
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, '# Public benchmark workspace\n');
    const clean = runCheck(cleanRoot);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);
  } finally {
    fs.rmSync(cleanRoot, { recursive: true, force: true });
  }

  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-public-raw-'));
  try {
    const raw = path.join(badRoot, 'route_validity', 'data', 'public', 'longmemeval', 'data.jsonl');
    fs.mkdirSync(path.dirname(raw), { recursive: true });
    fs.writeFileSync(raw, '{"raw":true}\n');
    const bad = runCheck(badRoot);
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /forbidden files found/);
  } finally {
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
});



test('source bundle hygiene accepts a zip containing only the public benchmark workspace README', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-public-readme-zip-'));
  const zipPath = path.join(os.tmpdir(), `bundle-public-readme-${process.pid}-${Date.now()}.zip`);
  try {
    const readme = path.join(root, 'route_validity', 'data', 'public', 'README.md');
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, '# Public benchmark workspace\n');
    const zipped = spawnSync('zip', ['-qr', zipPath, 'route_validity'], { cwd: root, encoding: 'utf8' });
    assert.equal(zipped.status, 0, zipped.stderr || zipped.stdout);
    const result = runCheck(zipPath);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(zipPath, { force: true });
  }
});

test('source bundle hygiene rejects a bundle missing required shared source contracts', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-missing-shared-'));
  try {
    fs.mkdirSync(path.join(root, 'ddalggak', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'ddalggak', 'src', 'index.js'), 'export {};\n');
    const result = runCheck(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /required source files missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source bundle hygiene rejects embedded git metadata and private keys', () => {
  for (const relative of ['ddalggak/.git/config', 'goc/secrets/deploy.pem', 'experiment_runs/pilot/raw_prompt.txt', 'ddalggak/experiments/room_journeys/pilot/policy_trials.jsonl', 'ddalggak/local_memory/loop_runs/loop-1/events.jsonl']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-bad-'));
    try {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'secret\n');
      const result = runCheck(root);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /forbidden files found/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('source bundle hygiene allows only the PurposeContext public workspace README', () => {
  const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-purpose-public-readme-'));
  try {
    const readme = path.join(cleanRoot, 'purpose_context', 'data', 'public', 'README.md');
    fs.mkdirSync(path.dirname(readme), { recursive: true });
    fs.writeFileSync(readme, '# Public benchmark workspace\n');
    const clean = runCheck(cleanRoot);
    assert.equal(clean.status, 0, clean.stderr || clean.stdout);
    const raw = path.join(cleanRoot, 'purpose_context', 'data', 'public', 'longmemeval.jsonl');
    fs.writeFileSync(raw, '{"raw":true}\n');
    const bad = runCheck(cleanRoot);
    assert.notEqual(bad.status, 0);
  } finally {
    fs.rmSync(cleanRoot, { recursive: true, force: true });
  }
});

test('source bundle hygiene allows env templates but rejects real env files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-env-policy-'));
  try {
    const project = path.join(root, 'aaai_intervention_fidelity');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, '.env.example'), 'OPENAI_API_KEY=\n');
    let result = runCheck(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    fs.writeFileSync(path.join(project, '.env'), 'OPENAI_API_KEY=secret\n');
    result = runCheck(root);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /forbidden files found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
