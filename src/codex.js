import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./proc.js";

function appendCodexDebugLog(line = "") {
  const file = path.resolve(process.env.CODEX_DEBUG_LOG || "codex_debug.log");
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(line || "")}\n`, "utf8");
  } catch {}
}

export async function runCodexExec({ workspaceRoot, prompt, signal, cwd, jobId = "", model = "" }) {
  // Requires Codex CLI logged in on the server
  const sandboxMode = process.env.CODEX_SANDBOX_MODE || "workspace-write";
  const approvalPolicy = process.env.CODEX_APPROVAL_POLICY || "never";
  const timeoutMs = 45 * 60 * 1000;
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  const requestedModel = String(model || "").trim();
  appendCodexDebugLog(`[codex] job=${String(jobId || "").trim() || "-"} cwd=${commandCwd} workspace=${workspacePath} model=${requestedModel || "(default)"}`);

  // Keep Codex workspace explicit (-C), while process CWD can be the run directory.
  // Feed prompt via stdin ("-") so prompt text is never parsed as CLI args.
  const modelArgs = requestedModel ? ["--model", requestedModel] : [];
  const modernArgs = [...modelArgs, "exec", "-C", workspacePath, "--sandbox", sandboxMode, "-c", `approval_policy=${approvalPolicy}`, "-"];
  const modern = await runCommand("codex", modernArgs, { cwd: commandCwd, timeoutMs, input: prompt, abortSignal: signal });
  if (modern.ok) return modern;

  // Fallback for older codex-cli variants that still support this flag in `exec`.
  const optionCompatibilityError = [
    "unexpected argument '-c'",
    "unknown argument '-c'",
    "unknown config key",
    "unknown field `approval_policy`",
  ].some((needle) => (modern.stderr || "").toLowerCase().includes(needle.toLowerCase()));
  if (!optionCompatibilityError) return modern;

  const legacyArgs = [...modelArgs, "exec", "-C", workspacePath, "--sandbox", sandboxMode, "--ask-for-approval", approvalPolicy, "-"];
  const legacy = await runCommand("codex", legacyArgs, { cwd: commandCwd, timeoutMs, input: prompt, abortSignal: signal });
  if (legacy.ok) return legacy;

  // If legacy flag is unsupported too, keep modern error as the primary one.
  if ((legacy.stderr || "").includes("unexpected argument '--ask-for-approval'")) return modern;
  return legacy;
}
