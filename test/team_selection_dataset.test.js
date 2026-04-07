import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamSelectionDataset, exportTeamSelectionDataset, normalizeTeamSelectionEvent, serializeTeamSelectionDatasetJsonl } from '../src/application/team_selection_dataset.js';


test('normalizeTeamSelectionEvent keeps selected topology, executable readiness, and outcome fields', () => {
  const row = normalizeTeamSelectionEvent({
    id: 'evt-1',
    job_id: 'job-1',
    task_text: 'Implement and review a patch',
    selected_blueprint_id: 'impl_team',
    recommendation: {
      candidates: [
        {
          template_id: 'impl_team',
          task_archetype: 'implementation',
          score: 12,
          topology: { pattern: 'review_loop', participant_count: 2, edge_count: 1 },
          memory_fit: { final_answer_surface_ready: true, surface_count: 4, shared_surface_count: 2 },
          executable_definition: {
            member_count: 2,
            role_ids: ['builder', 'reviewer'],
            executable_readiness: { ready: true },
            capability_contract: { runtime_bound: true, admission_status: 'ready', blocking_reason_codes: [], degrade_reason_codes: ['missing_optional:web_browse'] },
          },
        },
      ],
    },
    outcome: { success: true, quality_score: 0.8, token_cost: 1200, latency_ms: 3200 },
  });

  assert.equal(row.task_archetype, 'implementation');
  assert.equal(row.topology_pattern, 'review_loop');
  assert.equal(row.final_answer_surface_ready, true);
  assert.equal(row.selected_ready, true);
  assert.equal(row.selected_runtime_bound, true);
  assert.deepEqual(row.selected_role_ids, ['builder', 'reviewer']);
  assert.equal(row.selected_candidate_found, true);
  assert.equal(row.training_eligible, true);
  assert.equal(row.success, true);
});


test('normalizeTeamSelectionEvent excludes rows when selected candidate is missing from recommendation', () => {
  const row = normalizeTeamSelectionEvent({
    id: 'evt-2',
    task_text: 'Implement and review a patch',
    selected_blueprint_id: 'impl_team',
    recommendation: {
      candidates: [
        { template_id: 'research_team', task_archetype: 'research' },
      ],
    },
  });

  assert.equal(row.selected_candidate_found, false);
  assert.equal(row.training_eligible, false);
  assert.deepEqual(row.exclusion_reasons, ['selected_candidate_not_in_recommendation']);
  assert.equal(row.selected_features, null);
  assert.equal(row.selected_score, null);
});


test('normalizeTeamSelectionEvent can recover selected candidate from explicit snapshot', () => {
  const row = normalizeTeamSelectionEvent({
    id: 'evt-3',
    task_text: 'Implement and review a patch',
    selected_blueprint_id: 'impl_team',
    recommendation: {
      candidates: [],
      selected_candidate_snapshot: {
        template_id: 'impl_team',
        task_archetype: 'implementation',
        score: 9,
        topology: { pattern: 'review_loop', participant_count: 2, edge_count: 1 },
        executable_definition: { member_count: 2, role_ids: ['builder', 'reviewer'] },
      },
    },
  });

  assert.equal(row.selected_candidate_found, true);
  assert.equal(row.selected_candidate_source, 'selected_candidate_snapshot');
  assert.equal(row.training_eligible, false);
  assert.deepEqual(row.exclusion_reasons, ['missing_recommendation_candidates']);
  assert.equal(row.selected_score, 9);
});


test('buildTeamSelectionDataset aggregates archetype, success, and eligibility counts', () => {
  const dataset = buildTeamSelectionDataset([
    { selected_blueprint_id: 'a', recommendation: { candidates: [{ template_id: 'a', task_archetype: 'implementation' }] }, outcome: { success: true } },
    { selected_blueprint_id: 'b', recommendation: { candidates: [{ template_id: 'x', task_archetype: 'implementation' }] }, outcome: { success: false } },
    { selected_blueprint_id: 'c', recommendation: { candidates: [{ template_id: 'c', task_archetype: 'research' }] }, outcome: { success: true } },
  ]);

  assert.equal(dataset.kind, 'team_selection_dataset_v1');
  assert.equal(dataset.schema_version, 3);
  assert.equal(dataset.count, 3);
  assert.equal(dataset.eligible_count, 2);
  assert.equal(dataset.excluded_count, 1);
  assert.equal(dataset.archetype_counts.implementation, 2);
  assert.equal(dataset.archetype_counts.research, 1);
  assert.equal(dataset.success_counts.success, 2);
  assert.equal(dataset.success_counts.failure, 1);
  assert.equal(dataset.exclusion_reason_counts.selected_candidate_not_in_recommendation, 1);
});


test('serializeTeamSelectionDatasetJsonl emits only training-eligible rows', () => {
  const jsonl = serializeTeamSelectionDatasetJsonl([
    {
      id: 'evt-1',
      selected_blueprint_id: 'impl_team',
      recommendation: { candidates: [{ template_id: 'impl_team', task_archetype: 'implementation' }] },
    },
    {
      id: 'evt-2',
      selected_blueprint_id: 'missing_team',
      recommendation: { candidates: [{ template_id: 'impl_team', task_archetype: 'implementation' }] },
    },
  ]);
  const lines = jsonl.trim().split(/\n/);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.selected_blueprint_id, 'impl_team');
  assert.ok(parsed.input_features);
});


test('exportTeamSelectionDataset reads from tracking when available', () => {
  const tracking = {
    readTeamSelectionEvents(jobId, limit) {
      assert.equal(jobId, 'job-42');
      assert.equal(limit, 5);
      return [
        {
          id: 'evt-1',
          selected_blueprint_id: 'impl_team',
          recommendation: { candidates: [{ template_id: 'impl_team', task_archetype: 'implementation' }] },
        },
      ];
    },
  };
  const dataset = exportTeamSelectionDataset({ tracking, jobId: 'job-42', limit: 5 });
  assert.equal(dataset.count, 1);
  assert.equal(dataset.rows[0].task_archetype, 'implementation');
});
