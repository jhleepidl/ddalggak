import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./proc.js";

const VALID_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const PLAN_DISABLED_RE = /Approval mode "plan" is only available when experimental\.plan is enabled\./i;
const MODEL_CAPACITY_EXHAUSTED_RE = /MODEL_CAPACITY_EXHAUSTED/i;
const NO_CAPACITY_RE = /No capacity available for model/i;
const RESOURCE_EXHAUSTED_RE = /RESOURCE_EXHAUSTED/i;
const STATUS_429_RE = /\b429\b|status[^0-9]{0,20}429|code[^0-9]{0,20}429/i;
const STATUS_404_RE = /\b404\b|status[^0-9]{0,20}404|code[^0-9]{0,20}404/i;
const QUOTA_EXCEEDED_RE = /quota[_\s-]*exceeded|quota\b.*(exceed|exhaust|limit)|billing.*(limit|quota)/i;
const REQUESTED_ENTITY_NOT_FOUND_RE = /Requested entity was not found/i;
const MODEL_NOT_FOUND_RE = /ModelNotFoundError/i;
const GEMINI_25_MODEL_RE = /\bgemini-2\.5(?:-[a-z0-9._-]+)?\b/i;
const MODEL_FLAG_UNSUPPORTED_RE = /(unknown|unrecognized|unexpected)\s+(option|argument|flag)[^-\n\r]*--model|unknown flag:\s*--model/i;
const DEFAULT_GEMINI_MODEL_PRIMARY = "gemini-3-flash-preview";
const DEFAULT_GEMINI_MODEL_FALLBACKS = "auto";
const DEFAULT_CAPACITY_MAX_RETRIES = 8;
const DEFAULT_CAPACITY_SWITCH_AFTER = 2;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_DELAY_MS = 30000;
const DEFAULT_BACKOFF_JITTER_MS = 500;
const DEFAULT_MAX_CONCURRENT_GEMINI = 1;
const DEFAULT_GEMINI_MIN_INTERVAL_MS = 2000;
const DEFAULT_GEMINI_RETRY_TIMEBOX_MS = 180000;
const DEFAULT_GEMINI_CAPACITY_COOLDOWN_MS = 60000;
const DEFAULT_GEMINI_SETTINGS_OVERWRITE = "merge";
const DEFAULT_GEMINI_DEBUG_LOG = "gemini_debug.log";

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

function toPositiveInt(raw, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
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

function buildModelCandidates(explicitModel = "") {
  const primary = normalizeModelName(
    explicitModel
    || process.env.GEMINI_MODEL_PRIMARY
    || process.env.GEMINI_MODEL
    || DEFAULT_GEMINI_MODEL_PRIMARY
  );
  const fallbackRaw = String(process.env.GEMINI_MODEL_FALLBACKS || DEFAULT_GEMINI_MODEL_FALLBACKS);
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

  pushModel(primary);
  for (const token of fallbackRaw.split(",")) pushModel(token);
  if (out.length === 0) out.push("auto");
  return out;
}

function classifyGeminiError(result = {}) {
  const text = [
    String(result.stdout || ""),
    String(result.stderr || ""),
  ].join("\n");
  if (!text.trim()) return "unknown_error";

  const isCapacityExhausted = NO_CAPACITY_RE.test(text)
    || MODEL_CAPACITY_EXHAUSTED_RE.test(text)
    || (RESOURCE_EXHAUSTED_RE.test(text) && STATUS_429_RE.test(text));
  if (isCapacityExhausted) return "capacity_exhausted";

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

function makeCombinedStderr(parts = []) {
  return parts.map((part) => String(part || "").trim()).filter(Boolean).join("\n\n");
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
  const modelEnv = {
    ...(model ? { GEMINI_MODEL: model } : {}),
    GEMINI_DISABLE_DIRTREE: String(process.env.GEMINI_DISABLE_DIRTREE || "1").trim() || "1",
    ...asObject(extraEnv),
  };
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
  });
  if (stdinRun.ok) return stdinRun;

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
  });
  if (inlineRun.ok) return inlineRun;

  return {
    ...inlineRun,
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

async function acquireGeminiGlobalSlot() {
  const limit = getGeminiConcurrencyLimit();
  if (geminiGlobalLimiter.running < limit) {
    geminiGlobalLimiter.running += 1;
    return;
  }
  await new Promise((resolve) => {
    geminiGlobalLimiter.waiters.push(resolve);
  });
}

async function withGeminiGlobalLimiter(fn) {
  await acquireGeminiGlobalSlot();
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

export async function runGeminiPrompt({
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
}) {
  // Keep CLI prompt argument simple and stream the real prompt via stdin.
  // This avoids parser issues when prompt text starts with "-" or markdown fences.
  const promptText = String(prompt ?? "");
  if (!promptText.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "[gemini] empty prompt", durationMs: 0 };
  }

  const timeoutMs = 30 * 60 * 1000;
  const commandCwd = path.resolve(String(cwd || workspaceRoot || process.cwd()).trim() || process.cwd());
  const workspacePath = commandCwd;
  ensureGeminiWorkspaceConfig(workspacePath, { overwritePolicy: settingsOverwrite, patchSettings: workspaceSettingsPatch });
  const cleanJobId = String(jobId || "").trim() || (
    String(concurrencyKey || "").startsWith("job:")
      ? String(concurrencyKey || "").slice(4).trim()
      : ""
  );
  const baseEnv = {
    GEMINI_WORKSPACE_PATH: workspacePath,
    ...asObject(extraEnv),
  };
  void concurrencyKey;
  const requestedMode = VALID_APPROVAL_MODES.has(String(approvalMode || "").trim()) ? String(approvalMode || "").trim() : resolveApprovalMode();
  const modelCandidates = buildModelCandidates(model);
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
    if (Number(geminiCapacityCircuit.openUntilMs || 0) > 0 && Number(geminiCapacityCircuit.openUntilMs || 0) <= nowMs) {
      geminiCapacityCircuit.openUntilMs = 0;
      geminiCapacityCircuit.consecutiveCapacityFailures = 0;
    }
    if (Number(geminiCapacityCircuit.openUntilMs || 0) > nowMs) {
      const remainingMs = Math.max(0, Math.floor(Number(geminiCapacityCircuit.openUntilMs || 0) - nowMs));
      const circuitMsg = `[gemini] capacity circuit open; retry after ${remainingMs}ms`;
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
      `[gemini] job=${cleanJobId || "-"} cwd=${workspacePath} model=${displayModelName(currentModelName)} retry=${retryCount}`
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
    });
    if (result.ok) {
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

    geminiCapacityCircuit.consecutiveCapacityFailures = Math.max(
      0,
      Number(geminiCapacityCircuit.consecutiveCapacityFailures || 0)
    ) + 1;
    if (geminiCapacityCircuit.consecutiveCapacityFailures >= 3) {
      geminiCapacityCircuit.openUntilMs = Date.now() + circuitCooldownMs;
      const circuitMsg = `[gemini] capacity circuit opened for ${circuitCooldownMs}ms`;
      notes.push(circuitMsg);
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
