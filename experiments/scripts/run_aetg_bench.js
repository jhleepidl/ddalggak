#!/usr/bin/env node
import path from 'node:path';

import {
  aggregateMetrics,
  readJsonl,
  runModeSelectionCases,
  writeJsonl,
} from '../../src/application/benchmark_runner.js';
import { createExperimentRun, finalizeExperimentRun, writeExperimentResult } from '../../src/application/experiment_trace.js';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? (process.argv[idx + 1] || fallback) : fallback;
}

const root = process.cwd();
const outDir = path.resolve(root, arg('out', 'experiments/runs/aetg_bench_manual'));
const dataset = path.resolve(root, arg('dataset', 'experiments/datasets/aetg_bench/mode_selection.jsonl'));
const policies = arg('policies', 'current,current+psi').split(',').map((s) => s.trim()).filter(Boolean);
const cases = readJsonl(dataset);
const rows = [];

for (const policy of policies) {
  for (const result of runModeSelectionCases(cases, { policy })) {
    const run = createExperimentRun({ outDir, suite: 'mode_selection', condition: policy, paper: 'AETG', runId: `mode_selection_${policy}_${result.id}` });
    writeExperimentResult(run.dir, result);
    finalizeExperimentRun(run.dir, { metrics: result.metrics });
    rows.push(result);
  }
}

const summary = [];
for (const policy of policies) {
  const policyRows = rows.filter((row) => row.policy === policy);
  summary.push({ policy, count: policyRows.length, metrics: aggregateMetrics(policyRows) });
}
writeJsonl(path.join(outDir, 'aetg_results.jsonl'), rows);
writeJsonl(path.join(outDir, 'aetg_summary.jsonl'), summary);
console.log(JSON.stringify({ outDir, rows: rows.length, summary }, null, 2));
