import test from "node:test";
import assert from "node:assert/strict";

import {
  buildLogicalAgentCatalogIndex,
  resolveLogicalAgentRef,
} from "../src/application/logical_agents.js";

test("logical agent catalog groups installed/public preset lineage under stable logical ids", () => {
  const builderPublicId = "builder_public_uuid_like";
  const builderPrivateId = "builder_private_uuid_like";
  const catalog = buildLogicalAgentCatalogIndex([
    {
      id: builderPublicId,
      name: "Builder",
      system_key: "builder",
      source_agent_id: null,
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
    {
      id: builderPrivateId,
      name: "Builder",
      system_key: null,
      source_agent_id: builderPublicId,
      is_system_default: false,
      owner_user_id: "user_1",
      service_id: "svc_1",
      visibility: "private",
      installed_from_public: true,
    },
  ]);

  assert.equal(catalog.agents.length, 1);
  assert.equal(catalog.rawIdToLogicalId.get(builderPublicId), "builder");
  assert.equal(catalog.rawIdToLogicalId.get(builderPrivateId), "builder");

  const builder = catalog.byLogicalId.get("builder");
  assert.ok(builder);
  assert.equal(builder.command_ref, "builder");
  assert.equal(builder.representative_agent_id, builderPrivateId);
  assert.equal(builder.logical_kind, "preset");
  assert.equal(builder.logical_role_id, "builder");
  assert.equal(builder.logical_label, "Builder");
  assert.deepEqual(builder.logical_member_agent_ids, [builderPublicId, builderPrivateId]);
});

test("logical agent refs remain human-usable through canonical and raw lineage ids", () => {
  const reviewerPublicId = "reviewer_public_uuid_like";
  const reviewerPrivateId = "reviewer_private_uuid_like";
  const catalog = buildLogicalAgentCatalogIndex([
    {
      id: reviewerPublicId,
      name: "Reviewer",
      system_key: "reviewer",
      source_agent_id: null,
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
    {
      id: reviewerPrivateId,
      name: "Reviewer",
      system_key: null,
      source_agent_id: reviewerPublicId,
      is_system_default: false,
      owner_user_id: "user_1",
      service_id: "svc_1",
      visibility: "private",
      installed_from_public: true,
    },
  ]);

  const reviewerByRole = resolveLogicalAgentRef("reviewer", catalog);
  assert.equal(reviewerByRole?.logical_agent?.logical_agent_id, "reviewer");
  assert.equal(reviewerByRole?.logical_agent?.logical_kind, "preset");

  const reviewerByPublicId = resolveLogicalAgentRef(reviewerPublicId, catalog);
  assert.equal(reviewerByPublicId?.logical_agent?.logical_agent_id, "reviewer");
  assert.equal(reviewerByPublicId?.logical_agent?.command_ref, "reviewer");
});

test("planner lineage remains a control actor and not a worker preset", () => {
  const plannerCatalog = buildLogicalAgentCatalogIndex([
    {
      id: "planner_public_uuid_like",
      name: "Planner",
      system_key: "planner",
      is_system_default: true,
      service_id: "public",
      visibility: "public",
      published: true,
    },
  ]);

  const planner = plannerCatalog.byLogicalId.get("planner");
  assert.ok(planner);
  assert.equal(planner.logical_kind, "control_actor");
  assert.equal(planner.logical_role_id, "deprecated_control_plane_only");
});
