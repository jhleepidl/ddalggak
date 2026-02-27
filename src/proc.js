import { spawn } from "node:child_process";

export async function runCommand(command, args = [], opts = {}) {
  const { cwd, shell = false, timeoutMs = 120000, env = {} } = opts;
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";

    const child = spawn(command, args, { cwd, shell, env: { ...process.env, ...env } });

    const killTimer = setTimeout(() => {
      stderr += `\n[timeout] killed after ${timeoutMs}ms`;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);

    child.stdout?.on("data", d => (stdout += d.toString("utf8")));
    child.stderr?.on("data", d => (stderr += d.toString("utf8")));

    child.on("error", e => {
      clearTimeout(killTimer);
      resolve({ ok: false, exitCode: -1, stdout, stderr: stderr + `\n[spawn error] ${String(e?.message ?? e)}`, durationMs: Date.now() - startedAt });
    });

    child.on("close", code => {
      clearTimeout(killTimer);
      resolve({ ok: code === 0, exitCode: code ?? -1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}
