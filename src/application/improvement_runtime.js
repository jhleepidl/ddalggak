import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

function clean(value = '') {
  return String(value || '').trim();
}

function clip(value = '', max = 4000) {
  const raw = clean(value);
  if (!raw) return '';
  return raw.length > max ? `${raw.slice(0, Math.max(0, max - 1))}…` : raw;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function parseCommandList(value = '', fallback = []) {
  const raw = clean(value);
  if (!raw) return [...fallback];
  return raw
    .split(';;')
    .map((entry) => clean(entry))
    .filter(Boolean);
}

function parseBooleanLike(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parsePositiveInteger(value, fallback = 300000, { min = 1000, max = 1800000 } = {}) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(num)));
}

function envFirst(keys = [], fallback = '') {
  for (const key of keys) {
    const value = clean(process.env[key]);
    if (value) return value;
  }
  return clean(fallback);
}

function envKeyList(target, suffix) {
  const upper = clean(target).toUpperCase();
  return [
    `SELF_IMPROVE_${upper}_${suffix}`,
    `DDALGGAK_SELF_IMPROVE_${upper}_${suffix}`,
    `${upper}_${suffix}`,
  ];
}

function exists(p = '') {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function ensureDir(p = '') {
  if (!clean(p)) return;
  fs.mkdirSync(p, { recursive: true });
}

function safeSegment(value = '') {
  const raw = clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return raw || 'item';
}

function writeTextFile(filePath = '', content = '') {
  const cleanPath = clean(filePath);
  if (!cleanPath) return;
  ensureDir(path.dirname(cleanPath));
  fs.writeFileSync(cleanPath, String(content || ''), 'utf8');
}

function writeJsonFile(filePath = '', payload = {}) {
  writeTextFile(filePath, JSON.stringify(payload, null, 2));
}

function defaultTestCommands(target = '') {
  const key = clean(target).toLowerCase();
  if (key === 'ddalggak') {
    return [
      'node --check src/goc_client.js',
      'node --test test/goc_raw_history_sync.test.js test/goc_board_candidate_client.test.js test/improvement_runtime.test.js test/improvement_orchestrator.test.js',
    ];
  }
  if (key === 'goc') {
    return [
      'python -m py_compile backend/app/main.py backend/app/routers/boards.py backend/app/routers/improvement_jobs.py backend/app/services/improvement_jobs.py',
      'cd backend && python -m unittest tests.test_board_history_logic tests.test_improvement_job_logic',
    ];
  }
  return [];
}

function defaultCanaryCommands(target = '') {
  const key = clean(target).toLowerCase();
  if (key === 'ddalggak') {
    return [];
  }
  if (key === 'goc') {
    return [
      'python -m py_compile backend/app/services/improvement_jobs.py backend/app/routers/boards.py',
    ];
  }
  return [];
}

export function resolveImprovementTargetConfig(target = '', overrides = {}) {
  const cleanTarget = clean(target).toLowerCase();
  const workspaceRoot = clean(overrides.workspaceRoot)
    || envFirst(envKeyList(cleanTarget, 'WORKSPACE'));
  const targetRuntime = clean(overrides.targetRuntime)
    || envFirst(envKeyList(cleanTarget, 'RUNTIME'), 'forge')
    || 'forge';
  const testCommands = parseCommandList(
    clean(overrides.testCommands) || envFirst(envKeyList(cleanTarget, 'TEST_CMD')),
    defaultTestCommands(cleanTarget),
  );
  const canaryCommands = parseCommandList(
    clean(overrides.canaryCommands) || envFirst(envKeyList(cleanTarget, 'CANARY_CMD')),
    defaultCanaryCommands(cleanTarget),
  );
  const restartCommand = clean(overrides.restartCommand) || envFirst(envKeyList(cleanTarget, 'RESTART_CMD'));
  const promoteCommand = clean(overrides.promoteCommand)
    || envFirst(envKeyList(cleanTarget, 'PROMOTE_CMD'))
    || restartCommand;
  const patchCommand = clean(overrides.patchCommand) || envFirst(envKeyList(cleanTarget, 'PATCH_CMD'));
  const autoPromote = typeof overrides.autoPromote === 'boolean'
    ? overrides.autoPromote
    : parseBooleanLike(envFirst(envKeyList(cleanTarget, 'AUTO_PROMOTE')), false);
  const patchTimeoutMs = parsePositiveInteger(
    clean(overrides.patchTimeoutMs) || envFirst(envKeyList(cleanTarget, 'PATCH_TIMEOUT_MS')),
    600000,
    { min: 5000, max: 3600000 },
  );
  const inspectPaths = parseCommandList(
    clean(overrides.inspectPaths) || envFirst(envKeyList(cleanTarget, 'INSPECT_PATHS')),
    cleanTarget === 'ddalggak'
      ? ['src/adapters/telegram/commands.js', 'src/goc_client.js', 'src/application/improvement_orchestrator.js', 'package.json']
      : ['backend/app/main.py', 'backend/app/routers/boards.py', 'backend/app/services/improvement_jobs.py', 'frontend/src/components/BoardPanel.tsx'],
  );
  return {
    target: cleanTarget,
    workspace_root: workspaceRoot,
    target_runtime: targetRuntime,
    test_commands: testCommands,
    canary_commands: canaryCommands,
    restart_command: restartCommand,
    promote_command: promoteCommand,
    patch_command: patchCommand,
    patch_timeout_ms: patchTimeoutMs,
    auto_promote: autoPromote === true,
    inspect_paths: inspectPaths,
  };
}

export function buildRepoSnapshot({ target = '', workspaceRoot = '', inspectPaths = [] } = {}) {
  const cleanTarget = clean(target).toLowerCase();
  const root = clean(workspaceRoot);
  const resolvedInspectPaths = asArray(inspectPaths).map((entry) => clean(entry)).filter(Boolean);
  const files = [];
  for (const relativePath of resolvedInspectPaths) {
    const absolutePath = root ? path.join(root, relativePath) : relativePath;
    const present = exists(absolutePath);
    const stat = present ? fs.statSync(absolutePath) : null;
    files.push({
      path: relativePath,
      exists: present,
      type: stat?.isDirectory?.() ? 'dir' : 'file',
      size: stat?.isFile?.() ? Number(stat.size || 0) : undefined,
      mtime: stat?.mtime ? stat.mtime.toISOString() : undefined,
    });
  }
  const packageJsonPath = root ? path.join(root, 'package.json') : 'package.json';
  const backendRequirementsPath = root ? path.join(root, 'backend', 'requirements.txt') : path.join('backend', 'requirements.txt');
  return {
    target: cleanTarget,
    workspace_root: root || null,
    workspace_exists: root ? exists(root) : false,
    git_dir_exists: root ? exists(path.join(root, '.git')) : false,
    package_json_exists: exists(packageJsonPath),
    backend_requirements_exists: exists(backendRequirementsPath),
    inspect_paths: files,
  };
}

export function formatRepoSnapshotPreview(snapshot = {}) {
  const row = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const lines = [
    `target: ${clean(row.target) || '-'}`,
    `workspace_root: ${clean(row.workspace_root) || '-'}`,
    `workspace_exists: ${row.workspace_exists === true ? 'yes' : 'no'}`,
    `git_dir_exists: ${row.git_dir_exists === true ? 'yes' : 'no'}`,
    `package_json_exists: ${row.package_json_exists === true ? 'yes' : 'no'}`,
    `backend_requirements_exists: ${row.backend_requirements_exists === true ? 'yes' : 'no'}`,
    'inspect_paths:',
  ];
  const inspect = asArray(row.inspect_paths);
  if (!inspect.length) {
    lines.push('- none');
  } else {
    for (const item of inspect) {
      lines.push(`- ${clean(item.path) || '-'} :: ${item.exists ? 'present' : 'missing'}${item.mtime ? ` @ ${item.mtime}` : ''}`);
    }
  }
  return lines.join('\n');
}

export async function runShellCommand(command = '', { cwd = '', timeoutMs = 300000, env = {} } = {}) {
  const cleanCommand = clean(command);
  if (!cleanCommand) {
    return {
      ok: false,
      command: cleanCommand,
      cwd: clean(cwd) || undefined,
      exit_code: null,
      signal: null,
      duration_ms: 0,
      stdout: '',
      stderr: 'empty command',
    };
  }
  const started = Date.now();
  return await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn('/bin/bash', ['-lc', cleanCommand], {
      cwd: clean(cwd) || undefined,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      stderr += `${stderr ? '\n' : ''}timeout after ${timeoutMs}ms`;
    }, Math.max(500, Number(timeoutMs || 300000)));
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        command: cleanCommand,
        cwd: clean(cwd) || undefined,
        exit_code: null,
        signal: null,
        duration_ms: Date.now() - started,
        stdout: clip(stdout, 12000),
        stderr: clip(`${stderr ? `${stderr}\n` : ''}${error?.message || String(error)}`, 12000),
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: Number(code) === 0,
        command: cleanCommand,
        cwd: clean(cwd) || undefined,
        exit_code: Number.isInteger(code) ? Number(code) : null,
        signal: clean(signal) || null,
        duration_ms: Date.now() - started,
        stdout: clip(stdout, 12000),
        stderr: clip(stderr, 12000),
      });
    });
  });
}

export async function runCommandSequence(commands = [], options = {}) {
  const list = asArray(commands).map((entry) => clean(entry)).filter(Boolean);
  if (!list.length) {
    return {
      ok: true,
      status: 'skipped',
      command_count: 0,
      results: [],
      duration_ms: 0,
      stdout: '',
      stderr: '',
    };
  }
  const started = Date.now();
  const results = [];
  for (const command of list) {
    const result = await runShellCommand(command, options);
    results.push(result);
    if (!result.ok) {
      return {
        ok: false,
        status: 'failed',
        command_count: list.length,
        results,
        duration_ms: Date.now() - started,
        stdout: clip(results.map((entry) => clean(entry.stdout)).filter(Boolean).join('\n\n'), 12000),
        stderr: clip(results.map((entry) => clean(entry.stderr)).filter(Boolean).join('\n\n'), 12000),
      };
    }
  }
  return {
    ok: true,
    status: 'passed',
    command_count: list.length,
    results,
    duration_ms: Date.now() - started,
    stdout: clip(results.map((entry) => clean(entry.stdout)).filter(Boolean).join('\n\n'), 12000),
    stderr: clip(results.map((entry) => clean(entry.stderr)).filter(Boolean).join('\n\n'), 12000),
  };
}

function normalizeReportRows(reports = []) {
  return asArray(reports).map((entry) => {
    const row = asObject(entry);
    const payload = asObject(row.payload);
    return {
      id: clean(row.id),
      resource_kind: clean(payload.resource_kind),
      phase: clean(payload.phase),
      status: clean(payload.status),
      summary: clip(payload.summary, 400),
      preview_text: clip(row.text || '', 4000),
      created_at: clean(row.created_at),
    };
  });
}

export function createImprovementContextBundle({
  workspaceRoot = '',
  jobId = '',
  target = '',
  instruction = '',
  jobPayload = {},
  reports = [],
  boardSummary = {},
} = {}) {
  const root = clean(workspaceRoot);
  if (!root) throw new Error('createImprovementContextBundle requires workspaceRoot');
  if (!exists(root)) throw new Error(`workspaceRoot does not exist: ${root}`);
  const safeJob = safeSegment(jobId || `job_${Date.now()}`);
  const bundleRoot = path.join(root, '.self_improve', 'jobs', safeJob);
  ensureDir(bundleRoot);

  const manifest = {
    job_id: clean(jobId) || safeJob,
    target: clean(target) || clean(jobPayload.improvement_target),
    workspace_root: root,
    instruction: clean(instruction) || clean(jobPayload.instruction),
    created_at: new Date().toISOString(),
    board_summary: asObject(boardSummary),
    job_payload: asObject(jobPayload),
    reports: normalizeReportRows(reports),
  };

  const manifestPath = path.join(bundleRoot, 'manifest.json');
  const instructionPath = path.join(bundleRoot, 'instruction.txt');
  const reportsPath = path.join(bundleRoot, 'reports.json');
  const patchPlanPath = path.join(bundleRoot, 'patch_plan.txt');
  const patchStdoutPath = path.join(bundleRoot, 'patch_stdout.txt');
  const patchStderrPath = path.join(bundleRoot, 'patch_stderr.txt');
  const diffStatPath = path.join(bundleRoot, 'diff_stat.txt');
  const diffPatchPath = path.join(bundleRoot, 'diff.patch');
  const debugDir = path.join(bundleRoot, 'debug');
  const llmTraceDir = path.join(bundleRoot, 'llm_traces');
  const llmTraceIndexPath = path.join(llmTraceDir, 'index.jsonl');

  writeJsonFile(manifestPath, manifest);
  writeTextFile(instructionPath, `${manifest.instruction || ''}\n`);
  writeJsonFile(reportsPath, manifest.reports);
  writeTextFile(patchPlanPath, '');
  writeTextFile(patchStdoutPath, '');
  writeTextFile(patchStderrPath, '');
  writeTextFile(diffStatPath, '');
  writeTextFile(diffPatchPath, '');
  ensureDir(debugDir);
  ensureDir(llmTraceDir);

  return {
    bundle_root: bundleRoot,
    manifest_path: manifestPath,
    instruction_path: instructionPath,
    reports_path: reportsPath,
    patch_plan_path: patchPlanPath,
    patch_stdout_path: patchStdoutPath,
    patch_stderr_path: patchStderrPath,
    diff_stat_path: diffStatPath,
    diff_patch_path: diffPatchPath,
    debug_dir: debugDir,
    llm_trace_dir: llmTraceDir,
    llm_trace_index_path: llmTraceIndexPath,
    manifest,
  };
}

async function readGitOutput(workspaceRoot = '', command = '') {
  const result = await runShellCommand(command, { cwd: workspaceRoot });
  return result.ok ? clean(result.stdout) : '';
}

export async function collectWorkspaceDiff({ workspaceRoot = '' } = {}) {
  const root = clean(workspaceRoot);
  if (!root) {
    return {
      ok: false,
      workspace_root: root,
      git_available: false,
      branch: '',
      head: '',
      status_text: '',
      diff_stat: '',
      diff_patch: '',
      changed_files: [],
      changed_file_count: 0,
    };
  }
  const gitProbe = await runShellCommand('git rev-parse --is-inside-work-tree', { cwd: root });
  if (!gitProbe.ok || clean(gitProbe.stdout).toLowerCase() !== 'true') {
    return {
      ok: false,
      workspace_root: root,
      git_available: false,
      branch: '',
      head: '',
      status_text: '',
      diff_stat: '',
      diff_patch: '',
      changed_files: [],
      changed_file_count: 0,
    };
  }
  const branch = await readGitOutput(root, 'git rev-parse --abbrev-ref HEAD');
  const head = await readGitOutput(root, 'git rev-parse HEAD');
  const statusText = await readGitOutput(root, 'git status --short');
  const diffStat = await readGitOutput(root, 'git diff --stat --no-ext-diff');
  const diffPatch = await readGitOutput(root, 'git diff --no-ext-diff --unified=1');
  const changedFiles = Array.from(new Set(
    statusText
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean),
  ));
  return {
    ok: true,
    workspace_root: root,
    git_available: true,
    branch,
    head,
    status_text: clip(statusText, 12000),
    diff_stat: clip(diffStat, 12000),
    diff_patch: clip(diffPatch, 12000),
    changed_files: changedFiles.slice(0, 256),
    changed_file_count: changedFiles.length,
  };
}

export function formatWorkspaceDiffPreview(diff = {}) {
  const row = asObject(diff);
  const lines = [
    `workspace_root: ${clean(row.workspace_root) || '-'}`,
    `git_available: ${row.git_available === true ? 'yes' : 'no'}`,
    `branch: ${clean(row.branch) || '-'}`,
    `head: ${clean(row.head) || '-'}`,
    `changed_file_count: ${Number(row.changed_file_count || 0)}`,
  ];
  const changedFiles = asArray(row.changed_files);
  if (changedFiles.length) {
    lines.push('changed_files:');
    for (const file of changedFiles.slice(0, 24)) lines.push(`- ${file}`);
  }
  if (clean(row.diff_stat)) {
    lines.push('', 'diff_stat:', clean(row.diff_stat));
  }
  return lines.join('\n');
}
