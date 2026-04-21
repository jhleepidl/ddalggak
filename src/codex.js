import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./proc.js";

function appendCodexDebugLog(line = "") {
  const file = path.resolve(process.env.CODEX_DEBUG_LOG || "codex_debug.log");
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(line || "")}\n`, "utf8");
  } catch {}
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function flattenConfigOverrides(raw = {}, prefix = "") {
  const out = [];
  const row = asObject(raw);
  for (const [key, value] of Object.entries(row)) {
    const cleanKey = String(key || "").trim();
    if (!cleanKey) continue;
    const nextPrefix = prefix ? `${prefix}.${cleanKey}` : cleanKey;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flattenConfigOverrides(value, nextPrefix));
    } else {
      out.push([nextPrefix, value]);
    }
  }
  return out;
}

export async function runCodexExec({ workspaceRoot, prompt, signal, cwd, jobId = "", model = "", profile = "", addDirs = [], configOverrides = {}, sandboxMode = "", approvalPolicy = "", env = {}, timeoutMs = null }) {
  // Requires Codex CLI logged in on the server
  const effectiveSandboxMode = String(sandboxMode || process.env.CODEX_SANDBOX_MODE || "workspace-write").trim() || "workspace-write";
  const effectiveApprovalPolicy = String(approvalPolicy || process.env.CODEX_APPROVAL_POLICY || "never").trim() || "never";
  const requestedTimeoutMs = Number(timeoutMs ?? process.env.CODEX_TIMEOUT_MS);
  const effectiveTimeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
    ? Math.max(1_000, Math.floor(requestedTimeoutMs))
    : 45 * 60 * 1000;
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  const requestedModel = String(model || "").trim();
  const requestedProfile = String(profile || process.env.CODEX_PROFILE || "").trim();
  const extraDirs = Array.isArray(addDirs) ? addDirs.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  const envConfigOverrides = {};
  if (String(process.env.CODEX_MODEL_PROVIDER || "").trim()) envConfigOverrides.model_provider = String(process.env.CODEX_MODEL_PROVIDER || "").trim();
  if (["1", "true", "yes", "on"].includes(String(process.env.CODEX_ENABLE_WEB_SEARCH || "").trim().toLowerCase())) envConfigOverrides["tools.web_search"] = true;
  const mergedConfigOverrides = {
    ...envConfigOverrides,
    ...(configOverrides && typeof configOverrides === "object" ? configOverrides : {}),
  };
  appendCodexDebugLog(`[codex] job=${String(jobId || "").trim() || "-"} cwd=${commandCwd} workspace=${workspacePath} model=${requestedModel || "(default)"}`);

  // Keep Codex workspace explicit (-C), while process CWD can be the run directory.
  // Feed prompt via stdin ("-") so prompt text is never parsed as CLI args.
  const modelArgs = requestedModel ? ["--model", requestedModel] : [];
  const profileArgs = requestedProfile ? ["--profile", requestedProfile] : [];
  const addDirArgs = extraDirs.flatMap((entry) => ["--add-dir", entry]);
  const configArgs = flattenConfigOverrides(mergedConfigOverrides).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`]);
  const modernArgs = [...modelArgs, ...profileArgs, "exec", "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "-c", `approval_policy=${effectiveApprovalPolicy}`, ...configArgs, "-"];
  const modern = await runCommand("codex", modernArgs, { cwd: commandCwd, timeoutMs: effectiveTimeoutMs, input: prompt, abortSignal: signal, env });
  if (modern.ok) return modern;

  // Fallback for older codex-cli variants that still support this flag in `exec`.
  const optionCompatibilityError = [
    "unexpected argument '-c'",
    "unknown argument '-c'",
    "unknown config key",
    "unknown field `approval_policy`",
  ].some((needle) => (modern.stderr || "").toLowerCase().includes(needle.toLowerCase()));
  if (!optionCompatibilityError) return modern;

  const legacyArgs = [...modelArgs, ...profileArgs, "exec", "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "--ask-for-approval", effectiveApprovalPolicy, "-"];
  const legacy = await runCommand("codex", legacyArgs, { cwd: commandCwd, timeoutMs: effectiveTimeoutMs, input: prompt, abortSignal: signal, env });
  if (legacy.ok) return legacy;

  // If legacy flag is unsupported too, keep modern error as the primary one.
  if ((legacy.stderr || "").includes("unexpected argument '--ask-for-approval'")) return modern;
  return legacy;
}
