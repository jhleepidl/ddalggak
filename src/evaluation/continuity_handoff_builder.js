import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { probeProviderCapabilities } from './provider_capability_registry.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'item'; }
function nowIso() { return new Date().toISOString(); }
function writeText(file, text) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(text ?? ''), 'utf8'); }
function writeJson(file, value) { writeText(file, `${JSON.stringify(value, null, 2)}\n`); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function csvCell(value = '') { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

const FORBIDDEN_NAMES = new Set(['.env', '.env.local', '.env.production', 'credentials.json', 'token.json', 'chat_sessions.json']);
const FORBIDDEN_SEGMENTS = new Set(['node_modules', '.git', '__pycache__', '.pytest_cache', 'dist', 'build']);
const TEXT_EXTENSIONS = new Set(['.md','.txt','.json','.jsonl','.csv','.log','.yaml','.yml','.xml','.html','.js','.mjs','.cjs','.ts','.tsx','.py','.sh']);
const SECRET_PATTERNS = [
  [/\b(sk-[A-Za-z0-9_-]{16,})\b/g, '<redacted-openai-key>'],
  [/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, '<redacted-github-token>'],
  [/\b(\d{8,12}:[A-Za-z0-9_-]{25,})\b/g, '<redacted-telegram-token>'],
  [/(api[_-]?key|service[_-]?key|token|secret|password)\s*[:=]\s*[^\s"']+/gi, '$1=<redacted>'],
  [/(authorization\s*:\s*bearer\s+)[A-Za-z0-9._-]+/gi, '$1<redacted>'],
];

function shouldExclude(relative = '') {
  const parts = relative.split(/[\\/]+/).filter(Boolean);
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return true;
  if (FORBIDDEN_NAMES.has(parts.at(-1))) return true;
  if (parts.at(-1)?.startsWith('.env')) return true;
  return false;
}

export function redactContinuityText(text = '') {
  let out = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  const home = clean(process.env.HOME);
  if (home) out = out.replaceAll(home, '~');
  return out;
}

function copySanitizedFile(source, destination) {
  const ext = path.extname(source).toLowerCase();
  ensureDir(path.dirname(destination));
  if (TEXT_EXTENSIONS.has(ext) || !ext) writeText(destination, redactContinuityText(fs.readFileSync(source, 'utf8')));
  else fs.copyFileSync(source, destination);
}

function copyTree(source, destination, copied = []) {
  if (!fs.existsSync(source)) return copied;
  const root = path.resolve(source);
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name);
      const rel = path.relative(root, abs).replaceAll('\\', '/');
      if (shouldExclude(rel)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) {
        copySanitizedFile(abs, path.join(destination, rel));
        copied.push(rel);
      }
    }
  };
  visit(root);
  return copied;
}

function gitInfo(repoPath = '') {
  const repo = clean(repoPath);
  if (!repo || !fs.existsSync(repo)) return null;
  const run = (args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  const head = run(['rev-parse', 'HEAD']);
  if (head.status !== 0) return { path: repo, git_repository: false };
  return {
    path: repo,
    git_repository: true,
    head: clean(head.stdout),
    branch: clean(run(['branch', '--show-current']).stdout),
    last_commit: clean(run(['log', '-1', '--oneline']).stdout),
    status: redactContinuityText(run(['status', '--short']).stdout),
  };
}

function collectScorecards(runDirs = []) {
  const rows = [];
  for (const runDir of runDirs) {
    const state = readJson(path.join(runDir, 'state.json'));
    if (!state) continue;
    const judge = state.semantic_judgment?.result || {};
    const required = asArray(state.manual_rubric).filter((item) => item.required !== false);
    rows.push({
      run_id: state.run_id, scenario_id: state.scenario_id, track: state.track, status: state.status,
      manual_score: state.score ?? '', judge_passed: typeof judge.passed === 'boolean' ? judge.passed : '', judge_score: judge.score ?? '',
      required_pass: required.filter((item) => item.result === 'pass').length,
      required_fail: required.filter((item) => item.result === 'fail').length,
      required_unknown: required.filter((item) => item.result === 'unknown').length,
    });
  }
  return rows;
}


function renderComparison(scoreRows = []) {
  const byScenario = new Map();
  for (const row of scoreRows) {
    const key = row.scenario_id || 'unknown';
    const list = byScenario.get(key) || []; list.push(row); byScenario.set(key, list);
  }
  const lines = ['# Continuity Baseline Comparison', '', '같은 scenario의 `baseline`과 `ai_rooms` track을 비교합니다.', ''];
  for (const [scenario, rows] of byScenario.entries()) {
    lines.push(`## ${scenario}`, '');
    lines.push('| Track | Status | Manual score | Judge score | Required failures |', '|---|---|---:|---:|---:|');
    for (const row of rows) lines.push(`| ${row.track || '-'} | ${row.status || '-'} | ${row.manual_score === '' ? '-' : row.manual_score} | ${row.judge_score === '' ? '-' : row.judge_score} | ${row.required_fail} |`);
    const baseline = rows.find((row) => row.track === 'baseline');
    const rooms = rows.find((row) => row.track === 'ai_rooms');
    if (baseline && rooms) {
      const b = Number(baseline.judge_score !== '' ? baseline.judge_score : baseline.manual_score);
      const a = Number(rooms.judge_score !== '' ? rooms.judge_score : rooms.manual_score);
      if (Number.isFinite(a) && Number.isFinite(b)) lines.push('', `- score delta (AI Rooms - baseline): ${(a - b).toFixed(3)}`);
    } else lines.push('', '- 비교하려면 같은 scenario를 `--track baseline`과 `--track ai_rooms`로 각각 실행하세요.');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function renderHandoff({ manifest, scoreRows }) {
  const lines = [
    '# AI Rooms Continuity Test Handoff', '',
    `Created: ${manifest.created_at}`, '',
    '## Purpose', '',
    'Room continuity 테스트 결과를 코드·모델·CLI 버전·scorecard와 함께 전달합니다.', '',
    '## Versions', '',
  ];
  for (const repo of manifest.repositories) {
    lines.push(`### ${repo.name}`, '', `- HEAD: ${repo.info?.head || '-'}`, `- branch: ${repo.info?.branch || '-'}`, `- last commit: ${repo.info?.last_commit || '-'}`, `- dirty: ${clean(repo.info?.status) ? 'yes' : 'no'}`, '');
  }
  lines.push('## Provider CLIs', '');
  for (const item of manifest.provider_registry?.items || []) lines.push(`- ${item.provider}: ${item.cli_version || 'unavailable'} (${item.cli_available ? 'available' : 'unavailable'})`);
  lines.push('', '## Scenario Results', '');
  for (const row of scoreRows) lines.push(`- ${row.scenario_id} [${row.track}]: ${row.status}, manual=${row.manual_score || '-'}, judge=${row.judge_score || '-'}`);
  lines.push('', '## Review order', '', '1. `scorecard.csv`', '2. `runs/<run>/state.json`', '3. `runs/<run>/RUNBOOK.md`', '4. `runs/<run>/judge_output.txt`', '5. `HANDOFF_MANIFEST.json`', '', '## Safety', '', '- `.env`, token, credential, Git metadata, dependency/build cache는 제외했습니다.', '- 텍스트 파일의 일반적인 key/token 패턴은 자동 redaction했습니다.', '- 개인 대화나 민감한 업로드 원문은 전달 전에 직접 검토하세요.', '');
  return lines.join('\n');
}

export async function buildContinuityHandoff({ runDirs = [], outDir = '', archivePath = '', repositories = {}, sourceZips = [], evaluationDirs = [], logFiles = [], createArchive = true, probe = true } = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const root = ensureDir(path.resolve(outDir || path.join('continuity_handoff', `handoff_${timestamp}`)));
  const copied = [];
  const resolvedRuns = runDirs.map((entry) => path.resolve(entry));
  for (const runDir of resolvedRuns) {
    if (!fs.existsSync(runDir)) continue;
    const target = path.join(root, 'runs', safe(path.basename(runDir)));
    copyTree(runDir, target, copied);
  }
  for (const evalDir of evaluationDirs.map((entry) => path.resolve(entry))) {
    if (!fs.existsSync(evalDir)) continue;
    copyTree(evalDir, path.join(root, 'evaluations', safe(path.basename(evalDir))), copied);
  }
  for (const logFile of logFiles.map((entry) => path.resolve(entry))) {
    if (!fs.existsSync(logFile) || !fs.statSync(logFile).isFile()) continue;
    copySanitizedFile(logFile, path.join(root, 'logs', safe(path.basename(logFile))));
  }
  for (const zipFile of sourceZips.map((entry) => path.resolve(entry))) {
    if (!fs.existsSync(zipFile) || !fs.statSync(zipFile).isFile()) continue;
    fs.copyFileSync(zipFile, path.join(ensureDir(path.join(root, 'source')), safe(path.basename(zipFile))));
  }
  const repositoryRows = Object.entries(repositories).map(([name, repoPath]) => ({ name, info: gitInfo(repoPath) }));
  const providerRegistry = probe ? await probeProviderCapabilities() : null;
  const scoreRows = collectScorecards(resolvedRuns);
  const headers = ['run_id','scenario_id','track','status','manual_score','judge_passed','judge_score','required_pass','required_fail','required_unknown'];
  writeText(path.join(root, 'scorecard.csv'), `${headers.join(',')}\n${scoreRows.map((row) => headers.map((key) => csvCell(row[key])).join(',')).join('\n')}\n`);
  writeText(path.join(root, 'COMPARISON.md'), renderComparison(scoreRows));
  const manifest = {
    schema_version: 'ddalggak.continuity_handoff/v1', created_at: nowIso(), hostname: os.hostname(), platform: process.platform,
    node_version: process.version, repositories: repositoryRows, provider_registry: providerRegistry,
    run_dirs: resolvedRuns.map((entry) => path.basename(entry)), evaluation_dirs: evaluationDirs.map((entry) => path.basename(entry)),
    included_source_zips: sourceZips.map((entry) => path.basename(entry)), copied_file_count: copied.length,
  };
  writeJson(path.join(root, 'HANDOFF_MANIFEST.json'), manifest);
  writeText(path.join(root, 'HANDOFF.md'), renderHandoff({ manifest, scoreRows }));
  let archive = null;
  if (createArchive) {
    archive = path.resolve(archivePath || `${root}.zip`);
    ensureDir(path.dirname(archive));
    const result = spawnSync('zip', ['-qr', archive, path.basename(root)], { cwd: path.dirname(root), encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`zip failed: ${clean(result.stderr || result.stdout)}`);
  }
  return { output_dir: root, archive_path: archive, manifest, score_rows: scoreRows };
}
