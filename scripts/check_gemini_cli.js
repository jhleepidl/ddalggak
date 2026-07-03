#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

function splitList(raw = '') {
  return String(raw || '').split(',').map((row) => row.trim()).filter(Boolean);
}

const timeoutMs = Math.max(1000, Number(argValue('--timeout-ms', '20000')) || 20000);
const prompt = String(argValue('--prompt', 'Reply with exactly: OK')).trim();
const approvalMode = String(argValue('--approval-mode', process.env.GEMINI_APPROVAL_MODE || 'default')).trim() || 'default';
const contextMode = String(argValue('--context-mode', process.env.GEMINI_CONTEXT_MODE || 'isolated')).trim().toLowerCase() || 'isolated';
const singleModel = String(argValue('--model', process.env.GEMINI_MODEL || '')).trim();
const modelsArg = String(argValue('--models', '')).trim();
const defaultPool = process.env.GEMINI_MODEL_POOL || 'gemini-2.5-flash,gemini-2.5-pro,gemini-3.1-pro-preview,gemini-3-flash-preview,auto';
const models = splitList(modelsArg || singleModel || defaultPool);

function classify(output = '') {
  if (/MODEL_CAPACITY_EXHAUSTED|No capacity available|RESOURCE_EXHAUSTED|\b429\b|capacity/i.test(output)) return 'capacity';
  if (/Requested entity was not found|ModelNotFoundError|\b404\b/i.test(output)) return 'model_not_found';
  if (/auth|credential|login|permission/i.test(output)) return 'auth_or_permission';
  if (/\[timeout\]|killed after|timed? out/i.test(output)) return 'timeout';
  return 'other';
}

function makeCwd() {
  if (contextMode === 'workspace') return process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddalggak-gemini-health-'));
  fs.mkdirSync(path.join(dir, '.gemini'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'GEMINI.md'), 'DdalGgak Gemini CLI health check. Use only the prompt.\n', 'utf8');
  fs.writeFileSync(path.join(dir, '.gemini', 'settings.json'), JSON.stringify({
    context: { includeDirectoryTree: false, discoveryMaxDirs: 1, loadMemoryFromIncludeDirectories: false },
    output: { format: 'json' },
  }, null, 2) + '\n', 'utf8');
  return dir;
}

function runCase({ model, mode }) {
  const cwd = makeCwd();
  const cleanModel = String(model || '').trim();
  const env = {
    ...process.env,
    GEMINI_FORCE_FILE_STORAGE: process.env.GEMINI_FORCE_FILE_STORAGE || 'true',
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE || 'true',
    GEMINI_DISABLE_DIRTREE: process.env.GEMINI_DISABLE_DIRTREE || '1',
    DDALGGAK_GEMINI_CONTEXT_MODE: contextMode,
    ...(cleanModel && cleanModel !== 'auto' ? { GEMINI_MODEL: cleanModel } : {}),
  };
  if (cleanModel === 'auto') delete env.GEMINI_MODEL;
  let args = ['--output-format', 'text', '--approval-mode', approvalMode];
  if (cleanModel && cleanModel !== 'auto') args.push('--model', cleanModel);
  let input;
  if (mode === 'stdin_pipe') {
    args = ['--prompt', '.', ...args];
    input = `${prompt}\n`;
  } else if (mode === 'prompt_flag') {
    args = ['--prompt', prompt, ...args];
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    const child = spawn('gemini', args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += stdoutDecoder.write(d); });
    child.stdout.on('end', () => { stdout += stdoutDecoder.end(); });
    child.stderr.on('data', (d) => { stderr += stderrDecoder.write(d); });
    child.stderr.on('end', () => { stderr += stderrDecoder.end(); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ model: cleanModel || 'auto', mode, ok: false, exitCode: -1, durationMs: Date.now() - startedAt, cwd, classification: 'spawn_error', stderrPreview: String(e?.message || e).slice(0, 800) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      resolve({
        model: cleanModel || 'auto',
        mode,
        ok: code === 0 && stdout.trim().length > 0,
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        cwd,
        classification: code === 0 && stdout.trim().length > 0 ? 'ok' : classify(combined),
        stdoutChars: stdout.length,
        stdoutPreview: stdout.trim().slice(0, 800),
        stderrPreview: stderr.trim().slice(0, 1200),
        env: {
          GEMINI_FORCE_FILE_STORAGE: env.GEMINI_FORCE_FILE_STORAGE,
          GEMINI_CLI_TRUST_WORKSPACE: env.GEMINI_CLI_TRUST_WORKSPACE,
          GEMINI_MODEL: env.GEMINI_MODEL || '(cli-auto)',
          contextMode,
        },
      });
    });
    if (typeof input === 'string') child.stdin.end(input);
    else child.stdin.end();
  });
}

const results = [];
for (const model of models) {
  const stdinResult = await runCase({ model, mode: 'stdin_pipe' });
  results.push(stdinResult);
  if (stdinResult.ok) continue;
  results.push(await runCase({ model, mode: 'prompt_flag' }));
}
const firstOk = results.find((row) => row.ok);
console.log(JSON.stringify({ ok: Boolean(firstOk), selected_model: firstOk?.model || null, context_mode: contextMode, results }, null, 2));
process.exit(firstOk ? 0 : 1);
