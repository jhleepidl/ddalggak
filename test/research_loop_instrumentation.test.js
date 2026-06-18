import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContextBoundaryConfig,
  buildEvaluationPayload,
  buildLoopRecipeConfig,
  buildMemoryTreatmentConfig,
  buildResearchAttemptPayload,
} from '../src/research_loop_instrumentation.js';

test('buildLoopRecipeConfig normalizes task attempt plan into loop recipe', () => {
  const recipe = buildLoopRecipeConfig({
    taskAttemptPlan: {
      run_mode: 'branch',
      previous_result_policy: 'exclude',
      target_team: 'paper',
      work_mode: { work_mode: 'research_campaign', review_policy: 'stage_gate' },
    },
    teamCandidate: { skeleton_motif: 'curator_producer_reviewer', skills: ['curation', 'review'] },
    memoryPolicy: { include_memory_package: true, projection_profile: 'paper' },
  });
  assert.equal(recipe.kind, 'loop_recipe_v1');
  assert.equal(recipe.depth, 'loop');
  assert.equal(recipe.team_skeleton, 'curator_producer_reviewer');
  assert.equal(recipe.memory_policy.previous_result_policy, 'exclude');
  assert.deepEqual(recipe.skills, ['curation', 'review']);
});

test('buildMemoryTreatmentConfig distinguishes control, ablation, and stale treatments', () => {
  assert.equal(buildMemoryTreatmentConfig({}).type, 'control_no_memory');
  assert.equal(buildMemoryTreatmentConfig({ memoryPackage: { ablation_of: 'm3' } }).type, 'ablation');
  assert.equal(buildMemoryTreatmentConfig({ memoryPackage: { stale: true, conflicting: true } }).type, 'stale_conflicting');
  assert.equal(buildMemoryTreatmentConfig({ contextPolicy: { include_full_chat_tail: true } }).type, 'full_chat_tail');
});

test('buildContextBoundaryConfig records allowed and blocked object ids', () => {
  const boundary = buildContextBoundaryConfig({
    mode: 'least_privilege',
    roleId: 'reviewer',
    allowed: ['m1'],
    blocked: ['secret'],
    policyReasons: ['private'],
  });
  assert.equal(boundary.mode, 'least_privilege');
  assert.deepEqual(boundary.allowed_memory_object_ids, ['m1']);
  assert.deepEqual(boundary.blocked_memory_object_ids, ['secret']);
  assert.equal(boundary.privacy_filter, true);
});

test('buildResearchAttemptPayload creates GoC task attempt body with research metadata', () => {
  const body = buildResearchAttemptPayload({
    threadId: 'thread-1',
    taskId: 'task-1',
    taskText: 'review evidence',
    taskAttemptPlan: { run_mode: 'new', target_team: 'review', previous_result_policy: 'optional' },
    teamCandidate: { skeleton_motif: 'producer_reviewer' },
    memoryPackage: { package_id: 'pkg-1', memory_object_ids: ['m1'] },
    contextPolicy: { include_memory_package: true, projection_profile: 'review' },
  });
  assert.equal(body.thread_id, 'thread-1');
  assert.equal(body.meta.loop_recipe.kind, 'loop_recipe_v1');
  assert.equal(body.meta.memory_treatment.type, 'role_specific_package');
  assert.equal(body.memory_package_id, 'pkg-1');
});

test('buildEvaluationPayload wraps metrics for GoC evaluation endpoint', () => {
  const payload = buildEvaluationPayload({ metrics: { quality: 0.9, success: true }, notes: 'good' });
  assert.equal(payload.actor, 'ddalggak');
  assert.equal(payload.metrics.quality, 0.9);
  assert.equal(payload.notes, 'good');
});
