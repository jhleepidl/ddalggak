import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SkillResolver } from '../src/control_plane/skill_resolver.js';
import { recordSkillActivationDecision } from '../src/application/skill_rule_activation_audit.js';

function tmpJob() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-audit-'));
  const jobDir = path.join(root, 'runs', 'job1');
  fs.mkdirSync(path.join(jobDir, 'local_memory'), { recursive: true });
  return { root, jobDir };
}

test('skill activation decisions are written to run local memory', () => {
  const { jobDir } = tmpJob();
  const row = recordSkillActivationDecision({ skillId: 'skill.karpathy_coding_guidelines.v1', roleId: 'builder', decision: 'activated', reasons: ['task_type_match'], score: 42 }, { jobDir, mirrorToBoard: false });
  assert.equal(row.skill_id, 'skill.karpathy_coding_guidelines.v1');
  const log = fs.readFileSync(path.join(jobDir, 'local_memory', 'skill_activations.jsonl'), 'utf8');
  assert.match(log, /karpathy_coding_guidelines/);
  const all = fs.readFileSync(path.join(jobDir, 'local_memory', 'activation_decisions.jsonl'), 'utf8');
  assert.match(all, /activated/);
});

test('skill resolver audit records selected and non-selected candidates', () => {
  const { jobDir } = tmpJob();
  const registry = {
    list: () => [
      { id: 'skill.good', status: 'active', compatible_roles: ['builder'], trigger_terms: ['build'], description: 'Build code', ranking_metadata: { reuse_score: 80 } },
      { id: 'skill.other', status: 'active', compatible_roles: ['builder'], trigger_terms: ['unrelated'], description: 'Other' },
    ],
    resolve: (id) => ({ id }),
  };
  const resolver = new SkillResolver({ registry, maxSkillsPerRole: 1, minScore: 1 });
  const result = resolver.resolveForRole({ roleType: 'builder', goal: 'build a small feature', auditOptions: { jobDir, mirrorToBoard: false } });
  assert.equal(result.attachments.length, 1);
  const log = fs.readFileSync(path.join(jobDir, 'local_memory', 'activation_decisions.jsonl'), 'utf8');
  assert.match(log, /skill.good/);
  assert.match(log, /activated/);
});
