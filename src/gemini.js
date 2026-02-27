import { runCommand } from "./proc.js";

const VALID_APPROVAL_MODES = new Set(["default", "auto_edit", "yolo", "plan"]);
const PLAN_DISABLED_RE = /Approval mode "plan" is only available when experimental\.plan is enabled\./i;

let planModeAvailability = null;

function resolveApprovalMode() {
  const raw = String(process.env.GEMINI_APPROVAL_MODE || "default").trim();
  return VALID_APPROVAL_MODES.has(raw) ? raw : "default";
}

async function invokeGemini({ promptText, approvalMode, commandCwd, timeoutMs, signal }) {
  // Keep CLI prompt argument simple and stream the real prompt via stdin.
  // This avoids parser issues when prompt text starts with "-" or markdown fences.
  const stdinArgs = ["--prompt", ".", "--output-format", "text", "--approval-mode", approvalMode];
  const stdinRun = await runCommand("gemini", stdinArgs, {
    cwd: commandCwd,
    timeoutMs,
    input: promptText,
    abortSignal: signal,
  });
  if (stdinRun.ok) return stdinRun;

  // Fallback for variants that do not append stdin to --prompt input.
  const inlineArgs = ["--prompt", promptText, "--output-format", "text", "--approval-mode", approvalMode];
  const inlineRun = await runCommand("gemini", inlineArgs, {
    cwd: commandCwd,
    timeoutMs,
    abortSignal: signal,
  });
  if (inlineRun.ok) return inlineRun;

  return {
    ...inlineRun,
    stderr: [stdinRun.stderr, inlineRun.stderr].filter(Boolean).join("\n\n"),
  };
}

export async function runGeminiPrompt({ workspaceRoot, prompt, signal, cwd }) {
  const promptText = String(prompt ?? "");
  if (!promptText.trim()) {
    return { ok: false, exitCode: -1, stdout: "", stderr: "[gemini] empty prompt", durationMs: 0 };
  }

  const timeoutMs = 30 * 60 * 1000;
  const commandCwd = cwd || workspaceRoot;
  const requestedMode = resolveApprovalMode();
  const firstMode = requestedMode === "plan" && planModeAvailability === false ? "default" : requestedMode;

  const first = await invokeGemini({
    promptText,
    approvalMode: firstMode,
    commandCwd,
    timeoutMs,
    signal,
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
    });
    return {
      ...retry,
      stderr: [
        retry.stderr,
        "[gemini] plan mode unavailable (experimental.plan=false); retried with approval-mode=default",
      ].filter(Boolean).join("\n"),
    };
  }

  return first;
}
