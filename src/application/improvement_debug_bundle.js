import fs from 'node:fs';
import path from 'node:path';

function clean(value = '') {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clip(value = '', max = 12000) {
  const raw = clean(value);
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw;
}

function ensureDir(dirPath = '') {
  if (!clean(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath = '', content = '') {
  const target = clean(filePath);
  if (!target) return;
  ensureDir(path.dirname(target));
  fs.writeFileSync(target, String(content || ''), 'utf8');
}

function writeJson(filePath = '', payload = {}) {
  writeText(filePath, JSON.stringify(payload, null, 2));
}

function readText(filePath = '', maxChars = 200000) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.length > maxChars ? raw.slice(-maxChars) : raw;
  } catch {
    return '';
  }
}

function copyTextIfPresent(source = '', destination = '', maxChars = 200000) {
  const content = readText(source, maxChars);
  if (content) writeText(destination, content);
  return Boolean(content);
}

function safePreview(value = '', maxChars = 4000) {
  const text = clean(value);
  if (!text) return '-';
  return text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
}

function reportKind(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  return clean(payload.resource_kind || row.resource_kind || payload.kind || row.kind);
}

function nestedPayload(report = {}) {
  return asObject(asObject(report).payload?.payload || asObject(report).payload);
}

function reportStatus(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  const nested = nestedPayload(row);
  return clean(payload.status || nested.status || row.status);
}

function reportPhase(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  const nested = nestedPayload(row);
  return clean(payload.phase || nested.phase || row.phase);
}

function reportSummary(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  const nested = nestedPayload(row);
  return clean(payload.summary || nested.summary || row.summary || row.text);
}

function reportText(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  const nested = nestedPayload(row);
  return clean(row.text || row.preview_text || row.previewText || payload.preview_text || nested.preview_text || nested.stdout || nested.stderr);
}

function reportTimestamp(report = {}) {
  const row = asObject(report);
  const payload = asObject(row.payload);
  const raw = row.created_at || row.updated_at || payload.created_at || payload.updated_at || payload.reported_at || payload.generated_at;
  const ms = Date.parse(clean(raw));
  return Number.isFinite(ms) ? ms : null;
}

function latestReport(reports = [], kind = '') {
  const targetKind = clean(kind);
  const matches = asArray(reports).filter((entry) => reportKind(entry) === targetKind);
  if (!matches.length) return null;
  const withTime = matches
    .map((entry) => ({ entry, ts: reportTimestamp(entry) }))
    .filter((row) => row.ts !== null)
    .sort((a, b) => b.ts - a.ts);
  if (withTime.length > 0) return withTime[0].entry;
  return matches[matches.length - 1];
}

function extractCommandResults(reports = []) {
  const out = {};
  for (const kind of ['code_diff', 'test_report', 'canary_result', 'review_report', 'eval_gate', 'promotion_decision', 'rollback_report']) {
    const report = latestReport(reports, kind);
    if (!report) continue;
    out[kind] = {
      status: reportStatus(report),
      phase: reportPhase(report),
      summary: reportSummary(report),
      metrics: asObject(asObject(report).payload?.metrics),
      payload: nestedPayload(report),
    };
  }
  return out;
}

function extractResultLogs(report = {}) {
  const payload = nestedPayload(report);
  const results = asArray(payload.results);
  return {
    stdout: results.map((entry) => clean(asObject(entry).stdout)).filter(Boolean).join('\n\n'),
    stderr: results.map((entry) => clean(asObject(entry).stderr)).filter(Boolean).join('\n\n'),
  };
}

function findRunRoot({ workspaceRoot = '', jobId = '' } = {}) {
  const safeJob = clean(jobId);
  if (!safeJob) return '';
  const candidates = [
    path.join(clean(workspaceRoot), 'runs', safeJob),
    path.join(process.cwd(), 'runs', safeJob),
  ];
  return candidates.find((entry) => entry && fs.existsSync(entry)) || '';
}

function redactEnvValue(key = '', value = '') {
  const lower = clean(key).toLowerCase();
  if (/secret|token|password|passwd|credential|private|apikey|api_key|access[_-]?key|refresh[_-]?key|auth|cookie|session/.test(lower)) {
    return '<redacted>';
  }
  return clip(value, 2000);
}

export const DEFAULT_FORBIDDEN_PATH_PATTERNS = [
  '.env',
  '.env.',
  'credential',
  'credentials',
  'secret',
  'token',
  '.pem',
  '.key',
  '.crt',
  'deploy/',
  '/deploy/',
  'deployment',
  'production',
  'promote-',
  'promote_',
  'rollback-',
  'rollback_',
];

export function parseForbiddenPathPatterns(value = '', fallback = DEFAULT_FORBIDDEN_PATH_PATTERNS) {
  const raw = clean(value);
  if (!raw) return [...fallback];
  return raw.split(/[;,\n]/).map((entry) => clean(entry)).filter(Boolean);
}

export function isForbiddenChangedPath(filePath = '', patterns = DEFAULT_FORBIDDEN_PATH_PATTERNS) {
  const file = clean(filePath).replace(/\\+/g, '/').toLowerCase();
  if (!file) return false;
  const base = path.posix.basename(file);
  if (base === '.env' || base.startsWith('.env.')) return true;
  return asArray(patterns).some((pattern) => {
    const raw = clean(pattern).replace(/\\+/g, '/').toLowerCase();
    if (!raw) return false;
    if (raw.startsWith('/') || raw.endsWith('/')) return file.includes(raw);
    return file.includes(raw);
  });
}

export function inferReviewRisk({ stdout = '', stderr = '', payload = {} } = {}) {
  const direct = clean(asObject(payload).risk || asObject(payload).review_risk || asObject(payload).risk_level).toLowerCase();
  if (['low', 'medium', 'high'].includes(direct)) return direct;
  const text = `${stdout}\n${stderr}`.toLowerCase();
  if (/risk\s*[:=]\s*high|high\s+risk|block(ed|ing)?|do not promote|reject/.test(text)) return 'high';
  if (/risk\s*[:=]\s*medium|medium\s+risk|needs? review|request changes|caution/.test(text)) return 'medium';
  if (/risk\s*[:=]\s*low|low\s+risk|approve|safe to promote|recommend promote/.test(text)) return 'low';
  return 'unknown';
}

export function createImprovementDebugBundle({
  bundle = {},
  workspaceRoot = '',
  jobId = '',
  targetConfig = {},
  jobPayload = {},
  reports = [],
  diff = {},
  patchResult = null,
  testResult = null,
  canaryResult = null,
} = {}) {
  const debugDir = clean(bundle.debug_dir || path.join(clean(bundle.bundle_root), 'debug'));
  if (!debugDir) throw new Error('createImprovementDebugBundle requires bundle.debug_dir or bundle.bundle_root');
  ensureDir(debugDir);

  const root = clean(workspaceRoot || targetConfig.workspace_root);
  const cleanJobId = clean(jobId || jobPayload.job_id || bundle.manifest?.job_id);
  const runRoot = findRunRoot({ workspaceRoot: root, jobId: cleanJobId });
  const traceDir = clean(bundle.llm_trace_dir || path.join(debugDir, 'llm_traces'));
  ensureDir(traceDir);

  const currentDiff = asObject(diff);
  const changedFiles = asArray(currentDiff.changed_files).map((entry) => clean(entry)).filter(Boolean);
  const forbiddenPatterns = parseForbiddenPathPatterns(targetConfig.forbidden_path_patterns || process.env.SELF_IMPROVE_FORBIDDEN_PATHS);
  const forbiddenChangedFiles = changedFiles.filter((file) => isForbiddenChangedPath(file, forbiddenPatterns));
  const commandResults = extractCommandResults(reports);

  const gitHead = {
    stdout: [clean(currentDiff.branch), clean(currentDiff.head)].filter(Boolean).join('\n'),
    stderr: '',
  };
  const gitStatus = {
    stdout: clean(currentDiff.status_text),
    stderr: '',
  };
  const gitDiffStat = {
    stdout: clean(currentDiff.diff_stat),
    stderr: '',
  };

  const testLogs = testResult ? { stdout: clean(testResult.stdout), stderr: clean(testResult.stderr) } : extractResultLogs(latestReport(reports, 'test_report'));
  const canaryLogs = canaryResult ? { stdout: clean(canaryResult.stdout), stderr: clean(canaryResult.stderr) } : extractResultLogs(latestReport(reports, 'canary_result'));
  const patchLogs = patchResult ? { stdout: clean(patchResult.stdout), stderr: clean(patchResult.stderr) } : extractResultLogs(latestReport(reports, 'code_diff'));

  const failedReports = asArray(reports).filter((entry) => /fail|block|error|reject/i.test(`${reportStatus(entry)} ${reportPhase(entry)}`));
  const failureSummary = [
    `# Failure summary for ${cleanJobId || 'improvement job'}`,
    '',
    `target: ${clean(targetConfig.target || jobPayload.improvement_target) || '-'}`,
    `workspace_root: ${root || '-'}`,
    `instruction: ${clean(jobPayload.instruction || bundle.manifest?.instruction) || '-'}`,
    '',
    failedReports.length ? '## Failed/blocked reports' : '## Failed/blocked reports\nNone observed in collected reports.',
    ...failedReports.slice(0, 12).map((entry) => `- ${reportKind(entry)} ${reportStatus(entry)} ${reportPhase(entry)} :: ${clip(reportSummary(entry), 280)}`),
    '',
    forbiddenChangedFiles.length ? `## Forbidden changed files\n${forbiddenChangedFiles.map((file) => `- ${file}`).join('\n')}` : '## Forbidden changed files\nNone detected.',
  ].join('\n');

  const reproduction = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    root ? `cd ${JSON.stringify(root)}` : '# cd <workspace_root>',
    '',
    '# Test commands',
    ...asArray(targetConfig.test_commands).map((command) => clean(command)).filter(Boolean).map((command) => command),
    '',
    '# Canary commands',
    ...asArray(targetConfig.canary_commands).map((command) => clean(command)).filter(Boolean).map((command) => command),
    '',
  ].join('\n');

  const envLines = Object.keys(process.env).sort().map((key) => `${key}=${redactEnvValue(key, process.env[key])}`);
  const redactedKeys = Object.keys(process.env).filter((key) => redactEnvValue(key, process.env[key]) === '<redacted>').sort();

  writeText(path.join(debugDir, 'failure_summary.md'), `${failureSummary}\n`);
  writeText(path.join(debugDir, 'reproduction.sh'), `${reproduction}\n`);
  try { fs.chmodSync(path.join(debugDir, 'reproduction.sh'), 0o755); } catch {}
  writeJson(path.join(debugDir, 'command_results.json'), {
    job_id: cleanJobId,
    target: clean(targetConfig.target || jobPayload.improvement_target),
    reports: commandResults,
    patch: patchResult || null,
    tests: testResult || null,
    canary: canaryResult || null,
  });
  writeText(path.join(debugDir, 'test_stdout.full.log'), [testLogs.stdout, canaryLogs.stdout].filter(Boolean).join('\n\n'));
  writeText(path.join(debugDir, 'test_stderr.full.log'), [testLogs.stderr, canaryLogs.stderr].filter(Boolean).join('\n\n'));
  writeText(path.join(debugDir, 'patch_stdout.full.log'), patchLogs.stdout);
  writeText(path.join(debugDir, 'patch_stderr.full.log'), patchLogs.stderr);
  writeText(path.join(debugDir, 'environment_sanitized.txt'), `${envLines.join('\n')}\n`);
  writeText(path.join(debugDir, 'repo_status.txt'), `${gitStatus.stdout || currentDiff.status_text || ''}${gitStatus.stderr ? `\n${gitStatus.stderr}` : ''}`);
  writeText(path.join(debugDir, 'git_head.txt'), `${gitHead.stdout}${gitHead.stderr ? `\n${gitHead.stderr}` : ''}`);
  writeText(path.join(debugDir, 'git_diff_stat.txt'), `${gitDiffStat.stdout || currentDiff.diff_stat || ''}${gitDiffStat.stderr ? `\n${gitDiffStat.stderr}` : ''}`);
  writeText(path.join(debugDir, 'scope_files.txt'), `${changedFiles.join('\n')}${changedFiles.length ? '\n' : ''}`);
  writeText(path.join(debugDir, 'forbidden_paths.txt'), `${forbiddenPatterns.join('\n')}\n`);
  writeJson(path.join(debugDir, 'secrets_redaction_report.json'), {
    redacted_env_key_count: redactedKeys.length,
    redacted_env_keys: redactedKeys,
    forbidden_changed_files: forbiddenChangedFiles,
  });

  if (runRoot) {
    copyTextIfPresent(path.join(runRoot, 'runtime_events.jsonl'), path.join(debugDir, 'runtime_events_tail.jsonl'));
    copyTextIfPresent(path.join(runRoot, 'conversation.jsonl'), path.join(debugDir, 'conversation_tail.jsonl'));
    copyTextIfPresent(path.join(runRoot, 'latest_checkpoint.md'), path.join(debugDir, 'latest_checkpoint.md'));
    const runTraceIndex = path.join(runRoot, 'llm_traces', 'index.jsonl');
    if (fs.existsSync(runTraceIndex)) copyTextIfPresent(runTraceIndex, path.join(traceDir, 'index.jsonl'));
  }
  if (bundle.llm_trace_index_path && fs.existsSync(bundle.llm_trace_index_path)) {
    copyTextIfPresent(bundle.llm_trace_index_path, path.join(traceDir, 'index.jsonl'));
  }

  const artifactLines = [
    '# Debug artifact index',
    '',
    `bundle_root: ${clean(bundle.bundle_root) || '-'}`,
    `debug_dir: ${debugDir}`,
    `llm_trace_dir: ${traceDir}`,
    '',
    ...fs.readdirSync(debugDir).sort().map((name) => `- ${name}`),
  ];
  writeText(path.join(debugDir, 'artifact_index.md'), `${artifactLines.join('\n')}\n`);

  const reviewInput = [
    `# Scoped review input for ${cleanJobId || 'improvement job'}`,
    '',
    'This file is intended for an external reviewer. It deliberately includes scoped summaries and sanitized metadata instead of raw prompts, raw traces, credentials, or full runtime logs.',
    '',
    '## Instruction',
    clean(jobPayload.instruction || bundle.manifest?.instruction) || '-',
    '',
    '## Failure summary',
    safePreview(failureSummary, 6000),
    '',
    '## Git head',
    safePreview(`${gitHead.stdout}${gitHead.stderr ? `\n${gitHead.stderr}` : ''}`, 3000),
    '',
    '## Repo status',
    safePreview(`${gitStatus.stdout || currentDiff.status_text || ''}${gitStatus.stderr ? `\n${gitStatus.stderr}` : ''}`, 6000),
    '',
    '## Diff stat',
    safePreview(`${gitDiffStat.stdout || currentDiff.diff_stat || ''}${gitDiffStat.stderr ? `\n${gitDiffStat.stderr}` : ''}`, 6000),
    '',
    '## Changed files',
    changedFiles.length ? changedFiles.slice(0, 120).map((file) => `- ${file}`).join('\n') : '-',
    '',
    '## Forbidden changed files',
    forbiddenChangedFiles.length ? forbiddenChangedFiles.map((file) => `- ${file}`).join('\n') : '-',
    '',
    '## Command result summary',
    JSON.stringify(commandResults, null, 2),
    '',
    '## Review output format',
    'Use this exact line near the top of your answer: Risk: low|medium|high',
  ].join('\n');
  const reviewInputPath = path.join(debugDir, 'review_input.md');
  writeText(reviewInputPath, `${reviewInput}\n`);
  const refreshedArtifactLines = [
    '# Debug artifact index',
    '',
    `bundle_root: ${clean(bundle.bundle_root) || '-'}`,
    `debug_dir: ${debugDir}`,
    `llm_trace_dir: ${traceDir}`,
    '',
    ...fs.readdirSync(debugDir).sort().map((name) => `- ${name}`),
  ];
  writeText(path.join(debugDir, 'artifact_index.md'), `${refreshedArtifactLines.join('\n')}\n`);

  return {
    debug_dir: debugDir,
    failure_summary_path: path.join(debugDir, 'failure_summary.md'),
    reproduction_path: path.join(debugDir, 'reproduction.sh'),
    command_results_path: path.join(debugDir, 'command_results.json'),
    artifact_index_path: path.join(debugDir, 'artifact_index.md'),
    review_input_path: reviewInputPath,
    environment_sanitized_path: path.join(debugDir, 'environment_sanitized.txt'),
    forbidden_paths_path: path.join(debugDir, 'forbidden_paths.txt'),
    secrets_redaction_report_path: path.join(debugDir, 'secrets_redaction_report.json'),
    llm_trace_dir: traceDir,
    forbidden_changed_files: forbiddenChangedFiles,
    changed_files: changedFiles,
  };
}

export function evaluateImprovementGate({ reports = [], diff = {}, targetConfig = {}, jobPayload = {}, reviewResult = null } = {}) {
  const latestTest = latestReport(reports, 'test_report');
  const latestCanary = latestReport(reports, 'canary_result');
  const latestReview = latestReport(reports, 'review_report');
  const latestPatch = latestReport(reports, 'code_diff');
  const changedFiles = asArray(diff.changed_files).map((entry) => clean(entry)).filter(Boolean);
  const maxChangedFiles = Number.isFinite(Number(targetConfig.max_changed_files)) ? Number(targetConfig.max_changed_files) : 40;
  const requireReview = targetConfig.require_review === true || Boolean(clean(targetConfig.review_command));
  const forbiddenPatterns = parseForbiddenPathPatterns(targetConfig.forbidden_path_patterns || process.env.SELF_IMPROVE_FORBIDDEN_PATHS);
  const forbiddenChangedFiles = changedFiles.filter((file) => isForbiddenChangedPath(file, forbiddenPatterns));

  const testStatus = reportStatus(latestTest) || clean(jobPayload.last_test_status);
  const canaryStatus = reportStatus(latestCanary) || clean(jobPayload.last_canary_status);
  const patchStatus = reportStatus(latestPatch) || clean(jobPayload.last_patch_status);
  const reviewPayload = nestedPayload(latestReview || {});
  const reviewRisk = reviewResult?.risk || inferReviewRisk({ stdout: reportText(latestReview || {}), payload: reviewPayload });
  const reviewStatus = reportStatus(latestReview) || (reviewResult ? clean(reviewResult.status) : '');

  const reasons = [];
  const warnings = [];
  if (patchStatus && !['applied', 'no_changes'].includes(patchStatus)) reasons.push(`patch status is ${patchStatus}`);
  if (!testStatus) warnings.push('no test report was recorded');
  else if (testStatus !== 'passed') reasons.push(`test status is ${testStatus}`);
  if (!canaryStatus) warnings.push('no canary report was recorded');
  else if (canaryStatus !== 'passed' && canaryStatus !== 'skipped') reasons.push(`canary status is ${canaryStatus}`);
  else if (canaryStatus === 'skipped') warnings.push('canary was skipped');
  if (forbiddenChangedFiles.length) reasons.push(`forbidden paths changed: ${forbiddenChangedFiles.slice(0, 6).join(', ')}`);
  if (changedFiles.length > maxChangedFiles) reasons.push(`changed file count ${changedFiles.length} exceeds limit ${maxChangedFiles}`);
  if (reviewRisk === 'high') reasons.push('review risk is high');
  if (requireReview && !reviewStatus) warnings.push('review is required but no review report was recorded');
  if (requireReview && reviewStatus && reviewStatus !== 'completed' && reviewStatus !== 'passed' && reviewStatus !== 'approved') warnings.push(`review status is ${reviewStatus}`);
  if (requireReview && (!reviewStatus || reviewRisk === 'unknown' || reviewRisk === 'medium')) warnings.push(`review risk is ${reviewRisk || 'unknown'}`);

  let status = 'passed';
  if (reasons.length) status = 'blocked';
  else if (warnings.length) status = 'needs_review';

  return {
    status,
    reasons,
    warnings,
    test_status: testStatus || 'missing',
    canary_status: canaryStatus || 'missing',
    patch_status: patchStatus || 'missing',
    review_status: reviewStatus || 'missing',
    review_risk: reviewRisk || 'unknown',
    forbidden_paths_changed: forbiddenChangedFiles.length > 0,
    forbidden_changed_files: forbiddenChangedFiles,
    diff_size_ok: changedFiles.length <= maxChangedFiles,
    changed_file_count: changedFiles.length,
    max_changed_files: maxChangedFiles,
    require_review: requireReview,
  };
}

export function formatEvalGatePreview(gate = {}) {
  const row = asObject(gate);
  const lines = [
    `status: ${clean(row.status) || '-'}`,
    `test_status: ${clean(row.test_status) || '-'}`,
    `canary_status: ${clean(row.canary_status) || '-'}`,
    `review_status: ${clean(row.review_status) || '-'}`,
    `review_risk: ${clean(row.review_risk) || '-'}`,
    `changed_file_count: ${Number(row.changed_file_count || 0)} / ${Number(row.max_changed_files || 0)}`,
    `forbidden_paths_changed: ${row.forbidden_paths_changed === true ? 'yes' : 'no'}`,
  ];
  if (asArray(row.reasons).length) {
    lines.push('', 'blocking reasons:');
    for (const reason of asArray(row.reasons)) lines.push(`- ${reason}`);
  }
  if (asArray(row.warnings).length) {
    lines.push('', 'warnings:');
    for (const warning of asArray(row.warnings)) lines.push(`- ${warning}`);
  }
  return lines.join('\n');
}
