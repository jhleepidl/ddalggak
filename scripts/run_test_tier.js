#!/usr/bin/env node
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { absoluteTestFiles, buildTestTierRegistry, resolveTestTierFiles } from './test_tier_registry.js';

function parseArgs(argv = []) {
  const args = [...argv];
  const tier = String(args.shift() || 'fast').trim().toLowerCase();
  let listOnly = false;
  let concurrency = null;
  const forwarded = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--list') {
      listOnly = true;
      continue;
    }
    if (value === '--concurrency') {
      concurrency = Number(args[index + 1]);
      index += 1;
      continue;
    }
    if (value.startsWith('--concurrency=')) {
      concurrency = Number(value.split('=', 2)[1]);
      continue;
    }
    forwarded.push(value);
  }
  return { tier, listOnly, concurrency, forwarded };
}

function defaultConcurrency(tier) {
  const envKey = `DDALGGAK_TEST_CONCURRENCY_${String(tier).toUpperCase()}`;
  const explicit = Number(process.env[envKey] || process.env.DDALGGAK_TEST_CONCURRENCY || 0);
  if (Number.isFinite(explicit) && explicit > 0) return Math.max(1, Math.floor(explicit));
  const available = Math.max(1, Number(os.availableParallelism?.() || os.cpus().length || 1));
  if (tier === 'system') return 1;
  if (tier === 'integration') return Math.min(2, available);
  return Math.min(4, available);
}

function runTier(tier, { listOnly = false, concurrency = null, forwarded = [] } = {}) {
  const resolved = resolveTestTierFiles(tier);
  const useConcurrency = Number.isFinite(concurrency) && concurrency > 0
    ? Math.max(1, Math.floor(concurrency))
    : defaultConcurrency(tier);
  const isolation = tier === 'fast'
    ? String(process.env.DDALGGAK_TEST_ISOLATION_FAST || 'none').trim().toLowerCase()
    : 'process';
  console.log(`[test-tier] tier=${tier} files=${resolved.files.length} concurrency=${useConcurrency} isolation=${isolation}`);
  if (resolved.registry.config.policy) console.log(`[test-tier] policy=${resolved.registry.config.policy}`);
  if (listOnly) {
    for (const file of resolved.files) console.log(file);
    return 0;
  }
  const result = spawnSync(process.execPath, [
    '--test',
    ...(isolation === 'none' ? ['--experimental-test-isolation=none'] : []),
    `--test-concurrency=${useConcurrency}`,
    ...forwarded,
    ...absoluteTestFiles(resolved.files),
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`[test-tier] failed to start ${tier}: ${result.error.message}`);
    return 1;
  }
  return Number.isInteger(result.status) ? result.status : 1;
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed.tier === 'all') {
  if (parsed.listOnly) {
    const registry = buildTestTierRegistry();
    for (const tier of ['fast', 'integration', 'system']) {
      console.log(`\n[${tier}]`);
      for (const file of registry[tier]) console.log(file);
    }
    process.exit(0);
  }
  for (const tier of ['fast', 'integration', 'system']) {
    const status = runTier(tier, parsed);
    if (status !== 0) process.exit(status);
  }
  process.exit(0);
}
process.exit(runTier(parsed.tier, parsed));
