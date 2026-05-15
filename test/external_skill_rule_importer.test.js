import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { importExternalSkillRuleSource } from '../src/application/external_skill_rule_importer.js';

test('external importer installs markdown skill as local skill package', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-external-skill-'));
  const skillsDir = path.join(tmp, 'skills');
  const mdPath = path.join(tmp, 'Tiny Skill.md');
  fs.writeFileSync(mdPath, '# Tiny Skill\n\nUse this tiny skill for focused tests.\n');

  const result = importExternalSkillRuleSource(mdPath, { rootDir: tmp, skillsDir });
  assert.equal(result.ok, true);
  assert.equal(result.installed_skills.length, 1);
  assert.equal(fs.existsSync(result.installed_skills[0].manifest_path), true);
  assert.match(fs.readFileSync(result.installed_skills[0].instructions_path, 'utf8'), /Tiny Skill/);
});

test('external importer accepts JSON package with skills and rules', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-external-package-'));
  const skillsDir = path.join(tmp, 'skills');
  const json = JSON.stringify({
    skills: [{
      id: 'skill.external_review.v1',
      slug: 'external_review',
      name: 'External Review',
      description: 'Review imported package',
      compatible_roles: ['reviewer'],
      instructions_ref: 'SKILL.md',
    }],
    rules: [{ text: 'Avoid unrelated refactors.', topic: 'agent_behavior' }],
  });

  const result = importExternalSkillRuleSource(json, { rootDir: tmp, skillsDir });
  assert.equal(result.installed_skills.length, 1);
  assert.equal(result.imported_rules.length, 1);
  assert.equal(result.imported_rules[0].text, 'Avoid unrelated refactors.');
});

test('external importer rejects direct remote URL imports', () => {
  assert.throws(
    () => importExternalSkillRuleSource('https://example.com/skill.json'),
    /remote URL import is disabled/,
  );
});
