import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./proc.js";
import { recordLlmTrace } from "./application/llm_trace_recorder.js";

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

function attachCodexTrace({ result, jobId, surface, agentId, roleId, model, prompt, cwd, workspaceRoot, metadata }) {
  const trace = recordLlmTrace({
    jobId,
    provider: "codex",
    surface,
    agentId,
    roleId,
    model,
    prompt,
    result,
    cwd,
    workspaceRoot,
    metadata,
  });
  return trace ? { ...result, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : result;
}

export async function runCodexExec({ workspaceRoot, prompt, signal, cwd, jobId = "", model = "", profile = "", addDirs = [], configOverrides = {}, sandboxMode = "", approvalPolicy = "", env = {}, surface = "codex_exec", agentId = "", roleId = "", traceMetadata = {} }) {
  // Requires Codex CLI logged in on the server
  const effectiveSandboxMode = String(sandboxMode || process.env.CODEX_SANDBOX_MODE || "workspace-write").trim() || "workspace-write";
  const effectiveApprovalPolicy = String(approvalPolicy || process.env.CODEX_APPROVAL_POLICY || "never").trim() || "never";
  const timeoutMs = 45 * 60 * 1000;
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
  const commonTraceMetadata = {
    sandbox_mode: effectiveSandboxMode,
    approval_policy: effectiveApprovalPolicy,
    add_dirs: extraDirs,
    profile: requestedProfile || null,
    ...asObject(traceMetadata),
  };
  const traceModel = requestedModel || requestedProfile || "default";
  const modernArgs = [...modelArgs, ...profileArgs, "exec", "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "-c", `approval_policy=${effectiveApprovalPolicy}`, ...configArgs, "-"];
  const modern = await runCommand("codex", modernArgs, { cwd: commandCwd, timeoutMs, input: prompt, abortSignal: signal, env });
  if (modern.ok) return attachCodexTrace({ result: modern, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: modernArgs, compatibility_retry: false } });

  // Fallback for older codex-cli variants that still support this flag in `exec`.
  const optionCompatibilityError = [
    "unexpected argument '-c'",
    "unknown argument '-c'",
    "unknown config key",
    "unknown field `approval_policy`",
  ].some((needle) => (modern.stderr || "").toLowerCase().includes(needle.toLowerCase()));
  if (!optionCompatibilityError) return attachCodexTrace({ result: modern, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: modernArgs, compatibility_retry: false } });

  const legacyArgs = [...modelArgs, ...profileArgs, "exec", "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "--ask-for-approval", effectiveApprovalPolicy, "-"];
  const legacy = await runCommand("codex", legacyArgs, { cwd: commandCwd, timeoutMs, input: prompt, abortSignal: signal, env });
  if (legacy.ok) return attachCodexTrace({ result: legacy, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: legacyArgs, compatibility_retry: true, primary_error: modern.stderr || null } });

  // If legacy flag is unsupported too, keep modern error as the primary one.
  const finalResult = (legacy.stderr || "").includes("unexpected argument '--ask-for-approval'") ? modern : legacy;
  return attachCodexTrace({ result: finalResult, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: finalResult === modern ? modernArgs : legacyArgs, compatibility_retry: true, primary_error: modern.stderr || null, legacy_error: legacy.stderr || null } });
}
