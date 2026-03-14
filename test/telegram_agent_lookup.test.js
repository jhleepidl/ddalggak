import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { normalizeAgentLookupKey } from "../src/application/logical_agents.js";
import { pickBaselineConversationCatalogAgents } from "../src/application/telegram_goc_runtime.js";

test("GoC baseline agent selection uses the shared agent lookup normalizer", () => {
  const routePlanningPath = path.resolve("src/application/telegram_route_planning.js");
  const gocRuntimePath = path.resolve("src/application/telegram_goc_runtime.js");
  const routePlanningSource = fs.readFileSync(routePlanningPath, "utf8");
  const gocRuntimeSource = fs.readFileSync(gocRuntimePath, "utf8");

  assert.equal(normalizeAgentLookupKey(" Researcher / Agent "), "researcheragent");
  assert.match(routePlanningSource, /from "\.\/logical_agents\.js"/);
  assert.match(gocRuntimeSource, /from "\.\/logical_agents\.js"/);
  assert.doesNotMatch(routePlanningSource, /function normalizeAgentLookupKey/);
  assert.doesNotMatch(gocRuntimeSource, /function normalizeAgentLookupKey/);

  const picked = pickBaselineConversationCatalogAgents([
    { id: "router-1", name: " Router / Core " },
    { id: "planner-1", systemKey: "Planner" },
    { id: "research-1", system_key: "Researcher" },
    { id: "coder-1", name: "Code / Coder" },
  ]);

  assert.deepEqual(picked, [
    "router-1",
    "planner-1",
    "research-1",
    "coder-1",
  ]);
});
