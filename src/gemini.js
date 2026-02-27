import { runCommand } from "./proc.js";

export async function runGeminiPrompt({ workspaceRoot, prompt, signal, cwd }) {
  const promptText = String(prompt ?? "");
  if (!promptText.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "[gemini] empty prompt", durationMs: 0 };
  }

  const timeoutMs = 30 * 60 * 1000;
  const commandCwd = cwd || workspaceRoot;
  const approvalMode = process.env.GEMINI_APPROVAL_MODE || "plan";

  // Keep CLI prompt argument simple and stream the real prompt via stdin.
  // This avoids parser issues when prompt text starts with "-" or markdown fences.
  const modernArgs = ["--prompt", ".", "--output-format", "text", "--approval-mode", approvalMode];
  const modern = await runCommand("gemini", modernArgs, {
    cwd: commandCwd,
    timeoutMs,
    input: promptText,
    abortSignal: signal,
  });
  if (modern.ok) return modern;

  // Fallback for variants that do not append stdin to --prompt input.
  const fallbackArgs = ["--prompt", promptText, "--output-format", "text", "--approval-mode", approvalMode];
  return await runCommand("gemini", fallbackArgs, { cwd: commandCwd, timeoutMs, abortSignal: signal });
}
