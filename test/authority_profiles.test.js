import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AUTHORITY_PROFILES,
  normalizeAuthorityProfile,
} from "../src/domain/authority_profiles.js";
import {
  AuthorityRegistry,
  pickDefaultAuthorityProfileId,
} from "../src/catalog/authority_registry.js";

test("authority profiles expose the required default control presets", () => {
  const registry = new AuthorityRegistry();
  const ids = registry.list().map((profile) => profile.authority_profile_id);

  assert.ok(ids.includes("worker_readonly_research"));
  assert.ok(ids.includes("worker_readonly_review"));
  assert.ok(ids.includes("worker_publish_guarded"));
  assert.ok(ids.includes("supervisor_controlled"));
  assert.equal(pickDefaultAuthorityProfileId("researcher"), "worker_readonly_research");
  assert.equal(pickDefaultAuthorityProfileId("builder"), "worker_publish_guarded");
  assert.equal(pickDefaultAuthorityProfileId("operator"), "supervisor_controlled");
});

test("authority profile normalization keeps required policy fields", () => {
  const normalized = normalizeAuthorityProfile(DEFAULT_AUTHORITY_PROFILES[0]);

  assert.ok(normalized);
  assert.ok(Array.isArray(normalized.allowed_actions));
  assert.ok(Array.isArray(normalized.denied_actions));
  assert.ok(Array.isArray(normalized.approval_required_for));
  assert.ok(Array.isArray(normalized.tool_allowlist));
  assert.equal(typeof normalized.max_parallel_children, "number");
});
