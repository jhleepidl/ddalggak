#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function clean(value = '') {
  return String(value ?? '').trim();
}

function boolEnv(name, fallback = false) {
  const raw = clean(process.env[name]).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function intValue(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function safeSegment(value = '') {
  return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'item';
}

function timestampSegment(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function ensureDir(dirPath = '') {
  const target = clean(dirPath);
  if (!target) return;
  fs.mkdirSync(target, { recursive: true });
}

function exists(filePath = '') {
  try { return Boolean(filePath) && fs.existsSync(filePath); } catch { return false; }
}

function readText(filePath = '', maxChars = 2_000_000) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (maxChars > 0 && raw.length > maxChars) return raw.slice(raw.length - maxChars);
    return raw;
  } catch {
    return '';
  }
}

function writeText(filePath = '', text = '') {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, String(text ?? ''), 'utf8');
}

function writeJson(filePath = '', payload = {}) {
  writeText(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function parseArgs(argv = []) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function redactPath(value = '') {
  const home = clean(process.env.HOME);
  let out = clean(value);
  if (home && out.startsWith(home)) out = `~${out.slice(home.length)}`;
  return out;
}

function readJsonl(filePath = '') {
  return readText(filePath, 20_000_000)
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
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
  const safeJob = clean(jobId);
  if (safeJob) {
    const candidates = traceDirCandidatesForJob({ jobId: safeJob, runsDir, cwd });
    return candidates.find((entry) => exists(entry)) || candidates[0];
  }
  const explicitEnv = clean(process.env.SELF_IMPROVE_LLM_TRACE_DIR) || clean(process.env.LLM_TRACE_DIR);
  if (explicitEnv) return path.resolve(cwd, explicitEnv);
  if (boolEnv('LLM_TRACE_UNSCOPED', false)) {
    const runBase = path.resolve(cwd, clean(runsDir || process.env.RUNS_DIR || 'runs'));
    return path.join(runBase, '_unscoped', 'llm_traces');
  }
  return '';
}

function resolveRunDirs({ jobId = '', runsDir = '', cwd = process.cwd() } = {}) {
  const safeJob = safeSegment(jobId || '');
  if (!clean(jobId)) return [];
  const runBase = path.resolve(cwd, clean(runsDir || process.env.RUNS_DIR || 'runs'));
  return [
    path.join(runBase, safeJob),
    path.resolve(cwd, '.self_improve', 'jobs', safeJob),
  ].filter((entry, index, arr) => entry && arr.indexOf(entry) === index);
}

function safeCopyFile(source = '', destination = '', copied = []) {
  if (!exists(source)) return false;
  ensureDir(path.dirname(destination));
  fs.copyFileSync(source, destination);
  copied.push({ source: redactPath(source), destination: path.relative(process.cwd(), destination) || destination, bytes: fs.statSync(destination).size });
  return true;
}

function absoluteIfPresent(filePath = '', baseDir = process.cwd()) {
  const value = clean(filePath);
  if (!value) return '';
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

function traceIdFromEntry(entry = {}) {
  const direct = clean(entry.trace_id || entry.traceId || entry.id);
  if (direct) return safeSegment(direct);
  const pathHint = clean(entry.request_path || entry.prompt_path || entry.response_path || entry.stdout_path || entry.stderr_path);
  if (!pathHint) return 'trace';
  return safeSegment(path.basename(path.dirname(pathHint)) || path.basename(pathHint, path.extname(pathHint)) || 'trace');
}

function copyTraceEntryFiles({ entry = {}, traceDir = '', outputTraceDir = '', copied = [] } = {}) {
  const traceId = traceIdFromEntry(entry);
  const sourceRoot = path.join(traceDir, traceId);
  const destRoot = path.join(outputTraceDir, traceId);
  const specs = [
    ['request.json', entry.request_path],
    ['response.json', entry.response_path],
    ['prompt.txt', entry.prompt_path],
    ['stdout.txt', entry.stdout_path],
    ['stderr.txt', entry.stderr_path],
  ];
  for (const [fileName, explicitPath] of specs) {
    const explicit = absoluteIfPresent(explicitPath, traceDir);
    const source = explicit && exists(explicit) ? explicit : path.join(sourceRoot, fileName);
    safeCopyFile(source, path.join(destRoot, fileName), copied);
  }
}

function copyRecentTraceFiles({ traceDir = '', outputTraceDir = '', maxTraces = 20, copied = [] } = {}) {
  const indexPath = path.join(traceDir, 'index.jsonl');
  const entries = readJsonl(indexPath);
  const selected = entries.slice(Math.max(0, entries.length - maxTraces));
  safeCopyFile(indexPath, path.join(outputTraceDir, 'index.jsonl'), copied);

  for (const entry of selected) {
    copyTraceEntryFiles({ entry, traceDir, outputTraceDir, copied });
  }
  return { total: entries.length, included: selected.length, entries: selected };
}

function copyOptionalRunFiles({ runDirs = [], outputDir = '', maxChars = 600_000, copied = [] } = {}) {
  const wanted = [
    ['conversation.jsonl', 'conversation_tail.jsonl'],
    ['runtime_events.jsonl', 'runtime_events_tail.jsonl'],
    ['latest_checkpoint.md', 'latest_checkpoint.md'],
    ['prompt_metrics.jsonl', 'prompt_metrics_tail.jsonl'],
    ['debug/failure_summary.md', 'debug/failure_summary.md'],
    ['debug/review_input.md', 'debug/review_input.md'],
    ['debug/command_results.json', 'debug/command_results.json'],
    ['debug/artifact_index.md', 'debug/artifact_index.md'],
  ];
  for (const runDir of runDirs) {
    if (!exists(runDir)) continue;
    for (const [relativeSource, relativeDest] of wanted) {
      const source = path.join(runDir, relativeSource);
      if (!exists(source)) continue;
      const destination = path.join(outputDir, 'run_context', relativeDest);
      const text = readText(source, maxChars);
      writeText(destination, `${text}${text.endsWith('\n') ? '' : '\n'}`);
      copied.push({ source: redactPath(source), destination: path.relative(process.cwd(), destination) || destination, bytes: fs.statSync(destination).size });
    }
  }
}

function summarizeEnv() {
  const keys = [
    'LLM_TRACE_ENABLED',
    'LLM_TRACE_SAVE_PROMPTS',
    'LLM_TRACE_SAVE_OUTPUTS',
    'LLM_TRACE_SAVE_STDERR',
    'LLM_TRACE_REDACT_SECRETS',
    'LLM_TRACE_UNSCOPED',
    'LLM_TRACE_DIR',
    'RUNS_DIR',
    'MEMORY_MODE',
    'GOC_API_BASE',
    'GOC_UI_BASE',
  ];
  const out = {};
  for (const key of keys) {
    const value = process.env[key];
    if (value === undefined) continue;
    out[key] = /TOKEN|KEY|SECRET|PASSWORD/i.test(key) ? '<redacted>' : value;
  }
  return out;
}

function buildReadme({ jobId = '', traceDir = '', traceStats = {}, runDirs = [], outputDir = '' } = {}) {
  return [
    '# LLM trace handoff bundle',
    '',
    '이 폴더는 ddalggak의 raw LLM trace와 최소 실행 문맥을 ChatGPT에게 전달하기 쉽게 묶은 것입니다.',
    '',
    '## What to upload',
    '',
    '이 폴더 전체를 zip/tar.gz로 압축해서 업로드하세요. 용량이 크면 아래 파일부터 우선 업로드하세요.',
    '',
    '1. `HANDOFF_MANIFEST.json`',
    '2. `llm_traces/index.jsonl`',
    '3. 실패하거나 이상한 응답과 관련된 trace 폴더의 `request.json`, `response.json`, `prompt.txt`, `stdout.txt`, `stderr.txt`',
    '4. `run_context/conversation_tail.jsonl`',
    '5. `run_context/runtime_events_tail.jsonl`',
    '6. `run_context/latest_checkpoint.md`',
    '',
    '## Summary',
    '',
    `- job_id: ${clean(jobId) || '-'}`,
    `- source_trace_dir: ${redactPath(traceDir) || '-'}`,
    `- output_dir: ${redactPath(outputDir) || '-'}`,
    `- total_traces: ${Number(traceStats.total || 0)}`,
    `- included_traces: ${Number(traceStats.included || 0)}`,
    `- run_dirs_checked: ${runDirs.map(redactPath).join(', ') || '-'}`,
    '',
    '## Safety notes',
    '',
    '- `LLM_TRACE_REDACT_SECRETS=true` 상태에서 생성한 trace만 공유하는 것을 권장합니다.',
    '- `.env`, API key, Telegram token, GoC service key 파일은 업로드하지 마세요.',
    '- GoC에는 raw trace 전문을 올리지 말고 summary/report만 올리는 운영 원칙을 유지하세요.',
    '',
  ].join('\n');
}

export function buildTraceHandoffBundle(options = {}) {
  const cwd = path.resolve(clean(options.cwd) || process.cwd());
  const jobId = clean(options.jobId || options.job || process.env.SELF_IMPROVE_JOB_ID || '');
  const traceDir = resolveTraceDir({ jobId, traceDir: options.traceDir, runsDir: options.runsDir, cwd });
  if (!traceDir) throw new Error('trace directory could not be resolved; pass --job-id or --trace-dir');
  if (!exists(traceDir)) throw new Error(`trace directory does not exist: ${traceDir}`);

  const outputRoot = options.out
    ? path.resolve(cwd, clean(options.out))
    : path.join(cwd, 'trace_handoff', `${safeSegment(jobId || 'unscoped')}_${timestampSegment()}`);
  ensureDir(outputRoot);

  const maxTraces = intValue(options.maxTraces ?? options.limit, 20, { min: 1, max: 500 });
  const copied = [];
  const outputTraceDir = path.join(outputRoot, 'llm_traces');
  const traceStats = copyRecentTraceFiles({ traceDir, outputTraceDir, maxTraces, copied });
  const runDirs = resolveRunDirs({ jobId, runsDir: options.runsDir, cwd });
  copyOptionalRunFiles({ runDirs, outputDir: outputRoot, copied });

  const manifest = {
    created_at: new Date().toISOString(),
    job_id: jobId || null,
    source_trace_dir: redactPath(traceDir),
    output_dir: redactPath(outputRoot),
    total_traces: traceStats.total,
    included_traces: traceStats.included,
    trace_ids: traceStats.entries.map((entry) => entry.trace_id).filter(Boolean),
    env_summary: summarizeEnv(),
    run_dirs_checked: runDirs.map(redactPath),
    copied_files: copied,
    upload_priority: [
      'HANDOFF_MANIFEST.json',
      'llm_traces/index.jsonl',
      'llm_traces/<traceId>/{request.json,response.json,prompt.txt,stdout.txt,stderr.txt}',
      'run_context/conversation_tail.jsonl',
      'run_context/runtime_events_tail.jsonl',
      'run_context/latest_checkpoint.md',
    ],
  };
  writeJson(path.join(outputRoot, 'HANDOFF_MANIFEST.json'), manifest);
  writeText(path.join(outputRoot, 'README.md'), buildReadme({ jobId, traceDir, traceStats, runDirs, outputDir: outputRoot }));
  return { output_dir: outputRoot, manifest_path: path.join(outputRoot, 'HANDOFF_MANIFEST.json'), manifest };
}

function printUsage() {
  console.log(`Usage:\n  node scripts/trace_handoff_bundle.js --job-id <jobId> [--out <dir>] [--max-traces 20]\n  node scripts/trace_handoff_bundle.js --trace-dir <path> [--out <dir>] [--max-traces 20]\n\nThis creates a shareable trace handoff directory. Compress the output directory before uploading it to ChatGPT.`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printUsage();
    return;
  }
  const result = buildTraceHandoffBundle(args);
  console.log(`Trace handoff bundle created: ${result.output_dir}`);
  console.log(`Manifest: ${result.manifest_path}`);
  console.log('Compress it with:');
  console.log(`  tar -czf ${path.basename(result.output_dir)}.tar.gz -C ${path.dirname(result.output_dir)} ${path.basename(result.output_dir)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exit(1);
  });
}
