import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogicalAgentCatalogIndex,
  resolveLogicalAgentRef,
} from "../src/application/logical_agents.js";

test("logical agent catalog dedupes public defaults and installed private copies using public lineage ids", () => {
  const plannerPublicId = "planner_public_uuid_like";
  const plannerPrivateId = "planner_private_uuid_like";
  const routerPublicId = "router_public_uuid_like";
  const routerPrivateId = "router_private_uuid_like";
  const catalog = buildLogicalAgentCatalogIndex([
    {
      id: plannerPublicId,
      name: "Planner",
      system_key: "planner",
      source_agent_id: null,
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
    {
      id: plannerPrivateId,
      name: "Planner",
      system_key: null,
      source_agent_id: plannerPublicId,
      is_system_default: false,
      owner_user_id: "user_1",
      service_id: "svc_1",
      visibility: "private",
      installed_from_public: true,
    },
    {
      id: routerPublicId,
      name: "Router",
      system_key: "router",
      source_agent_id: null,
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
    {
      id: routerPrivateId,
      name: "Router",
      system_key: null,
      source_agent_id: routerPublicId,
      is_system_default: false,
      owner_user_id: "user_1",
      service_id: "svc_1",
      visibility: "private",
      installed_from_public: true,
    },
  ]);

  assert.equal(catalog.agents.length, 2);
  assert.equal(catalog.rawIdToLogicalId.get(plannerPublicId), "planner");
  assert.equal(catalog.rawIdToLogicalId.get(plannerPrivateId), "planner");
  assert.equal(catalog.rawIdToLogicalId.get(routerPublicId), "router");
  assert.equal(catalog.rawIdToLogicalId.get(routerPrivateId), "router");

  const planner = catalog.byLogicalId.get("planner");
  assert.ok(planner);
  assert.equal(planner.command_ref, "planner");
  assert.equal(planner.representative_agent_id, plannerPrivateId);
  assert.deepEqual(planner.logical_member_agent_ids, [plannerPublicId, plannerPrivateId]);
});

test("logical agent refs stay human-usable for real backend lineage ids", () => {
  const plannerPublicId = "planner_public_uuid_like";
  const plannerPrivateId = "planner_private_uuid_like";
  const catalog = buildLogicalAgentCatalogIndex([
    {
      id: plannerPublicId,
      name: "Planner",
      system_key: "planner",
      source_agent_id: null,
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
    {
      id: plannerPrivateId,
      name: "Planner",
      system_key: null,
      source_agent_id: plannerPublicId,
      is_system_default: false,
      owner_user_id: "user_1",
      service_id: "svc_1",
      visibility: "private",
      installed_from_public: true,
    },
  ]);

  const plannerByRole = resolveLogicalAgentRef("planner", catalog);
  assert.equal(plannerByRole?.logical_agent?.logical_agent_id, "planner");
  assert.equal(plannerByRole?.logical_agent?.command_ref, "planner");

  const plannerByPublicId = resolveLogicalAgentRef(plannerPublicId, catalog);
  assert.equal(plannerByPublicId?.logical_agent?.logical_agent_id, "planner");
  assert.equal(plannerByPublicId?.logical_agent?.command_ref, "planner");
});
