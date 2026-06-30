import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { appendRoomSemanticObservations, readRoomSemanticObservations } from '../src/application/room_semantic_observation_log.js';
import { createRoomContextSnapshot, buildBudgetedRoomContextProjection } from '../src/application/room_context_projection.js';

test('room semantic observations are schema-agnostic and projected without hard-coded slots', () => {
  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-semantic-observations-'));
  try {
    const rows = appendRoomSemanticObservations({
      jobDir,
      observations: [
        {
          type: 'user_constraint',
          text: 'The user wants options that fit a light meal around the currently discussed area.',
          confidence: 'agent_extracted',
          source_turn_id: 'turn-1',
          extractor: 'test_semantic_agent',
        },
      ],
    });
    assert.equal(rows.length, 1);
    const stored = readRoomSemanticObservations({ jobDir });
    assert.equal(stored.length, 1);
    assert.equal(stored[0].type, 'user_constraint');

    const snapshot = createRoomContextSnapshot({
      jobDir,
      latestUserText: '그 조건으로 내일 점심 추천해줘.',
      command: '/c',
    });
    const projection = buildBudgetedRoomContextProjection({ snapshot, tier: 'micro', maxChars: 1200 });
    assert.match(projection.text, /room_semantic_observations/);
    assert.match(projection.text, /AGENT-EXTRACTED SEMANTIC OBSERVATIONS/);
    assert.match(projection.text, /light meal around the currently discussed area/);
    assert.doesNotMatch(projection.text, /active_location_candidates/);
  } finally {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
