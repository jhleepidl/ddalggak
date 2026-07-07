import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRoomPreferenceDataset,
  classifyRoomPreferenceSignal,
  computeRoomRewardFeatures,
  exportRoomPreferenceDataset,
  formatRoomPreferenceDatasetExportForTelegram,
  formatRoomPreferenceLearningSummaryForTelegram,
  inferLearningTarget,
} from '../src/application/room_preference_learning.js';

test('preference signal classifier extracts explicit approve/reject/correct choices', () => {
  const approve = classifyRoomPreferenceSignal({ event_type: 'room_agent_specialization_approved', command: '/room agents approve', extra: { action_count: 1 } });
  assert.equal(approve.label, 'positive_preference');
  assert.equal(approve.polarity, 1);
  assert.equal(approve.facets.user_approval, true);

  const reject = classifyRoomPreferenceSignal({ event_type: 'room_memory_candidate_rejected', command: '/memory reject latest', extra: { reason: '아니 그건 저장하지마' } });
  assert.equal(reject.label, 'negative_preference');
  assert.equal(reject.polarity, -1);
  assert.equal(reject.facets.user_rejection, true);

  const correction = classifyRoomPreferenceSignal({ event_type: 'room_correction_added', command: '/correct', goal: '아냐 이 방향은 틀렸어' });
  assert.equal(correction.polarity, -1);
  assert.equal(correction.facets.correction, true);
});

test('room preference dataset exposes learning targets and reward features', () => {
  const events = [
    { chat_id: 'c', ts: '2026-07-05T00:00:00Z', event_type: 'default_room_preset_applied', command: '/room preset', extra: { package_id: 'research_paper_factory' }, room: { domain_label: 'research_paper' } },
    { chat_id: 'c', ts: '2026-07-05T00:01:00Z', event_type: 'room_agent_specialization_approved', command: '/room agents approve', extra: { action_count: 2 }, room: { domain_label: 'research_paper' } },
    { chat_id: 'c', ts: '2026-07-05T00:02:00Z', event_type: 'room_memory_candidate_rejected', command: '/memory reject latest', extra: { reason: 'wrong memory' }, room: { domain_label: 'research_paper' } },
    { chat_id: 'c', ts: '2026-07-05T00:03:00Z', event_type: 'work_depth_used', command: '/loop', goal: 'test artifact passed', extra: { depth: 'loop' }, room: { domain_label: 'research_paper' } },
  ];
  const dataset = buildRoomPreferenceDataset({ events, roomPackage: { package_id: 'research_paper_factory', agents: ['researcher'], skills: ['literature_scan'] } });
  assert.equal(dataset.row_count, 4);
  assert.ok(dataset.summary.dpo_ready_rows >= 2);
  assert.ok(dataset.rows.some((row) => row.learning_target === 'agent_policy'));
  assert.ok(dataset.rows.some((row) => row.training_use.agent_model_policy_scorer));
  assert.match(formatRoomPreferenceLearningSummaryForTelegram(dataset), /Room preference learning/);
  assert.match(formatRoomPreferenceLearningSummaryForTelegram(dataset), /room package \/ recipe/);
  const reward = computeRoomRewardFeatures(events);
  assert.equal(reward.approvals, 1);
  assert.equal(reward.rejections, 1);
  assert.ok(reward.artifact_relevant_events >= 1);
});

test('preference dataset export writes json and jsonl without raw transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-pref-'));
  const result = exportRoomPreferenceDataset({
    chatId: 'chat-pref',
    rootDir: dir,
    events: [{ chat_id: 'chat-pref', event_type: 'room_package_exported', command: '/room export', extra: { package_id: 'pkg' } }],
    roomPackage: { package_id: 'pkg' },
  });
  assert.equal(result.ok, true);
  assert.ok(fs.existsSync(result.files.json));
  assert.ok(fs.existsSync(result.files.jsonl));
  const row = JSON.parse(fs.readFileSync(result.files.jsonl, 'utf8').trim());
  assert.equal(row.witness.raw_transcript_exported, false);
  assert.equal(row.guardrail.model_may_mutate_room_state, false);
  assert.match(formatRoomPreferenceDatasetExportForTelegram(result), /preference dataset exported/);
});

test('learning target inference covers package, recipe, memory, skill, agent and model policy', () => {
  assert.equal(inferLearningTarget({ event_type: 'default_room_preset_applied' }), 'room_package');
  assert.equal(inferLearningTarget({ command: '/loop 3 build' }), 'room_recipe');
  assert.equal(inferLearningTarget({ event_type: 'room_memory_candidate_approved' }), 'memory_policy');
  assert.equal(inferLearningTarget({ event_type: 'room_skill_imported' }), 'skill_policy');
  assert.equal(inferLearningTarget({ event_type: 'room_agent_specialization_approved' }), 'agent_policy');
  assert.equal(inferLearningTarget({ event_type: 'model_policy_changed' }), 'model_policy');
});
