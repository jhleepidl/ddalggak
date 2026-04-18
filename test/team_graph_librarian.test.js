import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTeamMotifRegistry } from '../src/application/team_motif_registry.js';
import { applyGraphLibrarianPlan, buildDemandGraph, planTeamCompositionWithGraphLibrarian } from '../src/application/team_graph_librarian.js';
import { buildRuntimeOrchestration } from '../src/application/orchestrator.js';
import { loadAgents } from '../src/agents.js';

const historicalSnapshot = {
  runtime_agents: [
    { instance_id: 'inst_op', slot_id: 'slot_op', role_id: 'operator' },
    { instance_id: 'inst_r1', slot_id: 'slot_r1', role_id: 'researcher' },
    { instance_id: 'inst_r2', slot_id: 'slot_r2', role_id: 'researcher' },
    { instance_id: 'inst_syn', slot_id: 'slot_syn', role_id: 'synthesizer' },
  ],
  execution_graph: {
    pattern: 'parallel',
    order: ['slot_op', 'slot_r1', 'slot_r2', 'slot_syn'],
    parallel_groups: [{ slot_ids: ['slot_r1', 'slot_r2'] }],
  },
  execution_feedback: {
    run_count: 3,
    patterns: [{ completion_rate_pct: 100 }],
  },
};

test('graph librarian composes motifs into augmented role demand', () => {
  const motifRegistry = buildTeamMotifRegistry({ runtimeTeamSnapshot: historicalSnapshot });
  assert.ok(motifRegistry.some((motif) => motif.source === 'historical_snapshot'));

  const taskInterpretation = {
    goal: 'Compare two evidence sources in parallel and produce a concise summary',
    task_type: 'analysis',
    deliverable_type: 'brief',
    parallelism_preference: 'parallel',
    review_policy: 'optional',
    candidate_capability_slots: [
      { role_id: 'researcher', purpose: 'collect evidence' },
      { role_id: 'synthesizer', purpose: 'write summary' },
    ],
  };

  const demandGraph = buildDemandGraph({
    goal: taskInterpretation.goal,
    taskInterpretation,
    runtimeTeamSnapshot: historicalSnapshot,
  });
  assert.equal(demandGraph.needs_parallel_research, true);

  const plan = planTeamCompositionWithGraphLibrarian({
    goal: taskInterpretation.goal,
    taskInterpretation,
    runtimeTeamSnapshot: historicalSnapshot,
    motifRegistry,
    maxAgents: 5,
  });

  assert.equal(plan.ok, true);
  assert.ok(plan.selected_motif_ids.length > 0);
  assert.ok(plan.suggested_candidate_capability_slots.filter((slot) => slot.role_id === 'researcher').length >= 2);
  assert.equal(plan.planner_metadata.team_synthesis_mode, 'graph_librarian');

  const applied = applyGraphLibrarianPlan(taskInterpretation, plan);
  assert.equal(applied.parallelism_preference, 'parallel');
  assert.ok(applied.candidate_capability_slots.length >= taskInterpretation.candidate_capability_slots.length);
});

test('runtime orchestration surfaces graph librarian metadata and parallel specialist slots', () => {
  const registry = loadAgents();
  const orchestration = buildRuntimeOrchestration({
    mode: 'run',
    goal: '두 소스를 병렬 조사하고 최종 브리핑으로 정리해줘',
    registry,
    maxAgents: 5,
    runtimeTeamSnapshot: historicalSnapshot,
  });

  assert.equal(orchestration.planner_metadata.team_synthesis_mode, 'graph_librarian');
  assert.ok(Array.isArray(orchestration.planner_metadata.selected_motif_ids));
  assert.ok(orchestration.planner_metadata.selected_motif_ids.length > 0);
  assert.ok(orchestration.team_plan.slots.filter((slot) => slot.role_id === 'researcher').length >= 2);
  assert.equal(orchestration.interpreted_task.parallelism_preference, 'parallel');
  assert.ok(orchestration.team_plan.selection_explanations.some((entry) => String(entry.reason || '').includes('graph_librarian')));
});


test('graph librarian planner metadata keeps motif channel for experiments', () => {
  const motifRegistry = buildTeamMotifRegistry({ runtimeTeamSnapshot: historicalSnapshot, channel: 'candidate' });
  const plan = planTeamCompositionWithGraphLibrarian({
    goal: '병렬 조사 후 최종 요약',
    taskInterpretation: {
      task_type: 'analysis',
      deliverable_type: 'brief',
      parallelism_preference: 'parallel',
      candidate_capability_slots: [
        { role_id: 'researcher', purpose: 'collect evidence' },
        { role_id: 'synthesizer', purpose: 'write summary' },
      ],
    },
    runtimeTeamSnapshot: historicalSnapshot,
    motifRegistry,
    motifChannel: 'candidate',
  });
  assert.equal(plan.planner_metadata.motif_channel, 'candidate');
  assert.equal(plan.planner_metadata.registry_motif_count > 0, true);
});


test('graph librarian supports single and hybrid execution modes', () => {
  const motifRegistry = buildTeamMotifRegistry({ runtimeTeamSnapshot: historicalSnapshot });
  const taskInterpretation = {
    goal: '자료 조사 후 검토해서 요약',
    task_type: 'analysis',
    deliverable_type: 'brief',
    review_policy: 'required',
    candidate_capability_slots: [
      { role_id: 'researcher', purpose: 'collect evidence' },
      { role_id: 'reviewer', purpose: 'check contradictions' },
      { role_id: 'synthesizer', purpose: 'write summary' },
    ],
  };
  const single = planTeamCompositionWithGraphLibrarian({
    goal: taskInterpretation.goal,
    taskInterpretation,
    runtimeTeamSnapshot: historicalSnapshot,
    motifRegistry,
    executionMode: 'single_compiled',
  });
  assert.equal(single.planner_metadata.team_synthesis_mode, 'single_compiled');
  assert.equal(single.suggested_candidate_capability_slots.length, 1);

  const hybrid = planTeamCompositionWithGraphLibrarian({
    goal: taskInterpretation.goal,
    taskInterpretation,
    runtimeTeamSnapshot: historicalSnapshot,
    motifRegistry,
    executionMode: 'hybrid_sidecar',
  });
  assert.equal(hybrid.planner_metadata.team_synthesis_mode, 'hybrid_sidecar');
  assert.ok(hybrid.suggested_candidate_capability_slots.length >= 1);
  assert.ok(hybrid.suggested_candidate_capability_slots.length <= 2);
});
