import { runCommand } from "./proc.js";

export async function runCodexExec({ workspaceRoot, prompt }) {
  // Requires Codex CLI logged in on the server
  const args = ["exec", "--sandbox", "workspace-write", "--ask-for-approval", "never", prompt];
  return await runCommand("codex", args, { cwd: workspaceRoot, timeoutMs: 45 * 60 * 1000 });
}
