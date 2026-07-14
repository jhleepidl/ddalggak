import test from "node:test";
import assert from "node:assert/strict";

import { decoratePlanActionsWithRuntimeRules, executeAgentRun, formatChatRuntimeRulesBlock } from "../src/application/telegram_chat_execution.js";
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


test("Room rules are formatted as high-priority user-visible requirements", () => {
  const block = formatChatRuntimeRulesBlock({
    runtime_rules: [
      { id: "rule-user", text: "결론을 먼저 한 문장으로 말해줘", source: "user", enabled: true },
      { id: "rule-learned", text: "근거와 다음 확인 섹션을 포함해줘", source: "learned", enabled: true },
      { id: "rule-disabled", text: "이 규칙은 포함하지 마", source: "user", enabled: false },
    ],
  });

  assert.match(block, /USER ROOM RULES — HIGH PRIORITY/);
  assert.match(block, /agent output and final answer/);
  assert.match(block, /결론을 먼저 한 문장으로 말해줘/);
  assert.match(block, /근거와 다음 확인 섹션을 포함해줘/);
  assert.doesNotMatch(block, /이 규칙은 포함하지 마/);
  assert.ok(block.indexOf("결론을 먼저") < block.indexOf("근거와 다음 확인"));
});


test("Room rules are attached to parallel child actions as well as the parent plan", () => {
  const [spawn] = decoratePlanActionsWithRuntimeRules([
    {
      type: "spawn_agents",
      inputs: { parent: true },
      agents: [
        { agent_id: "lane_1", goal: "first", inputs: { lane_id: "lane_1" } },
        { agent_id: "lane_2", goal: "second", inputs: { lane_id: "lane_2" } },
      ],
    },
  ], "[USER ROOM RULES] structured output");

  assert.match(spawn.inputs._runtime_rules_text, /structured output/);
  assert.equal(spawn.agents.length, 2);
  assert.ok(spawn.agents.every((agent) => /structured output/.test(agent.inputs._runtime_rules_text)));
  assert.deepEqual(spawn.agents.map((agent) => agent.inputs.lane_id), ["lane_1", "lane_2"]);
});
