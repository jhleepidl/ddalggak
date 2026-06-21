import fs from "node:fs";
import { geminiCliDisabledByDefault, geminiCliDisabledMessage, normalizeGeminiReplacementProvider, sanitizeGeminiModelForProvider } from "./provider_migration.js";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./proc.js";
import { recordLlmTrace } from "./application/llm_trace_recorder.js";

const VALID_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const PLAN_DISABLED_RE = /Approval mode "plan" is only available when experimental\.plan is enabled\./i;
const TIMEOUT_RE = /\[timeout\]|killed after|timed?\s*out|ETIMEDOUT/i;
const MODEL_CAPACITY_EXHAUSTED_RE = /MODEL_CAPACITY_EXHAUSTED/i;
const NO_CAPACITY_RE = /No capacity available for model/i;
const RESOURCE_EXHAUSTED_RE = /RESOURCE_EXHAUSTED/i;
const STATUS_429_RE = /\b429\b|status[^0-9]{0,20}429|code[^0-9]{0,20}429/i;
const GEMINI_CAPACITY_EARLY_EXIT_RE = /MODEL_CAPACITY_EXHAUSTED|No capacity available for model|RESOURCE_EXHAUSTED/i;
const STATUS_404_RE = /\b404\b|status[^0-9]{0,20}404|code[^0-9]{0,20}404/i;
const QUOTA_EXCEEDED_RE = /quota[_\s-]*exceeded|quota\b.*(exceed|exhaust|limit)|billing.*(limit|quota)/i;
const REQUESTED_ENTITY_NOT_FOUND_RE = /Requested entity was not found/i;
const MODEL_NOT_FOUND_RE = /ModelNotFoundError/i;
const GEMINI_25_MODEL_RE = /\bgemini-2\.5(?:-[a-z0-9._-]+)?\b/i;
const MODEL_FLAG_UNSUPPORTED_RE = /(unknown|unrecognized|unexpected)\s+(option|argument|flag)[^-\n\r]*--model|unknown flag:\s*--model/i;
const DEFAULT_GEMINI_MODEL_PRIMARY = "auto";
// DdalGgak auto-pool is intentionally different from Gemini CLI's own
// `auto`: it tries concrete models first so a model-specific 429 on Gemini 3
// does not make the whole Gemini provider unusable. Keep CLI auto last.
const DEFAULT_GEMINI_MODEL_POOL = "gemini-2.5-flash,gemini-2.5-pro,gemini-3.1-pro-preview,gemini-3-flash-preview,auto";
const DEFAULT_GEMINI_MODEL_FALLBACKS = "";
const DEFAULT_CAPACITY_MAX_RETRIES = 2;
const DEFAULT_CAPACITY_SWITCH_AFTER = 1;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_DELAY_MS = 30000;
const DEFAULT_BACKOFF_JITTER_MS = 500;
const DEFAULT_MAX_CONCURRENT_GEMINI = 1;
const DEFAULT_GEMINI_MIN_INTERVAL_MS = 2000;
const DEFAULT_GEMINI_RETRY_TIMEBOX_MS = 90000;
const DEFAULT_GEMINI_CAPACITY_COOLDOWN_MS = 60000;
const DEFAULT_GEMINI_SETTINGS_OVERWRITE = "merge";
const DEFAULT_GEMINI_DEBUG_LOG = "gemini_debug.log";
const DEFAULT_GEMINI_FORCE_FILE_STORAGE = "true";
const DEFAULT_GEMINI_CLI_TRUST_WORKSPACE = "true";
const GEMINI_GNU_SCREEN_RE = /GNU screen detected|\bSTY=|screen-.*keyboard|keyboard input.*screen/i;
// Sticky success is intentionally an operational default, not a sample .env knob.
// In GEMINI_MODEL=auto/pool mode, the last successful concrete model is tried
// first on the next matching surface. Hidden env switches remain for emergency
// debugging/rollback, but the default TTL is infinite.
const DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_ENABLED = "true";
const DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_SCOPE = "surface";
const DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_TTL_MS = 0;
const GEMINI_STICKY_STATE_VERSION = 1;

let planModeAvailability = null;
let modelFlagAvailability = null;
const geminiGlobalLimiter = {
  running: 0,
  waiters: [],
  lastCallAtMs: 0,
};
const geminiCapacityCircuit = {
  consecutiveCapacityFailures: 0,
  openUntilMs: 0,
};
const geminiModelCapacityCircuits = new Map();

function asObject(value) {
  return value && typeof value === "object" ? value : {};
}

function parseJsonMaybe(rawText = "") {
  const raw = String(rawText || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeOverwritePolicy(raw) {
  const key = String(raw || "").trim().toLowerCase();
  if (key === "never" || key === "always" || key === "merge") return key;
  return DEFAULT_GEMINI_SETTINGS_OVERWRITE;
}

function defaultGeminiWorkspaceSettings() {
  return {
    general: {
      plan: {
        modelRouting: false,
      },
    },
    output: {
      format: "json",
    },
    context: {
      includeDirectoryTree: false,
      discoveryMaxDirs: 20,
      loadMemoryFromIncludeDirectories: false,
    },
  };
}

function sanitizeWorkspaceModelSettings(raw = {}, { workspaceModelOverride = "" } = {}) {
  const row = asObject(raw);
  const model = asObject(row.model);
  const currentName = String(model.name || "").trim();
  const overrideRaw = String(workspaceModelOverride ?? "").trim();
  const overrideMode = !overrideRaw
    ? "none"
    : (overrideRaw.toLowerCase() === "auto" ? "auto" : "fixed");
  const overrideName = overrideMode === "fixed" ? overrideRaw : "";

  if (overrideMode === "fixed") {
    const next = {
      ...row,
      model: {
        ...model,
        name: overrideName,
      },
    };
    const changed = currentName !== overrideName;
    return {
      settings: next,
      changed,
      logLine: changed
        ? `[gemini] workspace settings sanitized: model.name ${currentName || "(none)"} -> ${overrideName}`
        : "",
    };
  }

  if (overrideMode === "auto") {
    if (!row.model) {
      return {
        settings: row,
        changed: false,
        logLine: "",
      };
    }
    const next = { ...row };
    delete next.model;
    return {
      settings: next,
      changed: true,
      logLine: currentName
        ? `[gemini] workspace settings sanitized: removed model.name=${currentName} (GEMINI_WORKSPACE_MODEL=auto)`
        : "[gemini] workspace settings sanitized: removed model section (GEMINI_WORKSPACE_MODEL=auto)",
    };
  }

  if (currentName && GEMINI_25_MODEL_RE.test(currentName)) {
    const next = { ...row };
    delete next.model;
    return {
      settings: next,
      changed: true,
      logLine: `[gemini] workspace settings sanitized: removed model.name=${currentName}`,
    };
  }

  return {
    settings: row,
    changed: false,
    logLine: "",
  };
}

function mergeObjectsPreferExisting(baseValue, userValue) {
  if (Array.isArray(baseValue)) {
    return Array.isArray(userValue) ? [...userValue] : [...baseValue];
  }
  if (baseValue && typeof baseValue === "object") {
    const base = asObject(baseValue);
    const user = asObject(userValue);
    const out = { ...base };
    for (const [key, value] of Object.entries(user)) {
      if (key in base) out[key] = mergeObjectsPreferExisting(base[key], value);
      else out[key] = value;
    }
    return out;
  }
  return typeof userValue === "undefined" ? baseValue : userValue;
}


function mergeObjectsPreferPatch(baseValue, patchValue) {
  if (Array.isArray(baseValue)) {
    return Array.isArray(patchValue) ? [...patchValue] : [...baseValue];
  }
  if (baseValue && typeof baseValue === "object") {
    const base = asObject(baseValue);
    const patch = asObject(patchValue);
    const out = { ...base };
    for (const [key, value] of Object.entries(patch)) {
      if (key in base) out[key] = mergeObjectsPreferPatch(base[key], value);
      else out[key] = value;
    }
    return out;
  }
  return typeof patchValue === "undefined" ? baseValue : patchValue;
}

function enforceWorkspaceContextSettings(raw = {}) {
  const row = asObject(raw);
  const context = asObject(row.context);
  const discoveryMaxDirs = Number(context.discoveryMaxDirs);
  const nextDiscoveryMaxDirs = Number.isFinite(discoveryMaxDirs)
    ? Math.max(1, Math.min(20, Math.floor(discoveryMaxDirs)))
    : 20;
  return {
    ...row,
    context: {
      ...context,
      includeDirectoryTree: false,
      discoveryMaxDirs: nextDiscoveryMaxDirs,
      loadMemoryFromIncludeDirectories: false,
    },
  };
}

function appendGeminiDebugLog(line = "") {
  const file = path.resolve(process.env.GEMINI_DEBUG_LOG || DEFAULT_GEMINI_DEBUG_LOG);
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(line || "")}\n`, "utf8");
  } catch {}
}

export function ensureGeminiWorkspaceConfig(workspacePath, { overwritePolicy = "", patchSettings = {} } = {}) {
  const workspaceDir = path.resolve(String(workspacePath || process.cwd()));
  fs.mkdirSync(workspaceDir, { recursive: true });
  const geminiDir = path.join(workspaceDir, ".gemini");
  const settingsPath = path.join(geminiDir, "settings.json");
  const policy = normalizeOverwritePolicy(overwritePolicy || process.env.GEMINI_SETTINGS_OVERWRITE);
  const workspaceModelOverride = process.env.GEMINI_WORKSPACE_MODEL;
  const defaults = enforceWorkspaceContextSettings(defaultGeminiWorkspaceSettings());
  const policyPatch = asObject(patchSettings);
  const manageWorkspaceConfig = fs.existsSync(settingsPath)
    || ['1', 'true', 'yes', 'on'].includes(String(process.env.GEMINI_MANAGE_WORKSPACE_CONFIG || '').trim().toLowerCase())
    || Boolean(String(workspaceModelOverride || '').trim())
    || Object.keys(policyPatch).length > 0;
  if (!manageWorkspaceConfig) {
    return {
      workspaceDir,
      settingsPath,
      policy,
      skipped: true,
    };
  }
  fs.mkdirSync(geminiDir, { recursive: true });

  const existingRaw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, "utf8") : "";
  const existing = parseJsonMaybe(existingRaw);
  let next = defaults;
  if (existing && policy === "never") {
    next = enforceWorkspaceContextSettings(existing);
  } else if (existing && policy === "merge") {
    next = enforceWorkspaceContextSettings(mergeObjectsPreferExisting(defaults, existing));
  } else if (existing && policy === "always") {
    next = defaults;
  }
  const sanitized = sanitizeWorkspaceModelSettings(next, { workspaceModelOverride });
  next = enforceWorkspaceContextSettings(sanitized.settings);
  if (sanitized.changed && sanitized.logLine) appendGeminiDebugLog(sanitized.logLine);
  if (Object.keys(policyPatch).length > 0) {
    next = enforceWorkspaceContextSettings(mergeObjectsPreferPatch(next, policyPatch));
  }

  const serialized = `${JSON.stringify(next, null, 2)}\n`;
  if (existingRaw !== serialized) {
    fs.writeFileSync(settingsPath, serialized, "utf8");
  }
  return {
    workspaceDir,
    settingsPath,
    policy,
  };
}

function resolveApprovalMode() {
  const raw = String(process.env.GEMINI_APPROVAL_MODE || "default").trim();
  return VALID_APPROVAL_MODES.has(raw) ? raw : "default";
}

function normalizeModelName(raw) {
  const model = String(raw || "").trim();
  if (!model) return "";
  return model.toLowerCase() === "auto" ? "auto" : model;
}

function modelEnvValue(modelName) {
  const clean = normalizeModelName(modelName);
  return clean === "auto" ? "" : clean;
}

function displayModelName(modelName) {
  const clean = normalizeModelName(modelName);
  return clean || "auto";
}

function modelCircuitKey(modelName) {
  const clean = normalizeModelName(modelName);
  return clean || "auto";
}

function getGeminiModelCircuit(modelName) {
  const key = modelCircuitKey(modelName);
  if (!geminiModelCapacityCircuits.has(key)) {
    geminiModelCapacityCircuits.set(key, { consecutiveCapacityFailures: 0, openUntilMs: 0 });
  }
  return geminiModelCapacityCircuits.get(key);
}

function isTruthyEnv(raw) {
  return ["1", "true", "yes", "on"].includes(String(raw || "").trim().toLowerCase());
}

function splitModelList(raw = "") {
  return String(raw || "")
    .split(",")
    .map((token) => normalizeModelName(token))
    .filter(Boolean);
}

function toPositiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function isFalseyEnv(raw) {
  return ["0", "false", "no", "off", "disabled"].includes(String(raw || "").trim().toLowerCase());
}

function isGeminiStickySuccessEnabled() {
  const raw = process.env.GEMINI_MODEL_STICKY_SUCCESS;
  if (typeof raw === "undefined") return DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_ENABLED === "true";
  return !isFalseyEnv(raw);
}

function getGeminiStickySuccessScope() {
  const raw = String(process.env.GEMINI_MODEL_STICKY_SUCCESS_SCOPE || DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_SCOPE).trim().toLowerCase();
  if (["global", "all", "shared", "provider"].includes(raw)) return "global";
  if (["off", "false", "0", "none", "disabled"].includes(raw)) return "off";
  return "surface";
}

function getGeminiStickySuccessTtlMs() {
  // 0 means no expiry. This is the default so operators do not need an env knob.
  const raw = process.env.GEMINI_MODEL_STICKY_SUCCESS_TTL_MS;
  if (typeof raw === "undefined" || String(raw).trim() === "") return DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_TTL_MS;
  return toPositiveInt(raw, DEFAULT_GEMINI_MODEL_STICKY_SUCCESS_TTL_MS, { min: 0, max: 3650 * 24 * 60 * 60 * 1000 });
}

function normalizeStickySurface(raw = "") {
  return String(raw || "gemini_prompt").trim().replace(/[^a-zA-Z0-9._:-]+/g, "_").replace(/^_+|_+$/g, "") || "gemini_prompt";
}

function resolveGeminiProviderStateDir({ originalCwd = "", jobId = "" } = {}) {
  const explicit = String(process.env.GEMINI_MODEL_SUCCESS_STATE_DIR || process.env.GEMINI_PROVIDER_STATE_DIR || "").trim();
  if (explicit) return path.resolve(explicit);

  const runRoot = findRunRootFromWorkspacePath(originalCwd, jobId);
  if (runRoot && path.basename(runRoot) === String(jobId || "").trim()) {
    return path.join(path.dirname(runRoot), "provider_state");
  }
  if (runRoot && path.basename(runRoot) !== "workspace") {
    return path.join(path.dirname(runRoot), "provider_state");
  }

  const runsDir = String(process.env.RUNS_DIR || "runs").trim() || "runs";
  return path.join(path.resolve(runsDir), "provider_state");
}

function getGeminiStickySuccessStatePath(context = {}) {
  return path.join(resolveGeminiProviderStateDir(context), "gemini_model_success.json");
}

function readGeminiStickySuccessState(context = {}) {
  const filePath = getGeminiStickySuccessStatePath(context);
  try {
    const parsed = parseJsonMaybe(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGeminiStickySuccessState(state = {}, context = {}) {
  const filePath = getGeminiStickySuccessStatePath(context);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function stickyBucketForScope(scope, surface = "") {
  if (scope === "global") return "global:*";
  return `surface:${normalizeStickySurface(surface)}`;
}

function getGeminiStickySuccessEntry({ surface = "", originalCwd = "", jobId = "" } = {}) {
  if (!isGeminiStickySuccessEnabled()) return null;
  const scope = getGeminiStickySuccessScope();
  if (scope === "off") return null;
  const state = readGeminiStickySuccessState({ originalCwd, jobId });
  const buckets = state && typeof state === "object" && state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const entry = buckets[stickyBucketForScope(scope, surface)] || null;
  if (!entry || typeof entry !== "object") return null;
  const model = normalizeModelName(entry.model);
  if (!model || model === "auto") return null;
  const ttlMs = getGeminiStickySuccessTtlMs();
  if (ttlMs > 0) {
    const updatedAtMs = Number(entry.updated_at_ms || 0);
    if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || Date.now() - updatedAtMs > ttlMs) return null;
  }
  return { ...entry, model };
}

function recordGeminiStickySuccess({ model = "", surface = "", originalCwd = "", jobId = "" } = {}) {
  if (!isGeminiStickySuccessEnabled()) return false;
  const scope = getGeminiStickySuccessScope();
  if (scope === "off") return false;
  const cleanModel = normalizeModelName(model);
  if (!cleanModel || cleanModel === "auto") return false;
  const state = readGeminiStickySuccessState({ originalCwd, jobId });
  const buckets = state && typeof state === "object" && state.buckets && typeof state.buckets === "object" ? state.buckets : {};
  const bucketKey = stickyBucketForScope(scope, surface);
  const previous = buckets[bucketKey] && typeof buckets[bucketKey] === "object" ? buckets[bucketKey] : {};
  const nextState = {
    ...(state && typeof state === "object" ? state : {}),
    version: GEMINI_STICKY_STATE_VERSION,
    updated_at: new Date().toISOString(),
    updated_at_ms: Date.now(),
    buckets: {
      ...buckets,
      [bucketKey]: {
        model: cleanModel,
        scope,
        surface: scope === "surface" ? normalizeStickySurface(surface) : "*",
        updated_at: new Date().toISOString(),
        updated_at_ms: Date.now(),
        success_count: Math.max(0, Number(previous.success_count || 0)) + 1,
      },
    },
  };
  return writeGeminiStickySuccessState(nextState, { originalCwd, jobId });
}

function applyGeminiStickySuccessCandidates(candidates = [], context = {}) {
  if (!Array.isArray(candidates) || candidates.length <= 1) return candidates;
  const entry = getGeminiStickySuccessEntry(context);
  const stickyModel = normalizeModelName(entry?.model || "");
  if (!stickyModel || stickyModel === "auto") return candidates;
  const stickyKey = stickyModel.toLowerCase();
  const index = candidates.findIndex((candidate) => normalizeModelName(candidate).toLowerCase() === stickyKey);
  if (index <= 0) return candidates;
  return [candidates[index], ...candidates.slice(0, index), ...candidates.slice(index + 1)];
}

function getGeminiConcurrencyLimit() {
  return toPositiveInt(
    process.env.MAX_CONCURRENT_GEMINI,
    DEFAULT_MAX_CONCURRENT_GEMINI,
    { min: 1, max: 8 }
  );
}

function getCapacityMaxRetries() {
  return toPositiveInt(
    process.env.GEMINI_MAX_RETRIES ?? process.env.GEMINI_CAPACITY_MAX_RETRIES,
    DEFAULT_CAPACITY_MAX_RETRIES,
    { min: 0, max: 16 }
  );
}

function getCapacitySwitchAfter() {
  return toPositiveInt(
    process.env.GEMINI_CAPACITY_SWITCH_AFTER,
    DEFAULT_CAPACITY_SWITCH_AFTER,
    { min: 1, max: 6 }
  );
}

function getBackoffBaseMs() {
  return toPositiveInt(
    process.env.GEMINI_BACKOFF_BASE_MS ?? process.env.GEMINI_CAPACITY_BACKOFF_BASE_MS,
    DEFAULT_BACKOFF_BASE_MS,
    { min: 200, max: 10000 }
  );
}

function getBackoffMaxDelayMs() {
  return toPositiveInt(
    process.env.GEMINI_BACKOFF_MAX_MS ?? process.env.GEMINI_CAPACITY_MAX_DELAY_MS,
    DEFAULT_BACKOFF_MAX_DELAY_MS,
    { min: 1000, max: 120000 }
  );
}

function getBackoffJitterMs() {
  return toPositiveInt(
    process.env.GEMINI_JITTER_MS ?? process.env.GEMINI_CAPACITY_JITTER_MS,
    DEFAULT_BACKOFF_JITTER_MS,
    { min: 0, max: 5000 }
  );
}

function getGeminiMinIntervalMs() {
  return toPositiveInt(
    process.env.GEMINI_MIN_INTERVAL_MS,
    DEFAULT_GEMINI_MIN_INTERVAL_MS,
    { min: 0, max: 120000 }
  );
}

function getGeminiRetryTimeboxMs() {
  return toPositiveInt(
    process.env.GEMINI_RETRY_TIMEBOX_MS,
    DEFAULT_GEMINI_RETRY_TIMEBOX_MS,
    { min: 5000, max: 600000 }
  );
}

function getGeminiCapacityCooldownMs() {
  return toPositiveInt(
    process.env.GEMINI_CAPACITY_COOLDOWN_MS,
    DEFAULT_GEMINI_CAPACITY_COOLDOWN_MS,
    { min: 1000, max: 600000 }
  );
}

function shouldUseDdalggakModelPool(primaryModel = "") {
  const mode = String(process.env.GEMINI_MODEL_AUTO_MODE || process.env.GEMINI_AUTO_MODE || "pool").trim().toLowerCase();
  if (["cli", "native", "gemini", "off", "false", "0"].includes(mode)) return false;
  const primary = normalizeModelName(primaryModel);
  return !primary || primary === "auto";
}

export function resolveGeminiModelCandidates(explicitModel = "", context = {}) {
  const explicit = String(explicitModel || "").trim();
  const rawPrimary = String(
    explicit
    || process.env.GEMINI_MODEL_PRIMARY
    || process.env.GEMINI_MODEL
    || DEFAULT_GEMINI_MODEL_PRIMARY
  ).trim();
  const primary = normalizeModelName(rawPrimary);
  const fallbackRaw = String(process.env.GEMINI_MODEL_FALLBACKS ?? DEFAULT_GEMINI_MODEL_FALLBACKS);
  const out = [];
  const seen = new Set();

  const pushModel = (raw) => {
    const model = normalizeModelName(raw);
    if (!model) return;
    const key = model.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(model);
  };

  const usingAutoPool = shouldUseDdalggakModelPool(primary);
  if (usingAutoPool) {
    const poolRaw = String(process.env.GEMINI_MODEL_POOL || DEFAULT_GEMINI_MODEL_POOL);
    for (const token of splitModelList(poolRaw)) pushModel(token);
  } else {
    pushModel(primary);
  }

  for (const token of splitModelList(fallbackRaw)) pushModel(token);
  if (out.length === 0) out.push("auto");

  // Only implicit auto/pool mode gets sticky reordering. Explicit per-call models
  // must stay operator/request controlled, though they still receive fallbacks.
  if (!explicit && usingAutoPool) {
    return applyGeminiStickySuccessCandidates(out, context);
  }
  return out;
}

function classifyGeminiError(result = {}) {
  const text = [
    String(result.stdout || ""),
    String(result.stderr || ""),
  ].join("\n");
  if (!text.trim()) return "unknown_error";

  if (/\[aborted\]/i.test(text)) return "aborted";

  const isCapacityExhausted = NO_CAPACITY_RE.test(text)
    || MODEL_CAPACITY_EXHAUSTED_RE.test(text)
    || (RESOURCE_EXHAUSTED_RE.test(text) && STATUS_429_RE.test(text));
  // Gemini CLI may keep retrying a capacity-exhausted model inside a single
  // subprocess until the outer timeout kills it. Keep the more specific
  // capacity signal so the wrapper can switch models/retry instead of reporting
  // a generic timeout.
  if (isCapacityExhausted) return "capacity_exhausted";

  if (TIMEOUT_RE.test(text)) return "timeout";

  const isModelNotFound = REQUESTED_ENTITY_NOT_FOUND_RE.test(text)
    || MODEL_NOT_FOUND_RE.test(text)
    || STATUS_404_RE.test(text);
  if (isModelNotFound) return "model_not_found";

  if (QUOTA_EXCEEDED_RE.test(text)) return "quota_exceeded";
  return "unknown_error";
}

function capacityBackoffDelayMs(retryCount) {
  const base = getBackoffBaseMs();
  const maxDelay = getBackoffMaxDelayMs();
  const jitter = getBackoffJitterMs();
  const expDelay = Math.min(maxDelay, base * (2 ** Math.max(0, retryCount - 1)));
  const jitterMs = jitter > 0 ? Math.floor(Math.random() * (jitter + 1)) : 0;
  return Math.min(maxDelay, expDelay + jitterMs);
}

async function safeHook(hook, payload) {
  if (typeof hook !== "function") return;
  try {
    await hook(payload);
  } catch {}
}

async function waitWithAbort(ms, signal) {
  const waitMs = Number(ms);
  if (!(waitMs > 0)) return true;
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return true;
  }
  if (signal.aborted) return false;
  return await new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(ok);
    };
    const onAbort = () => finish(false);
    const timer = setTimeout(() => finish(true), waitMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function makeAbortedResult() {
  return {
    ok: false,
    exitCode: -1,
    stdout: "",
    stderr: "[gemini] aborted",
    durationMs: 0,
  };
}

function makeFailureResult(stderr, { exitCode = -1, stdout = "" } = {}) {
  return {
    ok: false,
    exitCode,
    stdout: String(stdout || ""),
    stderr: String(stderr || ""),
    durationMs: 0,
  };
}

function isTimeoutResult(result = {}) {
  const text = [String(result?.stdout || ""), String(result?.stderr || "")].join("\\n");
  return TIMEOUT_RE.test(text);
}

function shouldRetryInlineAfterStdinFailure(result = {}) {
  if (result?.ok) return false;
  if (isTimeoutResult(result)) return false;
  if (/\[aborted\]/i.test(String(result?.stderr || ""))) return false;
  // Inline retry is a transport fallback for rare CLI/stdin parser issues.
  // It must not double timeout/capacity/model failures.
  const flag = String(process.env.GEMINI_INLINE_RETRY_ON_STDIN_FAILURE || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(flag);
}

function makeCombinedStderr(parts = []) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n");
}

function envValueOrDefault(key, fallback) {
  const raw = process.env[key];
  if (typeof raw === "undefined") return String(fallback);
  const value = String(raw).trim();
  return value || String(fallback);
}

function resolveGeminiContextMode(raw = "") {
  const value = String(raw || process.env.GEMINI_CONTEXT_MODE || process.env.GEMINI_CLI_CONTEXT_MODE || "isolated").trim().toLowerCase();
  if (["workspace", "project", "repo", "native"].includes(value)) return "workspace";
  if (["isolated", "isolate", "minimal", "prompt", "prompt_only", "prompt-only", "sandbox"].includes(value)) return "isolated";
  return "isolated";
}

function sanitizeSurfaceForPath(raw = "") {
  const clean = String(raw || "gemini_prompt").replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return clean || "gemini_prompt";
}

function pruneOldGeminiIsolatedWorkspaces(baseDir) {
  const maxAgeMs = toPositiveInt(process.env.GEMINI_CONTEXT_TEMP_MAX_AGE_MS, 6 * 60 * 60 * 1000, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000 });
  const maxDirs = toPositiveInt(process.env.GEMINI_CONTEXT_TEMP_MAX_DIRS, 64, { min: 4, max: 1024 });
  let rows = [];
  try {
    rows = fs.readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const fullPath = path.join(baseDir, entry.name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(fullPath).mtimeMs; } catch {}
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  } catch {
    return;
  }
  const now = Date.now();
  rows.forEach((row, index) => {
    if (index < maxDirs && now - Number(row.mtimeMs || 0) <= maxAgeMs) return;
    try { fs.rmSync(row.fullPath, { recursive: true, force: true }); } catch {}
  });
}

function findRunRootFromWorkspacePath(originalCwd = "", jobId = "") {
  const cwd = path.resolve(String(originalCwd || "").trim() || process.cwd());
  const cleanJob = String(jobId || "").trim();
  const parts = cwd.split(path.sep);

  if (cleanJob) {
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (parts[i] !== cleanJob) continue;
      const candidate = parts.slice(0, i + 1).join(path.sep) || path.sep;
      if (path.basename(candidate) === cleanJob) return candidate;
    }
  }

  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (parts[i] !== "workspace") continue;
    const candidate = parts.slice(0, i).join(path.sep) || path.sep;
    if (candidate && candidate !== cwd) return candidate;
  }

  if (path.basename(cwd) === "workspace") return path.dirname(cwd);
  return "";
}

function resolveGeminiIsolatedWorkspaceBase({ jobId = "", originalCwd = "" } = {}) {
  const explicit = String(process.env.GEMINI_CONTEXT_TEMP_DIR || process.env.GEMINI_CLI_CONTEXT_TEMP_DIR || "").trim();
  if (explicit) return path.resolve(explicit);

  const scope = String(process.env.GEMINI_CONTEXT_TEMP_SCOPE || "run").trim().toLowerCase();
  if (!["tmp", "temp", "os_tmp", "os-tmp"].includes(scope)) {
    const runRoot = findRunRootFromWorkspacePath(originalCwd, jobId);
    if (runRoot) {
      const dirName = String(process.env.GEMINI_CONTEXT_DIR_NAME || "gemini_cwd").trim() || "gemini_cwd";
      return path.join(runRoot, "local_memory", dirName);
    }
  }

  return path.join(os.tmpdir(), "ddalggak-gemini-cli");
}

function makeGeminiIsolatedWorkspace({ jobId = "", surface = "", originalCwd = "" } = {}) {
  const base = resolveGeminiIsolatedWorkspaceBase({ jobId, originalCwd });
  fs.mkdirSync(base, { recursive: true });
  try { fs.writeFileSync(path.join(base, ".gitignore"), "*\n!.gitignore\n", "utf8"); } catch {}
  const reuseMode = String(process.env.GEMINI_CONTEXT_REUSE || "stable").trim().toLowerCase();
  pruneOldGeminiIsolatedWorkspaces(base);
  const safeSurface = sanitizeSurfaceForPath(surface || "default").slice(0, 40) || "default";
  const dir = reuseMode === "temp"
    ? fs.mkdtempSync(path.join(base, `${safeSurface}-`))
    : path.join(base, safeSurface);
  fs.mkdirSync(path.join(dir, ".gemini"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "GEMINI.md"),
    [
      "# DdalGgak isolated Gemini CLI context",
      "Use only the prompt text and explicit file/artifact excerpts provided by DdalGgak.",
      "Do not infer project state from this temporary directory.",
      originalCwd ? `Original workspace path for audit only: ${originalCwd}` : "",
      "",
    ].filter(Boolean).join("\n"),
    "utf8"
  );
  fs.writeFileSync(
    path.join(dir, ".gemini", "settings.json"),
    JSON.stringify(enforceWorkspaceContextSettings(defaultGeminiWorkspaceSettings()), null, 2) + "\n",
    "utf8"
  );
  return dir;
}

function buildGeminiCliRuntimeEnv({ model = "", extraEnv = {} } = {}) {
  const userEnv = asObject(extraEnv);
  return {
    // Gemini CLI can mis-detect GNU screen/tmux as an interactive keyboard surface
    // and exit before processing stdin. DdalGgak always drives it non-interactively,
    // so force a dumb CI terminal and blank screen-specific markers unless the caller
    // explicitly overrides them in extraEnv.
    TERM: "dumb",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    STY: "",
    WINDOW: "",
    TERMCAP: "",
    TMUX: "",
    GEMINI_FORCE_FILE_STORAGE: envValueOrDefault("GEMINI_FORCE_FILE_STORAGE", DEFAULT_GEMINI_FORCE_FILE_STORAGE),
    GEMINI_CLI_TRUST_WORKSPACE: envValueOrDefault("GEMINI_CLI_TRUST_WORKSPACE", DEFAULT_GEMINI_CLI_TRUST_WORKSPACE),
    ...(model ? { GEMINI_MODEL: model } : {}),
    GEMINI_DISABLE_DIRTREE: String(process.env.GEMINI_DISABLE_DIRTREE || "1").trim() || "1",
    ...userEnv,
  };
}

export function getGeminiCliRuntimeEnvDefaults(extraEnv = {}) {
  return buildGeminiCliRuntimeEnv({ extraEnv });
}

function buildGeminiArgs({ promptText, approvalMode, inline, model, includeModelArg }) {
  const args = [
    "--prompt",
    inline ? promptText : ".",
    "--output-format",
    "text",
    "--approval-mode",
    approvalMode,
  ];
  if (includeModelArg && model) {
    args.push("--model", model);
  }
  return args;
}

async function runGeminiOnce({
  promptText,
  approvalMode,
  commandCwd,
  timeoutMs,
  signal,
  model,
  includeModelArg,
  extraEnv = {},
}) {
  const modelEnv = buildGeminiCliRuntimeEnv({ model, extraEnv });
  const stdinArgs = buildGeminiArgs({
    promptText,
    approvalMode,
    inline: false,
    model,
    includeModelArg,
  });
  const stdinRun = await runCommand("gemini", stdinArgs, {
    cwd: commandCwd,
    timeoutMs,
    input: promptText,
    abortSignal: signal,
    env: modelEnv,
    maxStdoutChars: getGeminiMaxStdoutChars(),
    maxStderrChars: getGeminiMaxStderrChars(),
    earlyExitPattern: GEMINI_CAPACITY_EARLY_EXIT_RE,
    earlyExitLabel: "gemini_capacity_exhausted",
  });
  if (stdinRun.ok) return { ...stdinRun, attempt_count: 1, transport: "stdin" };
  if (signal?.aborted) return makeAbortedResult();
  if (!shouldRetryInlineAfterStdinFailure(stdinRun)) {
    return { ...stdinRun, attempt_count: 1, transport: "stdin" };
  }

  const inlineArgs = buildGeminiArgs({
    promptText,
    approvalMode,
    inline: true,
    model,
    includeModelArg,
  });
  const inlineRun = await runCommand("gemini", inlineArgs, {
    cwd: commandCwd,
    timeoutMs,
    abortSignal: signal,
    env: modelEnv,
    maxStdoutChars: getGeminiMaxStdoutChars(),
    maxStderrChars: getGeminiMaxStderrChars(),
    earlyExitPattern: GEMINI_CAPACITY_EARLY_EXIT_RE,
    earlyExitLabel: "gemini_capacity_exhausted",
  });
  if (inlineRun.ok) return { ...inlineRun, attempt_count: 2, transport: "inline" };

  return {
    ...inlineRun,
    attempt_count: 2,
    transport: "inline",
    stderr: makeCombinedStderr([stdinRun.stderr, inlineRun.stderr]),
  };
}

async function invokeGemini({ promptText, approvalMode, commandCwd, timeoutMs, signal, modelName, extraEnv = {} }) {
  const model = modelEnvValue(modelName);
  const canUseModelArg = !!model && modelFlagAvailability !== false;
  const firstRun = await runGeminiOnce({
    promptText,
    approvalMode,
    commandCwd,
    timeoutMs,
    signal,
    model,
    includeModelArg: canUseModelArg,
    extraEnv,
  });
  if (firstRun.ok) {
    if (canUseModelArg && model) modelFlagAvailability = true;
    return firstRun;
  }
  if (signal?.aborted) return makeAbortedResult();

  if (GEMINI_GNU_SCREEN_RE.test(String(firstRun.stderr || "") + "\n" + String(firstRun.stdout || ""))) {
    const retryEnv = {
      ...asObject(extraEnv),
      TERM: "dumb",
      CI: "1",
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      STY: "",
      WINDOW: "",
      TERMCAP: "",
      TMUX: "",
      GEMINI_CLI_NON_INTERACTIVE: "1",
    };
    const retryNoScreen = await runGeminiOnce({
      promptText,
      approvalMode,
      commandCwd,
      timeoutMs,
      signal,
      model,
      includeModelArg: canUseModelArg,
      extraEnv: retryEnv,
    });
    return {
      ...retryNoScreen,
      stderr: makeCombinedStderr([
        firstRun.stderr,
        retryNoScreen.stderr,
        "[gemini] GNU screen/tmux interactive warning detected; retried with non-interactive terminal env",
      ]),
    };
  }

  if (canUseModelArg && model && MODEL_FLAG_UNSUPPORTED_RE.test(String(firstRun.stderr || ""))) {
    modelFlagAvailability = false;
    const retryNoFlag = await runGeminiOnce({
      promptText,
      approvalMode,
      commandCwd,
      timeoutMs,
      signal,
      model,
      includeModelArg: false,
      extraEnv,
    });
    return {
      ...retryNoFlag,
      stderr: makeCombinedStderr([
        firstRun.stderr,
        retryNoFlag.stderr,
        "[gemini] --model flag unavailable; retried with GEMINI_MODEL env only",
      ]),
    };
  }

  return firstRun;
}

async function invokeGeminiWithPlanFallback({
  promptText,
  requestedMode,
  commandCwd,
  timeoutMs,
  signal,
  modelName,
  extraEnv = {},
}) {
  const firstMode = requestedMode === "plan" && planModeAvailability === false ? "default" : requestedMode;
  const first = await invokeGemini({
    promptText,
    approvalMode: firstMode,
    commandCwd,
    timeoutMs,
    signal,
    modelName,
    extraEnv,
  });
  if (first.ok) {
    if (firstMode === "plan") planModeAvailability = true;
    return first;
  }
  if (signal?.aborted) return makeAbortedResult();

  if (firstMode === "plan" && PLAN_DISABLED_RE.test(String(first.stderr || ""))) {
    planModeAvailability = false;
    const retry = await invokeGemini({
      promptText,
      approvalMode: "default",
      commandCwd,
      timeoutMs,
      signal,
      modelName,
      extraEnv,
    });
    return {
      ...retry,
      stderr: makeCombinedStderr([
        retry.stderr,
        "[gemini] plan mode unavailable (experimental.plan=false); retried with approval-mode=default",
      ]),
    };
  }
  return first;
}

function releaseGeminiGlobalSlot() {
  geminiGlobalLimiter.running = Math.max(0, Number(geminiGlobalLimiter.running || 0) - 1);
  const limit = getGeminiConcurrencyLimit();
  while (geminiGlobalLimiter.running < limit && geminiGlobalLimiter.waiters.length > 0) {
    const resume = geminiGlobalLimiter.waiters.shift();
    geminiGlobalLimiter.running += 1;
    resume();
  }
}

function getGeminiQueueWaitTimeoutMs() {
  const n = Number(process.env.GEMINI_QUEUE_WAIT_TIMEOUT_MS || 0);
  return Number.isFinite(n) && n > 0 ? Math.max(1000, Math.floor(n)) : 15000;
}

function getGeminiMaxQueueWaiters() {
  return toPositiveInt(
    process.env.GEMINI_MAX_QUEUE_WAITERS,
    16,
    { min: 1, max: 256 }
  );
}

function getGeminiMaxStdoutChars() {
  return toPositiveInt(
    process.env.GEMINI_MAX_STDOUT_CHARS,
    2_000_000,
    { min: 10_000, max: 20_000_000 }
  );
}

function getGeminiMaxStderrChars() {
  return toPositiveInt(
    process.env.GEMINI_MAX_STDERR_CHARS,
    1_000_000,
    { min: 10_000, max: 20_000_000 }
  );
}

async function acquireGeminiGlobalSlot(signal = null) {
  const limit = getGeminiConcurrencyLimit();
  if (geminiGlobalLimiter.running < limit) {
    geminiGlobalLimiter.running += 1;
    return true;
  }
  const timeoutMs = getGeminiQueueWaitTimeoutMs();
  const maxWaiters = getGeminiMaxQueueWaiters();
  if (geminiGlobalLimiter.waiters.length >= maxWaiters) {
    return false;
  }
  return await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let onAbort = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    };
    const waiter = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const removeWaiter = () => {
      const idx = geminiGlobalLimiter.waiters.indexOf(waiter);
      if (idx >= 0) geminiGlobalLimiter.waiters.splice(idx, 1);
    };
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      removeWaiter();
      cleanup();
      resolve(false);
    }, timeoutMs);
    if (signal) {
      onAbort = () => {
        if (settled) return;
        settled = true;
        removeWaiter();
        cleanup();
        resolve(false);
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    if (geminiGlobalLimiter.waiters.length >= maxWaiters) {
      cleanup();
      settled = true;
      resolve(false);
      return;
    }
    geminiGlobalLimiter.waiters.push(waiter);
  });
}

async function withGeminiGlobalLimiter(fn, { signal = null } = {}) {
  const acquired = await acquireGeminiGlobalSlot(signal);
  if (!acquired) {
    return makeFailureResult('[gemini] queue wait timeout after ' + getGeminiQueueWaitTimeoutMs() + 'ms');
  }
  try {
    return await fn();
  } finally {
    geminiGlobalLimiter.lastCallAtMs = Date.now();
    releaseGeminiGlobalSlot();
  }
}

async function waitForGeminiMinInterval(signal) {
  const minIntervalMs = getGeminiMinIntervalMs();
  if (!(minIntervalMs > 0)) return true;
  const elapsed = Date.now() - Number(geminiGlobalLimiter.lastCallAtMs || 0);
  if (elapsed >= minIntervalMs) return true;
  const waitMs = minIntervalMs - elapsed;
  return await waitWithAbort(waitMs, signal);
}

function withGeminiMeta(result, {
  modelName = "",
  errorType = "",
  retryCount = 0,
  notes = [],
} = {}) {
  const out = {
    ...(result && typeof result === "object" ? result : {}),
    used_model: displayModelName(modelName),
    retry_count: Number.isFinite(Number(retryCount)) ? Math.max(0, Math.floor(Number(retryCount))) : 0,
  };
  if (errorType) out.error_type = errorType;
  const combinedNotes = notes.map((row) => String(row || "").trim()).filter(Boolean);
  if (combinedNotes.length > 0) {
    out.stderr = makeCombinedStderr([out.stderr, ...combinedNotes]);
  }
  return out;
}

function attachGeminiTrace({ result, jobId, surface, agentId, roleId, model, prompt, cwd, workspaceRoot, metadata }) {
  const trace = recordLlmTrace({
    jobId,
    provider: "gemini",
    surface,
    agentId,
    roleId,
    model,
    prompt,
    result,
    cwd,
    workspaceRoot,
    metadata,
  });
  return trace ? { ...result, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : result;
}

function cleanJobIdForContext(jobId = "", concurrencyKey = "") {
  const direct = String(jobId || "").trim();
  if (direct) return direct;
  const key = String(concurrencyKey || "").trim();
  return key.startsWith("job:") ? key.slice(4).trim() : "";
}

function optionsContextModeFromEnv(extraEnv = {}) {
  return String(asObject(extraEnv).GEMINI_CONTEXT_MODE || asObject(extraEnv).GEMINI_CLI_CONTEXT_MODE || "").trim();
}

function resolveGeminiTraceCommandCwd(options = {}) {
  const originalWorkspacePath = path.resolve(String(options?.cwd || options?.workspaceRoot || process.cwd()).trim() || process.cwd());
  const contextMode = resolveGeminiContextMode(optionsContextModeFromEnv(options?.extraEnv));
  if (contextMode !== "isolated") return originalWorkspacePath;
  const reuseMode = String(process.env.GEMINI_CONTEXT_REUSE || "stable").trim().toLowerCase();
  if (reuseMode === "temp") return originalWorkspacePath;
  const jobId = String(options?.jobId || (String(options?.concurrencyKey || "").startsWith("job:") ? String(options.concurrencyKey).slice(4).trim() : "")).trim();
  const surface = String(options?.workspaceSettingsPatch?.surface || options?.extraEnv?.DDALGGAK_GEMINI_SURFACE || options?.surface || "gemini_prompt").trim() || "gemini_prompt";
  return path.join(resolveGeminiIsolatedWorkspaceBase({ jobId, originalCwd: originalWorkspacePath }), sanitizeSurfaceForPath(surface).slice(0, 40) || "default");
}

async function runGeminiPromptInternal({
  workspaceRoot,
  prompt,
  signal,
  cwd,
  model = "",
  concurrencyKey = "",
  jobId = "",
  onRetry = null,
  onModelSwitch = null,
  onGiveUp = null,
  approvalMode = "",
  settingsOverwrite = "",
  workspaceSettingsPatch = {},
  extraEnv = {},
  timeoutMs: requestedTimeoutMs = 0,
  surface = "",
}) {
  // Keep CLI prompt argument simple and stream the real prompt via stdin.
  // This avoids parser issues when prompt text starts with "-" or markdown fences.
  const promptText = String(prompt ?? "");
  if (!promptText.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "[gemini] empty prompt", durationMs: 0 };
  }

  const explicitTimeoutMs = Number(requestedTimeoutMs || 0);
  const timeoutMs = Number.isFinite(explicitTimeoutMs) && explicitTimeoutMs > 0
    ? Math.max(1000, Math.floor(explicitTimeoutMs))
    : (Number(process.env.GEMINI_TIMEOUT_MS || 0) > 0
      ? Number(process.env.GEMINI_TIMEOUT_MS)
      : 4 * 60 * 1000);
  const originalWorkspacePath = path.resolve(String(cwd || workspaceRoot || process.cwd()).trim() || process.cwd());
  const contextMode = resolveGeminiContextMode(optionsContextModeFromEnv(extraEnv));
  const geminiSurface = String(workspaceSettingsPatch?.surface || extraEnv?.DDALGGAK_GEMINI_SURFACE || surface || "gemini_prompt").trim() || "gemini_prompt";
  const cleanJobId = String(jobId || "").trim() || (
    String(concurrencyKey || "").startsWith("job:")
      ? String(concurrencyKey || "").slice(4).trim()
      : ""
  );
  const commandCwd = contextMode === "isolated"
    ? makeGeminiIsolatedWorkspace({
      jobId: cleanJobId,
      surface: geminiSurface,
      originalCwd: originalWorkspacePath,
    })
    : originalWorkspacePath;
  const workspacePath = commandCwd;
  ensureGeminiWorkspaceConfig(workspacePath, { overwritePolicy: settingsOverwrite, patchSettings: workspaceSettingsPatch });
  if (contextMode === "isolated" && path.resolve(originalWorkspacePath) !== path.resolve(commandCwd)) {
    const hasExplicitWorkspacePatch = Object.keys(asObject(workspaceSettingsPatch)).length > 0;
    if (hasExplicitWorkspacePatch || String(settingsOverwrite || "").trim()) {
      ensureGeminiWorkspaceConfig(originalWorkspacePath, { overwritePolicy: settingsOverwrite, patchSettings: workspaceSettingsPatch });
    }
  }
  const baseEnv = {
    GEMINI_WORKSPACE_PATH: workspacePath,
    DDALGGAK_ORIGINAL_WORKSPACE_PATH: originalWorkspacePath,
    DDALGGAK_GEMINI_CONTEXT_MODE: contextMode,
    ...asObject(extraEnv),
  };
  void concurrencyKey;
  const requestedMode = VALID_APPROVAL_MODES.has(String(approvalMode || "").trim()) ? String(approvalMode || "").trim() : resolveApprovalMode();
  const modelCandidates = resolveGeminiModelCandidates(model, {
    surface: geminiSurface,
    originalCwd: originalWorkspacePath,
    jobId: cleanJobId,
  });
  const maxRetries = getCapacityMaxRetries();
  const switchAfter = getCapacitySwitchAfter();
  const retryTimeboxMs = getGeminiRetryTimeboxMs();
  const circuitCooldownMs = getGeminiCapacityCooldownMs();
  const unavailableModels = new Set();

  let modelIndex = 0;
  let retryCount = 0;
  let consecutiveCapacityErrors = 0;
  const notes = [];
  const startedAtMs = Date.now();
  const pickNextAvailableModelIndex = (startIndex) => {
    for (let i = Math.max(0, Number(startIndex) + 1); i < modelCandidates.length; i += 1) {
      const modelName = modelCandidates[i];
      const key = normalizeModelName(modelName).toLowerCase();
      if (!unavailableModels.has(key)) return i;
    }
    return -1;
  };

  while (true) {
    if (signal?.aborted) {
      return withGeminiMeta(makeAbortedResult(), {
        modelName: modelCandidates[modelIndex] || "auto",
        errorType: "aborted",
        retryCount,
        notes,
      });
    }

    const nowMs = Date.now();
    const currentCircuit = getGeminiModelCircuit(modelCandidates[modelIndex] || "auto");
    if (Number(currentCircuit.openUntilMs || 0) > 0 && Number(currentCircuit.openUntilMs || 0) <= nowMs) {
      currentCircuit.openUntilMs = 0;
      currentCircuit.consecutiveCapacityFailures = 0;
    }
    if (Number(currentCircuit.openUntilMs || 0) > nowMs) {
      const remainingMs = Math.max(0, Math.floor(Number(currentCircuit.openUntilMs || 0) - nowMs));
      const currentKey = normalizeModelName(modelCandidates[modelIndex] || "auto").toLowerCase();
      if (currentKey) unavailableModels.add(currentKey);
      const nextModelIndex = pickNextAvailableModelIndex(modelIndex);
      if (nextModelIndex >= 0) {
        const fromModel = modelCandidates[modelIndex] || "auto";
        const toModel = modelCandidates[nextModelIndex] || "auto";
        notes.push(`[gemini] capacity circuit open for ${displayModelName(fromModel)}; switching to ${displayModelName(toModel)} (${remainingMs}ms remaining)`);
        modelIndex = nextModelIndex;
        continue;
      }
      const circuitMsg = `[gemini] capacity circuit open for ${displayModelName(modelCandidates[modelIndex] || "auto")}; retry after ${remainingMs}ms`;
      await safeHook(onGiveUp, {
        reason: "capacity_circuit_open",
        retryCount,
        maxRetries,
        remainingMs,
      });
      return withGeminiMeta(makeFailureResult(circuitMsg), {
        modelName: modelCandidates[modelIndex] || "auto",
        errorType: "capacity_exhausted",
        retryCount,
        notes: [...notes, circuitMsg],
      });
    }

    const intervalReady = await waitForGeminiMinInterval(signal);
    if (!intervalReady) {
      return withGeminiMeta(makeAbortedResult(), {
        modelName: modelCandidates[modelIndex] || "auto",
        errorType: "aborted",
        retryCount,
        notes,
      });
    }

    const currentModelName = modelCandidates[modelIndex] || "auto";
    appendGeminiDebugLog(
      `[gemini] job=${cleanJobId || "-"} cwd=${workspacePath} original_cwd=${originalWorkspacePath} context_mode=${contextMode} model=${displayModelName(currentModelName)} retry=${retryCount} file_storage=${envValueOrDefault("GEMINI_FORCE_FILE_STORAGE", DEFAULT_GEMINI_FORCE_FILE_STORAGE)} trust_workspace=${envValueOrDefault("GEMINI_CLI_TRUST_WORKSPACE", DEFAULT_GEMINI_CLI_TRUST_WORKSPACE)}`
    );
    const result = await withGeminiGlobalLimiter(async () => {
      return await invokeGeminiWithPlanFallback({
        promptText,
        requestedMode,
        commandCwd,
        timeoutMs,
        signal,
        modelName: currentModelName,
        extraEnv: baseEnv,
      });
    }, { signal });
    if (signal?.aborted) {
      return withGeminiMeta(makeAbortedResult(), {
        modelName: currentModelName,
        errorType: 'aborted',
        retryCount,
        notes,
      });
    }
    if (result.ok) {
      recordGeminiStickySuccess({
        model: currentModelName,
        surface: geminiSurface,
        originalCwd: originalWorkspacePath,
        jobId: cleanJobId,
      });
      const successCircuit = getGeminiModelCircuit(currentModelName);
      successCircuit.consecutiveCapacityFailures = 0;
      successCircuit.openUntilMs = 0;
      geminiCapacityCircuit.consecutiveCapacityFailures = 0;
      geminiCapacityCircuit.openUntilMs = 0;
      return withGeminiMeta(result, {
        modelName: currentModelName,
        retryCount,
        notes,
      });
    }

    const errorType = classifyGeminiError(result);
    if (errorType === "model_not_found") {
      geminiCapacityCircuit.consecutiveCapacityFailures = 0;
      const currentKey = normalizeModelName(currentModelName).toLowerCase();
      if (currentKey) unavailableModels.add(currentKey);
      const nextModelIndex = pickNextAvailableModelIndex(modelIndex);
      if (nextModelIndex >= 0) {
        const toModel = modelCandidates[nextModelIndex] || "auto";
        notes.push(`[gemini] model_not_found -> model switch: ${displayModelName(currentModelName)} -> ${displayModelName(toModel)}`);
        modelIndex = nextModelIndex;
        continue;
      }
      notes.push(`[gemini] model_not_found and no more candidates: ${displayModelName(currentModelName)}`);
      await safeHook(onGiveUp, {
        reason: "model_not_found",
        retryCount,
        model: displayModelName(currentModelName),
      });
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }

    if (errorType !== "capacity_exhausted") {
      geminiCapacityCircuit.consecutiveCapacityFailures = 0;
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }

    const capacityCircuit = getGeminiModelCircuit(currentModelName);
    capacityCircuit.consecutiveCapacityFailures = Math.max(
      0,
      Number(capacityCircuit.consecutiveCapacityFailures || 0)
    ) + 1;
    if (capacityCircuit.consecutiveCapacityFailures >= 2) {
      capacityCircuit.openUntilMs = Date.now() + circuitCooldownMs;
      const currentKey = normalizeModelName(currentModelName).toLowerCase();
      if (currentKey) unavailableModels.add(currentKey);
      const nextModelIndex = pickNextAvailableModelIndex(modelIndex);
      const circuitMsg = `[gemini] capacity circuit opened for ${displayModelName(currentModelName)} for ${circuitCooldownMs}ms`;
      notes.push(circuitMsg);
      if (nextModelIndex >= 0) {
        const toModel = modelCandidates[nextModelIndex] || "auto";
        notes.push(`[gemini] capacity_exhausted -> model switch: ${displayModelName(currentModelName)} -> ${displayModelName(toModel)}`);
        await safeHook(onModelSwitch, {
          fromModel: displayModelName(currentModelName),
          toModel: displayModelName(toModel),
          retryCount: retryCount + 1,
          maxRetries,
          errorType,
        });
        modelIndex = nextModelIndex;
        consecutiveCapacityErrors = 0;
        retryCount += 1;
        continue;
      }
      await safeHook(onGiveUp, {
        reason: "capacity_circuit_opened",
        retryCount,
        maxRetries,
        cooldownMs: circuitCooldownMs,
      });
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }

    if (retryCount >= maxRetries) {
      notes.push(`[gemini] capacity retries exhausted: ${retryCount}/${maxRetries}`);
      await safeHook(onGiveUp, {
        reason: "max_retries",
        retryCount,
        maxRetries,
      });
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }

    const elapsedMs = Date.now() - startedAtMs;
    if (elapsedMs >= retryTimeboxMs) {
      const timeboxMsg = `[gemini] retry timebox exceeded: ${elapsedMs}/${retryTimeboxMs}ms`;
      notes.push(timeboxMsg);
      await safeHook(onGiveUp, {
        reason: "timebox_exceeded",
        retryCount,
        maxRetries,
        elapsedMs,
        retryTimeboxMs,
      });
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }

    consecutiveCapacityErrors += 1;
    if (consecutiveCapacityErrors >= switchAfter && modelIndex < (modelCandidates.length - 1)) {
      const fromModel = currentModelName;
      modelIndex += 1;
      consecutiveCapacityErrors = 0;
      const toModel = modelCandidates[modelIndex] || "auto";
      notes.push(`[gemini] capacity_exhausted -> model switch: ${displayModelName(fromModel)} -> ${displayModelName(toModel)}`);
      await safeHook(onModelSwitch, {
        fromModel: displayModelName(fromModel),
        toModel: displayModelName(toModel),
        retryCount: retryCount + 1,
        maxRetries,
        errorType,
      });
    }

    retryCount += 1;
    const delayMsRaw = capacityBackoffDelayMs(retryCount);
    const remainingTimeboxMs = Math.max(0, retryTimeboxMs - (Date.now() - startedAtMs));
    const delayMs = Math.min(delayMsRaw, remainingTimeboxMs);
    await safeHook(onRetry, {
      retryCount,
      maxRetries,
      errorType,
      delayMs,
      model: displayModelName(modelCandidates[modelIndex] || "auto"),
    });
    if (delayMs <= 0) {
      const timeboxMsg = `[gemini] retry timebox exhausted before wait: ${Date.now() - startedAtMs}/${retryTimeboxMs}ms`;
      notes.push(timeboxMsg);
      await safeHook(onGiveUp, {
        reason: "timebox_exceeded",
        retryCount,
        maxRetries,
        elapsedMs: Date.now() - startedAtMs,
        retryTimeboxMs,
      });
      return withGeminiMeta(result, {
        modelName: currentModelName,
        errorType,
        retryCount,
        notes,
      });
    }
    const waited = await waitWithAbort(delayMs, signal);
    if (!waited) {
      return withGeminiMeta(makeAbortedResult(), {
        modelName: modelCandidates[modelIndex] || "auto",
        errorType: "aborted",
        retryCount,
        notes,
      });
    }
  }
}


async function runGeminiReplacementPrompt(options = {}) {
  const replacement = normalizeGeminiReplacementProvider();
  const workspaceRoot = options?.workspaceRoot || options?.cwd || process.cwd();
  const cwd = options?.cwd || workspaceRoot;
  const prompt = String(options?.prompt || '');
  const jobId = options?.jobId || (String(options?.concurrencyKey || '').startsWith('job:') ? String(options?.concurrencyKey || '').slice(4).trim() : '');
  const surface = options?.surface || 'gemini_migrated_prompt';
  const agentId = options?.agentId || '';
  const roleId = options?.roleId || '';
  const timeoutMs = Number(options?.timeoutMs || 0) || 0;
  const migrationMetadata = {
    migrated_from_provider: 'gemini',
    replacement_provider: replacement,
    gemini_cli_disabled: true,
    original_model: String(options?.model || '').trim() || undefined,
    ...(options?.traceMetadata && typeof options.traceMetadata === 'object' ? options.traceMetadata : {}),
  };
  if (replacement === 'codex') {
    const { runCodexExec } = await import('./codex.js');
    const res = await runCodexExec({
      workspaceRoot,
      cwd,
      prompt,
      signal: options?.signal,
      jobId,
      model: sanitizeGeminiModelForProvider(options?.model || '', 'codex') || process.env.CODEX_MODEL || '',
      surface,
      agentId,
      roleId,
      timeoutMs: timeoutMs || Number(process.env.CODEX_EXEC_TIMEOUT_MS || 0) || 0,
      sandboxMode: surface === 'supervisor_router' ? (process.env.CHAT_SUPERVISOR_CODEX_SANDBOX_MODE || 'read-only') : undefined,
      approvalPolicy: surface === 'supervisor_router' ? (process.env.CHAT_SUPERVISOR_CODEX_APPROVAL_POLICY || 'never') : undefined,
      traceMetadata: migrationMetadata,
    });
    return { ...(res && typeof res === 'object' ? res : {}), provider: 'codex', migrated_from_provider: 'gemini' };
  }
  if (replacement === 'antigravity') {
    const { runAntigravityPrompt } = await import('./antigravity.js');
    const res = await runAntigravityPrompt({
      workspaceRoot,
      cwd,
      prompt,
      signal: options?.signal,
      jobId,
      model: sanitizeGeminiModelForProvider(options?.model || '', 'antigravity') || process.env.ANTIGRAVITY_MODEL || process.env.GOOGLE_AI_MODEL || '',
      surface,
      agentId,
      roleId,
      timeoutMs: timeoutMs || Number(process.env.ANTIGRAVITY_TIMEOUT_MS || 0) || 0,
      traceMetadata: migrationMetadata,
      env: options?.extraEnv && typeof options.extraEnv === 'object' ? options.extraEnv : {},
    });
    return { ...(res && typeof res === 'object' ? res : {}), provider: 'antigravity', migrated_from_provider: 'gemini' };
  }
  return {
    ok: false,
    exitCode: -1,
    stdout: '',
    stderr: `${geminiCliDisabledMessage()} Replacement provider is ${replacement || 'disabled'}.`,
    durationMs: 0,
    used_model: replacement || 'disabled',
    provider: replacement || 'disabled',
    migrated_from_provider: 'gemini',
  };
}

export async function runGeminiPrompt(options = {}) {
  if (geminiCliDisabledByDefault()) {
    return await runGeminiReplacementPrompt(options);
  }
  const traceStartedAtMs = Date.now();
  const traceStartedAt = new Date(traceStartedAtMs).toISOString();
  const result = await runGeminiPromptInternal(options);
  const traceEndedAtMs = Date.now();
  const traceEndedAt = new Date(traceEndedAtMs).toISOString();
  const wallDurationMs = Math.max(0, traceEndedAtMs - traceStartedAtMs);
  const tracedResult = {
    ...(result || {}),
    wallDurationMs,
    startedAt: traceStartedAt,
    endedAt: traceEndedAt,
  };
  const promptText = String(options?.prompt ?? "");
  const originalTraceCwd = path.resolve(String(options?.cwd || options?.workspaceRoot || process.cwd()).trim() || process.cwd());
  const commandCwd = resolveGeminiTraceCommandCwd(options);
  const traceModel = String(tracedResult?.used_model || options?.model || process.env.GEMINI_MODEL_PRIMARY || process.env.GEMINI_MODEL || "auto").trim() || "auto";
  return attachGeminiTrace({
    result: tracedResult,
    jobId: options?.jobId || (String(options?.concurrencyKey || "").startsWith("job:") ? String(options?.concurrencyKey || "").slice(4).trim() : ""),
    surface: options?.surface || "gemini_prompt",
    agentId: options?.agentId || "",
    roleId: options?.roleId || "",
    model: traceModel,
    prompt: promptText,
    cwd: commandCwd,
    workspaceRoot: originalTraceCwd,
    metadata: {
      approval_mode: options?.approvalMode || process.env.GEMINI_APPROVAL_MODE || "default",
      concurrency_key: options?.concurrencyKey || null,
      settings_overwrite: options?.settingsOverwrite || null,
      original_cwd: originalTraceCwd,
      command_cwd: commandCwd,
      context_mode: resolveGeminiContextMode(optionsContextModeFromEnv(options?.extraEnv)),
      ...asObject(options?.traceMetadata),
    },
  });
}
