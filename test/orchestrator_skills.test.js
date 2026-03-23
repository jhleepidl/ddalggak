import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeOrchestration } from "../src/application/orchestrator.js";
import { SkillRegistryV2 as SkillRegistry } from "../src/catalog/skill_registry_v2.js";

const registry = {
  agents: [
    { id: "planner", role_type: "planner", provider: "chatgpt", model: "chatgpt", prompt: "plan" },
    { id: "researcher", role_type: "researcher", provider: "gemini", model: "gemini", prompt: "research" },
    { id: "coder", role_type: "coder", provider: "codex", model: "codex", prompt: "code" },
    { id: "reviewer", role_type: "reviewer", provider: "gemini", model: "gemini", prompt: "review" },
    { id: "messenger", role_type: "messenger", provider: "gemini", model: "gemini", prompt: "summarize" },
    { id: "context_curator", role_type: "context_curator", provider: "gemini", model: "gemini", prompt: "context" },
  ],
};

test("runtime orchestration attaches skills and context packs additively", () => {
  const skillRegistry = new SkillRegistry({
    skillsDir: path.resolve(process.cwd(), "skills"),
  });
  const orchestration = buildRuntimeOrchestration({
    mode: "run",
    goal: "팀 멤버십 검증 후 telegram summary를 작성해줘",
    seedInstruction: "membership and summary",
    routePlan: null,
    registry,
    skillRegistry,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  assert.ok(Array.isArray(orchestration.runtime_agents));
  assert.ok(Array.isArray(orchestration.context_packs));
  assert.ok(Array.isArray(orchestration.selected_skill_ids));
  assert.ok(orchestration.context_packs.length > 0);
  assert.ok(Array.isArray(orchestration.team_plan.slots));
  assert.ok(orchestration.team_plan.execution_graph && typeof orchestration.team_plan.execution_graph === "object");

  const hasAttachedSkill = orchestration.runtime_agents.some((agent) =>
    Array.isArray(agent.attached_skills) && agent.attached_skills.length > 0
  );
  assert.equal(hasAttachedSkill, true);
  assert.ok(orchestration.runtime_agents.every((agent) => String(agent.context_pack_id || "").trim()));
  assert.ok(Array.isArray(orchestration.runtime_team_snapshot.runtime_agents));
  assert.ok(Array.isArray(orchestration.runtime_team_snapshot.context_packs));
  assert.ok(Array.isArray(orchestration.runtime_team_snapshot.selected_skill_ids));
  assert.ok(typeof orchestration.runtime_team_snapshot.skill_load_levels === "object");
  const runtimeInstanceIds = new Set(orchestration.runtime_agents.map((agent) => agent.instance_id));
  assert.equal(
    orchestration.team_plan.authority_graph
      .filter((entry) => entry.instance_id && entry.role_id !== "supervisor_runtime")
      .every((entry) => runtimeInstanceIds.has(entry.instance_id)),
    true
  );
  assert.equal(
    orchestration.team_plan.collaboration_cells
      .every((cell) => cell.member_instance_ids.every((instanceId) => runtimeInstanceIds.has(instanceId))),
    true
  );

  const firstAgentRun = orchestration.route_plan.actions.find((row) => row.type === "agent_run");
  assert.ok(firstAgentRun);
  assert.ok(firstAgentRun.inputs);
  assert.equal(["researcher", "builder", "reviewer", "synthesizer", "operator"].includes(firstAgentRun.agent), true);
  assert.equal(firstAgentRun.agent === "coder" || firstAgentRun.agent === "planner", false);
  assert.ok(Array.isArray(firstAgentRun.inputs.selected_skill_ids));
  assert.ok(typeof firstAgentRun.inputs.skill_load_levels === "object");
  assert.ok(String(firstAgentRun.inputs.context_pack_id || "").trim());
  assert.ok(orchestration.route_plan.execution_graph && typeof orchestration.route_plan.execution_graph === "object");
  const parallelAction = orchestration.route_plan.actions.find((action) => action.type === "spawn_parallel");
  if (parallelAction) {
    const matchingGroup = orchestration.team_plan.execution_graph.parallel_groups.find((group) =>
      group.parallel_group_id === parallelAction.inputs.parallel_group_id
    );
    assert.ok(matchingGroup);
    assert.deepEqual(
      [...matchingGroup.instance_ids].sort(),
      parallelAction.agents.map((child) => child.inputs.runtime_instance_id).sort()
    );
  }
});

test("orchestration remains compatible when no skills are available", () => {
  const emptyRegistry = {
    load() {
      return { skills: [] };
    },
    list() {
      return [];
    },
    resolve() {
      return null;
    },
    resolveSkillFilePath() {
      return "";
    },
  };
  const orchestration = buildRuntimeOrchestration({
    mode: "run",
    goal: "코드 구현 진행",
    seedInstruction: "implement",
    routePlan: null,
    registry,
    skillRegistry: emptyRegistry,
    resolveAgentId: (id) => String(id || "").trim().toLowerCase(),
  });

  assert.ok(Array.isArray(orchestration.route_plan.actions));
  assert.ok(orchestration.route_plan.actions.length > 0);
  assert.equal(orchestration.selected_skill_ids.length, 0);
});
