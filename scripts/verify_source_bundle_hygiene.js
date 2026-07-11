#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const targets = process.argv.slice(2);
if (!targets.length) targets.push(process.cwd());

const forbiddenPatterns = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)runs(\/|$)/,
  /(^|\/)ddalggak-main\/docs(\/|$)/,
  /(^|\/)ddalggak\/docs(\/|$)/,
  /(^|\/)graph-of-context-ui-main\/docs(\/|$)/,
  /(^|\/)goc\/docs(\/|$)/,
  /(^|\/)chat_sessions\.jsonl?$/,
  /(^|\/)room_memory_data(\/|$)/,
  /(^|\/)paper4_data(\/|$)/,
  /(^|\/)room-memory-trials\/results(\/|$)/,
  /(^|\/)room-memory-trials\/build(\/|$)/,
  /(^|\/)room-memory-trials\/dist(\/|$)/,
  /(^|\/)room_memory_trials\/results(\/|$)/,
  /(^|\/)room_memory_trials\/build(\/|$)/,
  /(^|\/)room_memory_trials\/dist(\/|$)/,
  /(^|\/)paper4\/results(\/|$)/,
  /(^|\/)paper4\/build(\/|$)/,
  /(^|\/)paper4\/dist(\/|$)/,
  /(^|\/)paper4-memory-schema-trials\/results(\/|$)/,
  /(^|\/)paper4-memory-schema-trials\/build(\/|$)/,
  /(^|\/)paper4-memory-schema-trials\/dist(\/|$)/,
  /(^|\/)data(\/|$)/,
  /(^|\/)models(\/|$)/,
  /(^|\/)reports(\/|$)/,
  /(^|\/)outputs(\/|$)/,
  /(^|\/)checkpoints(\/|$)/,
  /(^|\/)wandb(\/|$)/,
  /(^|\/)mlruns(\/|$)/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /(^|\/)\.pytest_cache(\/|$)/,
  /(^|\/)\.cache(\/|$)/,
  /(^|\/)\.venv(\/|$)/,
  /(^|\/)\.env$/,
  /(^|\/)\.env\.(?!example$).+$/,
  /\.log$/,
  /\.pyc$/,
  /\.(pem|key|p12|pfx)$/i,
];

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function isForbidden(relPath) {
  const clean = normalizePath(relPath);
  return forbiddenPatterns.some((pattern) => pattern.test(clean));
}

function walkDir(root, base = root, out = []) {
  for (const name of fs.readdirSync(root)) {
    const abs = path.join(root, name);
    const rel = normalizePath(path.relative(base, abs));
    if (isForbidden(rel)) {
      out.push(rel);
      continue;
    }
    const stat = fs.lstatSync(abs);
    if (stat.isDirectory()) walkDir(abs, base, out);
  }
  return out;
}

function listZip(zipPath) {
  const result = spawnSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`failed to inspect zip: ${zipPath}\n${result.stderr || result.stdout}`);
  }
  return result.stdout.split(/\r?\n/g).filter(Boolean);
}

const requiredBundleFiles = [
  'ddalggak/src/shared/openharness_contracts.js',
  'ddalggak/src/shared/team_structure_v2.js',
];

let failures = [];
for (const target of targets) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) {
    failures.push(`${target}: does not exist`);
    continue;
  }
  const stat = fs.statSync(abs);
  const bad = stat.isDirectory()
    ? walkDir(abs)
    : (abs.endsWith('.zip') ? listZip(abs).filter(isForbidden) : (isForbidden(path.basename(abs)) ? [path.basename(abs)] : []));
  if (bad.length) {
    failures.push(`${target}: forbidden files found\n${bad.slice(0, 200).map((x) => `  - ${x}`).join('\n')}${bad.length > 200 ? `\n  ... ${bad.length - 200} more` : ''}`);
  }
  if (stat.isDirectory() && fs.existsSync(path.join(abs, 'ddalggak'))) {
    const missing = requiredBundleFiles.filter((rel) => !fs.existsSync(path.join(abs, rel)));
    if (missing.length) failures.push(`${target}: required source files missing\n${missing.map((x) => `  - ${x}`).join('\n')}`);
  }
  if (!stat.isDirectory() && abs.endsWith('.zip')) {
    const entries = new Set(listZip(abs).map(normalizePath));
    const prefixes = ['', ...[...entries].filter((entry) => entry.endsWith('/ddalggak/')).map((entry) => entry.slice(0, -'ddalggak/'.length))];
    const missing = requiredBundleFiles.filter((rel) => !prefixes.some((prefix) => entries.has(`${prefix}${rel}`)));
    if (entries.size && [...entries].some((entry) => /(^|\/)ddalggak\//.test(entry)) && missing.length) {
      failures.push(`${target}: required source files missing\n${missing.map((x) => `  - ${x}`).join('\n')}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, checked: targets }, null, 2));
