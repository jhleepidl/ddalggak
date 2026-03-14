import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function isPidRunning(pid, { processImpl = process } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    processImpl.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function parseLockPid(raw = "") {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    const match = String(raw).match(/\b\d+\b/);
    if (!match) return null;
    const pid = Number(match[0]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  }
}

export function createSingleInstanceLock({
  enabled = true,
  lockFile = "",
  fsImpl = fs,
  pathImpl = path,
  processImpl = process,
} = {}) {
  let hasLock = false;

  function acquire() {
    if (!enabled || !lockFile) return false;
    fsImpl.mkdirSync(pathImpl.dirname(lockFile), { recursive: true });

    if (fsImpl.existsSync(lockFile)) {
      const existingPid = parseLockPid(fsImpl.readFileSync(lockFile, "utf8"));
      if (existingPid && existingPid !== processImpl.pid && isPidRunning(existingPid, { processImpl })) {
        const error = new Error(`Another telegram runner process is already running (pid=${existingPid}).`);
        error.code = "telegram_single_instance_conflict";
        error.pid = existingPid;
        throw error;
      }
    }

    fsImpl.writeFileSync(
      lockFile,
      `${JSON.stringify({ pid: processImpl.pid, startedAt: new Date().toISOString() })}\n`,
      "utf8"
    );
    hasLock = true;
    return true;
  }

  function release() {
    if (!hasLock || !lockFile) return false;
    try {
      if (fsImpl.existsSync(lockFile)) {
        const existingPid = parseLockPid(fsImpl.readFileSync(lockFile, "utf8"));
        if (!existingPid || existingPid === processImpl.pid) fsImpl.unlinkSync(lockFile);
      }
    } catch {}
    hasLock = false;
    return true;
  }

  return {
    acquire,
    release,
    hasLock: () => hasLock,
  };
}

export function createShutdownHandler({
  bot = null,
  releaseLock = () => {},
  processImpl = process,
} = {}) {
  let shuttingDown = false;

  return async function shutdown(code = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await bot?.stopPolling?.({ cancel: true });
    } catch {}
    try {
      releaseLock();
    } finally {
      processImpl.exit(code);
    }
  };
}

export function createPollingErrorHandler({
  shutdown = async () => {},
  logger = console.error,
  suppressWindowMs = 10_000,
} = {}) {
  let lastErrorSig = "";
  let lastErrorAt = 0;
  let suppressedErrors = 0;

  return function onPollingError(error) {
    const code = String(error?.code ?? "UNKNOWN");
    const message = String(error?.message ?? error);
    const telegramCode = Number(error?.response?.body?.error_code ?? 0);
    const sig = `${code}|${telegramCode}|${message}`;
    const now = Date.now();

    if (sig === lastErrorSig && now - lastErrorAt < suppressWindowMs) {
      suppressedErrors += 1;
      return;
    }

    if (suppressedErrors > 0) {
      logger(`polling_error repeated ${suppressedErrors} times (suppressed).`);
      suppressedErrors = 0;
    }

    lastErrorSig = sig;
    lastErrorAt = now;

    if (code === "ETELEGRAM" && telegramCode === 409) {
      logger("Telegram polling conflict (409): another bot instance is already using this token.");
      logger("Run only one instance (npm start or systemd service), then restart.");
      void shutdown(1);
      return;
    }

    if (code === "EFATAL" && message.includes("AggregateError")) {
      logger("Telegram polling fatal network error (EFATAL AggregateError).");
      logger("Check outbound network/DNS, and keep TELEGRAM_FORCE_IPV4=true if your host has unstable IPv6.");
      return;
    }

    logger(`polling_error [${code}] ${message}`);
  };
}

export function registerLifecycleSignals({
  shutdown = async () => {},
  releaseLock = () => {},
  processImpl = process,
} = {}) {
  const onExit = () => { releaseLock(); };
  const onSigInt = () => { void shutdown(0); };
  const onSigTerm = () => { void shutdown(0); };

  processImpl.on("exit", onExit);
  processImpl.on("SIGINT", onSigInt);
  processImpl.on("SIGTERM", onSigTerm);

  return function unregister() {
    const off = typeof processImpl.off === "function"
      ? processImpl.off.bind(processImpl)
      : processImpl.removeListener.bind(processImpl);
    off("exit", onExit);
    off("SIGINT", onSigInt);
    off("SIGTERM", onSigTerm);
  };
}
