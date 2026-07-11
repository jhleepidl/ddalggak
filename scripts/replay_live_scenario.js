#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runLiveScenarioSuite } from '../src/evaluation/live_scenario_runner.js';

function usage() {
  return `Replay a previous Live Scenario Lab run with the same provider/model/reasoning/harness signature.

Usage:
  node scripts/replay_live_scenario.js --result <path/to/result.json> [--sync-goc] [--output-dir <dir>] [--json]
`;
}

const argv = process.argv.slice(2);
let resultFile = '';
let outputDir = '';
let syncToGoc = false;
let json = false;
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--result') resultFile = argv[++i] || '';
  else if (arg === '--output-dir') outputDir = argv[++i] || '';
  else if (arg === '--sync-goc') syncToGoc = true;
  else if (arg === '--json') json = true;
  else if (arg === '--help' || arg === '-h') { console.log(usage()); process.exit(0); }
  else throw new Error(`Unknown argument: ${arg}`);
}
if (!resultFile) throw new Error('--result is required');
const absoluteResult = path.resolve(resultFile);
const previous = JSON.parse(fs.readFileSync(absoluteResult, 'utf8'));
const scenarioSnapshotPath = path.join(path.dirname(absoluteResult), 'scenario.json');
if (!fs.existsSync(scenarioSnapshotPath)) throw new Error(`Scenario snapshot not found next to result: ${scenarioSnapshotPath}`);
const scenarioSnapshot = JSON.parse(fs.readFileSync(scenarioSnapshotPath, 'utf8'));
const originalScenarioFile = String(scenarioSnapshot.__file || '').trim();
if (!originalScenarioFile || !fs.existsSync(originalScenarioFile)) {
  throw new Error('Original scenario file is unavailable; replay requires the original fixture baseline, not the mutated prior workspace.');
}
const summary = await runLiveScenarioSuite({
  scenarioFiles: [originalScenarioFile],
  provider: previous.provider,
  model: previous.model || '',
  reasoningEffort: previous.reasoning_effort || '',
  variantId: previous.harness_variant_id || '',
  repeat: 1,
  outputDir,
  syncToGoc,
});
if (json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`replayed_from=${absoluteResult}`);
  console.log(`evaluation=${summary.evaluation_id} status=${summary.status}`);
  console.log(`runs=${summary.total_run_count} passed=${summary.passed_run_count} failed=${summary.failed_run_count}`);
  console.log(`output=${summary.output_dir}`);
}
