#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { runLiveScenarioSuite } from '../src/evaluation/live_scenario_runner.js';
import { loadHarnessVariantRegistry, summarizeHarnessVariants } from '../src/evaluation/harness_variant_registry.js';

function argsOf(argv) {
  const out = { scenarioFiles: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--scenario') out.scenarioFiles.push(next());
    else if (arg === '--scenario-dir') out.scenarioDir = next();
    else if (arg === '--provider') out.provider = next();
    else if (arg === '--model') out.model = next();
    else if (arg === '--reasoning') out.reasoningEffort = next();
    else if (arg === '--variant') out.variantId = next();
    else if (arg === '--repeat') out.repeat = Number(next());
    else if (arg === '--matrix-index') out.matrixIndex = Number(next());
    else if (arg === '--output-dir') out.outputDir = next();
    else if (arg === '--registry') out.registryPath = next();
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--sync-goc') out.syncToGoc = true;
    else if (arg === '--discard-workspaces') out.keepWorkspaces = false;
    else if (arg === '--json') out.json = true;
    else if (arg === '--list-variants') out.listVariants = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return out;
}

function help() {
  return `Live Scenario Lab\n\nUsage:\n  node scripts/run_live_scenarios.js --scenario scenarios/live/coding_smoke.json [options]\n\nOptions:\n  --scenario <file>       Repeatable scenario file\n  --scenario-dir <dir>    Run every .json scenario in a directory\n  --provider <name>       Override provider (codex|claude|antigravity)\n  --model <name>          Override model\n  --reasoning <level>     Override reasoning effort\n  --variant <id>          Override harness variant\n  --repeat <n>            Override repetition count\n  --dry-run               Build workspaces/prompts without calling provider CLIs\n  --sync-goc              Best-effort ingest of summary into GoC\n  --output-dir <dir>      Evaluation output root\n  --list-variants         Print registered harness variants\n  --json                  Print machine-readable summary\n`;
}

const options = argsOf(process.argv.slice(2));
if (options.help) { console.log(help()); process.exit(0); }
if (options.listVariants) {
  console.log(JSON.stringify(summarizeHarnessVariants(loadHarnessVariantRegistry({ registryPath: options.registryPath, cwd: process.cwd() })), null, 2));
  process.exit(0);
}
if (!options.scenarioFiles.length && !options.scenarioDir) {
  const defaultFile = path.resolve('scenarios/live/coding_smoke.json');
  if (fs.existsSync(defaultFile)) options.scenarioFiles = [defaultFile];
}
const summary = await runLiveScenarioSuite(options);
if (options.json) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`evaluation=${summary.evaluation_id} status=${summary.status}`);
  console.log(`runs=${summary.total_run_count} passed=${summary.passed_run_count} failed=${summary.failed_run_count}`);
  for (const row of summary.variant_results || []) console.log(`- ${row.harness_variant_id}: success=${(row.success_rate * 100).toFixed(1)}% score=${row.average_score.toFixed(3)} duration=${Math.round(row.average_duration_ms)}ms`);
  console.log(`output=${summary.output_dir}`);
}
