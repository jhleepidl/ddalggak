import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildRuntimeMetadataPatch,
  buildRuntimeRolePayload,
  normalizeRuntimeMetadataEnvelope,
} from "../src/application/runtime_metadata.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_PATH = path.join(__dirname, "..", "test_fixtures", "runtime_contract_golden_fixture.json");
const FIXTURE = JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));

function sortedStrings(values = []) {
  return [...values].map((value) => String(value || "")).sort();
}


function canonicalizeJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripStatus(payload = {}) {
  const { status, ...rest } = payload || {};
  return rest;
}

test("golden runtime contract fixture stays canonical in ddalggak runtime metadata", () => {
  for (const scenario of FIXTURE.scenarios || []) {
    const message = `scenario=${scenario.name}`;
    const normalized = normalizeRuntimeMetadataEnvelope(scenario.run_payload || {});
    assert.ok(normalized, `${message}: normalized envelope missing`);
    assert.deepEqual(normalized.runtime_authority, scenario.authority, `${message}: authority drifted`);
    assert.equal(normalized.action_source, scenario.action_source, `${message}: action_source drifted`);

    const patch = buildRuntimeMetadataPatch(scenario.run_payload || {}, { includeFlattened: true });
    assert.deepEqual(canonicalizeJson(patch), canonicalizeJson(stripStatus(scenario.run_payload)), `${message}: metadata patch drifted`);

    const runtimeAgents = normalized.runtime_agents || [];
    assert.equal(runtimeAgents.length, scenario.expected.counts.runtime_agents, `${message}: runtime agent count drifted`);
    assert.deepEqual(
      sortedStrings(runtimeAgents.map((item) => item.instance_id || item.runtime_instance_id)),
      sortedStrings(scenario.expected.runtime_agent_instance_ids),
      `${message}: runtime agent ids drifted`,
    );
    assert.deepEqual(
      sortedStrings(normalized.context_packs.map((item) => item.id || item.context_pack_id)),
      sortedStrings(scenario.expected.context_pack_ids),
      `${message}: context pack ids drifted`,
    );
    assert.deepEqual(
      sortedStrings(normalized.selected_skill_ids || []),
      sortedStrings(scenario.expected.attached_skill_ids),
      `${message}: selected skill ids drifted`,
    );
    assert.deepEqual(
      sortedStrings((normalized.skill_usage_events || []).map((item) => item.skill_id)),
      sortedStrings(scenario.expected.skill_usage_ids),
      `${message}: skill usage ids drifted`,
    );

    const rolePayloads = runtimeAgents.map((item) => buildRuntimeRolePayload(item));
    assert.deepEqual(
      sortedStrings(rolePayloads.flatMap((item) => item.selected_skill_ids || [])),
      sortedStrings(scenario.expected.attached_skill_ids),
      `${message}: runtime role payload skill ids drifted`,
    );
    assert.deepEqual(
      sortedStrings(rolePayloads.map((item) => item.context_pack_id).filter(Boolean)),
      sortedStrings(scenario.expected.context_pack_ids),
      `${message}: runtime role payload context packs drifted`,
    );

    if (scenario.expected.interrupt_ready === true) {
      assert.equal(
        normalized.execution_graph?.interrupt_ready,
        true,
        `${message}: interrupt_ready should remain true`,
      );
    }
    assert.equal(
      normalized.runtime_authority?.degraded_mode === true,
      scenario.expected.degraded_mode === true,
      `${message}: degraded_mode drifted`,
    );
    assert.equal(
      normalized.runtime_authority?.plan_source,
      scenario.expected.plan_source,
      `${message}: plan_source drifted`,
    );
  }
});
