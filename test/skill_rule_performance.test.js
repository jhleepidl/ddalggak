import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeReuseScore,
  formatSkillRulePerformanceSummary,
  recordSkillRulePerformanceEvent,
  writeSkillRulePerformanceStore,
  readSkillRulePerformanceStore,
} from '../src/application/skill_rule_performance.js';
import { SkillRegistryV2 } from '../src/catalog/skill_registry_v2.js';

test('skill/rule performance store computes reuse scores and records events', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-skill-perf-'));
  const filePath = path.join(tmp, 'skill_rule_performance.json');
  const store = writeSkillRulePerformanceStore({
    skills: [{ id: 'skill.alpha.v1', usage_count: 4, success_rate: 0.8, verification_pass_rate: 0.75, risk: 'low' }],
  }, { filePath });

  assert.ok(store.skills['skill.alpha.v1'].reuse_score > 60);
  const updated = recordSkillRulePerformanceEvent({ id: 'skill.alpha.v1', kind: 'skill', success: true }, { filePath });
  assert.equal(updated.usage_count, 5);
  assert.ok(computeReuseScore(updated) >= 0);
  assert.match(formatSkillRulePerformanceSummary(readSkillRulePerformanceStore({ filePath })), /skill\.alpha\.v1/);
});

test('skill registry merges performance metadata into skill packages', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-skill-reg-perf-'));
  const skillsDir = path.join(tmp, 'skills');
  const skillDir = path.join(skillsDir, 'alpha');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'manifest.json'), JSON.stringify({
    id: 'skill.alpha.v1',
    slug: 'alpha',
    name: 'Alpha',
    description: 'Alpha coding skill',
    compatible_roles: ['builder'],
    instructions_ref: 'SKILL.md',
  }));
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Alpha\n');
  const perfPath = path.join(tmp, 'perf.json');
  writeSkillRulePerformanceStore({
    skills: [{ id: 'skill.alpha.v1', usage_count: 9, success_rate: 0.9, verification_pass_rate: 0.8, risk: 'low' }],
  }, { filePath: perfPath });

  const registry = new SkillRegistryV2({ skillsDir, rootDir: tmp, performancePath: perfPath });
  const loaded = registry.load({ refresh: true });
  assert.equal(loaded.skills.length, 1);
  const skill = registry.resolve('skill.alpha.v1');
  assert.equal(skill.ranking_metadata.usage_count, 9);
  assert.equal(skill.ranking_metadata.success_rate, 0.9);
  assert.ok(skill.ranking_metadata.reuse_score > 70);
});
