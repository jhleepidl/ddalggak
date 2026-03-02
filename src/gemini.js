import { runCommand } from "./proc.js";

const VALID_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const PLAN_DISABLED_RE = /Approval mode "plan" is only available when experimental\.plan is enabled\./i;
const MODEL_CAPACITY_EXHAUSTED_RE = /MODEL_CAPACITY_EXHAUSTED/i;
const NO_CAPACITY_RE = /No capacity available for model/i;
const RESOURCE_EXHAUSTED_RE = /RESOURCE_EXHAUSTED/i;
const STATUS_429_RE = /\b429\b|status[^0-9]{0,20}429|code[^0-9]{0,20}429/i;
const QUOTA_EXCEEDED_RE = /quota[_\s-]*exceeded|quota\b.*(exceed|exhaust|limit)|billing.*(limit|quota)/i;
const MODEL_FLAG_UNSUPPORTED_RE = /(unknown|unrecognized|unexpected)\s+(option|argument|flag)[^-\n\r]*--model|unknown flag:\s*--model/i;
const DEFAULT_GEMINI_MODEL_PRIMARY = "gemini-3-flash-preview";
const DEFAULT_GEMINI_MODEL_FALLBACKS = "auto,gemini-2.5-flash,gemini-2.5-pro";
const DEFAULT_CAPACITY_MAX_RETRIES = 8;
const DEFAULT_CAPACITY_SWITCH_AFTER = 2;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_DELAY_MS = 45000;
const DEFAULT_BACKOFF_JITTER_MS = 500;
const DEFAULT_MAX_CONCURRENT_GEMINI = 1;

let planModeAvailability = null;
let modelFlagAvailability = null;
const geminiConcurrencyByKey = new Map(); // key -> { running, waiters: [{ resolve }] }

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
    process.env.GEMINI_CAPACITY_MAX_RETRIES,
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
    process.env.GEMINI_CAPACITY_BACKOFF_BASE_MS,
    DEFAULT_BACKOFF_BASE_MS,
    { min: 200, max: 10000 }
  );
}

function getBackoffMaxDelayMs() {
  return toPositiveInt(
    process.env.GEMINI_CAPACITY_MAX_DELAY_MS,
    DEFAULT_BACKOFF_MAX_DELAY_MS,
    { min: 1000, max: 120000 }
  );
}

function getBackoffJitterMs() {
  return toPositiveInt(
    process.env.GEMINI_CAPACITY_JITTER_MS,
    DEFAULT_BACKOFF_JITTER_MS,
    { min: 0, max: 5000 }
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
}) {
  const modelEnv = model ? { GEMINI_MODEL: model } : {};
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

async function invokeGemini({ promptText, approvalMode, commandCwd, timeoutMs, signal, modelName }) {
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
}) {
  const firstMode = requestedMode === "plan" && planModeAvailability === false ? "default" : requestedMode;
  const first = await invokeGemini({
    promptText,
    approvalMode: firstMode,
    commandCwd,
    timeoutMs,
    signal,
    modelName,
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

function resolveConcurrencyKey(explicitKey, commandCwd, workspaceRoot) {
  const clean = String(explicitKey || "").trim();
  if (clean) return clean;
  const cwdKey = String(commandCwd || workspaceRoot || process.cwd()).trim();
  return cwdKey || "__gemini_default__";
}

function getConcurrencyState(key) {
  const cleanKey = String(key || "__gemini_default__");
  if (!geminiConcurrencyByKey.has(cleanKey)) {
    geminiConcurrencyByKey.set(cleanKey, { running: 0, waiters: [] });
  }
  return geminiConcurrencyByKey.get(cleanKey);
}

function releaseGeminiSlot(key) {
  const cleanKey = String(key || "__gemini_default__");
  const state = geminiConcurrencyByKey.get(cleanKey);
  if (!state) return;
  state.running = Math.max(0, Number(state.running || 0) - 1);
  const limit = getGeminiConcurrencyLimit();
  while (state.running < limit && state.waiters.length > 0) {
    const waiter = state.waiters.shift();
    state.running += 1;
    waiter.resolve(() => releaseGeminiSlot(cleanKey));
  }
  if (state.running === 0 && state.waiters.length === 0) {
    geminiConcurrencyByKey.delete(cleanKey);
  }
}

async function acquireGeminiSlot(key) {
  const cleanKey = String(key || "__gemini_default__");
  const state = getConcurrencyState(cleanKey);
  const limit = getGeminiConcurrencyLimit();
  if (state.running < limit) {
    state.running += 1;
    return () => releaseGeminiSlot(cleanKey);
  }
  return await new Promise((resolve) => {
    state.waiters.push({ resolve });
  });
}

async function withGeminiConcurrency(key, fn) {
  const release = await acquireGeminiSlot(key);
  try {
    return await fn();
  } finally {
    release();
  }
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
  onRetry = null,
  onModelSwitch = null,
}) {
  // Keep CLI prompt argument simple and stream the real prompt via stdin.
  // This avoids parser issues when prompt text starts with "-" or markdown fences.
  const promptText = String(prompt ?? "");
  if (!promptText.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "[gemini] empty prompt", durationMs: 0 };
  }

  const timeoutMs = 30 * 60 * 1000;
  const commandCwd = cwd || workspaceRoot;
  const requestedMode = resolveApprovalMode();
  const modelCandidates = buildModelCandidates(model);
  const maxRetries = getCapacityMaxRetries();
  const switchAfter = getCapacitySwitchAfter();
  const queueKey = resolveConcurrencyKey(concurrencyKey, commandCwd, workspaceRoot);

  return await withGeminiConcurrency(queueKey, async () => {
    let modelIndex = 0;
    let retryCount = 0;
    let consecutiveCapacityErrors = 0;
    const notes = [];

    while (true) {
      if (signal?.aborted) {
        return withGeminiMeta(makeAbortedResult(), {
          modelName: modelCandidates[modelIndex] || "auto",
          errorType: "aborted",
          retryCount,
          notes,
        });
      }

      const currentModelName = modelCandidates[modelIndex] || "auto";
      const result = await invokeGeminiWithPlanFallback({
        promptText,
        requestedMode,
        commandCwd,
        timeoutMs,
        signal,
        modelName: currentModelName,
      });
      if (result.ok) {
        return withGeminiMeta(result, {
          modelName: currentModelName,
          retryCount,
          notes,
        });
      }

      const errorType = classifyGeminiError(result);
      if (errorType !== "capacity_exhausted") {
        return withGeminiMeta(result, {
          modelName: currentModelName,
          errorType,
          retryCount,
          notes,
        });
      }

      if (retryCount >= maxRetries) {
        notes.push(`[gemini] capacity retries exhausted: ${retryCount}/${maxRetries}`);
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
      const delayMs = capacityBackoffDelayMs(retryCount);
      await safeHook(onRetry, {
        retryCount,
        maxRetries,
        errorType,
        delayMs,
        model: displayModelName(modelCandidates[modelIndex] || "auto"),
      });
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
  });
}
