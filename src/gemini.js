import { runCommand } from "./proc.js";

export async function runGeminiPrompt({ workspaceRoot, prompt }) {
  const args = ["-p", prompt];
  return await runCommand("gemini", args, { cwd: workspaceRoot, timeoutMs: 30 * 60 * 1000 });
}
