import fs from "node:fs";
import path from "node:path";
import { normalizeProviderName, normalizeStringList } from "./shared/normalize.js";
import {
  normalizeAgentTemplate,
  normalizeLegacyAgentToTemplate,
} from "./domain/agent_templates.js";
import {
  getLegacyAliasesForRole,
  getTransportRoleId,
  normalizeRoleId,
} from "./compatibility/legacy_roles.js";

const DEFAULT_AGENTS = [
  {
    id: "researcher",
    name: "Researcher",
    role_type: "researcher",
    description: "Research, evidence gathering, and risk analysis.",
    capability_tags: ["research", "analysis", "fact_check"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "Role: Research Agent",
      "- Identify implementation prerequisites, risks, evidence, and verification points before changes.",
      "- Prefer analysis, sources, and validation criteria over code patches unless implementation is explicitly requested.",
    ].join("\n"),
    meta: {
      team_default: true,
      system_key: "researcher",
      canonical_language: "en",
      localized: { ko: { description: "조사/증거 수집/리스크 분석 담당" } },
      legacy_aliases: [],
    },
  },
  {
    id: "builder",
    name: "Builder",
    role_type: "builder",
    description: "Code implementation, patching, and refactoring.",
    capability_tags: ["implementation", "coding", "refactor"],
    provider: "codex",
    model: "codex",
    prompt: [
      "Role: Builder Agent",
      "- Make precise code changes only within the requested scope and runtime policy.",
      "- Summarize the reason, impact, and verification points for each change.",
    ].join("\n"),
    meta: {
      team_default: true,
      system_key: "builder",
      canonical_language: "en",
      localized: { ko: { description: "코드 구현/수정 담당" } },
      legacy_aliases: ["coder"],
    },
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role_type: "reviewer",
    description: "Change review, QA, regression-risk inspection, and verification.",
    capability_tags: ["review", "qa", "verification"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "Role: Reviewer Agent",
      "- Inspect changes for bugs, regression risk, missing tests, and policy violations.",
      "- Report findings by severity with actionable recommendations.",
    ].join("\n"),
    meta: {
      team_default: true,
      system_key: "reviewer",
      canonical_language: "en",
      localized: { ko: { description: "변경 검토/회귀 위험 점검" } },
      legacy_aliases: ["verifier"],
    },
  },
  {
    id: "synthesizer",
    name: "Synthesizer",
    role_type: "synthesizer",
    description: "Final synthesis, briefing, and user-facing handoff.",
    capability_tags: ["summary", "briefing", "handoff"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "Role: Synthesis Agent",
      "- Convert upstream research, implementation, and review results into a clear final response.",
      "- Separate conclusion, evidence, and remaining risks without overclaiming.",
    ].join("\n"),
    meta: {
      team_default: true,
      system_key: "synthesizer",
      canonical_language: "en",
      localized: { ko: { description: "최종 결과 요약/전달 담당" } },
      legacy_aliases: ["messenger"],
    },
  },
  {
    id: "operator",
    name: "Operator",
    role_type: "operator",
    description: "Workflow, context, and runtime-state operations.",
    capability_tags: ["operations", "context", "runtime"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "Role: Operations Context Agent",
      "- Coordinate workflow shape, context loading, runtime state, and required handoffs.",
      "- Summarize execution readiness and operational risks concisely.",
    ].join("\n"),
    meta: {
      team_default: true,
      system_key: "operator",
      canonical_language: "en",
      localized: { ko: { description: "워크플로우/컨텍스트/상태 운영 담당" } },
      legacy_aliases: ["context_curator"],
    },
  },
];

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim().toLowerCase();
  if (!id) return null;
  const provider = normalizeProviderName(raw.provider || raw.model || "gemini");
  const roleType = String(raw.role_type || raw.roleType || id).trim().toLowerCase() || id;
  const capabilityTags = normalizeStringList(raw.capability_tags ?? raw.capabilityTags ?? [], {
    max: 32,
    lower: true,
  });
  const tools = normalizeStringList(raw.tools ?? raw.tool_ids ?? raw.toolIds ?? [], {
    max: 32,
    lower: true,
  });
  return {
    id,
    name: String(raw.name || id).trim(),
    role_type: roleType,
    description: String(raw.description || "").trim(),
    capability_tags: capabilityTags,
    provider,
    model: String(raw.model || raw.provider || "").trim() || provider,
    prompt: String(raw.prompt || "").trim(),
    tools,
    meta: raw.meta && typeof raw.meta === "object" ? raw.meta : {},
  };
}

function parseRegistry(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray(raw.agents)) return raw.agents;
  return null;
}

function dedupeById(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

export function getAgentsRegistryPath() {
  return path.resolve(process.env.AGENTS_REGISTRY_PATH || "./agents.json");
}

export function loadAgents() {
  const registryPath = getAgentsRegistryPath();
  const defaults = DEFAULT_AGENTS.map(normalizeAgent).filter(Boolean);

  let loaded = [];
  if (fs.existsSync(registryPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8"));
      const rows = parseRegistry(parsed);
      if (rows) loaded = rows.map(normalizeAgent).filter(Boolean);
    } catch {
      loaded = [];
    }
  }

  const agents = dedupeById(loaded.length > 0 ? loaded : defaults);
  const templates = dedupeById(
    agents
      .map((agent) => normalizeLegacyAgentToTemplate(agent))
      .filter(Boolean)
  );
  const byId = new Map();
  for (const agent of agents) {
    byId.set(agent.id, agent);
    const canonicalRoleId = normalizeRoleId(agent.role_type || agent.id, {
      allowDeprecatedControlPlane: false,
      fallback: "",
    });
    const aliases = canonicalRoleId
      ? [
        canonicalRoleId,
        getTransportRoleId(canonicalRoleId),
        ...getLegacyAliasesForRole(canonicalRoleId),
        ...(Array.isArray(agent?.meta?.legacy_aliases) ? agent.meta.legacy_aliases : []),
      ]
      : [];
    for (const alias of aliases) {
      const cleanAlias = String(alias || "").trim().toLowerCase();
      if (!cleanAlias || cleanAlias === "planner") continue;
      if (!byId.has(cleanAlias)) byId.set(cleanAlias, agent);
    }
  }
  const templatesById = new Map();
  for (const template of templates) {
    templatesById.set(template.id, template);
    const canonicalRoleId = normalizeRoleId(template.role_type || template.id, {
      allowDeprecatedControlPlane: false,
      fallback: "",
    });
    const aliases = canonicalRoleId
      ? [canonicalRoleId, getTransportRoleId(canonicalRoleId), ...getLegacyAliasesForRole(canonicalRoleId)]
      : [];
    for (const alias of aliases) {
      const cleanAlias = String(alias || "").trim().toLowerCase();
      if (!cleanAlias || cleanAlias === "planner") continue;
      if (!templatesById.has(cleanAlias)) templatesById.set(cleanAlias, template);
    }
  }
  return {
    path: registryPath,
    agents,
    byId,
    templates,
    templatesById,
  };
}

export function getAgent(agentId, registry = null) {
  const reg = registry || loadAgents();
  const key = String(agentId || "").trim().toLowerCase();
  return reg.byId.get(key) || null;
}

export function loadAgentTemplates(registry = null) {
  const reg = registry || loadAgents();
  const templates = Array.isArray(reg.templates)
    ? reg.templates
    : (Array.isArray(reg.agents)
      ? reg.agents.map((agent) => normalizeAgentTemplate(agent)).filter(Boolean)
      : []);
  const byId = reg.templatesById instanceof Map
    ? reg.templatesById
    : new Map(templates.map((template) => [template.id, template]));
  return {
    path: reg.path,
    templates,
    byId,
  };
}

export function getAgentTemplate(agentId, registry = null) {
  const reg = loadAgentTemplates(registry || loadAgents());
  const key = String(agentId || "").trim().toLowerCase();
  return reg.byId.get(key) || null;
}
