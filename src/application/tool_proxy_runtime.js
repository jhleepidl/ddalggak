import fs from "node:fs";
import path from "node:path";

import { runCommand } from "../proc.js";
import { normalizeRuntimeExecutionPolicy } from "./runtime_execution_policy.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clean(value = "") {
  return String(value || "").trim();
}

function clip(value = "", max = 1600) {
  const text = clean(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

function detectPackageManager(workspaceRoot = "") {
  const root = path.resolve(String(workspaceRoot || process.cwd()).trim() || process.cwd());
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

function readJson(filePath = "") {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function inferVerificationCommands(workspaceRoot = "") {
  const root = path.resolve(String(workspaceRoot || process.cwd()).trim() || process.cwd());
  const out = [];
  const packageJson = readJson(path.join(root, "package.json"));
  const packageManager = detectPackageManager(root);
  const scripts = asObject(packageJson?.scripts);
  const pushScript = (name) => {
    if (!scripts[name]) return false;
    out.push(`${packageManager} run ${name}`);
    return true;
  };

  if (packageJson) {
    if (!pushScript("test")) {
      pushScript("test:ci") || pushScript("test:unit") || pushScript("check");
    }
    if (out.length === 0) pushScript("build");
    if (out.length === 0) pushScript("lint");
    if (out.length > 0) return out;
  }
  if (
    fs.existsSync(path.join(root, "pytest.ini"))
    || fs.existsSync(path.join(root, "pyproject.toml"))
    || fs.existsSync(path.join(root, "requirements.txt"))
    || fs.existsSync(path.join(root, "tests"))
  ) {
    return ["python -m pytest -q"];
  }
  if (fs.existsSync(path.join(root, "Cargo.toml"))) return ["cargo test"];
  if (fs.existsSync(path.join(root, "go.mod"))) return ["go test ./..."];
  if (fs.existsSync(path.join(root, "Makefile"))) return ["make test"];
  return [];
}

const SAFE_COMMAND_RE = /^(?:npm|pnpm|yarn|bun)\s+run\s+(?:test(?::[a-z0-9:_-]+)?|build|check|lint|typecheck|verify)$|^python\s+-m\s+pytest(?:\s+[-\w./]+)*$|^pytest(?:\s+[-\w./]+)*$|^cargo\s+(?:test|check|build)(?:\s+[-\w./]+)*$|^go\s+test\s+\.\/\.\.\s*$|^make\s+test\s*$/i;

function normalizeRequestedCommands(action = {}, workspaceRoot = "") {
  const inputs = asObject(action?.inputs);
  const explicit = [
    ...asArray(inputs.commands),
    inputs.command,
  ].map((entry) => clean(entry)).filter(Boolean);
  if (explicit.length > 0) {
    const safe = explicit.filter((entry) => SAFE_COMMAND_RE.test(entry));
    return {
      commands: safe,
      unsafe: explicit.filter((entry) => !SAFE_COMMAND_RE.test(entry)),
      inferred: false,
    };
  }
  return {
    commands: inferVerificationCommands(workspaceRoot),
    unsafe: [],
    inferred: true,
  };
}

function inferIntentLabel(action = {}) {
  const inputs = asObject(action?.inputs);
  const intent = clean(inputs.intent || inputs.verification_mode || inputs.verificationMode || action?.intent || "").toLowerCase();
  if (intent) return intent;
  const label = clean(action?.label || action?.prompt || "").toLowerCase();
  if (/test|pytest|verify|verification|check/.test(label)) return "run_tests";
  if (/build/.test(label)) return "verify_build";
  return "tool_proxy";
}

export function planVerificationCommands({ action = {}, workspaceRoot = "" } = {}) {
  const normalized = normalizeRequestedCommands(action, workspaceRoot);
  return {
    ...normalized,
    intent: inferIntentLabel(action),
  };
}

export async function executeToolProxyAction({
  action = {},
  jobId = "",
  workspaceRoot = process.cwd(),
  sharedDir = "",
  tracking = null,
  signal = null,
  runtimeExecutionPolicy = {},
} = {}) {
  const root = path.resolve(String(workspaceRoot || process.cwd()).trim() || process.cwd());
  const plan = planVerificationCommands({ action, workspaceRoot: root });
  const label = clean(action?.label || action?.prompt || action?.inputs?.slot_id || "tool proxy");
  const policy = normalizeRuntimeExecutionPolicy(runtimeExecutionPolicy || {});
  const verificationApproval = String(policy?.approval_matrix?.verification || 'allow').trim().toLowerCase() || 'allow';
  if (verificationApproval === 'deny') {
    return {
      ok: false,
      text: [
        `🛠️ ${label}`,
        `workspace=${root}`,
        'runtime policy denied verification execution.',
      ].join("\n"),
      route_signals: ['verification_blocked', 'approval_denied'],
      commands: [],
    };
  }
  if (verificationApproval === 'ask') {
    return {
      ok: false,
      text: [
        `🛠️ ${label}`,
        `workspace=${root}`,
        'verification execution requires explicit approval under runtime policy.',
      ].join("\n"),
      route_signals: ['verification_requires_approval'],
      commands: [],
    };
  }
  const timeoutMs = Number.isFinite(Number(process.env.TOOL_PROXY_TIMEOUT_MS))
    ? Math.max(30_000, Math.min(20 * 60 * 1000, Math.floor(Number(process.env.TOOL_PROXY_TIMEOUT_MS))))
    : 8 * 60 * 1000;

  if (plan.unsafe.length > 0) {
    return {
      ok: false,
      text: [
        `🛠️ ${label}`,
        `workspace=${root}`,
        `unsafe_commands=${plan.unsafe.join(", ")}`,
        "허용된 verification command만 실행한다.",
      ].join("\n"),
      route_signals: ["verification_unavailable"],
      commands: [],
    };
  }

  if (plan.commands.length === 0) {
    return {
      ok: false,
      text: [
        `🛠️ ${label}`,
        `workspace=${root}`,
        sharedDir ? `shared=${sharedDir}` : "",
        "실행 가능한 verification command를 자동 추론하지 못했다.",
      ].filter(Boolean).join("\n"),
      route_signals: ["verification_unavailable"],
      commands: [],
    };
  }

  const commandResults = [];
  let allOk = true;
  for (const command of plan.commands) {
    const result = await runCommand("bash", ["-lc", command], {
      cwd: root,
      timeoutMs,
      abortSignal: signal,
    });
    commandResults.push({
      command,
      ok: !!result.ok,
      exitCode: Number(result.exitCode ?? -1),
      stdout: clean(result.stdout),
      stderr: clean(result.stderr),
      durationMs: Number(result.durationMs || 0),
    });
    if (!result.ok) {
      allOk = false;
      break;
    }
  }

  const lines = [
    `🛠️ ${label}`,
    `intent=${plan.intent}`,
    `workspace=${root}`,
    `commands=${plan.commands.join(" ; ")}`,
    `mode=${plan.inferred ? "inferred" : "explicit"}`,
  ];
  for (const row of commandResults) {
    lines.push(`- ${row.command} -> ${row.ok ? "ok" : "failed"} (exit=${row.exitCode}, ${row.durationMs}ms)`);
    const detail = clip(row.ok ? row.stdout : (row.stderr || row.stdout), 700);
    if (detail) lines.push(`  ${detail}`);
  }
  const text = lines.join("\n");

  try {
    tracking?.append?.(jobId, "progress", `## Tool proxy verification\n\n${text}\n`);
  } catch {}

  return {
    ok: allOk,
    text,
    commands: plan.commands,
    results: commandResults,
    route_signals: allOk
      ? [plan.intent === "verify_build" ? "build_verified" : "tests_verified"]
      : ["verification_failed"],
  };
}
