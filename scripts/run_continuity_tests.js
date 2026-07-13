#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createContinuityTestPlan,
  judgeContinuityRun,
  loadContinuityRun,
  runGuidedContinuityScenario,
} from '../src/evaluation/continuity_scenario_runner.js';

function clean(value = '') { return String(value ?? '').trim(); }
function parseArgs(argv = []) {
  const out = { scenarios: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    const value = !next || next.startsWith('--') ? true : (i += 1, next);
    if (key === 'scenario') out.scenarios.push(value); else out[key] = value;
  }
  return out;
}

function usage() {
  console.log(`Usage:
  npm run continuity:test -- --suite scenarios/continuity/core_suite.json --plan-only
  npm run continuity:test -- --scenario scenarios/continuity/restart_continuation.json
  npm run continuity:test -- --resume runs/continuity/<run-id>
  npm run continuity:test -- --resume <run-dir> --judge-provider claude [--judge-model <id>]

Options:
  --track ai_rooms|baseline
  --out runs/continuity
  --restart-command "sudo systemctl restart ddalggak"
  --switch-model-command "./scripts/switch-room-model.sh {{provider}} {{model}}"
  --plan-only
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) return usage();
  if (args.resume) {
    const loaded = loadContinuityRun(args.resume);
    if (!args.judgeOnly) await runGuidedContinuityScenario({ ...loaded, options: { restartCommand: args.restartCommand, switchModelCommand: args.switchModelCommand, replaceSourceCommand: args.replaceSourceCommand } });
    if (args.judgeProvider) await judgeContinuityRun({ ...loaded, state: loadContinuityRun(args.resume).state, provider: args.judgeProvider, model: clean(args.judgeModel), reasoningEffort: clean(args.judgeReasoning) || 'high' });
    console.log(`run=${loaded.runDir}`);
    return;
  }
  const suite = clean(args.suite) || (!args.scenarios.length ? 'scenarios/continuity/core_suite.json' : '');
  const plan = await createContinuityTestPlan({ scenarioFiles: args.scenarios, suiteFile: suite, outputRoot: clean(args.out) || 'runs/continuity', track: clean(args.track) || 'ai_rooms', probe: args.noProbe !== true });
  console.log(`planned ${plan.runs.length} continuity run(s)`);
  for (const row of plan.runs) console.log(`- ${row.scenario_id}: ${row.run_dir}`);
  if (args.planOnly) return;
  for (const row of plan.runs) {
    const loaded = loadContinuityRun(row.run_dir);
    await runGuidedContinuityScenario({ ...loaded, options: { restartCommand: args.restartCommand, switchModelCommand: args.switchModelCommand, replaceSourceCommand: args.replaceSourceCommand } });
    if (args.judgeProvider) await judgeContinuityRun({ ...loaded, state: loadContinuityRun(row.run_dir).state, provider: args.judgeProvider, model: clean(args.judgeModel), reasoningEffort: clean(args.judgeReasoning) || 'high' });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main().catch((error) => { console.error(error?.stack || error); process.exit(1); });
