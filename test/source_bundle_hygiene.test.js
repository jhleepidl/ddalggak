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
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
  for (const relative of ['ddalggak/.git/config', 'goc/secrets/deploy.pem']) {
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
