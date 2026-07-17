import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function cleanText(value = '') {
  return String(value ?? '').trim();
}

export function safeSegment(value = '', fallback = 'room') {
  const clean = cleanText(value).toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  return clean || fallback;
}

export function ensureDir(dir = '') {
  const resolved = path.resolve(cleanText(dir));
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

export function isPathInside(root = '', candidate = '') {
  const base = path.resolve(cleanText(root));
  const target = path.resolve(cleanText(candidate));
  if (target === base) return true;
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertPathInside(root = '', candidate = '', label = 'path') {
  if (!isPathInside(root, candidate)) {
    throw new Error(`${label} escapes allowed root: ${path.resolve(candidate)} not within ${path.resolve(root)}`);
  }
}

export function assertNoSymlinkComponents(candidate = '', { stopAt = '' } = {}) {
  const resolved = path.resolve(cleanText(candidate));
  const stop = stopAt ? path.resolve(cleanText(stopAt)) : path.parse(resolved).root;
  const relative = path.relative(stop, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`path is outside symlink validation root: ${resolved}`);
  }
  let current = stop;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error(`symbolic links are not allowed in Room execution paths: ${current}`);
  }
}

export function assertNoEscapingSymlinks(root = '', { maxEntries = 100000 } = {}) {
  const base = path.resolve(cleanText(root));
  let seen = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      seen += 1;
      if (seen > maxEntries) throw new Error(`Room workspace symlink scan exceeded ${maxEntries} entries`);
      const abs = path.join(dir, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        let resolved;
        try { resolved = fs.realpathSync(abs); }
        catch (error) { throw new Error(`Room workspace contains a broken symlink: ${abs} (${error.message})`); }
        if (!isPathInside(base, resolved)) throw new Error(`Room workspace symlink escapes canonical workspace: ${abs} -> ${resolved}`);
        continue;
      }
      if (stat.isDirectory()) walk(abs);
    }
  };
  walk(base);
  return { ok: true, entries_scanned: seen };
}


export function assertCanonicalDirectory(candidate = '', label = 'directory') {
  const resolved = path.resolve(cleanText(candidate));
  if (!fs.existsSync(resolved)) throw new Error(`${label} does not exist: ${resolved}`);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`${label} is not a directory: ${resolved}`);
  const real = fs.realpathSync(resolved);
  if (real !== resolved) throw new Error(`${label} contains a symbolic-link component: ${resolved} -> ${real}`);
  return resolved;
}

export function writeJsonAtomic(file = '', value = {}) {
  const target = path.resolve(cleanText(file));
  ensureDir(path.dirname(target));
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return target;
}

export function readJson(file = '', fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cleanText(file)), 'utf8'));
  } catch {
    return fallback;
  }
}

export function appendJsonl(file = '', value = {}) {
  const target = path.resolve(cleanText(file));
  ensureDir(path.dirname(target));
  fs.appendFileSync(target, `${JSON.stringify(value)}\n`, 'utf8');
  return target;
}

export function sha256(value = '') {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function directoryManifest(root = '', { ignored = [], maxEntries = 500000, maxHashBytes = 32 * 1024 * 1024 } = {}) {
  const base = path.resolve(cleanText(root));
  const ignoredSet = new Set(ignored.map((item) => cleanText(item)).filter(Boolean));
  const rows = [];
  let seen = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ignoredSet.has(entry.name)) continue;
      seen += 1;
      if (seen > maxEntries) throw new Error(`Room workspace manifest exceeded ${maxEntries} entries`);
      const abs = path.join(dir, entry.name);
      const rel = path.relative(base, abs).replaceAll(path.sep, '/');
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        rows.push({ path: rel, type: 'symlink', target: fs.readlinkSync(abs) });
      } else if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile()) {
        const bytes = Number(stat.size || 0);
        if (bytes <= maxHashBytes) {
          const data = fs.readFileSync(abs);
          rows.push({ path: rel, type: 'file', bytes, sha256: sha256(data) });
        } else {
          rows.push({ path: rel, type: 'file', bytes, mtime_ms: Math.trunc(stat.mtimeMs), sha256: null, hash_skipped: true });
        }
      }
    }
  };
  if (fs.existsSync(base)) walk(base);
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}

const SNAPSHOT_EXCLUDES = new Set([
  '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.pytest_cache', '.mypy_cache',
  '.next', '.venv', 'venv', '.cache', 'dist', 'build', 'target', 'coverage', 'runs', 'experiment_runs', 'local_memory',
]);

export function copyWorkspaceSnapshot(source = '', destination = '', { excludes = [] } = {}) {
  const src = path.resolve(cleanText(source));
  const dst = path.resolve(cleanText(destination));
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`Room workspace does not exist: ${src}`);
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(dst);
  const excluded = new Set([...SNAPSHOT_EXCLUDES, ...excludes.map((item) => cleanText(item)).filter(Boolean)]);
  fs.cpSync(src, dst, {
    recursive: true,
    force: true,
    errorOnExist: false,
    dereference: false,
    filter: (entry) => {
      const name = path.basename(entry);
      if (excluded.has(name)) return false;
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) return false;
      return true;
    },
  });
  return dst;
}
