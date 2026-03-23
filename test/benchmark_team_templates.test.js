import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBenchmarkTeamTemplate, listBenchmarkTeamTemplates } from '../src/application/benchmark_team_templates.js';

test('benchmark team template catalog exposes curated templates', () => {
  const list = listBenchmarkTeamTemplates();
  assert.ok(list.some((row) => row.template_id === 'deep_research_trio'));
  assert.ok(list.some((row) => row.template_id === 'repo_delivery_loop'));
});

test('buildBenchmarkTeamTemplate returns publish-ready seeded team', () => {
  const team = buildBenchmarkTeamTemplate('repo_delivery_loop');
  assert.equal(team?.team_name, 'Repo Delivery Loop');
  assert.equal(team?.planner_metadata?.benchmark_template_id, 'repo_delivery_loop');
  assert.equal(team?.interaction_spec?.final_answer_owner, 'Delivery Synthesizer');
  assert.ok(Array.isArray(team?.agents) && team.agents.some((row) => row.role === 'builder'));
});
