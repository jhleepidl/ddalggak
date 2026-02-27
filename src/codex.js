import { runCommand } from "./proc.js";

export async function runCodexExec({ workspaceRoot, prompt, signal, cwd }) {
  // Requires Codex CLI logged in on the server
  const sandboxMode = process.env.CODEX_SANDBOX_MODE || "workspace-write";
  const approvalPolicy = process.env.CODEX_APPROVAL_POLICY || "never";
  const timeoutMs = 45 * 60 * 1000;
  const commandCwd = cwd || workspaceRoot;

  // Keep Codex workspace explicit (-C), while process CWD can be the run directory.
  // Feed prompt via stdin ("-") so prompt text is never parsed as CLI args.
  const modernArgs = ["exec", "-C", workspaceRoot, "--sandbox", sandboxMode, "-c", `approval_policy=${approvalPolicy}`, "-"];
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

  const legacyArgs = ["exec", "-C", workspaceRoot, "--sandbox", sandboxMode, "--ask-for-approval", approvalPolicy, "-"];
  const legacy = await runCommand("codex", legacyArgs, { cwd: commandCwd, timeoutMs, input: prompt, abortSignal: signal });
  if (legacy.ok) return legacy;

  // If legacy flag is unsupported too, keep modern error as the primary one.
  if ((legacy.stderr || "").includes("unexpected argument '--ask-for-approval'")) return modern;
  return legacy;
}
