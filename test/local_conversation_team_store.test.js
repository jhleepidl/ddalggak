import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalConversationTeamStore } from "../src/runtime_capabilities/conversation_team_store.js";

test("local conversation team store supports add/remove/enable/disable per job", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ddalggak-team-store-"));
  const runsDir = path.join(tmpRoot, "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const jobId = "job_local_team_1";
  fs.mkdirSync(path.join(runsDir, jobId), { recursive: true });

  const store = new LocalConversationTeamStore({
    baseDir: runsDir,
  });

  const bootstrapped = await store.ensureTeam({
    jobId,
    baselineAgentIds: ["planner", "coder"],
  });
  assert.equal(bootstrapped.rows.length, 2);
  assert.equal(bootstrapped.rows[0].agent_id, "planner");
  assert.equal(bootstrapped.rows[1].agent_id, "coder");

  await store.setAgentEnabled({
    jobId,
    agentId: "coder",
    enabled: false,
  });
  let listed = await store.listAgents({ jobId });
  const coder = listed.rows.find((row) => row.agent_id === "coder");
  assert.ok(coder);
  assert.equal(coder.enabled, false);

  await store.addAgent({
    jobId,
    agentId: "researcher",
    enabled: true,
  });
  listed = await store.listAgents({ jobId });
  assert.ok(listed.rows.some((row) => row.agent_id === "researcher" && row.enabled === true));

  await store.removeAgent({
    jobId,
    agentId: "planner",
  });
  listed = await store.listAgents({ jobId });
  assert.equal(listed.rows.some((row) => row.agent_id === "planner"), false);
  assert.equal(listed.rows.some((row) => row.agent_id === "coder"), true);
  assert.equal(listed.rows.some((row) => row.agent_id === "researcher"), true);
});

