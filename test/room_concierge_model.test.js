import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyLearnedRoomConciergeModel,
  extractRoomConciergeFeatureVector,
  loadRoomConciergeModelFromFile,
  scoreRoomConciergeRoutes,
} from '../src/application/room_concierge_model.js';

const baseDecision = {
  route: 'concierge_direct_answer',
  depth: 'direct_answer',
  should_bypass_workbench: true,
  should_show_plan_preview: false,
  signals: ['simple_qa_intent'],
  blockers: [],
  metrics: { char_count: 12, tokenish_units: 3 },
};

test('extractRoomConciergeFeatureVector combines route signals and room footprint', () => {
  const features = extractRoomConciergeFeatureVector({
    text: '저녁 메뉴 추천',
    baseDecision,
    roomFootprint: {
      memory_pressure: 0.4,
      governance_pressure: 0.7,
      task_distribution: { casual: 0.8 },
      recent_route_stats: { total: 10, concierge_direct_answer: 7 },
    },
  });
  assert.equal(features.signal_simple_qa, 1);
  assert.equal(features.room_governance_pressure, 0.7);
  assert.equal(features.task_casual, 0.8);
  assert.equal(features.recent_direct_rate, 0.7);
});

test('linear local concierge model scores and applies safe escalation', () => {
  const model = {
    kind: 'room_concierge_model_v1',
    version: 'unit-linear',
    policy: { enabled: true, min_confidence: 0.55, allow_safe_escalation: true },
    route_weights: {
      standard_workbench: { bias: 2, room_governance_pressure: 2 },
      concierge_direct_answer: { bias: 0, signal_simple_qa: 1 },
    },
  };
  const features = extractRoomConciergeFeatureVector({ baseDecision, roomFootprint: { governance_pressure: 1 } });
  const score = scoreRoomConciergeRoutes({ model, features, baseDecision });
  assert.equal(score.ok, true);
  assert.equal(score.route, 'standard_workbench');
  const applied = applyLearnedRoomConciergeModel({ baseDecision, modelScore: score, model });
  assert.equal(applied.route, 'standard_workbench');
  assert.equal(applied.learned_model.applied, true);
});

test('local concierge model can be loaded from JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'concierge-model-'));
  const file = path.join(dir, 'model.json');
  fs.writeFileSync(file, JSON.stringify({
    kind: 'room_concierge_model_v1',
    version: 'from-file',
    policy: { enabled: true },
    route_weights: { concierge_direct_answer: { bias: 1 } },
  }), 'utf8');
  const model = loadRoomConciergeModelFromFile(file);
  assert.equal(model.version, 'from-file');
  assert.equal(model.policy.enabled, true);
  assert.equal(model.metadata.source_file, path.resolve(file));
});
