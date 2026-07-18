import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const COMMON_ENV_KEYS = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TERM',
  'TMPDIR', 'TEMP', 'TMP',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
]);

const PROVIDER_ENV_PREFIXES = {
  codex: ['OPENAI_', 'AZURE_OPENAI_'],
  antigravity: ['GOOGLE_', 'GEMINI_', 'AGY_'],
};

const PROVIDER_ENV_KEYS = {
  codex: new Set(['CODEX_HOME', 'CODEX_API_KEY']),
  antigravity: new Set(['ANTIGRAVITY_HOME', 'CLOUDSDK_CONFIG']),
};

export function isTruthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function isPathInsideOrEqual(root = '', candidate = '') {
  const base = path.resolve(String(root || '').trim() || process.cwd());
  const target = path.resolve(String(candidate || '').trim() || base);
  if (target === base) return true;
  const relative = path.relative(base, target);
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function splitEnvList(value = '') {
  return String(value || '')
    .split(/[,:\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function findExecutablePath(command = '', env = process.env) {
  const clean = String(command || '').trim();
  if (!clean) return '';
  if (clean.includes(path.sep)) {
    try { const candidate = path.resolve(clean); fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch { return ''; }
  }
  const searchPath = String(env.PATH || process.env.PATH || '');
  for (const dir of searchPath.split(path.delimiter).filter(Boolean)) {
    try { const candidate = path.resolve(dir, clean); fs.accessSync(candidate, fs.constants.X_OK); return fs.realpathSync(candidate); } catch {}
  }
  return '';
}

export function buildRoomProviderChildEnv(provider = '', runtimeEnv = process.env) {
  const providerId = String(provider || '').trim().toLowerCase();
  const extraKeys = new Set(splitEnvList(runtimeEnv.ROOM_PROVIDER_CHILD_ENV_ALLOWLIST || ''));
  const providerKeys = PROVIDER_ENV_KEYS[providerId] || new Set();
  const prefixes = PROVIDER_ENV_PREFIXES[providerId] || [];
  const out = {};
  for (const [key, value] of Object.entries(runtimeEnv || {})) {
    if (typeof value === 'undefined') continue;
    if (COMMON_ENV_KEYS.has(key) || providerKeys.has(key) || extraKeys.has(key) || prefixes.some((prefix) => key.startsWith(prefix))) {
      out[key] = String(value);
    }
  }
  out.PATH = out.PATH || process.env.PATH || '/usr/local/bin:/usr/bin:/bin';
  out.HOME = out.HOME || os.homedir();
  out.LANG = out.LANG || 'C.UTF-8';
  out.TZ = out.TZ || 'Asia/Seoul';
  out.CI = '1';
  out.NO_COLOR = '1';
  out.FORCE_COLOR = '0';
  out.TMPDIR = '/tmp';
  out.XDG_CACHE_HOME = '/tmp/.cache';
  out.npm_config_cache = '/tmp/npm-cache';
  out.PIP_CACHE_DIR = '/tmp/pip-cache';
  return out;
}

function writableProviderDirs(provider = '', env = process.env, controlRoot = '') {
  const home = path.resolve(String(env.HOME || os.homedir()).trim() || os.homedir());
  const candidates = [];
  if (String(provider).toLowerCase() === 'codex') {
    candidates.push(path.resolve(String(env.CODEX_HOME || path.join(home, '.codex')).trim()));
  } else if (String(provider).toLowerCase() === 'antigravity') {
    candidates.push(path.resolve(String(env.ANTIGRAVITY_HOME || path.join(home, '.gemini')).trim()));
  }
  for (const item of splitEnvList(env.ROOM_PROVIDER_BWRAP_WRITABLE_DIRS || '')) candidates.push(path.resolve(item));
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    if (controlRoot && isPathInsideOrEqual(controlRoot, candidate)) continue;
    try {
      if (fs.lstatSync(candidate).isDirectory()) unique.push(candidate);
    } catch {}
  }
  return unique;
}

export function prepareRoomProviderInvocation({
  provider = '',
  command = '',
  args = [],
  workspacePath = '',
  roomScoped = false,
  env = process.env,
} = {}) {
  const resolvedWorkspace = path.resolve(String(workspacePath || '').trim() || process.cwd());
  const controlRoot = path.resolve(String(env.DDALGGAK_CONTROL_ROOT || process.cwd()).trim() || process.cwd());
  const nestedInControl = isPathInsideOrEqual(controlRoot, resolvedWorkspace);
  const childEnv = roomScoped ? buildRoomProviderChildEnv(provider, env) : { ...env };
  if (roomScoped) childEnv.ROOM_WORKSPACE = nestedInControl ? '/workspace' : resolvedWorkspace;

  if (!roomScoped || !nestedInControl) {
    return {
      ok: true,
      command,
      args: [...args],
      cwd: resolvedWorkspace,
      childEnv,
      inheritEnv: !roomScoped,
      visibleWorkspacePath: resolvedWorkspace,
      nestedInControl,
      osSandbox: 'none',
      controlRoot,
    };
  }

  if (!isTruthy(env.ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT)) {
    return {
      ok: false,
      error: `Room workspace is inside the ddalggak control plane without ROOM_ALLOW_RUNTIME_INSIDE_CONTROL_ROOT=true: ${resolvedWorkspace}`,
      nestedInControl,
      controlRoot,
    };
  }

  const osSandbox = String(env.ROOM_PROVIDER_OS_SANDBOX || '').trim().toLowerCase();
  if (osSandbox !== 'bwrap') {
    return {
      ok: false,
      error: 'Nested Room workspaces require ROOM_PROVIDER_OS_SANDBOX=bwrap so the ddalggak parent tree is masked from provider processes.',
      nestedInControl,
      controlRoot,
    };
  }

  for (const arg of Array.isArray(args) ? args : []) {
    const value = String(arg || '').trim();
    if (!path.isAbsolute(value)) continue;
    const resolvedArg = path.resolve(value);
    if (isPathInsideOrEqual(controlRoot, resolvedArg) && resolvedArg !== resolvedWorkspace) {
      return {
        ok: false,
        error: `Provider CLI argument references the masked ddalggak control tree: ${resolvedArg}`,
        nestedInControl,
        controlRoot,
      };
    }
  }

  const providerExecutable = findExecutablePath(command, env);
  if (providerExecutable && isPathInsideOrEqual(controlRoot, providerExecutable)) {
    return {
      ok: false,
      error: `Provider CLI executable cannot live inside the masked ddalggak control tree: ${providerExecutable}`,
      nestedInControl,
      controlRoot,
    };
  }

  const bwrapCommand = String(env.ROOM_PROVIDER_BWRAP_COMMAND || 'bwrap').trim() || 'bwrap';
  if (!findExecutablePath(bwrapCommand, env) && !isTruthy(env.ROOM_PROVIDER_BWRAP_SKIP_EXECUTABLE_CHECK)) {
    return {
      ok: false,
      error: `bubblewrap executable is unavailable: ${bwrapCommand}`,
      nestedInControl,
      controlRoot,
    };
  }

  const visibleWorkspacePath = '/workspace';
  const bwrapArgs = [
    '--die-with-parent',
    '--new-session',
    '--unshare-pid',
    '--unshare-ipc',
    '--unshare-uts',
    '--ro-bind', '/', '/',
    '--dev-bind', '/dev', '/dev',
    '--proc', '/proc',
    '--tmpfs', '/tmp',
    '--dir', visibleWorkspacePath,
    '--bind', resolvedWorkspace, visibleWorkspacePath,
  ];
  for (const writableDir of writableProviderDirs(provider, env, controlRoot)) {
    bwrapArgs.push('--bind', writableDir, writableDir);
  }
  bwrapArgs.push(
    '--tmpfs', controlRoot,
    '--chdir', visibleWorkspacePath,
    '--setenv', 'PWD', visibleWorkspacePath,
    '--setenv', 'ROOM_WORKSPACE', visibleWorkspacePath,
    '--', command, ...args,
  );

  return {
    ok: true,
    command: bwrapCommand,
    args: bwrapArgs,
    cwd: resolvedWorkspace,
    childEnv,
    inheritEnv: false,
    visibleWorkspacePath,
    nestedInControl,
    osSandbox: 'bwrap',
    controlRoot,
    wrappedCommand: command,
  };
}

export function rewriteWorkspacePathForSandbox(text = '', hostWorkspace = '', visibleWorkspace = '') {
  const source = String(text ?? '');
  const host = String(hostWorkspace || '').trim();
  const visible = String(visibleWorkspace || '').trim();
  if (!host || !visible || host === visible) return source;
  return source.split(host).join(visible);
}
