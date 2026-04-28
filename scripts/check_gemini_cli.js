#!/usr/bin/env node
import { spawn } from 'node:child_process';

function argValue(name, fallback = '') {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && idx + 1 < process.argv.length ? process.argv[idx + 1] : fallback;
}

const timeoutMs = Math.max(1000, Number(argValue('--timeout-ms', '20000')) || 20000);
const model = String(argValue('--model', process.env.GEMINI_MODEL || 'gemini-3-flash-preview')).trim();
const prompt = String(argValue('--prompt', 'Reply with exactly: OK')).trim();
const approvalMode = String(argValue('--approval-mode', process.env.GEMINI_APPROVAL_MODE || 'default')).trim() || 'default';

function runCase(mode) {
  const env = {
    ...process.env,
    GEMINI_FORCE_FILE_STORAGE: process.env.GEMINI_FORCE_FILE_STORAGE || 'true',
    GEMINI_CLI_TRUST_WORKSPACE: process.env.GEMINI_CLI_TRUST_WORKSPACE || 'true',
    GEMINI_MODEL: model || process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
  };
  let args = ['--output-format', 'text', '--approval-mode', approvalMode];
  let input;
  if (mode === 'stdin_pipe') {
    input = `${prompt}\n`;
  } else if (mode === 'prompt_flag') {
    args = ['--prompt', prompt, ...args];
  } else if (mode === 'positional') {
    args = [prompt, ...args];
  }

  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('gemini', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      try { child.kill('SIGKILL'); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ mode, ok: false, exitCode: -1, durationMs: Date.now() - startedAt, stdoutChars: stdout.length, stderrPreview: String(e?.message || e).slice(0, 500) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        mode,
        ok: code === 0 && stdout.trim().length > 0,
        exitCode: code ?? -1,
        durationMs: Date.now() - startedAt,
        stdoutChars: stdout.length,
        stdoutPreview: stdout.trim().slice(0, 500),
        stderrPreview: stderr.trim().slice(0, 500),
        env: {
          GEMINI_FORCE_FILE_STORAGE: env.GEMINI_FORCE_FILE_STORAGE,
          GEMINI_CLI_TRUST_WORKSPACE: env.GEMINI_CLI_TRUST_WORKSPACE,
          GEMINI_MODEL: env.GEMINI_MODEL,
        },
      });
    });
    if (typeof input === 'string') child.stdin.end(input);
    else child.stdin.end();
  });
}

const modes = ['stdin_pipe', 'prompt_flag', 'positional'];
const results = [];
for (const mode of modes) results.push(await runCase(mode));
console.log(JSON.stringify({ ok: results.some((r) => r.ok), results }, null, 2));
process.exit(results.some((r) => r.ok) ? 0 : 1);
