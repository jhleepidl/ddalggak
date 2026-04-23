import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { SkillRegistryV2 as SkillRegistry } from "../src/catalog/skill_registry_v2.js";
import { installSkillPackageToCatalog, summarizeTeamSkillPackages } from "../src/application/skill_package_runtime.js";

test("installSkillPackageToCatalog writes imported skill manifests that registry can load", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-install-"));
  const installed = installSkillPackageToCatalog({
    id: "skill.kskill_stock_search.v1",
    name: "k-skill Korean Stock Search",
    version: "1.0.0",
    execution_adapter: {
      kind: "http_proxy",
      endpoint_env: "KSKILL_PROXY_BASE_URL",
      external_tool_requirements: ["proxy_http"],
    },
    credential_requirements: [
      { key: "KSKILL_PROXY_BASE_URL", required: false, provider: "k-skill-proxy" },
    ],
    trust_level: "reviewed",
    side_effect_level: "read_only",
  }, { skillsDir: tmpRoot });

  assert.ok(fs.existsSync(installed.manifest_path));
  assert.ok(fs.existsSync(installed.instructions_path));

  const registry = new SkillRegistry({ skillsDir: tmpRoot });
  registry.load({ refresh: true });
  const skill = registry.getById("skill.kskill_stock_search.v1");
  assert.ok(skill);
  assert.equal(skill.execution_adapter.kind, "http_proxy");
});

test("summarizeTeamSkillPackages returns execution metadata for attached skills", () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "skill-summary-"));
  installSkillPackageToCatalog({
    id: "skill.kskill_coupang_search.v1",
    name: "k-skill Coupang Search",
    execution_adapter: {
      kind: "local_mcp",
      external_tool_requirements: ["mcp"],
    },
    credential_requirements: [{ key: "COUPANG_ACCESS_KEY", required: false }],
    side_effect_level: "read_only",
  }, { skillsDir: tmpRoot });
  const registry = new SkillRegistry({ skillsDir: tmpRoot });
  registry.load({ refresh: true });

  const summary = summarizeTeamSkillPackages({
    team: { agents: [{ attached_skill_ids: ["skill.kskill_coupang_search.v1"] }] },
    skillRegistry: registry,
  });

  assert.equal(summary.length, 1);
  assert.equal(summary[0].execution_adapter.kind, "local_mcp");
  assert.ok(summary[0].external_tool_requirements.includes("mcp"));
});
