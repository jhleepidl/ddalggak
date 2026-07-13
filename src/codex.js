import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./proc.js";
import { recordLlmTrace } from "./application/llm_trace_recorder.js";
import { withRuntimeActivity } from "./application/runtime_activity_registry.js";

function appendCodexDebugLog(line = "") {
  const file = path.resolve(process.env.CODEX_DEBUG_LOG || "codex_debug.log");
  try {
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${String(line || "")}\n`, "utf8");
  } catch {}
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

const WORKSPACE_AUTO_APPROVAL_POLICIES = new Set([
  'workspace-auto',
  'workspace_always',
  'workspace-always',
  'always-workspace',
  'approve-workspace',
  'workspace-approve',
  'auto-approve-workspace',
  'trusted-workspace',
  'workspace-trusted',
]);

function isPathInsideOrEqual(root = '', candidate = '') {
  const base = path.resolve(String(root || '').trim() || process.cwd());
  const target = path.resolve(String(candidate || '').trim() || base);
  if (target === base) return true;
  const rel = path.relative(base, target);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function normalizeApprovalPolicyName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, '-');
}

function isTruthy(value = '') {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function resolveCodexGitRepoCheckPolicy({ workspacePath = '', requested = false, allowedRoot = '' } = {}) {
  const skipRequested = requested === true || isTruthy(requested);
  const resolvedWorkspace = path.resolve(String(workspacePath || '').trim() || process.cwd());
  const cleanAllowedRoot = String(allowedRoot || '').trim();
  if (!skipRequested) {
    return {
      requested: false,
      enabled: false,
      workspacePath: resolvedWorkspace,
      allowedRoot: cleanAllowedRoot ? path.resolve(cleanAllowedRoot) : '',
      error: '',
    };
  }
  if (!cleanAllowedRoot) {
    return {
      requested: true,
      enabled: false,
      workspacePath: resolvedWorkspace,
      allowedRoot: '',
      error: 'skip-git-repo-check requires an explicit allowed root',
    };
  }
  const resolvedAllowedRoot = path.resolve(cleanAllowedRoot);
  if (!isPathInsideOrEqual(resolvedAllowedRoot, resolvedWorkspace)) {
    return {
      requested: true,
      enabled: false,
      workspacePath: resolvedWorkspace,
      allowedRoot: resolvedAllowedRoot,
      error: `skip-git-repo-check is limited to the configured benchmark root: workspace=${resolvedWorkspace} allowedRoot=${resolvedAllowedRoot}`,
    };
  }
  return {
    requested: true,
    enabled: true,
    workspacePath: resolvedWorkspace,
    allowedRoot: resolvedAllowedRoot,
    error: '',
  };
}

export function resolveCodexWorkspaceApprovalPolicy({ approvalPolicy = '', sandboxMode = '', workspacePath = '', commandCwd = '', addDirs = [] } = {}) {
  const requestedApprovalPolicy = String(approvalPolicy || '').trim() || 'never';
  const normalized = normalizeApprovalPolicyName(requestedApprovalPolicy);
  const workspaceAutoApprove = WORKSPACE_AUTO_APPROVAL_POLICIES.has(normalized);
  let effectiveSandboxMode = String(sandboxMode || '').trim() || 'workspace-write';
  let cliApprovalPolicy = requestedApprovalPolicy;
  const notes = [];

  if (workspaceAutoApprove) {
    cliApprovalPolicy = 'never';
    if (!effectiveSandboxMode || ['read-only', 'readonly', 'read_only'].includes(effectiveSandboxMode.toLowerCase())) {
      effectiveSandboxMode = 'workspace-write';
      notes.push('promoted_sandbox_to_workspace_write');
    }
    const resolvedWorkspace = path.resolve(String(workspacePath || '').trim() || process.cwd());
    const resolvedCwd = path.resolve(String(commandCwd || resolvedWorkspace).trim() || resolvedWorkspace);
    if (!isPathInsideOrEqual(resolvedWorkspace, resolvedCwd)) {
      return {
        approvalPolicy: requestedApprovalPolicy,
        cliApprovalPolicy,
        sandboxMode: effectiveSandboxMode,
        workspaceAutoApprove,
        notes,
        error: `workspace-auto approval requires cwd inside workspace: cwd=${resolvedCwd} workspace=${resolvedWorkspace}`,
      };
    }
    for (const entry of Array.isArray(addDirs) ? addDirs : []) {
      const cleanEntry = String(entry || '').trim();
      if (!cleanEntry) continue;
      if (!isPathInsideOrEqual(resolvedWorkspace, cleanEntry)) {
        return {
          approvalPolicy: requestedApprovalPolicy,
          cliApprovalPolicy,
          sandboxMode: effectiveSandboxMode,
          workspaceAutoApprove,
          notes,
          error: `workspace-auto approval refuses --add-dir outside workspace: addDir=${path.resolve(cleanEntry)} workspace=${resolvedWorkspace}`,
        };
      }
    }
    notes.push('cli_approval_policy_never_with_workspace_write_sandbox');
  }

  return {
    approvalPolicy: requestedApprovalPolicy,
    cliApprovalPolicy,
    sandboxMode: effectiveSandboxMode,
    workspaceAutoApprove,
    notes,
    error: '',
  };
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
  const hasRequestedModel = Object.prototype.hasOwnProperty.call(metadata || {}, 'requested_model');
  const hasResolvedModel = Object.prototype.hasOwnProperty.call(metadata || {}, 'resolved_model');
  const requestedModel = String(hasRequestedModel ? (metadata?.requested_model || '') : (model === 'default' ? '' : (model || ''))).trim();
  const resolvedModel = String(hasResolvedModel ? (metadata?.resolved_model || '') : requestedModel).trim();
  const withModel = {
    ...(result && typeof result === 'object' ? result : {}),
    requested_model: requestedModel || null,
    resolved_model: resolvedModel || null,
    model_resolution_source: resolvedModel ? (requestedModel ? 'explicit_request' : 'provider_reported') : 'unresolved_provider_default',
    used_model: resolvedModel || requestedModel || 'default',
  };
  return trace ? { ...withModel, llm_trace_id: trace.trace_id, llm_trace_dir: trace.trace_dir } : withModel;
}

export async function runCodexExec({ workspaceRoot, prompt, signal, cwd, jobId = "", model = "", reasoningEffort = "", profile = "", addDirs = [], configOverrides = {}, sandboxMode = "", approvalPolicy = "", env = {}, surface = "codex_exec", agentId = "", roleId = "", traceMetadata = {}, timeoutMs = 0 }) {
  // Requires Codex CLI logged in on the server
  const command = String(process.env.CODEX_CLI_COMMAND || "codex").trim() || "codex";
  const requestedSandboxMode = String(sandboxMode || process.env.CODEX_SANDBOX_MODE || "workspace-write").trim() || "workspace-write";
  const requestedApprovalPolicy = String(approvalPolicy || process.env.CODEX_APPROVAL_POLICY || "never").trim() || "never";
  const effectiveTimeoutMs = Number(timeoutMs || process.env.CODEX_EXEC_TIMEOUT_MS || 0) > 0 ? Number(timeoutMs || process.env.CODEX_EXEC_TIMEOUT_MS) : 45 * 60 * 1000;
  const workspacePath = path.resolve(String(workspaceRoot || cwd || process.cwd()).trim() || process.cwd());
  const commandCwd = path.resolve(String(cwd || workspacePath).trim() || workspacePath);
  const requestedModel = String(model || "").trim();
  const requestedReasoningEffort = String(reasoningEffort || process.env.CODEX_REASONING_EFFORT || "").trim().toLowerCase();
  const requestedProfile = String(profile || process.env.CODEX_PROFILE || "").trim();
  const extraDirs = Array.isArray(addDirs) ? addDirs.map((entry) => String(entry || "").trim()).filter(Boolean) : [];
  const gitRepoCheckResolution = resolveCodexGitRepoCheckPolicy({
    workspacePath,
    requested: process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK || '',
    allowedRoot: process.env.DDALGGAK_CODEX_SKIP_GIT_REPO_CHECK_ROOT || '',
  });
  const approvalResolution = resolveCodexWorkspaceApprovalPolicy({
    approvalPolicy: requestedApprovalPolicy,
    sandboxMode: requestedSandboxMode,
    workspacePath,
    commandCwd,
    addDirs: extraDirs,
  });
  const effectiveSandboxMode = approvalResolution.sandboxMode;
  const effectiveApprovalPolicy = approvalResolution.approvalPolicy;
  const cliApprovalPolicy = approvalResolution.cliApprovalPolicy;
  const envConfigOverrides = {};
  if (String(process.env.CODEX_MODEL_PROVIDER || "").trim()) envConfigOverrides.model_provider = String(process.env.CODEX_MODEL_PROVIDER || "").trim();
  if (["1", "true", "yes", "on"].includes(String(process.env.CODEX_ENABLE_WEB_SEARCH || "").trim().toLowerCase())) envConfigOverrides["tools.web_search"] = true;
  const mergedConfigOverrides = {
    ...envConfigOverrides,
    ...(requestedReasoningEffort && requestedReasoningEffort !== 'provider_default' ? { model_reasoning_effort: requestedReasoningEffort } : {}),
    ...(configOverrides && typeof configOverrides === "object" ? configOverrides : {}),
  };
  appendCodexDebugLog(`[codex] job=${String(jobId || "").trim() || "-"} cwd=${commandCwd} workspace=${workspacePath} model=${requestedModel || "(default)"} approval=${effectiveApprovalPolicy}${approvalResolution.workspaceAutoApprove ? '/workspace-auto' : ''}`);

  if (approvalResolution.error || gitRepoCheckResolution.error) {
    const policyError = approvalResolution.error || gitRepoCheckResolution.error;
    const blocked = {
      ok: false,
      exitCode: -1,
      signal: null,
      stdout: '',
      stderr: `[codex execution policy blocked] ${policyError}`,
      durationMs: 0,
      timedOut: false,
      aborted: false,
      killed: false,
      killedProcessGroup: false,
      earlyTerminated: false,
      stdoutChars: 0,
      stderrChars: policyError.length,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
    return attachCodexTrace({ result: blocked, jobId, surface, agentId, roleId, model: requestedModel || requestedProfile || 'default', prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { sandbox_mode: effectiveSandboxMode, approval_policy: effectiveApprovalPolicy, cli_approval_policy: cliApprovalPolicy, workspace_auto_approve: approvalResolution.workspaceAutoApprove, approval_policy_notes: approvalResolution.notes, skip_git_repo_check_requested: gitRepoCheckResolution.requested, skip_git_repo_check_enabled: gitRepoCheckResolution.enabled, skip_git_repo_check_allowed_root: gitRepoCheckResolution.allowedRoot || null, add_dirs: extraDirs, profile: requestedProfile || null, requested_model: requestedModel || null, resolved_model: requestedModel || null, ...asObject(traceMetadata) } });
  }

  // Keep Codex workspace explicit (-C), while process CWD can be the run directory.
  // Feed prompt via stdin ("-") so prompt text is never parsed as CLI args.
  const modelArgs = requestedModel ? ["--model", requestedModel] : [];
  const profileArgs = requestedProfile ? ["--profile", requestedProfile] : [];
  const addDirArgs = extraDirs.flatMap((entry) => ["--add-dir", entry]);
  const gitRepoCheckArgs = gitRepoCheckResolution.enabled ? ['--skip-git-repo-check'] : [];
  const configArgs = flattenConfigOverrides(mergedConfigOverrides).flatMap(([key, value]) => ["-c", `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`]);
  const commonTraceMetadata = {
    sandbox_mode: effectiveSandboxMode,
    approval_policy: effectiveApprovalPolicy,
    cli_approval_policy: cliApprovalPolicy,
    workspace_auto_approve: approvalResolution.workspaceAutoApprove,
    approval_policy_notes: approvalResolution.notes,
    skip_git_repo_check_requested: gitRepoCheckResolution.requested,
    skip_git_repo_check_enabled: gitRepoCheckResolution.enabled,
    skip_git_repo_check_allowed_root: gitRepoCheckResolution.allowedRoot || null,
    timeout_ms: effectiveTimeoutMs,
    add_dirs: extraDirs,
    profile: requestedProfile || null,
    reasoning_effort: requestedReasoningEffort || null,
    requested_model: requestedModel || null,
    resolved_model: requestedModel || null,
    ...asObject(traceMetadata),
  };
  const traceModel = requestedModel || requestedProfile || "default";
  return await withRuntimeActivity({ provider: 'codex', kind: 'provider_execution', jobId, metadata: { surface, model: requestedModel || null, workspace: workspacePath } }, async () => {
    const modernArgs = [...modelArgs, ...profileArgs, "exec", ...gitRepoCheckArgs, "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "-c", `approval_policy=${cliApprovalPolicy}`, ...configArgs, "-"];
    const modern = await runCommand(command, modernArgs, { cwd: commandCwd, timeoutMs: effectiveTimeoutMs, input: prompt, abortSignal: signal, env });
    if (modern.ok) return attachCodexTrace({ result: modern, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: modernArgs, compatibility_retry: false } });

    // Fallback for older codex-cli variants that still support this flag in `exec`.
    const optionCompatibilityError = [
      "unexpected argument '-c'",
      "unknown argument '-c'",
      "unknown config key",
      "unknown field `approval_policy`",
    ].some((needle) => (modern.stderr || "").toLowerCase().includes(needle.toLowerCase()));
    if (!optionCompatibilityError) return attachCodexTrace({ result: modern, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: modernArgs, compatibility_retry: false } });

    const legacyArgs = [...modelArgs, ...profileArgs, "exec", ...gitRepoCheckArgs, "-C", workspacePath, ...addDirArgs, "--sandbox", effectiveSandboxMode, "--ask-for-approval", cliApprovalPolicy, "-"];
    const legacy = await runCommand(command, legacyArgs, { cwd: commandCwd, timeoutMs: effectiveTimeoutMs, input: prompt, abortSignal: signal, env });
    if (legacy.ok) return attachCodexTrace({ result: legacy, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: legacyArgs, compatibility_retry: true, primary_error: modern.stderr || null } });

    // If legacy flag is unsupported too, keep modern error as the primary one.
    const finalResult = (legacy.stderr || "").includes("unexpected argument '--ask-for-approval'") ? modern : legacy;
    return attachCodexTrace({ result: finalResult, jobId, surface, agentId, roleId, model: traceModel, prompt, cwd: commandCwd, workspaceRoot: workspacePath, metadata: { ...commonTraceMetadata, args: finalResult === modern ? modernArgs : legacyArgs, compatibility_retry: true, primary_error: modern.stderr || null, legacy_error: legacy.stderr || null } });
  });
}
