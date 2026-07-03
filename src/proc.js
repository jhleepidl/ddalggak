import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";


export function makeUtf8StreamDecoder() {
  const decoder = new StringDecoder("utf8");
  return {
    write(chunk) {
      if (Buffer.isBuffer(chunk)) return decoder.write(chunk);
      if (chunk instanceof Uint8Array) return decoder.write(Buffer.from(chunk));
      return decoder.write(Buffer.from(String(chunk ?? ""), "utf8"));
    },
    end() {
      return decoder.end();
    },
  };
}

function shouldUseProcessGroup(opts = {}) {
  if (process.platform === "win32") return false;
  if (opts.detached === false) return false;
  return true;
}

function positiveInt(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function envInt(name, fallback, bounds = {}) {
  const raw = process.env[name];
  if (typeof raw === 'undefined' || String(raw).trim() === '') return fallback;
  return positiveInt(raw, fallback, bounds);
}

function makeBoundedTextBuffer({ maxChars = 0, marker = '\n…(truncated; latest output preserved below)…\n' } = {}) {
  const limit = positiveInt(maxChars, 0, { min: 0 });
  const cleanMarker = String(marker || '\n…(truncated)…\n');
  const headLimit = limit > cleanMarker.length + 32
    ? Math.max(16, Math.floor((limit - cleanMarker.length) * 0.45))
    : Math.max(0, Math.floor(limit * 0.5));
  const tailLimit = Math.max(0, limit - headLimit - cleanMarker.length);
  let raw = '';
  let head = '';
  let tail = '';
  let totalChars = 0;
  let truncated = false;

  function append(value = '') {
    const chunk = String(value ?? '');
    if (!chunk) return;
    totalChars += chunk.length;
    if (!(limit > 0)) {
      raw += chunk;
      return;
    }
    if (!truncated && head.length + chunk.length <= limit) {
      head += chunk;
      return;
    }
    if (!truncated) {
      const combined = head + chunk;
      head = combined.slice(0, headLimit);
      tail = tailLimit > 0 ? combined.slice(-tailLimit) : '';
      truncated = true;
      return;
    }
    if (tailLimit > 0) tail = (tail + chunk).slice(-tailLimit);
  }

  function text() {
    if (!(limit > 0)) return raw;
    return truncated ? `${head}${cleanMarker}${tail}` : head;
  }

  return {
    append,
    text,
    get totalChars() { return totalChars; },
    get truncated() { return truncated; },
  };
}

function patternMatches(pattern, text = '') {
  if (!pattern) return false;
  if (pattern instanceof RegExp) return pattern.test(text);
  return String(text || '').includes(String(pattern));
}

export async function runCommand(command, args = [], opts = {}) {
  const {
    cwd,
    shell = false,
    timeoutMs = 120000,
    env = {},
    input,
    abortSignal,
    earlyExitPattern = null,
    earlyExitLabel = 'output_pattern',
  } = opts;
  const startedAt = Date.now();
  const useProcessGroup = shouldUseProcessGroup(opts);
  const hardKillGraceMs = Math.max(250, Math.floor(Number(opts.hardKillGraceMs ?? 1500) || 1500));
  const earlyKillGraceMs = Math.max(250, Math.floor(Number(opts.earlyKillGraceMs ?? 750) || 750));
  const maxStdoutChars = positiveInt(
    opts.maxStdoutChars ?? envInt('RUN_COMMAND_MAX_STDOUT_CHARS', 2_000_000, { min: 10000, max: 50_000_000 }),
    2_000_000,
    { min: 0, max: 100_000_000 }
  );
  const maxStderrChars = positiveInt(
    opts.maxStderrChars ?? envInt('RUN_COMMAND_MAX_STDERR_CHARS', 1_000_000, { min: 10000, max: 50_000_000 }),
    1_000_000,
    { min: 0, max: 100_000_000 }
  );

  return await new Promise((resolve) => {
    const stdoutBuffer = makeBoundedTextBuffer({ maxChars: maxStdoutChars });
    const stderrBuffer = makeBoundedTextBuffer({ maxChars: maxStderrChars });
    const stdoutDecoder = makeUtf8StreamDecoder();
    const stderrDecoder = makeUtf8StreamDecoder();
    let stdoutDecoderEnded = false;
    let stderrDecoderEnded = false;
    let wasAborted = false;
    let didTimeout = false;
    let killed = false;
    let killedProcessGroup = false;
    let earlyTerminated = false;
    let settled = false;
    let killTimer = null;
    let hardCloseTimer = null;
    let abortKillTimer = null;
    let earlyKillTimer = null;
    let child = null;

    const flushStdoutDecoder = () => {
      if (stdoutDecoderEnded) return;
      const rest = stdoutDecoder.end();
      if (rest) stdoutBuffer.append(rest);
      stdoutDecoderEnded = true;
    };
    const flushStderrDecoder = () => {
      if (stderrDecoderEnded) return;
      const rest = stderrDecoder.end();
      if (rest) stderrBuffer.append(rest);
      stderrDecoderEnded = true;
    };

    const currentStdout = () => stdoutBuffer.text();
    const currentStderr = () => stderrBuffer.text();
    const finalStdout = () => {
      flushStdoutDecoder();
      return stdoutBuffer.text();
    };
    const finalStderr = () => {
      flushStderrDecoder();
      return stderrBuffer.text();
    };

    const cleanup = () => {
      if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
      if (killTimer) clearTimeout(killTimer);
      if (hardCloseTimer) clearTimeout(hardCloseTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
      if (earlyKillTimer) clearTimeout(earlyKillTimer);
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        ...result,
        durationMs: Date.now() - startedAt,
        timedOut: didTimeout,
        aborted: wasAborted,
        killed,
        killedProcessGroup,
        earlyTerminated,
        stdoutChars: stdoutBuffer.totalChars,
        stderrChars: stderrBuffer.totalChars,
        stdoutTruncated: stdoutBuffer.truncated,
        stderrTruncated: stderrBuffer.truncated,
      });
    };

    const scheduleHardResolve = (reason) => {
      if (hardCloseTimer || settled) return;
      hardCloseTimer = setTimeout(() => {
        finish({
          ok: false,
          exitCode: -1,
          signal: "SIGKILL",
          stdout: finalStdout(),
          stderr: `${finalStderr()}\n[hard-resolve] child did not close after ${reason}`,
          hardResolved: true,
        });
      }, hardKillGraceMs);
      hardCloseTimer.unref?.();
    };

    const killChild = (signal = "SIGTERM") => {
      if (settled || !child) return;
      try {
        if (useProcessGroup && child.pid) {
          process.kill(-child.pid, signal);
          killedProcessGroup = true;
        } else {
          child.kill(signal);
        }
        killed = true;
      } catch {
        try {
          child.kill(signal);
          killed = true;
        } catch {}
      }
    };

    const maybeEarlyTerminate = (streamName, chunk = '') => {
      if (!earlyExitPattern || earlyTerminated || settled) return;
      const searchable = `${chunk}\n${streamName === 'stderr' ? currentStderr() : currentStdout()}`;
      if (!patternMatches(earlyExitPattern, searchable)) return;
      earlyTerminated = true;
      stderrBuffer.append(`\n[early-terminate] matched ${String(earlyExitLabel || 'output_pattern')} on ${streamName}`);
      killChild("SIGTERM");
      earlyKillTimer = setTimeout(() => {
        killChild("SIGKILL");
        scheduleHardResolve(`early terminate ${String(earlyExitLabel || 'output_pattern')}`);
      }, earlyKillGraceMs);
      earlyKillTimer.unref?.();
    };

    const abortHandler = () => {
      wasAborted = true;
      stderrBuffer.append("\n[aborted]");
      killChild("SIGTERM");
      abortKillTimer = setTimeout(() => {
        killChild("SIGKILL");
        scheduleHardResolve("abort");
      }, 1200);
      abortKillTimer.unref?.();
    };

    try {
      child = spawn(command, args, {
        cwd,
        shell,
        env: { ...process.env, ...env },
        detached: useProcessGroup,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      finish({
        ok: false,
        exitCode: -1,
        signal: null,
        stdout: '',
        stderr: `[spawn error] ${String(e?.message ?? e)}`,
      });
      return;
    }

    if (typeof input !== "undefined") {
      try {
        child.stdin?.on("error", () => {});
        child.stdin?.end(String(input));
      } catch {}
    } else {
      try { child.stdin?.end(); } catch {}
    }

    killTimer = setTimeout(() => {
      didTimeout = true;
      stderrBuffer.append(`\n[timeout] killed after ${timeoutMs}ms`);
      killChild("SIGKILL");
      scheduleHardResolve(`timeout ${timeoutMs}ms`);
    }, timeoutMs);
    killTimer.unref?.();

    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", (d) => {
      const chunk = stdoutDecoder.write(d);
      stdoutBuffer.append(chunk);
      maybeEarlyTerminate('stdout', chunk);
    });
    child.stdout?.on("end", flushStdoutDecoder);
    child.stderr?.on("data", (d) => {
      const chunk = stderrDecoder.write(d);
      stderrBuffer.append(chunk);
      maybeEarlyTerminate('stderr', chunk);
    });
    child.stderr?.on("end", flushStderrDecoder);

    child.on("error", e => {
      finish({
        ok: false,
        exitCode: -1,
        signal: null,
        stdout: finalStdout(),
        stderr: `${finalStderr()}\n[spawn error] ${String(e?.message ?? e)}`,
      });
    });

    child.on("close", (code, signal) => {
      const forcedFailure = wasAborted || didTimeout || earlyTerminated;
      finish({
        ok: !forcedFailure && code === 0,
        exitCode: forcedFailure ? -1 : (code ?? -1),
        signal: signal || null,
        stdout: finalStdout(),
        stderr: finalStderr(),
      });
    });
  });
}
