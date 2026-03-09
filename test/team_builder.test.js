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
  assert.ok(roleIds.includes("planner"));
  assert.ok(roleIds.includes("coder"));
  assert.ok(roleIds.includes("reviewer"));
  assert.equal(built.missing_roles.length, 0);
  assert.ok(built.runtime_agents.length >= 3);
});
