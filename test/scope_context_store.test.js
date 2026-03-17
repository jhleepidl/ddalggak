import test from "node:test";
import assert from "node:assert/strict";
import {
  createScopeContextStore,
  ScopeLocalContextStore,
  ScopeGocContextStore,
} from "../src/runtime_capabilities/scope_context_store.js";

test("createScopeContextStore defaults to the local scope context store", () => {
  const store = createScopeContextStore();
  assert.ok(store instanceof ScopeLocalContextStore);
  assert.equal(store.source, "local");
});

test("createScopeContextStore returns GoC-backed store when requested", () => {
  const fakeClient = { materializeRuntimeScopes: async () => ({}) };
  const store = createScopeContextStore({ source: "goc", client: fakeClient });
  assert.ok(store instanceof ScopeGocContextStore);
  assert.equal(store.source, "goc");
});
