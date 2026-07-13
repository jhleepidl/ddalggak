import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { runCodexExec } from '../codex.js';
import { runClaudeCliPrompt } from '../claude_cli.js';
import { runAntigravityPrompt } from '../antigravity.js';
import { probeProviderCapabilities } from './provider_capability_registry.js';

function clean(value = '') { return String(value ?? '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function nowIso() { return new Date().toISOString(); }
function safe(value = '') { return clean(value).replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'item'; }
function writeJson(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
function writeText(file, value) { ensureDir(path.dirname(file)); fs.writeFileSync(file, String(value ?? ''), 'utf8'); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function csvCell(value = '') { const text = String(value ?? ''); return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text; }

export function loadContinuityScenario(filePath) {
  const row = readJson(filePath);
  if (!clean(row.id)) throw new Error(`Continuity scenario missing id: ${filePath}`);
  if (!asArray(row.steps).length) throw new Error(`Continuity scenario missing steps: ${filePath}`);
  const ids = new Set();
  for (const step of row.steps) {
    const id = clean(step?.id);
    if (!id) throw new Error(`Continuity scenario step missing id: ${filePath}`);
    if (ids.has(id)) throw new Error(`Duplicate continuity scenario step id: ${id}`);
    ids.add(id);
    if (!clean(step?.action)) throw new Error(`Continuity scenario step missing action: ${id}`);
  }
  return { ...row, __file: path.resolve(filePath) };
}

export function loadContinuitySuite(filePath) {
  const row = readJson(filePath);
  const base = path.dirname(path.resolve(filePath));
  const files = asArray(row.scenarios).map((entry) => path.resolve(base, typeof entry === 'string' ? entry : entry.path));
  if (!files.length) throw new Error(`Continuity suite has no scenarios: ${filePath}`);
  return { ...row, __file: path.resolve(filePath), scenario_files: files };
}

export function createContinuityRunState({ scenario, outputRoot, track = 'ai_rooms', metadata = {} } = {}) {
  const runId = `${safe(scenario.id)}_${Date.now().toString(36)}`;
  const runDir = ensureDir(path.resolve(outputRoot || 'runs/continuity', runId));
  const state = {
    schema_version: 'ddalggak.continuity_run/v1',
    run_id: runId,
    scenario_id: scenario.id,
    scenario_title: clean(scenario.title) || scenario.id,
    scenario_file: scenario.__file || null,
    track: clean(track) || 'ai_rooms',
    status: 'planned',
    created_at: nowIso(),
    updated_at: nowIso(),
    current_step_index: 0,
    metadata: asObject(metadata),
    steps: asArray(scenario.steps).map((step) => ({
      id: step.id,
      action: step.action,
      title: clean(step.title) || step.id,
      status: 'pending',
      started_at: null,
      completed_at: null,
      observed_output: '',
      operator_note: '',
      command_result: null,
    })),
    manual_rubric: [],
    semantic_judgment: null,
    score: null,
  };
  writeJson(path.join(runDir, 'scenario.json'), scenario);
  writeJson(path.join(runDir, 'state.json'), state);
  writeText(path.join(runDir, 'RUNBOOK.md'), renderContinuityRunbook(scenario, state));
  writeScorecard(runDir, state);
  return { runDir, state };
}

export function renderContinuityRunbook(scenario = {}, state = {}) {
  const lines = [
    `# ${clean(scenario.title) || scenario.id}`,
    '',
    clean(scenario.description),
    '',
    `- scenario_id: ${scenario.id}`,
    `- track: ${state.track || 'ai_rooms'}`,
    `- run_id: ${state.run_id || '-'}`,
    '',
    '## Instructions',
    '',
    '각 step을 실제 Telegram staging Room에서 수행하고 봇 응답을 runner에 붙여넣으세요.',
    '응답 입력은 단독 줄 `::end`로 종료합니다. 민감정보는 붙여넣기 전에 제거하세요.',
    '',
    '## Steps',
    '',
  ].filter(Boolean);
  for (const [index, step] of asArray(scenario.steps).entries()) {
    lines.push(`### ${index + 1}. ${clean(step.title) || step.id}`);
    lines.push('');
    lines.push(`- action: \`${step.action}\``);
    if (clean(step.target)) lines.push(`- target: ${step.target}`);
    if (clean(step.text)) lines.push('', '```text', step.text, '```');
    if (clean(step.instruction)) lines.push('', step.instruction);
    if (asArray(step.observe).length) lines.push('', '확인:', ...step.observe.map((item) => `- ${item}`));
    lines.push('');
  }
  if (asArray(scenario.rubric).length) {
    lines.push('## Rubric', '');
    for (const item of scenario.rubric) lines.push(`- ${item.id}: ${item.label || item.id}`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

async function captureMultiline(rl, prompt = '') {
  if (prompt) output.write(`${prompt}\n`);
  output.write('붙여넣기를 마치려면 단독 줄 ::end 를 입력하세요. 비워두려면 바로 ::end.\n');
  const lines = [];
  while (true) {
    const line = await rl.question('> ');
    if (line === '::end') break;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

async function runOptionalCommand(command = '', { cwd = process.cwd(), env = process.env } = {}) {
  const text = clean(command);
  if (!text) return null;
  const { spawn } = await import('node:child_process');
  return await new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-lc', text], { cwd, env: { ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code, signal) => resolve({ ok: code === 0, exit_code: code, signal, stdout, stderr }));
    child.on('error', (error) => resolve({ ok: false, exit_code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim() }));
  });
}

function commandForStep(step = {}, options = {}) {
  const action = clean(step.action);
  if (action === 'restart_service') return clean(options.restartCommand || process.env.CONTINUITY_RESTART_COMMAND);
  if (action === 'switch_model') {
    const template = clean(options.switchModelCommand || process.env.CONTINUITY_SWITCH_MODEL_COMMAND);
    return template.replaceAll('{{provider}}', clean(step.provider)).replaceAll('{{model}}', clean(step.model));
  }
  if (action === 'replace_source') return clean(options.replaceSourceCommand || process.env.CONTINUITY_REPLACE_SOURCE_COMMAND);
  return '';
}

function stepInstruction(step = {}) {
  const action = clean(step.action);
  if (action === 'send_message' || action === 'inspect') return `Telegram에 다음을 전송하세요:\n\n${step.text || ''}`;
  if (action === 'restart_service') return clean(step.instruction) || 'ddalggak staging 서비스를 재시작하세요.';
  if (action === 'switch_model') return clean(step.instruction) || `Room 실행 모델을 ${step.provider || ''} ${step.model || ''}로 전환하세요.`;
  if (action === 'replace_source') return clean(step.instruction) || '새 source를 업로드하거나 source-of-truth를 교체하세요.';
  if (action === 'branch') return `Telegram에 다음 branch 명령을 전송하세요:\n\n${step.text || ''}`;
  return clean(step.instruction) || `Action ${action}을 수행하세요.`;
}

function updateState(runDir, state) {
  state.updated_at = nowIso();
  writeJson(path.join(runDir, 'state.json'), state);
  writeScorecard(runDir, state);
}

export async function runGuidedContinuityScenario({ scenario, runDir, state, options = {}, io = null } = {}) {
  const rl = io || readline.createInterface({ input, output });
  let ownsIo = !io;
  state.status = 'running';
  updateState(runDir, state);
  try {
    for (let index = Number(state.current_step_index || 0); index < scenario.steps.length; index += 1) {
      const spec = scenario.steps[index];
      const row = state.steps[index];
      row.status = 'running'; row.started_at = nowIso(); state.current_step_index = index;
      updateState(runDir, state);
      output.write(`\n=== ${index + 1}/${scenario.steps.length} ${row.title} ===\n${stepInstruction(spec)}\n`);
      const command = commandForStep(spec, options);
      if (command) {
        const answer = clean(await rl.question(`설정된 command를 실행할까요? [Y/n] `)).toLowerCase();
        if (!answer || answer === 'y' || answer === 'yes') row.command_result = await runOptionalCommand(command, { cwd: options.cwd || process.cwd() });
      }
      await rl.question('실제 단계 수행 후 Enter를 누르세요. ');
      row.observed_output = await captureMultiline(rl, '봇 응답 또는 관찰 결과를 붙여넣으세요.');
      row.operator_note = clean(await rl.question('짧은 메모(선택): '));
      row.status = 'completed'; row.completed_at = nowIso(); state.current_step_index = index + 1;
      updateState(runDir, state);
    }
    state.manual_rubric = [];
    output.write('\n=== Manual rubric ===\n');
    for (const item of asArray(scenario.rubric)) {
      const raw = clean(await rl.question(`${item.label || item.id} [p=pass/f=fail/u=unknown]: `)).toLowerCase();
      const result = raw.startsWith('p') ? 'pass' : raw.startsWith('f') ? 'fail' : 'unknown';
      const note = clean(await rl.question('근거/메모(선택): '));
      state.manual_rubric.push({ id: item.id, label: item.label || item.id, required: item.required !== false, result, note });
    }
    const required = state.manual_rubric.filter((item) => item.required !== false);
    const passed = required.filter((item) => item.result === 'pass').length;
    state.score = required.length ? passed / required.length : null;
    state.status = required.some((item) => item.result === 'fail') ? 'failed' : 'completed';
    state.completed_at = nowIso();
    updateState(runDir, state);
    return state;
  } finally {
    if (ownsIo) rl.close();
  }
}

function extractJson(text = '') {
  const raw = clean(text);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function buildJudgePrompt({ scenario, state }) {
  return [
    'Evaluate whether this Room continuity scenario succeeded.',
    'Use only the supplied transcript and rubric. Do not infer hidden state.',
    'Return JSON only with: passed(boolean), score(0..1), summary(string), rubric(array of {id,result,reason}), findings(array).',
    '',
    'SCENARIO', JSON.stringify({ id: scenario.id, title: scenario.title, description: scenario.description, rubric: scenario.rubric }, null, 2),
    '',
    'TRANSCRIPT', JSON.stringify(state.steps.map((step) => ({ id: step.id, action: step.action, observed_output: step.observed_output, operator_note: step.operator_note })), null, 2),
    '',
    'MANUAL RUBRIC', JSON.stringify(state.manual_rubric || [], null, 2),
  ].join('\n');
}

export async function judgeContinuityRun({ scenario, state, runDir, provider = 'claude', model = '', reasoningEffort = 'high', timeoutMs = 180000, executor = null } = {}) {
  const workspaceRoot = ensureDir(path.join(runDir, 'judge_workspace'));
  const prompt = buildJudgePrompt({ scenario, state });
  writeText(path.join(runDir, 'judge_prompt.txt'), prompt);
  let result;
  if (executor) result = await executor({ provider, model, reasoningEffort, prompt, workspaceRoot });
  else if (provider === 'codex') result = await runCodexExec({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `continuity_judge_${state.run_id}`, model, reasoningEffort, sandboxMode: 'workspace-write', approvalPolicy: 'never', timeoutMs, surface: 'continuity_judge' });
  else if (provider === 'antigravity') result = await runAntigravityPrompt({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `continuity_judge_${state.run_id}`, model, timeoutMs, surface: 'continuity_judge' });
  else result = await runClaudeCliPrompt({ workspaceRoot, cwd: workspaceRoot, prompt, jobId: `continuity_judge_${state.run_id}`, model, effort: reasoningEffort, timeoutMs, surface: 'continuity_judge' });
  const parsed = extractJson(result?.stdout || result?.text || result?.output || '');
  state.semantic_judgment = {
    provider, requested_model: clean(model) || null, reasoning_effort: clean(reasoningEffort) || null,
    ok: result?.ok === true, exit_code: result?.exitCode ?? result?.exit_code ?? null,
    result: parsed,
    raw_output_path: 'judge_output.txt', judged_at: nowIso(),
  };
  writeText(path.join(runDir, 'judge_output.txt'), result?.stdout || result?.text || result?.output || '');
  updateState(runDir, state);
  return state.semantic_judgment;
}

export function writeScorecard(runDir, state) {
  const headers = ['run_id','scenario_id','track','status','manual_score','judge_passed','judge_score','required_pass','required_fail','required_unknown'];
  const required = asArray(state.manual_rubric).filter((item) => item.required !== false);
  const judge = asObject(state.semantic_judgment?.result);
  const row = [
    state.run_id, state.scenario_id, state.track, state.status,
    state.score === null || state.score === undefined ? '' : state.score,
    typeof judge.passed === 'boolean' ? judge.passed : '',
    Number.isFinite(Number(judge.score)) ? Number(judge.score) : '',
    required.filter((item) => item.result === 'pass').length,
    required.filter((item) => item.result === 'fail').length,
    required.filter((item) => item.result === 'unknown').length,
  ];
  writeText(path.join(runDir, 'scorecard.csv'), `${headers.join(',')}\n${row.map(csvCell).join(',')}\n`);
}

export async function createContinuityTestPlan({ scenarioFiles = [], suiteFile = '', outputRoot = 'runs/continuity', track = 'ai_rooms', metadata = {}, probe = true } = {}) {
  let files = scenarioFiles.map((file) => path.resolve(file));
  if (suiteFile) files = loadContinuitySuite(suiteFile).scenario_files;
  if (!files.length) throw new Error('No continuity scenario files supplied');
  const providerRegistry = probe ? await probeProviderCapabilities() : null;
  const created = [];
  for (const file of files) {
    const scenario = loadContinuityScenario(file);
    const { runDir, state } = createContinuityRunState({ scenario, outputRoot, track, metadata: { ...metadata, provider_registry: providerRegistry } });
    created.push({ scenario, runDir, state });
  }
  return { schema_version: 'ddalggak.continuity_test_plan/v1', created_at: nowIso(), track, runs: created.map(({ scenario, runDir, state }) => ({ scenario_id: scenario.id, run_dir: runDir, run_id: state.run_id })) };
}

export function loadContinuityRun(runDir) {
  const resolved = path.resolve(runDir);
  return { runDir: resolved, scenario: readJson(path.join(resolved, 'scenario.json')), state: readJson(path.join(resolved, 'state.json')) };
}
