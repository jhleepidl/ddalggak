import test from "node:test";
import assert from "node:assert/strict";

import { executeAgentRun } from "../src/application/telegram_chat_execution.js";
import { memory } from "../src/application/telegram_runtime_state.js";

test("executeAgentRun keeps the runtime memory binding in the gemini path", async () => {
  const sentinel = new Error("memory-sentinel");
  const originalGetAgentRole = memory.getAgentRole;
  memory.getAgentRole = () => {
    throw sentinel;
  };

  try {
    await assert.rejects(
      executeAgentRun(
        { sendMessage: async () => null },
        101,
        "job-memory-binding-test",
        { agent: "researcher", prompt: "test prompt" },
        {
          runtime: {
            agentsCatalog: [
              {
                id: "researcher",
                provider: "gemini",
                model: "gemini-test",
                prompt: "role prompt",
              },
            ],
          },
        }
      ),
      (error) => error === sentinel
    );
  } finally {
    memory.getAgentRole = originalGetAgentRole;
  }
});

test("executeAgentRun rejects when authority profile blocks the action", async () => {
  await assert.rejects(
    executeAgentRun(
      { sendMessage: async () => null },
      102,
      "job-authority-denied-test",
      {
        agent: "builder",
        prompt: "apply the requested patch",
        inputs: {
          runtime_instance_id: "inst_builder_1",
          role_id: "builder",
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
            },
          ],
          runtime_team_snapshot: {
            runtime_agents: [
              {
                instance_id: "inst_builder_1",
                slot_id: "slot_builder_1",
                role_id: "builder",
                authority_profile_id: "worker_readonly_research",
              },
            ],
            authority_graph: [
              {
                slot_id: "slot_builder_1",
                instance_id: "inst_builder_1",
                role_id: "builder",
                authority_profile_id: "worker_readonly_research",
              },
            ],
          },
        },
      }
    ),
    (error) => String(error?.code || "") === "AUTHORITY_DENIED"
  );
});
