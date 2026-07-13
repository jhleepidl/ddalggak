import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runCommand } from '../proc.js';
import { runCodexExec } from '../codex.js';
import { runClaudeCliPrompt } from '../claude_cli.js';
import { runAntigravityPrompt } from '../antigravity.js';
import { buildHarnessPrompt, loadHarnessVariantRegistry, resolveHarnessVariant } from './harness_variant_registry.js';
import { normalizeProviderName, probeProviderCapability } from './provider_capability_registry.js';
import { syncHarnessEvaluationToGoc } from './live_scenario_goc_sync.js';
import { recordModelEvaluationObservation } from '../application/model_catalog_refresh.js';
import { recordRecipeEvaluationObservation } from './recipe_evidence_store.js';

function clean(value = '') { return String(value || '').trim(); }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'; }
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function appendJsonl(file, value) { ensureDir(path.dirname(file)); fs.appendFileSync(file, `${JSON.stringify(value)}\n`, 'utf8'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function globRegex(pattern = '') {
  const p = clean(pattern).replaceAll('\\', '/');
  let out = '^';
  for (let i = 0; i < p.length; i += 1) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === '*' && next === '*') { out += '.*'; i += 1; continue; }
    if (ch === '*') { out += '[^/]*'; continue; }
    if (ch === '?') { out += '[^/]'; continue; }
    out += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${out}$`);
}
function matchesAny(file, patterns = []) { return asArray(patterns).some((pattern) => globRegex(pattern).test(file.replaceAll('\\', '/'))); }

function walkFiles(root, { ignore = [] } = {}) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).replaceAll('\\', '/');
      if (matchesAny(rel, ignore) || matchesAny(`${rel}/`, ignore)) continue;
      if (entry.isDirectory()) visit(abs);
      else if (entry.isFile()) out.push(rel);
    }
  };
  visit(root);
  return out.sort();
}

function snapshotWorkspace(root, ignore = []) {
  const files = {};
  for (const rel of walkFiles(root, { ignore })) {
    const buf = fs.readFileSync(path.join(root, rel));
    files[rel] = { size: buf.length, sha256: sha256(buf) };
  }
  return files;
}

function diffSnapshots(before = {}, after = {}) {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed = [], created = [], deleted = [];
  for (const file of [...all].sort()) {
    if (!before[file]) created.push(file);
    else if (!after[file]) deleted.push(file);
    else if (before[file].sha256 !== after[file].sha256) changed.push(file);
  }
  return { changed, created, deleted, all_changed: [...created, ...changed, ...deleted].sort() };
}

export function loadLiveScenario(filePath) {
  const scenario = readJson(filePath);
  if (!clean(scenario.id)) throw new Error(`Scenario missing id: ${filePath}`);
  if (!clean(scenario.goal || scenario.prompt || scenario.user_prompt)) throw new Error(`Scenario missing goal/prompt: ${filePath}`);
  return { ...scenario, __file: path.resolve(filePath) };
}

export function normalizeScenarioMatrix(scenario = {}, overrides = {}) {
  const allRows = asArray(scenario.matrix).length ? asArray(scenario.matrix) : [asObject(scenario.execution)];
  const matrixIndex = Number.isInteger(overrides.matrixIndex) ? overrides.matrixIndex : null;
  const base = matrixIndex === null ? allRows : (allRows[matrixIndex] ? [allRows[matrixIndex]] : []);
  if (matrixIndex !== null && !base.length) throw new Error(`Scenario matrix index out of range: ${matrixIndex}`);
  const result = [];
  const explicitProvider = clean(overrides.provider);
  const explicitVariant = clean(overrides.variantId);
  for (const row of base) {
    const scenarioProvider = normalizeProviderName(row.provider || scenario.provider || 'codex');
    const provider = normalizeProviderName(explicitProvider || scenarioProvider);
    const repetitions = Math.max(1, Math.min(Number(overrides.repeat || row.repetitions || 1) || 1, 20));
    const inheritedVariant = clean(row.harness_variant_id);
    // A scenario may carry a provider-specific default variant. When the caller
    // overrides the provider, do not silently keep the old provider's variant.
    // An explicitly supplied --variant is still validated strictly by the registry.
    const harnessVariantId = explicitVariant || (explicitProvider && provider !== scenarioProvider ? '' : inheritedVariant);
    for (let rep = 1; rep <= repetitions; rep += 1) {
      result.push({
        provider,
        model: clean(overrides.model || row.model),
        reasoning_effort: clean(overrides.reasoningEffort || row.reasoning_effort),
        harness_variant_id: harnessVariantId,
        role: clean(row.role || scenario.role || 'code_executor'),
        timeout_ms: Number(row.timeout_ms || scenario.timeout_ms || 0) || 0,
        repetition: rep,
      });
    }
  }
  return result;
}

function copyFixture(scenario, workspaceRoot) {
  const fixture = asObject(scenario.fixture);
  const scenarioDir = path.dirname(scenario.__file || process.cwd());
  const source = clean(fixture.path) ? path.resolve(scenarioDir, fixture.path) : '';
  ensureDir(workspaceRoot);
  if (source) {
    if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`Fixture directory not found: ${source}`);
    fs.cpSync(source, workspaceRoot, { recursive: true, force: true });
  }
  for (const [rel, content] of Object.entries(asObject(fixture.files))) {
    const target = path.resolve(workspaceRoot, rel);
    const relative = path.relative(workspaceRoot, target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Fixture file escapes workspace: ${rel}`);
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
  }
}

async function executeProvider({ provider, workspaceRoot, prompt, jobId, variant, capabilityProfile, timeoutMs, providerExecutor = null }) {
  if (providerExecutor) return await providerExecutor({ provider, workspaceRoot, prompt, jobId, variant, capabilityProfile, timeoutMs });
  const traceMetadata = {
    evaluation_run: true,
    harness_variant_id: variant.id,
    harness_variant_hash: variant.variant_hash,
    reasoning_effort: variant.reasoning_effort,
    cli_version: capabilityProfile.cli_version,
    capability_fingerprint: [capabilityProfile.provider, capabilityProfile.cli_version, variant.model, variant.reasoning_effort].join('|'),
    native_delegation: variant.native_delegation,
  };
  if (provider === 'codex') {
    return await runCodexExec({
      workspaceRoot, cwd: workspaceRoot, prompt, jobId,
      model: variant.model,
      reasoningEffort: variant.reasoning_effort,
      configOverrides: asObject(variant.provider_runtime).config_overrides || {},
      sandboxMode: asObject(variant.provider_runtime).sandbox_mode || 'workspace-write',
      approvalPolicy: asObject(variant.provider_runtime).approval_policy || 'never',
      timeoutMs,
      surface: 'live_scenario_lab', traceMetadata,
    });
  }
  if (provider === 'claude') {
    return await runClaudeCliPrompt({
      workspaceRoot, cwd: workspaceRoot, prompt, jobId,
      model: variant.model,
      effort: asObject(variant.provider_runtime).effort || variant.reasoning_effort,
      timeoutMs,
      surface: 'live_scenario_lab', traceMetadata,
    });
  }
  if (provider === 'antigravity') {
    return await runAntigravityPrompt({
      workspaceRoot, cwd: workspaceRoot, prompt, jobId,
      model: variant.model,
      timeoutMs,
      surface: 'live_scenario_lab', traceMetadata,
    });
  }
  throw new Error(`Unsupported live scenario provider: ${provider}`);
}

async function runExpectationCommands({ workspaceRoot, commands = [], commandRunner = runCommand }) {
  const rows = [];
  for (const spec of asArray(commands)) {
    const row = typeof spec === 'string' ? { command: spec } : asObject(spec);
    const command = clean(row.command);
    if (!command) continue;
    const cwd = path.resolve(workspaceRoot, clean(row.cwd) || '.');
    const rel = path.relative(workspaceRoot, cwd);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Expectation command cwd escapes workspace: ${row.cwd}`);
    const result = await commandRunner(command, asArray(row.args).map((x) => String(x)), {
      cwd,
      timeoutMs: Number(row.timeout_ms || 120000),
      env: asObject(row.env),
    });
    rows.push({ command, args: asArray(row.args), cwd: rel || '.', required: row.required !== false, result });
  }
  return rows;
}

function check(condition, name, detail = {}) { return { name, passed: Boolean(condition), ...detail }; }

function evaluateDeterministic({ scenario, providerResult, diff, commandResults, workspaceRoot, durationMs }) {
  const exp = asObject(scenario.expectations);
  const files = asObject(exp.files);
  const checks = [];
  if (exp.provider_ok !== false) checks.push(check(providerResult?.ok === true, 'provider_ok', { actual: providerResult?.ok === true }));
  for (const rel of asArray(files.must_exist)) checks.push(check(fs.existsSync(path.join(workspaceRoot, rel)), `file_exists:${rel}`));
  for (const rel of asArray(files.must_not_exist)) checks.push(check(!fs.existsSync(path.join(workspaceRoot, rel)), `file_absent:${rel}`));
  if (files.patch_required === true) checks.push(check(diff.all_changed.length > 0, 'patch_required', { changed_count: diff.all_changed.length }));
  const forbidden = asArray(files.forbidden_changed);
  if (forbidden.length) {
    const violations = diff.all_changed.filter((file) => matchesAny(file, forbidden));
    checks.push(check(violations.length === 0, 'forbidden_changed', { violations }));
  }
  const allowed = asArray(files.allowed_changed);
  if (allowed.length) {
    const violations = diff.all_changed.filter((file) => !matchesAny(file, allowed));
    checks.push(check(violations.length === 0, 'allowed_changed', { violations }));
  }
  for (const row of commandResults) {
    if (row.required !== false) checks.push(check(row.result?.ok === true, `command:${row.command} ${asArray(row.args).join(' ')}`.trim(), { exit_code: row.result?.exitCode }));
  }
  const stdout = String(providerResult?.stdout || '');
  for (const needle of asArray(asObject(exp.stdout).includes)) checks.push(check(stdout.includes(String(needle)), `stdout_includes:${needle}`));
  for (const needle of asArray(asObject(exp.stdout).excludes)) checks.push(check(!stdout.includes(String(needle)), `stdout_excludes:${needle}`));
  if (Number(exp.max_duration_ms || 0) > 0) checks.push(check(durationMs <= Number(exp.max_duration_ms), 'max_duration_ms', { actual: durationMs, max: Number(exp.max_duration_ms) }));
  const passed = checks.every((row) => row.passed);
  return {
    schema_version: 'ddalggak.live_scenario_deterministic_evaluation/v1',
    passed,
    score: checks.length ? checks.filter((row) => row.passed).length / checks.length : (providerResult?.ok === true ? 1 : 0),
    checks,
  };
}


function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  const candidates = [raw];
  for (const match of raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(String(match[1] || '').trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

function buildSemanticJudgePrompt({ scenario, deterministic, diff, commandResults, providerResult, rubric = [] }) {
  const evidence = {
    scenario_id: scenario.id,
    goal: scenario.goal || scenario.prompt || scenario.user_prompt,
    acceptance_criteria: asArray(scenario.acceptance_criteria),
    changed_paths: diff.all_changed,
    deterministic_evaluation: deterministic,
    command_results: commandResults.map((row) => ({
      command: row.command,
      args: row.args,
      ok: row.result?.ok === true,
      exit_code: row.result?.exitCode ?? null,
      stdout_tail: String(row.result?.stdout || '').slice(-4000),
      stderr_tail: String(row.result?.stderr || '').slice(-4000),
    })),
    executor_completion: String(providerResult?.stdout || '').slice(-6000),
  };
  return [
    'Independently evaluate whether the execution satisfied the user goal and acceptance criteria.',
    'Do not modify files. Judge only from the supplied evidence. Be conservative when evidence is insufficient.',
    asArray(rubric).length ? `Additional rubric:\n${asArray(rubric).map((item) => `- ${clean(item)}`).join('\n')}` : '',
    'Return ONLY one JSON object with this exact shape:',
    '{"passed":true,"score":0.0,"summary":"short reason","findings":[{"severity":"low|medium|high","summary":"..."}]}',
    'score must be between 0 and 1.',
    `Evidence:\n${JSON.stringify(evidence, null, 2)}`,
  ].filter(Boolean).join('\n\n');
}

async function runSemanticJudge({ scenario, runDir, registry, capabilityCache, capabilityProbe, providerExecutor, deterministic, diff, commandResults, providerResult }) {
  const config = asObject(asObject(scenario.evaluation).semantic_judge || scenario.semantic_judge);
  if (config.enabled === false || (!Object.keys(config).length && config.enabled !== true)) return null;
  const provider = normalizeProviderName(config.provider || 'claude');
  const role = clean(config.role || 'reviewer');
  const variant = resolveHarnessVariant({
    registry,
    variantId: clean(config.harness_variant_id),
    provider,
    role,
    model: clean(config.model),
    reasoningEffort: clean(config.reasoning_effort),
  });
  const capabilityKey = `judge|${variant.provider}|${variant.model}|${variant.reasoning_effort}`;
  let capabilityProfile = capabilityCache.get(capabilityKey);
  if (!capabilityProfile) {
    capabilityProfile = await capabilityProbe({ provider: variant.provider, model: variant.model, reasoningEffort: variant.reasoning_effort });
    capabilityCache.set(capabilityKey, capabilityProfile);
  }
  const judgeWorkspace = ensureDir(path.join(runDir, 'judge_workspace'));
  const prompt = buildSemanticJudgePrompt({ scenario, deterministic, diff, commandResults, providerResult, rubric: config.rubric });
  fs.writeFileSync(path.join(runDir, 'semantic_judge_prompt.txt'), prompt, 'utf8');
  if (capabilityProfile.cli_available === false && !providerExecutor) {
    return { schema_version: 'ddalggak.live_scenario_semantic_evaluation/v1', status: 'unavailable', required: config.required === true, passed: false, score: 0, provider: variant.provider, model: variant.model || null, reasoning_effort: variant.reasoning_effort, cli_version: capabilityProfile.cli_version || null, error: `Judge CLI unavailable: ${variant.provider}` };
  }
  const result = await executeProvider({
    provider: variant.provider,
    workspaceRoot: judgeWorkspace,
    prompt,
    jobId: `judge_${safe(scenario.id)}`,
    variant,
    capabilityProfile,
    timeoutMs: Number(config.timeout_ms || 300000),
    providerExecutor,
  });
  const parsed = extractJsonObject(result?.stdout || '');
  const score = Math.max(0, Math.min(Number(parsed?.score ?? (parsed?.passed === true ? 1 : 0)), 1));
  const evaluation = {
    schema_version: 'ddalggak.live_scenario_semantic_evaluation/v1',
    status: result?.ok === true && parsed ? 'completed' : 'invalid_or_failed',
    required: config.required === true,
    passed: result?.ok === true && parsed?.passed === true,
    score,
    summary: clean(parsed?.summary),
    findings: asArray(parsed?.findings),
    provider: variant.provider,
    model: result?.used_model || variant.model || null,
    reasoning_effort: variant.reasoning_effort,
    cli_version: capabilityProfile.cli_version || null,
    harness_variant_id: variant.id,
    harness_variant_hash: variant.variant_hash,
    raw_parse_ok: Boolean(parsed),
    executor_ok: result?.ok === true,
  };
  writeJson(path.join(runDir, 'semantic_judge_result.json'), evaluation);
  return evaluation;
}

function buildRuntimeSignature(run = {}) {
  return [
    clean(run.harness_variant_id) || 'unknown-variant',
    clean(run.provider) || 'unknown-provider',
    clean(run.model) || 'provider-default',
    clean(run.reasoning_effort) || 'provider-default',
    clean(run.cli_version) || 'unknown-cli',
  ].join('|');
}

function aggregateResults(evaluationId, scenarioRuns, { suite = 'live', startedAt, finishedAt }) {
  const variants = new Map();
  for (const run of scenarioRuns) {
    const key = buildRuntimeSignature(run);
    const current = variants.get(key) || {
      runtime_signature: key,
      harness_variant_id: run.harness_variant_id,
      harness_variant_hash: run.harness_variant_hash,
      provider: run.provider,
      requested_model: run.requested_model || null,
      resolved_model: run.resolved_model || null,
      model: run.model || null,
      reasoning_effort: run.reasoning_effort || null,
      cli_version: run.cli_version || null,
      run_count: 0,
      passed_run_count: 0,
      failed_run_count: 0,
      total_score: 0,
      total_duration_ms: 0,
    };
    current.run_count += 1;
    if (run.passed) current.passed_run_count += 1; else current.failed_run_count += 1;
    current.total_score += Number(run.score || 0);
    current.total_duration_ms += Number(run.duration_ms || 0);
    variants.set(key, current);
  }
  const variantResults = [...variants.values()].map((row) => ({
    ...row,
    success_rate: row.run_count ? row.passed_run_count / row.run_count : 0,
    average_score: row.run_count ? row.total_score / row.run_count : 0,
    average_duration_ms: row.run_count ? row.total_duration_ms / row.run_count : 0,
  })).sort((a, b) => b.success_rate - a.success_rate || b.average_score - a.average_score || a.average_duration_ms - b.average_duration_ms);
  const recommended = variantResults[0] || null;
  return {
    schema_version: 'ddalggak.harness_evaluation_summary/v1',
    evaluation_id: evaluationId,
    suite,
    status: scenarioRuns.every((run) => run.passed) ? 'passed' : 'completed_with_failures',
    started_at: startedAt,
    finished_at: finishedAt,
    scenario_count: new Set(scenarioRuns.map((run) => run.scenario_id)).size,
    total_run_count: scenarioRuns.length,
    passed_run_count: scenarioRuns.filter((run) => run.passed).length,
    failed_run_count: scenarioRuns.filter((run) => !run.passed).length,
    variant_results: variantResults,
    recommendation: recommended ? {
      kind: 'evaluation_only_no_auto_promotion',
      runtime_signature: recommended.runtime_signature,
      harness_variant_id: recommended.harness_variant_id,
      reason: 'highest success rate, then score, then lower duration for this exact model/reasoning/CLI runtime signature',
    } : null,
    runs: scenarioRuns,
  };
}

export async function runLiveScenarioSuite({
  scenarioFiles = [], scenarioDir = '', outputDir = '', registryPath = '', provider = '', model = '', reasoningEffort = '', variantId = '', repeat = 0, matrixIndex = null,
  dryRun = false, keepWorkspaces = true, syncToGoc = false, providerExecutor = null, capabilityProbe = probeProviderCapability, commandRunner = runCommand,
} = {}) {
  let files = asArray(scenarioFiles).map((file) => path.resolve(file));
  if (clean(scenarioDir)) {
    files = files.concat(fs.readdirSync(path.resolve(scenarioDir)).filter((name) => name.endsWith('.json')).map((name) => path.join(path.resolve(scenarioDir), name)));
  }
  files = [...new Set(files)].sort();
  if (!files.length) throw new Error('No live scenario files provided');
  const scenarios = files.map(loadLiveScenario);
  const startedAt = nowIso();
  const evaluationId = `eval_${startedAt.replace(/[-:.TZ]/g, '').slice(0, 14)}_${crypto.randomBytes(3).toString('hex')}`;
  const root = ensureDir(path.resolve(outputDir || process.env.LIVE_SCENARIO_OUTPUT_DIR || path.join('runs', 'evaluations'), evaluationId));
  const workspacesRoot = ensureDir(path.join(root, 'workspaces'));
  const runsRoot = ensureDir(path.join(root, 'runs'));
  const registry = loadHarnessVariantRegistry({ registryPath, cwd: process.cwd() });
  const scenarioRuns = [];
  const capabilityCache = new Map();

  for (const scenario of scenarios) {
    const matrix = normalizeScenarioMatrix(scenario, { provider, model, reasoningEffort, variantId, repeat, matrixIndex });
    for (const cell of matrix) {
      const variant = resolveHarnessVariant({ registry, variantId: cell.harness_variant_id, provider: cell.provider, role: cell.role, model: cell.model, reasoningEffort: cell.reasoning_effort });
      const capabilityKey = `${variant.provider}|${variant.model}|${variant.reasoning_effort}`;
      let capabilityProfile = capabilityCache.get(capabilityKey);
      if (!capabilityProfile) {
        capabilityProfile = dryRun
          ? { schema_version: 'ddalggak.provider_capability_probe/v1', provider: variant.provider, model: variant.model || null, reasoning_effort: variant.reasoning_effort, cli_available: null, cli_version: 'dry-run', capabilities: {} }
          : await capabilityProbe({ provider: variant.provider, model: variant.model, reasoningEffort: variant.reasoning_effort });
        capabilityCache.set(capabilityKey, capabilityProfile);
      }
      const runId = `${safe(scenario.id)}__${safe(variant.id)}__r${cell.repetition}`;
      const runDir = ensureDir(path.join(runsRoot, runId));
      const workspaceRoot = ensureDir(path.join(workspacesRoot, runId));
      copyFixture(scenario, workspaceRoot);
      const ignore = asArray(asObject(scenario.fixture).ignore).length ? asArray(asObject(scenario.fixture).ignore) : ['.git/**', 'node_modules/**', 'runs/**'];
      const before = snapshotWorkspace(workspaceRoot, ignore);
      const built = buildHarnessPrompt({ scenario, variant, capabilityProfile, workspaceRoot });
      fs.writeFileSync(path.join(runDir, 'prompt.txt'), built.prompt, 'utf8');
      writeJson(path.join(runDir, 'scenario.json'), scenario);
      writeJson(path.join(runDir, 'capability.json'), capabilityProfile);
      writeJson(path.join(runDir, 'harness_variant.json'), variant);
      const callStarted = Date.now();
      let providerResult;
      if (dryRun) {
        providerResult = { ok: true, exitCode: 0, stdout: '[dry-run] provider execution skipped', stderr: '', durationMs: 0, used_model: variant.model || 'provider-default' };
      } else if (capabilityProfile.cli_available === false && !providerExecutor) {
        providerResult = { ok: false, exitCode: -1, stdout: '', stderr: `Provider CLI unavailable: ${variant.provider} (${capabilityProfile.cli_command || ''})`, durationMs: 0, used_model: variant.model || 'provider-default' };
      } else {
        providerResult = await executeProvider({ provider: variant.provider, workspaceRoot, prompt: built.prompt, jobId: evaluationId, variant, capabilityProfile, timeoutMs: cell.timeout_ms, providerExecutor });
      }
      const commandResults = dryRun ? [] : await runExpectationCommands({ workspaceRoot, commands: asObject(scenario.expectations).commands, commandRunner });
      const after = snapshotWorkspace(workspaceRoot, ignore);
      const diff = diffSnapshots(before, after);
      const durationMs = Date.now() - callStarted;
      const deterministic = dryRun
        ? { schema_version: 'ddalggak.live_scenario_deterministic_evaluation/v1', passed: true, score: 1, checks: [{ name: 'dry_run_execution_skipped', passed: true }] }
        : evaluateDeterministic({ scenario, providerResult, diff, commandResults, workspaceRoot, durationMs });
      const semantic = dryRun ? null : await runSemanticJudge({
        scenario, runDir, registry, capabilityCache, capabilityProbe, providerExecutor,
        deterministic, diff, commandResults, providerResult,
      });
      const semanticWeight = semantic?.status === 'completed' ? Math.max(0, Math.min(Number(asObject(asObject(scenario.evaluation).semantic_judge || scenario.semantic_judge).weight ?? 0.25), 1)) : 0;
      const combinedScore = semantic ? ((1 - semanticWeight) * deterministic.score + semanticWeight * semantic.score) : deterministic.score;
      const combinedPassed = deterministic.passed && (!semantic?.required || semantic.passed);
      const result = {
        schema_version: 'ddalggak.live_scenario_run_result/v1',
        evaluation_id: evaluationId,
        run_id: runId,
        scenario_id: scenario.id,
        scenario_title: clean(scenario.title),
        recipe_ids: asArray(scenario.recipe_ids).map((value) => clean(value)).filter(Boolean),
        harness_variant_id: variant.id,
        harness_variant_hash: variant.variant_hash,
        provider: variant.provider,
        requested_model: providerResult?.requested_model || variant.model || null,
        resolved_model: providerResult?.resolved_model || null,
        model: providerResult?.resolved_model || providerResult?.used_model || variant.model || 'provider-default-unresolved',
        reasoning_effort: variant.reasoning_effort,
        cli_version: capabilityProfile.cli_version || null,
        runtime_signature: buildRuntimeSignature({
          harness_variant_id: variant.id, provider: variant.provider, requested_model: providerResult?.requested_model || variant.model || null, resolved_model: providerResult?.resolved_model || null, model: providerResult?.resolved_model || providerResult?.used_model || variant.model || 'provider-default-unresolved',
          reasoning_effort: variant.reasoning_effort, cli_version: capabilityProfile.cli_version || null,
        }),
        native_delegation: variant.native_delegation,
        prompt_hash: built.prompt_hash,
        repetition: cell.repetition,
        dry_run: dryRun,
        passed: combinedPassed,
        score: combinedScore,
        duration_ms: durationMs,
        provider_result: {
          ok: providerResult?.ok === true,
          requested_model: providerResult?.requested_model || variant.model || null,
          resolved_model: providerResult?.resolved_model || null,
          model_resolution_source: providerResult?.model_resolution_source || null,
          exit_code: Number.isInteger(providerResult?.exitCode) ? providerResult.exitCode : null,
          stdout: String(providerResult?.stdout || ''),
          stderr: String(providerResult?.stderr || ''),
          duration_ms: Number(providerResult?.durationMs || 0),
          usage: asObject(providerResult?.usage),
          cost_usd: Number(providerResult?.cost_usd || 0),
          llm_trace_id: clean(providerResult?.llm_trace_id) || null,
        },
        workspace_diff: diff,
        deterministic_evaluation: deterministic,
        semantic_evaluation: semantic,
        command_results: commandResults.map((row) => ({ ...row, result: { ok: row.result?.ok === true, exitCode: row.result?.exitCode, stdout: row.result?.stdout, stderr: row.result?.stderr, durationMs: row.result?.durationMs } })),
        artifact_paths: { run_dir: runDir, workspace: keepWorkspaces ? workspaceRoot : null },
        completed_at: nowIso(),
      };
      writeJson(path.join(runDir, 'result.json'), result);
      if (!dryRun && result.recipe_ids.length > 0) {
        recordRecipeEvaluationObservation({ recipeIds: result.recipe_ids, result });
      }
      if (!dryRun && result.model && result.model !== 'provider-default-unresolved') {
        recordModelEvaluationObservation({
          provider: result.provider,
          model: result.model,
          passed: result.passed,
          score: result.score,
          evaluationId: result.evaluation_id,
          runId: result.run_id,
          runtimeSignature: result.runtime_signature,
        });
      }
      appendJsonl(path.join(root, 'results.jsonl'), result);
      scenarioRuns.push(result);
      if (!keepWorkspaces) fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
  }
  const finishedAt = nowIso();
  const summary = aggregateResults(evaluationId, scenarioRuns, { suite: clean(scenarios[0]?.suite) || 'live', startedAt, finishedAt });
  if (dryRun) summary.status = 'dry_run';
  writeJson(path.join(root, 'summary.json'), summary);
  writeJson(path.join(root, 'capabilities.json'), { schema_version: 'ddalggak.evaluation_capabilities/v1', items: [...capabilityCache.values()] });
  let gocSync = null;
  if (syncToGoc) {
    gocSync = await syncHarnessEvaluationToGoc(summary, { optional: true });
    writeJson(path.join(root, 'goc_sync.json'), gocSync);
  }
  return { ...summary, output_dir: root, goc_sync: gocSync };
}
