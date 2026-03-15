import test from "node:test";
import assert from "node:assert/strict";
import { buildTeamFromTemplates } from "../src/application/team_builder.js";

const templates = [
  {
    id: "planner",
    name: "Planner",
    role_type: "planner",
    capability_tags: ["planning"],
    provider: "chatgpt",
    model: "chatgpt",
    prompt: "plan",
  },
  {
    id: "researcher",
    name: "Researcher",
    role_type: "researcher",
    capability_tags: ["research"],
    provider: "gemini",
    model: "gemini",
    prompt: "research",
  },
  {
    id: "coder",
    name: "Coder",
    role_type: "coder",
    capability_tags: ["coding"],
    provider: "codex",
    model: "codex",
    prompt: "code",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role_type: "reviewer",
    capability_tags: ["review"],
    provider: "gemini",
    model: "gemini",
    prompt: "review",
  },
];

test("buildTeamFromTemplates selects known roles first", () => {
  const built = buildTeamFromTemplates({
    goal: "코드 구현 후 리뷰까지 진행해줘",
    templates,
  });
  const roleIds = built.team_plan.roles.map((role) => role.id);
  assert.equal(roleIds.includes("planner"), false);
  assert.ok(roleIds.includes("builder"));
  assert.ok(roleIds.includes("reviewer"));
  const builder = built.runtime_agents.find((agent) => agent.role_id === "builder");
  assert.ok(builder);
  assert.equal(builder.template_id, "coder");
  assert.ok(built.runtime_agents.length >= 2);
});

test("fallback runtime roles are clearly marked as ephemeral", () => {
  const built = buildTeamFromTemplates({
    goal: "간단한 요약만 해줘",
    templates: [templates[0]], // planner only
    maxAgents: 4,
  });

  const fallbackRoles = built.runtime_agents.filter((agent) => agent.synthesized === true);
  assert.ok(fallbackRoles.length > 0);
  for (const role of fallbackRoles) {
    assert.equal(role.ephemeral, true);
    assert.equal(role.role_id === "deprecated_control_plane_only", false);
  }
});
