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
