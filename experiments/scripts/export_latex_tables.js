#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { readJsonl } from '../../src/application/benchmark_runner.js';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? (process.argv[idx + 1] || fallback) : fallback;
}

function fmt(value) {
  if (typeof value !== 'number') return '--';
  return value.toFixed(3);
}

const input = path.resolve(process.cwd(), arg('input', 'experiments/runs/gcp_bench_manual/gcp_summary.jsonl'));
const out = path.resolve(process.cwd(), arg('out', 'experiments/runs/table.tex'));
const label = arg('label', 'tab:experiment_summary');
const caption = arg('caption', 'Benchmark summary.');
const rows = readJsonl(input);
const keyName = rows.some((row) => row.condition) ? 'condition' : 'policy';
const lines = [];
lines.push('\\begin{table}[t]');
lines.push('\\centering');
lines.push('\\begin{tabular}{lrrrr}');
lines.push('\\toprule');
lines.push(`${keyName} & Acc. $\\uparrow$ & WLR $\\downarrow$ & RSR $\\uparrow$ & Dist. $\\downarrow$ \\\\`);
lines.push('\\midrule');
for (const row of rows) {
  const m = row.metrics || {};
  const acc = m.correct_artifact_recall ?? m.mode_accuracy;
  const wlr = m.wrong_label_recurrence;
  const rsr = m.retraction_suppression;
  const dist = m.mode_distance;
  lines.push(`${row[keyName]} & ${fmt(acc)} & ${fmt(wlr)} & ${fmt(rsr)} & ${fmt(dist)} \\\\`);
}
lines.push('\\bottomrule');
lines.push('\\end{tabular}');
lines.push(`\\caption{${caption}}`);
lines.push(`\\label{${label}}`);
lines.push('\\end{table}');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${lines.join('\n')}\n`, 'utf8');
console.log(out);
