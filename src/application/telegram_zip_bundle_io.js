import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = Number.isFinite(Number(process.env.DDALGGAK_BUNDLE_CREATION_TIMEOUT_MS))
  ? Math.max(5_000, Math.floor(Number(process.env.DDALGGAK_BUNDLE_CREATION_TIMEOUT_MS)))
  : 120_000;

function clean(value = '') {
  return String(value || '').trim();
}

function pathEntries() {
  return clean(process.env.PATH)
    .split(path.delimiter)
    .map((entry) => clean(entry))
    .filter(Boolean);
}

function candidateNames() {
  const base = ['python3', 'python'];
  if (process.platform !== 'win32') return base;
  const exts = clean(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((entry) => clean(entry).toLowerCase())
    .filter(Boolean);
  const out = [];
  for (const name of base) {
    out.push(name);
    for (const ext of exts) out.push(`${name}${ext}`);
  }
  return out;
}

function isExecutableFile(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolvePythonBundleCandidates() {
  const seen = new Set();
  const out = [];
  const push = (value) => {
    const entry = clean(value);
    if (!entry) return;
    const key = process.platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(entry);
  };

  push(process.env.DDALGGAK_PYTHON_BIN);
  push(process.env.PYTHON_BIN);
  push(process.env.PYTHON);

  const names = candidateNames();
  for (const entry of pathEntries()) {
    for (const name of names) {
      const target = path.join(entry, name);
      if (isExecutableFile(target)) push(target);
    }
  }

  for (const name of names) push(name);
  return out;
}

function buildBundleFileName(jobId, entries = []) {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const rootName = String(entries?.[0]?.arc || 'bundle').split('/').filter(Boolean).pop() || 'bundle';
  const stem = rootName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 48) || 'bundle';
  return `artifact_bundle_${stem}_${stamp}.zip`;
}

async function runPythonBundleCreation(pythonBin, bundlePath, entries, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const payload = JSON.stringify(entries.map((entry) => ({ src: entry.src, arc: entry.arc })));
  const script = 'import json,sys,zipfile; out=sys.argv[1]; entries=json.loads(sys.argv[2]); z=zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED); [z.write(e["src"], e["arc"]) for e in entries]; z.close()';
  await new Promise((resolve, reject) => {
    const child = spawn(pythonBin, ['-c', script, bundlePath, payload], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      child.kill('SIGKILL');
      reject(new Error(`bundle creation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 10 * 1024 * 1024) stdout += String(chunk || '');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < 10 * 1024 * 1024) stderr += String(chunk || '');
    });
    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (Number(code || 0) === 0) {
        resolve();
        return;
      }
      const details = String(stderr || stdout || '').trim();
      reject(new Error(`bundle creation failed${details ? `: ${details}` : ''}`));
    });
  });
}

async function createZipBundle(jobId, entries, { bundleDir = path.join(os.tmpdir(), 'ddalggak-telegram-bundles'), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const rows = Array.isArray(entries) ? entries.filter((entry) => entry?.src && entry?.arc) : [];
  if (rows.length === 0) throw new Error('bundle selection is empty');
  fs.mkdirSync(bundleDir, { recursive: true });
  const bundlePath = path.join(bundleDir, buildBundleFileName(jobId, rows));
  const candidates = resolvePythonBundleCandidates();
  if (candidates.length === 0) throw new Error('python runtime not found for zip bundle creation');
  let lastError = null;
  for (const candidate of candidates) {
    try {
      await runPythonBundleCreation(candidate, bundlePath, rows, { timeoutMs });
      const stat = fs.statSync(bundlePath);
      return {
        bundlePath,
        fileName: path.basename(bundlePath),
        size: Number(stat.size || 0),
        entries: rows,
        runtime: candidate,
      };
    } catch (error) {
      lastError = error;
      try { fs.rmSync(bundlePath, { force: true }); } catch {}
    }
  }
  throw lastError || new Error('python runtime not found for zip bundle creation');
}

export {
  DEFAULT_TIMEOUT_MS,
  buildBundleFileName,
  resolvePythonBundleCandidates,
  runPythonBundleCreation,
  createZipBundle,
};
