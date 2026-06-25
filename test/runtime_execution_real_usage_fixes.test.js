import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { executeAgentRun, executeActions } from "../src/application/telegram_chat_execution.js";
import { jobs, tracking } from "../src/application/telegram_runtime_state.js";
import { executeSupervisorActions } from "../src/chat/executor.js";
import { buildPendingApprovalPrompt } from "../src/adapters/telegram/formatting.js";

function withPatchedPath(binDir, fn) {
  const originalPath = process.env.PATH || "";
  const originalAllowGeminiCli = process.env.DDALGGAK_ALLOW_GEMINI_CLI;
  process.env.PATH = `${binDir}${path.delimiter}${originalPath}`;
  process.env.DDALGGAK_ALLOW_GEMINI_CLI = '1';
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath;
      if (typeof originalAllowGeminiCli === 'undefined') delete process.env.DDALGGAK_ALLOW_GEMINI_CLI;
      else process.env.DDALGGAK_ALLOW_GEMINI_CLI = originalAllowGeminiCli;
    });
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { mode: 0o755 });
}

test("executeAgentRun applies action-level codex runtime policy overrides to the real CLI invocation", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-codex-bin-"));
  writeExecutable(path.join(binDir, "codex"), `#!/usr/bin/env bash
printf 'ARGS:%s\n' "$*"
exit 0
`);

  const job = jobs.createJob({ title: "codex runtime policy override" });
  tracking.init(job.jobId);
  await withPatchedPath(binDir, async () => {
    const result = await executeAgentRun(
      { sendMessage: async () => null },
      1101,
      job.jobId,
      {
        agent: "builder",
        prompt: "apply the requested patch",
        inputs: {
          role_id: "builder",
          codex_sandbox_mode: "danger-full-access",
          codex_approval_policy: "on-request",
          codex_profile: "action-profile",
        },
      },
      {
        runtime: {
          agentsCatalog: [
            {
              id: "builder",
              provider: "codex",
              model: "codex-test",
              prompt: "builder prompt",
              runtime_execution: {
                providers: {
                  codex: {
                    sandbox_mode: "workspace-write",
                    approval_policy: "never",
                    profile: "agent-profile",
                  },
                },
              },
            },
          ],
          activeTeamConfig: {
            runtime_execution: {
              providers: {
                codex: {
                  sandbox_mode: "workspace-write",
                  approval_policy: "never",
                },
              },
            },
          },
        },
      }
    );

    assert.match(String(result.output || ""), /--sandbox danger-full-access/);
    assert.match(String(result.output || ""), /approval_policy=on-request/);
    assert.match(String(result.output || ""), /--profile action-profile/);
  });
});

test("executeAgentRun applies action-level gemini runtime policy overrides to the real CLI invocation", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-gemini-bin-"));
  writeExecutable(path.join(binDir, "gemini"), `#!/usr/bin/env bash
printf 'ARGS:%s\n' "$*"
printf 'FLAG:%s\n' "$EXTRA_ENV_FLAG"
exit 0
`);

  const job = jobs.createJob({ title: "gemini runtime policy override" });
  tracking.init(job.jobId);
  await withPatchedPath(binDir, async () => {
    const result = await executeAgentRun(
      { sendMessage: async () => null },
      1102,
      job.jobId,
      {
        agent: "researcher",
        prompt: "research the current design",
        inputs: {
          role_id: "researcher",
          gemini_approval_mode: "yolo",
          runtime_execution: {
            providers: {
              gemini: {
                settings_overwrite: "always",
                workspace_settings: {
                  output: { format: "yaml" },
                },
                extra_env: {
                  EXTRA_ENV_FLAG: "from-action",
                },
              },
            },
          },
        },
      },
      {
        runtime: {
          agentsCatalog: [
            {
              id: "researcher",
              provider: "gemini",
              model: "gemini-test",
              prompt: "research prompt",
            },
          ],
          activeTeamConfig: {
            runtime_execution: {
              providers: {
                gemini: {
                  approval_mode: "default",
                },
              },
            },
          },
        },
      }
    );

    assert.match(String(result.output || ""), /--approval-mode yolo/);
    assert.match(String(result.output || ""), /FLAG:from-action/);
    const settingsPath = path.join(job.workspaceDir, ".gemini", "settings.json");
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    assert.equal(parsed.output.format, "yaml");
  });
});

test("executeActions no longer drops tool_proxy and checkpoint actions on pasted JSON plans", async () => {
  const job = jobs.createJob({ title: "legacy pasted json plan" });
  tracking.init(job.jobId);
  fs.writeFileSync(
    path.join(job.workspaceDir, "package.json"),
    JSON.stringify({ name: "tool-proxy-fixture", scripts: { test: "node -e \"console.log('tool-proxy-ok')\"" } }, null, 2),
    "utf8"
  );

  const sent = [];
  const bot = {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text || ""));
      return null;
    },
  };

  await executeActions(bot, 2201, job.jobId, {
    actions: [
      {
        type: "tool_proxy_call",
        label: "verify workspace",
        inputs: {
          commands: ["npm run test"],
        },
      },
      {
        type: "checkpoint",
        label: "review gate",
        inputs: {
          approval_required: true,
          checkpoint_id: "checkpoint_review_gate",
        },
      },
    ],
  });

  const joined = sent.join("\n\n");
  assert.match(joined, /commands=npm run test/);
  assert.match(joined, /tool-proxy-ok/);
  assert.match(joined, /checkpoint required: review gate/);
});

test("approval preview includes runtime policy summary for real execution actions", async () => {
  const execution = await executeSupervisorActions({
    chatId: "chat_runtime_policy_preview",
    userId: "user_runtime_policy_preview",
    jobId: "job_runtime_policy_preview",
    plan: {
      runtime_team_snapshot: {
        runtime_execution: {
          checkpointing: { enabled: true },
          continuous_improvement: { enabled: true, max_turns: 4 },
          approval_matrix: {
            codex_exec: "ask",
            verification: "deny",
          },
          providers: {
            codex: {
              sandbox_mode: "workspace-write",
              approval_policy: "on-request",
            },
          },
        },
      },
      actions: [
        {
          type: "run_agent",
          agent_id: "builder",
          goal: "apply the requested patch",
          inputs: {
            codex_sandbox_mode: "danger-full-access",
          },
          risk: "L1",
        },
      ],
    },
    originalUserText: "코드 수정해줘",
    jobConfig: {
      approval: {
        require_file_write: true,
      },
    },
    agents: [
      { id: "builder", name: "Repo Builder", provider: "codex", model: "codex-test" },
    ],
    callbacks: {},
  });

  assert.ok(execution.pendingApproval);
  assert.equal(Array.isArray(execution.pendingApproval.runtime_policy_summary), true);
  assert.match(execution.pendingApproval.runtime_policy_summary.join("\n"), /continuous_improvement=enabled/);
  assert.match(execution.pendingApproval.runtime_policy_summary.join("\n"), /provider=codex/);
  assert.match(execution.pendingApproval.runtime_policy_summary.join("\n"), /sandbox_mode=danger-full-access/);

  const prompt = buildPendingApprovalPrompt(execution.pendingApproval);
  assert.match(String(prompt.text || ""), /실행 정책:/);
  assert.match(String(prompt.text || ""), /sandbox_mode=danger-full-access/);
});


test("executeActions accepts canonical run_agent and spawn_agents aliases for pasted plans", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-alias-bin-"));
  writeExecutable(path.join(binDir, "gemini"), `#!/usr/bin/env bash
printf 'ARGS:%s
' "$*"
exit 0
`);

  const job = jobs.createJob({ title: "canonical pasted aliases" });
  tracking.init(job.jobId);
  const sent = [];
  const bot = {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text || ""));
      return null;
    },
  };

  await withPatchedPath(binDir, async () => {
    await executeActions(bot, 2202, job.jobId, {
      runtime_team_snapshot: {
        runtime_execution: {
          providers: {
            gemini: { approval_mode: "default" },
          },
        },
      },
      actions: [
        {
          type: "run_agent",
          agent_id: "researcher",
          goal: "summarize the current state",
        },
        {
          type: "spawn_agents",
          summary: "parallel review",
          agents: [
            { agent_id: "researcher", goal: "inspect state A" },
            { agent_id: "researcher", goal: "inspect state B" },
          ],
        },
      ],
    }, null, {
      runtime: {
        agentsCatalog: [
          { id: "researcher", provider: "gemini", model: "gemini-test", prompt: "research prompt" },
        ],
      },
    });
  });

  const joined = sent.join("\n\n");
  assert.match(joined, /Researcher/);
  assert.match(joined, /spawn_agents downgraded/);
});

test("executeActions surfaces execution contract downgrade notes for pasted plans", async () => {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-contract-bin-"));
  writeExecutable(path.join(binDir, "gemini"), `#!/usr/bin/env bash
printf 'ARGS:%s
' "$*"
exit 0
`);

  const job = jobs.createJob({ title: "execution contract note" });
  tracking.init(job.jobId);
  const sent = [];
  const bot = {
    sendMessage: async (_chatId, text) => {
      sent.push(String(text || ""));
      return null;
    },
  };

  await withPatchedPath(binDir, async () => {
    await executeActions(bot, 2203, job.jobId, {
      runtime_team_snapshot: {
        authority_graph: [
          {
            action_type: "spawn_agents",
            execute_allowed: false,
            approval_required: false,
            reasons: ["parallel spawn blocked by policy"],
          },
        ],
      },
      actions: [
        {
          type: "spawn_agents",
          summary: "parallel review",
          agents: [
            { agent_id: "researcher", goal: "inspect state A" },
            { agent_id: "researcher", goal: "inspect state B" },
          ],
        },
      ],
    }, null, {
      runtime: {
        agentsCatalog: [
          { id: "researcher", provider: "gemini", model: "gemini-test", prompt: "research prompt" },
        ],
      },
    });
  });

  const joined = sent.join("\n\n");
  assert.match(joined, /execution contract/);
  assert.match(joined, /spawn_agents downgraded/);
  assert.match(joined, /Researcher/);
});
