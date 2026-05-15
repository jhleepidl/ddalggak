import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readSemanticBoard, upsertSemanticBoardCards, upsertSemanticBoardLinks } from '../src/application/semantic_board.js';
import { repairSemanticBoardStore, validateSemanticBoard, validateSemanticBoardStore } from '../src/application/semantic_board_validator.js';

function tmpRoot() { return fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-board-validator-')); }

test('semantic board validator detects dangling links and repair removes them', () => {
  const rootDir = tmpRoot();
  upsertSemanticBoardCards([{ id: 'skill.a', type: 'skill_card', title: 'A', content: { canonical_en: 'A' } }], { rootDir });
  upsertSemanticBoardLinks([{ from: 'skill.a', to: 'missing.card', type: 'uses' }], { rootDir });

  const before = validateSemanticBoardStore({ rootDir }).validation;
  assert.equal(before.ok, false);
  assert.ok(before.issues.some((row) => row.code === 'dangling_link_to'));

  const repaired = repairSemanticBoardStore({ rootDir });
  assert.equal(repaired.removed_link_ids.length, 1);
  const after = validateSemanticBoardStore({ rootDir }).validation;
  assert.equal(after.ok, true);
  assert.equal(readSemanticBoard({ rootDir }).links.length, 0);
});

test('semantic board validator warns about active links to inactive cards', () => {
  const validation = validateSemanticBoard({
    cards: [
      { id: 'skill.a', type: 'skill_card', title: 'A', status: 'retracted', content: { canonical_en: 'A' } },
      { id: 'agent.builder', type: 'agent_card', title: 'Builder', status: 'active' },
    ],
    links: [{ from: 'agent.builder', to: 'skill.a', type: 'uses', status: 'active' }],
  });
  assert.equal(validation.ok, true);
  assert.ok(validation.issues.some((row) => row.code === 'active_link_to_inactive_card'));
});
