#!/usr/bin/env node
import path from 'node:path';

import {
  aggregateMetrics,
  evaluateTextExpectation,
  readJsonl,
  writeJsonl,
} from '../../src/application/benchmark_runner.js';
import { computeProjectionStress } from '../../src/application/projection_stress.js';
import { createExperimentRun, finalizeExperimentRun, writeExperimentResult } from '../../src/application/experiment_trace.js';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? (process.argv[idx + 1] || fallback) : fallback;
}

function selectedSuites() {
  const raw = arg('suite', 'all');
  if (raw === 'all') return ['artifact_correction_recall', 'retraction_suppression', 'compaction_survival'];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function conditionsForCase(item) {
  return Object.keys(item.outputs || {});
}

const root = process.cwd();
const outDir = path.resolve(root, arg('out', 'experiments/runs/gcp_bench_manual'));
const datasetDir = path.resolve(root, arg('dataset-dir', 'experiments/datasets/gcp_bench'));
const rows = [];

for (const suite of selectedSuites()) {
  const file = path.join(datasetDir, `${suite}.jsonl`);
  for (const item of readJsonl(file)) {
    for (const condition of conditionsForCase(item)) {
      const run = createExperimentRun({ outDir, suite, condition, paper: 'RGCG', runId: `${suite}_${condition}_${item.id}` });
      const output = item.outputs[condition] || '';
      const projectionStress = computeProjectionStress(item.projection_context || {});
      const metrics = evaluateTextExpectation(output, item.expected || {});
      const result = {
        run_id: run.run_id,
        paper: 'RGCG',
        suite,
        condition,
        id: item.id,
        task_family: item.task_family,
        projection_stress: projectionStress,
        output,
        expected: item.expected,
        metrics,
      };
      writeExperimentResult(run.dir, result);
      finalizeExperimentRun(run.dir, { metrics });
      rows.push(result);
    }
  }
}

const summary = [];
for (const condition of [...new Set(rows.map((row) => row.condition))]) {
  const conditionRows = rows.filter((row) => row.condition === condition);
  summary.push({ condition, count: conditionRows.length, metrics: aggregateMetrics(conditionRows) });
}
writeJsonl(path.join(outDir, 'gcp_results.jsonl'), rows);
writeJsonl(path.join(outDir, 'gcp_summary.jsonl'), summary);
console.log(JSON.stringify({ outDir, rows: rows.length, summary }, null, 2));
