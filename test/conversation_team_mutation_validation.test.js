import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyConversationPreferenceMutation,
  applyValidatedConversationTeamMutation,
  createConversationTeamMutationValidationError,
  reconcileConversationTeamWithCatalog,
  validateConversationPreferenceMutationAgainstCatalog,
} from "../src/application/conversation_team_mutation.js";
import { LocalConversationTeamStore } from "../src/runtime_capabilities/conversation_team_store.js";

function createLocalStore() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-team-mutation-"));
  const runsDir = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  return new LocalConversationTeamStore({ baseDir: runsDir });
}

const catalogRows = [
  { id: "builder" },
  { id: "researcher" },
  { id: "market_news_researcher" },
];

test("local add rejects unknown agent id and does not persist bogus membership", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_unknown_add";
  await store.ensureTeam({ jobId, baselineAgentIds: ["builder"] });

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
  assert.equal(listed.rows.some((row) => row.agent_id === "builder"), true);
});

test("local enable rejects unknown agent id and does not persist bogus membership", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_unknown_enable";
  await store.ensureTeam({ jobId, baselineAgentIds: ["builder"] });

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
  assert.equal(listed.rows.some((row) => row.agent_id === "builder"), true);
});

test("local add keeps succeeding for known catalog agent ids", async () => {
  const store = createLocalStore();
  const jobId = "job_mutation_known_add";
  await store.ensureTeam({ jobId, baselineAgentIds: ["builder"] });

  const mutation = await applyValidatedConversationTeamMutation({
    teamStore: store,
    actionType: "add",
    agentId: "researcher",
    mutationOptions: { jobId },
    catalogRows,
    requireCatalogValidation: true,
  });

  assert.equal(mutation.ok, true);
  assert.equal(Array.isArray(mutation.result?.rows), true);
  assert.equal(
    mutation.result.rows.some((row) => row.agent_id === "researcher" && row.enabled === true),
    true
  );
});

test("conversation team reconciliation remains consistent with catalog truth", () => {
  const reconciled = reconcileConversationTeamWithCatalog({
    conversationRows: [
      { agent_id: "builder", enabled: true },
      { agent_id: "ghost", enabled: true },
      { agent_id: "researcher", enabled: false },
    ],
    catalogRows,
  });

  assert.deepEqual(reconciled.active_enabled_agent_ids, ["builder"]);
  assert.deepEqual(reconciled.disabled_member_agent_ids, ["researcher"]);
  assert.deepEqual(reconciled.unknown_member_agent_ids, ["ghost"]);
});

test("preference validation resolves legacy roles and preset ids safely", () => {
  const roleValidation = validateConversationPreferenceMutationAgainstCatalog({
    actionType: "disable",
    agentId: "coder",
    catalogRows,
  });
  assert.equal(roleValidation.ok, true);
  assert.equal(roleValidation.target.kind, "role");
  assert.equal(roleValidation.target.target_id, "builder");

  const presetValidation = validateConversationPreferenceMutationAgainstCatalog({
    actionType: "add",
    agentId: "market_news_researcher",
    catalogRows,
  });
  assert.equal(presetValidation.ok, true);
  assert.equal(presetValidation.target.kind, "preset");
  assert.equal(presetValidation.target.target_id, "market_news_researcher");
});

test("preference mutations persist pinned presets and suppressed roles", async () => {
  const store = createLocalStore();
  const jobId = "job_preference_mutation";

  const pinned = await applyConversationPreferenceMutation({
    teamStore: store,
    actionType: "add",
    agentId: "market_news_researcher",
    mutationOptions: { jobId },
    catalogRows,
  });
  assert.equal(pinned.ok, true);
  assert.deepEqual(pinned.result.preferences.pinned_preset_ids, ["market_news_researcher"]);

  const suppressed = await applyConversationPreferenceMutation({
    teamStore: store,
    actionType: "remove",
    agentId: "coder",
    mutationOptions: { jobId },
    catalogRows,
  });
  assert.equal(suppressed.ok, true);
  assert.deepEqual(suppressed.result.preferences.pinned_preset_ids, ["market_news_researcher"]);
  assert.deepEqual(suppressed.result.preferences.suppressed_role_ids, ["builder"]);
});
