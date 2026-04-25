#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function clean(value = '') { return String(value ?? '').trim(); }
function safeSegment(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'item'; }
function exists(filePath = '') { try { return Boolean(filePath) && fs.existsSync(filePath); } catch { return false; } }
function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i += 1; }
  }
  return args;
}
function boolLike(value = '', fallback = false) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function statusLine(ok, text) { return `${ok ? '✅' : '⚠️ '} ${text}`; }
function canWriteDir(dirPath = '') {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.trace_doctor_probe_${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}
function traceDirCandidatesForJob({ jobId = '', runsDir = '', cwd = process.cwd() } = {}) {
  const safeJob = clean(jobId);
  if (!safeJob) return [];
  const runBase = path.resolve(cwd, clean(runsDir || process.env.RUNS_DIR || 'runs'));
  return [
    path.join(runBase, safeSegment(safeJob), 'llm_traces'),
    path.resolve(cwd, '.self_improve', 'jobs', safeSegment(safeJob), 'llm_traces'),
  ];
}
function resolveTraceDir({ jobId = '', traceDir = '', runsDir = '', cwd = process.cwd() } = {}) {
  const explicitCli = clean(traceDir);
  if (explicitCli) return path.resolve(cwd, explicitCli);
  if (clean(jobId)) {
    const candidates = traceDirCandidatesForJob({ jobId, runsDir, cwd });
    return candidates.find((entry) => exists(entry)) || candidates[0];
  }
  const explicitEnv = clean(process.env.SELF_IMPROVE_LLM_TRACE_DIR) || clean(process.env.LLM_TRACE_DIR);
  if (explicitEnv) return path.resolve(cwd, explicitEnv);
  if (boolLike(process.env.LLM_TRACE_UNSCOPED, false)) return path.resolve(cwd, clean(runsDir || process.env.RUNS_DIR || 'runs'), '_unscoped', 'llm_traces');
  return '';
}
export function runTraceDoctor(options = {}) {
  const cwd = path.resolve(clean(options.cwd) || process.cwd());
  const jobId = clean(options.jobId || options.job || process.env.SELF_IMPROVE_JOB_ID || '');
  const traceDir = resolveTraceDir({ jobId, traceDir: options.traceDir, runsDir: options.runsDir, cwd });
  const runsDir = path.resolve(cwd, clean(options.runsDir || process.env.RUNS_DIR || 'runs'));
  const indexPath = traceDir ? path.join(traceDir, 'index.jsonl') : '';
  const runsWritable = canWriteDir(runsDir);
  const rows = [
    '# ddalggak trace doctor',
    '',
    statusLine(boolLike(process.env.LLM_TRACE_ENABLED, false), 'LLM_TRACE_ENABLED=true'),
    statusLine(boolLike(process.env.LLM_TRACE_SAVE_PROMPTS, true), 'LLM_TRACE_SAVE_PROMPTS=true'),
    statusLine(boolLike(process.env.LLM_TRACE_SAVE_OUTPUTS, true), 'LLM_TRACE_SAVE_OUTPUTS=true'),
    statusLine(boolLike(process.env.LLM_TRACE_REDACT_SECRETS, true), 'LLM_TRACE_REDACT_SECRETS=true'),
    statusLine(!boolLike(process.env.LLM_TRACE_UNSCOPED, false), 'LLM_TRACE_UNSCOPED=false 권장'),
    statusLine(runsWritable, `RUNS_DIR writable: ${runsDir}`),
    traceDir ? statusLine(exists(traceDir), `trace dir exists: ${traceDir}`) : statusLine(false, 'trace dir unresolved; pass --job-id or --trace-dir'),
    indexPath ? statusLine(exists(indexPath), `trace index exists: ${indexPath}`) : statusLine(false, 'trace index unresolved'),
    '',
    '## Useful commands',
    jobId
      ? `node scripts/trace_handoff_bundle.js --job-id ${jobId} --out /tmp/ddalggak_trace_${safeSegment(jobId)}`
      : 'node scripts/trace_handoff_bundle.js --trace-dir <path-to-llm_traces> --out /tmp/ddalggak_trace_handoff',
  ];
  const output = `${rows.join('\n')}\n`;
  return {
    ok: boolLike(process.env.LLM_TRACE_ENABLED, false) && boolLike(process.env.LLM_TRACE_REDACT_SECRETS, true) && runsWritable,
    output,
    trace_dir: traceDir,
    index_path: indexPath,
  };
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log('Usage: node scripts/trace_doctor.js [--job-id <jobId>] [--trace-dir <path>]');
    return;
  }
  const result = runTraceDoctor(args);
  process.stdout.write(result.output);
  if (!result.ok) process.exitCode = 1;
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => { console.error(err?.message || err); process.exit(1); });
}
