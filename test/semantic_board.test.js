import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildPromptProjectionFromBoard,
  formatSemanticBoardSummary,
  importSemanticBoardSource,
  mirrorSkillPerformanceToSemanticBoard,
  mirrorSkillRuleImportToSemanticBoard,
  readSemanticBoard,
  runtimeRuleToSemanticCard,
  skillPackageToSemanticCard,
  summarizeSemanticBoard,
  upsertSemanticBoardCards,
  upsertSemanticBoardLinks,
} from '../src/application/semantic_board.js';

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-board-test-'));
}

test('semantic board stores cards and links as typed state', () => {
  const rootDir = tmpRoot();
  const skill = skillPackageToSemanticCard({
    id: 'skill.karpathy_coding_guidelines.local',
    name: 'Karpathy Coding Guidelines',
    description: 'Think first, keep changes surgical, verify results.',
    capability_tags: ['coding', 'review'],
    performance: { reuse_score: 82 },
  });
  const rule = runtimeRuleToSemanticCard({ id: 'rule.no_unrequested_refactor', text: 'Do not refactor unrelated code.' });

  upsertSemanticBoardCards([skill, rule], { rootDir });
  upsertSemanticBoardLinks([{ from: skill.id, to: rule.id, type: 'exports_rule', weight: 0.8 }], { rootDir });

  const board = readSemanticBoard({ rootDir });
  const summary = summarizeSemanticBoard(board);
  assert.equal(summary.card_count, 2);
  assert.equal(summary.link_count, 1);
  assert.equal(summary.by_type.skill_card, 1);
  assert.match(formatSemanticBoardSummary(board), /Top reusable cards/);

  const projection = buildPromptProjectionFromBoard(board, { cardTypes: ['skill_card'], limit: 3 });
  assert.equal(projection.card_count, 1);
  assert.equal(projection.cards[0].id, skill.id);
});

test('semantic board imports skill/rule JSON packages', () => {
  const rootDir = tmpRoot();
  const pkg = {
    skills: [{ id: 'skill.small_patch', name: 'Small Patch', description: 'Make minimal edits.' }],
    rules: [{ id: 'rule.verify', text: 'Verify before claiming success.' }],
    links: [{ from: 'skill.small_patch', to: 'rule.verify', type: 'exports_rule' }],
  };
  const result = importSemanticBoardSource(JSON.stringify(pkg), { rootDir });
  assert.equal(result.cards_imported, 2);
  assert.equal(result.links_imported, 1);
  const board = readSemanticBoard({ rootDir });
  assert.equal(board.cards.length, 2);
  assert.equal(board.links.length, 1);
});

test('semantic board mirrors skill/rule import result and performance scores', () => {
  const rootDir = tmpRoot();
  const importResult = {
    installed_skills: [{ skill: { id: 'skill.external', name: 'External Skill', description: 'Imported.' } }],
    imported_rules: [{ id: 'rule.external', text: 'Imported rule.' }],
  };
  const mirrored = mirrorSkillRuleImportToSemanticBoard(importResult, { rootDir });
  assert.equal(mirrored.mirrored, 2);

  const perf = mirrorSkillPerformanceToSemanticBoard({
    skills: { 'skill.external': { id: 'skill.external', kind: 'skill', reuse_score: 91, usage_count: 3 } },
    rules: { 'rule.external': { id: 'rule.external', kind: 'rule', reuse_score: 75, usage_count: 2 } },
  }, { rootDir });
  assert.equal(perf.upserted, 2);

  const board = readSemanticBoard({ rootDir });
  const skill = board.cards.find((card) => card.id === 'skill.external');
  assert.equal(skill.performance.reuse_score, 91);
});
