#!/usr/bin/env node
import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { runAllModelBenchmark } from '../src/evaluation/all_model_benchmark_runner.js';

function parseArgs(argv = []) {
  const out = { scenarioFiles: [], providers: [], models: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const next = () => argv[++i];
    if (token === '--scenario') out.scenarioFiles.push(next());
    else if (token === '--scenario-dir') out.scenarioDir = next();
    else if (token === '--provider') out.providers.push(next());
    else if (token === '--model') out.models.push(next());
    else if (token === '--repeat') out.repeat = Number(next());
    else if (token === '--max-models') out.maxModels = Number(next());
    else if (token === '--output-dir') out.outputDir = next();
    else if (token === '--resume') out.resumeDir = next();
    else if (token === '--registry') out.registryPath = next();
    else if (token === '--catalog') out.catalogPath = next();
    else if (token === '--lifecycle-registry') out.lifecycleRegistryPath = next();
    else if (token === '--execute') out.execute = true;
    else if (token === '--refresh') out.refresh = true;
    else if (token === '--pending-only') out.pendingOnly = true;
    else if (token === '--include-unavailable') out.includeUnavailable = true;
    else if (token === '--retry-failed') out.retryFailed = true;
    else if (token === '--fail-fast') out.failFast = true;
    else if (token === '--sync-goc') out.syncToGoc = true;
    else if (token === '--discard-workspaces') out.keepWorkspaces = false;
    else if (token === '--json') out.json = true;
    else if (token === '--help' || token === '-h') out.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return out;
}

function usage() {
  console.log(`All discovered model benchmark matrix\n\nUsage:\n  npm run models:bench-all -- [options]\n\nSafety:\n  The default is plan-only. Add --execute to call provider CLIs and incur usage/cost.\n\nOptions:\n  --scenario <file>          Repeatable live scenario file\n  --scenario-dir <dir>       Scenario directory (default: scenarios/live)\n  --provider <name>          Repeatable provider filter\n  --model <id|provider:id>   Repeatable exact model filter\n  --repeat <n>               Runs per model/scenario case (default: 1)\n  --pending-only             Benchmark only lifecycle pending models\n  --include-unavailable       Include unavailable or execution-ineligible discovered models\n  --max-models <n>           Limit discovered model rows\n  --refresh                  Refresh discovery before planning\n  --execute                  Execute the planned provider calls\n  --resume <matrix-dir>      Continue an interrupted matrix\n  --retry-failed             Retry quality failures, execution errors, and explicitly skipped access-denied cases during resume\n  --fail-fast                Stop after the first failed case\n  --sync-goc                 Best-effort sync each evaluation to GoC\n  --discard-workspaces       Remove per-run workspaces after evaluation\n  --output-dir <dir>         Explicit matrix output directory\n  --json                     Print machine-readable summary\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return usage();
  const result = await runAllModelBenchmark({
    ...args,
    scenarioDir: args.scenarioDir === undefined && !args.scenarioFiles.length ? 'scenarios/live' : (args.scenarioDir || ''),
    repeat: args.repeat || 1,
    keepWorkspaces: args.keepWorkspaces !== false,
  });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`matrix=${result.matrix_id} status=${result.status}`);
    console.log(`cases=${result.counts.total} passed=${result.counts.passed} failed=${result.counts.failed} execution_errors=${result.counts.execution_error || 0} skipped=${result.counts.skipped} pending=${result.counts.pending}`);
    console.log(`planned_provider_calls=${result.planned_provider_calls}`);
    console.log(`output=${result.output_dir}`);
    if (result.plan_only) console.log('Plan only. Re-run with --execute, or resume this directory with --resume <dir> --execute.');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
}
