import { spawn } from "node:child_process";

export async function runCommand(command, args = [], opts = {}) {
  const { cwd, shell = false, timeoutMs = 120000, env = {}, input, abortSignal } = opts;
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let wasAborted = false;

    const child = spawn(command, args, { cwd, shell, env: { ...process.env, ...env } });

    if (typeof input !== "undefined") {
      try {
        child.stdin?.on("error", () => {});
        child.stdin?.end(String(input));
      } catch {}
    } else {
      try { child.stdin?.end(); } catch {}
    }

    const killTimer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    const abortHandler = () => {
      wasAborted = true;
      stderr += "\n[aborted]";
      try { child.kill("SIGTERM"); } catch {}
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
      }, 1200);
    };
    if (abortSignal) {
      if (abortSignal.aborted) abortHandler();
      else abortSignal.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout?.on("data", d => (stdout += d.toString("utf8")));
    child.stderr?.on("data", d => (stderr += d.toString("utf8")));

    child.on("error", e => {
      if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
      clearTimeout(killTimer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + `\n[spawn error] ${String(e?.message ?? e)}`, durationMs: Date.now() - startedAt });
    });

    child.on("close", code => {
      if (abortSignal) abortSignal.removeEventListener("abort", abortHandler);
      clearTimeout(killTimer);
      resolve({
        ok: !wasAborted && code === 0,
        exitCode: wasAborted ? -1 : (code ?? -1),
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
