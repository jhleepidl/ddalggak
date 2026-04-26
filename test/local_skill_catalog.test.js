import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listLocalSkillPackages, getLocalSkillPackage } from '../src/application/local_skill_catalog.js';

test('local skill catalog normalizes local manifests', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-catalog-'));
  const dir = path.join(tmp, 'skills', 'demo_skill');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ id: 'skill.demo.v1', slug: 'demo_skill', name: 'Demo Skill', description: 'A local skill', capability_tags: ['demo'], kind: 'tool' }), 'utf8');
  const rows = listLocalSkillPackages({ rootDir: tmp });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'skill.demo.v1');
  assert.equal(rows[0].side_effect_level, 'read_only');
  assert.equal(getLocalSkillPackage('demo_skill', { rootDir: tmp }).id, 'skill.demo.v1');
});
