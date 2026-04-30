import { spawn } from "node:child_process";

function shouldUseProcessGroup(opts = {}) {
  if (process.platform === "win32") return false;
  if (opts.detached === false) return false;
  return true;
}

export async function runCommand(command, args = [], opts = {}) {
  const { cwd, shell = false, timeoutMs = 120000, env = {}, input, abortSignal } = opts;
  const startedAt = Date.now();
  const useProcessGroup = shouldUseProcessGroup(opts);
  const hardKillGraceMs = Math.max(250, Math.floor(Number(opts.hardKillGraceMs ?? 1500) || 1500));

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let wasAborted = false;
    let didTimeout = false;
    let killed = false;
    let killedProcessGroup = false;
    let settled = false;
    let killTimer = null;
    let hardCloseTimer = null;
    let abortKillTimer = null;
    let child = null;

    const cleanup = () => {
      if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
      if (killTimer) clearTimeout(killTimer);
      if (hardCloseTimer) clearTimeout(hardCloseTimer);
      if (abortKillTimer) clearTimeout(abortKillTimer);
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
      });
    };

    const scheduleHardResolve = (reason) => {
      if (hardCloseTimer || settled) return;
      hardCloseTimer = setTimeout(() => {
        finish({
          ok: false,
          exitCode: -1,
          signal: "SIGKILL",
          stdout,
          stderr: `${stderr}\n[hard-resolve] child did not close after ${reason}`,
          hardResolved: true,
        });
      }, hardKillGraceMs);
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

    const abortHandler = () => {
      wasAborted = true;
      stderr += "\n[aborted]";
      killChild("SIGTERM");
      abortKillTimer = setTimeout(() => {
        killChild("SIGKILL");
        scheduleHardResolve("abort");
      }, 1200);
      abortKillTimer.unref?.();
    };

    child = spawn(command, args, {
      cwd,
      shell,
      env: { ...process.env, ...env },
      detached: useProcessGroup,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      killChild("SIGKILL");
      scheduleHardResolve(`timeout ${timeoutMs}ms`);
    }, timeoutMs);

    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", d => (stdout += d.toString("utf8")));
    child.stderr?.on("data", d => (stderr += d.toString("utf8")));

    child.on("error", e => {
      finish({
        ok: false,
        exitCode: -1,
        signal: null,
        stdout,
        stderr: stderr + `\n[spawn error] ${String(e?.message ?? e)}`,
      });
    });

    child.on("close", (code, signal) => {
      const forcedFailure = wasAborted || didTimeout;
      finish({
        ok: !forcedFailure && code === 0,
        exitCode: forcedFailure ? -1 : (code ?? -1),
        signal: signal || null,
        stdout,
        stderr,
      });
    });
  });
}
