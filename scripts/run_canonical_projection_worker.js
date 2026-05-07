#!/usr/bin/env node
import { runCanonicalProjectionWorker } from '../src/application/canonical_projection_worker.js';

function arg(name, fallback = '') {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}
const jobDir = arg('job-dir', process.env.JOB_DIR || process.env.RUN_DIR || '');
const limit = Number(arg('limit', '20')) || 20;
if (!jobDir) {
  console.error('Usage: node scripts/run_canonical_projection_worker.js --job-dir <runs/jobId> [--limit 20]');
  process.exit(2);
}
const result = await runCanonicalProjectionWorker({ jobDir, limit, allowLocalRetry: true });
console.log(JSON.stringify({ ...result, prompt: undefined }, null, 2));
