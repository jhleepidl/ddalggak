import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyValidatedConversationTeamMutation,
  createConversationTeamMutationValidationError,
  reconcileConversationTeamWithCatalog,
} from "../src/application/conversation_team_mutation.js";
import { LocalConversationTeamStore } from "../src/runtime_capabilities/conversation_team_store.js";

function createLocalStore() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-team-mutation-"));
  const runsDir = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  return new LocalConversationTeamStore({ baseDir: runsDir });
}

const catalogRows = [
  { id: "planner" },
  { id: "coder" },
  { id: "researcher" },
];

test("local add rejects unknown agent id and does not persist bogus membership", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_unknown_add";
  await store.ensureTeam({ jobId, baselineAgentIds: ["planner"] });

  const mutation = await applyValidatedConversationTeamMutation({
    teamStore: store,
    actionType: "add",
    agentId: "ghost",
    mutationOptions: { jobId },
    catalogRows,
    requireCatalogValidation: true,
  });

  assert.equal(mutation.ok, false);
  assert.equal(mutation.validation?.code, "unknown_agent");
  assert.match(String(mutation.validation?.message || ""), /Unknown agent id/i);

  const error = createConversationTeamMutationValidationError(mutation.validation);
  assert.equal(error.code, "unknown_agent");
  assert.match(String(error.message || ""), /Unknown agent id/i);

  const listed = await store.listAgents({ jobId });
  assert.equal(listed.rows.some((row) => row.agent_id === "ghost"), false);
  assert.equal(listed.rows.some((row) => row.agent_id === "planner"), true);
});

test("local enable rejects unknown agent id and does not persist bogus membership", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_unknown_enable";
  await store.ensureTeam({ jobId, baselineAgentIds: ["planner"] });

  const mutation = await applyValidatedConversationTeamMutation({
    teamStore: store,
    actionType: "enable",
    agentId: "ghost",
    mutationOptions: { jobId },
    catalogRows,
    requireCatalogValidation: true,
  });

  assert.equal(mutation.ok, false);
  assert.equal(mutation.validation?.code, "unknown_agent");

  const listed = await store.listAgents({ jobId });
  assert.equal(listed.rows.some((row) => row.agent_id === "ghost"), false);
  assert.equal(listed.rows.some((row) => row.agent_id === "planner"), true);
});

test("local add keeps succeeding for known catalog agent ids", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_known_add";
  await store.ensureTeam({ jobId, baselineAgentIds: ["planner"] });

  const mutation = await applyValidatedConversationTeamMutation({
    teamStore: store,
    actionType: "add",
    agentId: "coder",
    mutationOptions: { jobId },
    catalogRows,
    requireCatalogValidation: true,
  });

  assert.equal(mutation.ok, true);
  assert.equal(Array.isArray(mutation.result?.rows), true);
  assert.equal(
    mutation.result.rows.some((row) => row.agent_id === "coder" && row.enabled === true),
    true
  );
});

test("conversation team reconciliation remains consistent with catalog truth", () => {
  const reconciled = reconcileConversationTeamWithCatalog({
    conversationRows: [
      { agent_id: "planner", enabled: true },
      { agent_id: "ghost", enabled: true },
      { agent_id: "coder", enabled: false },
    ],
    catalogRows,
  });

  assert.deepEqual(reconciled.active_enabled_agent_ids, ["planner"]);
  assert.deepEqual(reconciled.disabled_member_agent_ids, ["coder"]);
  assert.deepEqual(reconciled.unknown_member_agent_ids, ["ghost"]);
});
