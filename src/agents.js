import fs from "node:fs";
import path from "node:path";
import { normalizeProviderName, normalizeStringList } from "./shared/normalize.js";
import {
  normalizeAgentTemplate,
  normalizeLegacyAgentToTemplate,
} from "./domain/agent_templates.js";

const DEFAULT_AGENTS = [
  {
    id: "planner",
    name: "Planner",
    role_type: "planner",
    description: "상위 의사결정/다음 단계 계획 수립",
    capability_tags: ["planning", "routing", "prioritization"],
    provider: "chatgpt",
    model: "chatgpt",
    prompt: [
      "역할: 오케스트레이터 플래너",
      "- 전체 목표 대비 우선순위를 정하고 다음 액션을 최소 단계로 제안한다.",
      "- 중복 분석/중복 구현을 피하고 의사결정 근거를 짧게 남긴다.",
    ].join("\n"),
  },
  {
    id: "coder",
    name: "Coder",
    role_type: "coder",
    description: "코드 구현/수정 담당",
    capability_tags: ["implementation", "coding", "refactor"],
    provider: "codex",
    model: "codex",
    prompt: [
      "역할: 구현 에이전트",
      "- 요청 범위 안에서만 정확히 코드 변경을 수행한다.",
      "- 변경 이유/영향/테스트 포인트를 간결히 요약한다.",
    ].join("\n"),
  },
  {
    id: "researcher",
    name: "Researcher",
    role_type: "researcher",
    description: "조사/리스크 분석 담당",
    capability_tags: ["research", "analysis", "risk_assessment"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "역할: 기술 조사 에이전트",
      "- 구현 전 확인사항, 리스크, 검증 체크리스트를 정리한다.",
      "- 코드 패치 대신 분석/근거 중심으로 답한다.",
    ].join("\n"),
  },
  {
    id: "reviewer",
    name: "Reviewer",
    role_type: "reviewer",
    description: "변경 검토/회귀 위험 점검",
    capability_tags: ["review", "qa", "verification"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "역할: 리뷰 에이전트",
      "- 변경사항의 버그 가능성, 회귀 위험, 누락 테스트를 우선 점검한다.",
      "- 치명도 순으로 발견사항을 정리한다.",
    ].join("\n"),
  },
  {
    id: "messenger",
    name: "Messenger",
    role_type: "messenger",
    description: "최종 결과 요약/전달 담당",
    capability_tags: ["summary", "briefing", "handoff"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "역할: 결과 종합 에이전트",
      "- upstream 조사/구현/리뷰 결과를 짧고 명확한 최종 응답으로 정리한다.",
      "- 과장 없이 결론, 근거, 남은 리스크를 분리해서 전달한다.",
    ].join("\n"),
  },
  {
    id: "context_curator",
    name: "Context Curator",
    role_type: "context_curator",
    description: "워크플로우/컨텍스트/상태 운영 담당",
    capability_tags: ["operations", "context", "runtime"],
    provider: "gemini",
    model: "gemini",
    prompt: [
      "역할: 운영 컨텍스트 에이전트",
      "- 작업 흐름, 컨텍스트 적재, 런타임 상태를 정리하고 필요한 연결을 맞춘다.",
      "- 실행 준비 상태와 운영 리스크를 간결하게 요약한다.",
    ].join("\n"),
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
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const templatesById = new Map(templates.map((template) => [template.id, template]));
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
