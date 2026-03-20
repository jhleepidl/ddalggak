import fs from "node:fs";
import path from "node:path";

import { loadLatestRuntimeCheckpoint } from "./runtime_checkpointing.js";
import { buildProviderRuntimePolicySummary } from "./provider_runtime_policy.js";
import { normalizeRuntimeExecutionPolicy } from "./runtime_execution_policy.js";

function clean(value = "") {
  return String(value || "").trim();
}

function safeWrite(filePath = "", content = "") {
  const target = path.resolve(String(filePath || ""));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content || ""), "utf8");
  return target;
}

function writeRuntimeRestoreFiles({ workspaceRoot = process.cwd() } = {}) {
  const latest = loadLatestRuntimeCheckpoint({ workspaceRoot });
  if (!latest?.payload) return {};
  const baseDir = path.join(path.resolve(String(workspaceRoot || process.cwd())), ".orchestrator");
  const markdownFile = safeWrite(path.join(baseDir, "runtime_restore.md"), `${String(latest.summary || '').trim()}
`);
  const jsonFile = safeWrite(path.join(baseDir, "runtime_restore.json"), `${JSON.stringify(latest.payload, null, 2)}
`);
  return {
    restoreMarkdownFile: markdownFile,
    restoreJsonFile: jsonFile,
    restoreSummary: String(latest.summary || '').trim(),
  };
}

function writeRuntimePolicyFiles({ workspaceRoot = process.cwd(), runtimeExecutionPolicy = {}, provider = "", providerOptions = {} } = {}) {
  const normalized = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy);
  const baseDir = path.join(path.resolve(String(workspaceRoot || process.cwd())), ".orchestrator");
  const markdown = [
    "# Runtime execution policy",
    "",
    buildProviderRuntimePolicySummary({ runtimeExecutionPolicy: normalized, provider, options: providerOptions }),
    "",
  ].join("\n");
  return {
    runtimePolicyMarkdownFile: safeWrite(path.join(baseDir, "runtime_execution_policy.md"), markdown),
    runtimePolicyJsonFile: safeWrite(path.join(baseDir, "runtime_execution_policy.json"), `${JSON.stringify(normalized, null, 2)}
`),
  };
}

export function writeGeminiMemoryFile({ workspaceRoot = process.cwd(), roleMemo = "", kbContract = "", goal = "", runtimeExecutionPolicy = {}, providerOptions = {} } = {}) {
  const target = path.join(path.resolve(String(workspaceRoot || process.cwd())), "GEMINI.md");
  const restore = writeRuntimeRestoreFiles({ workspaceRoot });
  const policyFiles = writeRuntimePolicyFiles({ workspaceRoot, runtimeExecutionPolicy, provider: "gemini", providerOptions });
  const body = [
    "# Gemini workspace memory",
    "",
    goal ? `## Goal\n${clean(goal)}\n` : "",
    roleMemo ? `## Role memory\n${clean(roleMemo)}\n` : "",
    kbContract ? `## Knowledge base contract\n${clean(kbContract)}\n` : "",
    restore.restoreSummary ? `## Runtime restore context\n${clean(restore.restoreSummary)}\n` : "",
    `## Runtime execution policy\n${clean(buildProviderRuntimePolicySummary({ runtimeExecutionPolicy, provider: 'gemini', options: providerOptions }))}\n`,
    "## Rules",
    "- Use the concrete tracking filenames from the KB contract.",
    "- Do not invent tracking filenames.",
    "- Treat stable memory files as read-only.",
    policyFiles.runtimePolicyMarkdownFile ? `- Read ${path.relative(path.resolve(String(workspaceRoot || process.cwd())), policyFiles.runtimePolicyMarkdownFile) || '.orchestrator/runtime_execution_policy.md'} for runtime policy details.` : "",
    restore.restoreMarkdownFile ? `- Read ${path.relative(path.resolve(String(workspaceRoot || process.cwd())), restore.restoreMarkdownFile) || '.orchestrator/runtime_restore.md'} before continuing resumed work.` : "",
    "",
  ].filter(Boolean).join("\n");
  return safeWrite(target, `${body}
`);
}

export function writeCodexInstructionFile({ workspaceRoot = process.cwd(), roleMemo = "", kbContract = "", instruction = "", goal = "", runtimeExecutionPolicy = {}, providerOptions = {} } = {}) {
  const target = path.join(path.resolve(String(workspaceRoot || process.cwd())), ".codex", "instructions.md");
  const restore = writeRuntimeRestoreFiles({ workspaceRoot });
  const policyFiles = writeRuntimePolicyFiles({ workspaceRoot, runtimeExecutionPolicy, provider: "codex", providerOptions });
  const body = [
    "# Codex workspace instructions",
    "",
    goal ? `## Goal\n${clean(goal)}\n` : "",
    roleMemo ? `## Role memory\n${clean(roleMemo)}\n` : "",
    kbContract ? `## Knowledge base contract\n${clean(kbContract)}\n` : "",
    restore.restoreSummary ? `## Runtime restore context\n${clean(restore.restoreSummary)}\n` : "",
    `## Runtime execution policy\n${clean(buildProviderRuntimePolicySummary({ runtimeExecutionPolicy, provider: 'codex', options: providerOptions }))}\n`,
    instruction ? `## Current task\n${clean(instruction)}\n` : "",
    "## Rules",
    "- Modify files only inside CODEX_WORKSPACE_ROOT.",
    "- Use concrete KB filenames when referring to tracking docs.",
    "- Do not invent nonexistent tracking filenames.",
    "- Verification is handled by a separate tool_proxy step unless explicitly asked otherwise.",
    policyFiles.runtimePolicyMarkdownFile ? `- Read ${path.relative(path.resolve(String(workspaceRoot || process.cwd())), policyFiles.runtimePolicyMarkdownFile) || '.orchestrator/runtime_execution_policy.md'} for sandbox/approval/MCP policy.` : "",
    restore.restoreMarkdownFile ? `- Read ${path.relative(path.resolve(String(workspaceRoot || process.cwd())), restore.restoreMarkdownFile) || '.orchestrator/runtime_restore.md'} before continuing resumed work.` : "",
    "",
  ].filter(Boolean).join("\n");
  return safeWrite(target, `${body}
`);
}
