import fs from "node:fs";
import path from "node:path";

const DEFAULT_AGENTS = [
  {
    id: "planner",
    name: "Planner",
    description: "상위 의사결정/다음 단계 계획 수립",
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
    description: "코드 구현/수정 담당",
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
    description: "조사/리스크 분석 담당",
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
    description: "변경 검토/회귀 위험 점검",
    provider: "gemini",
    model: "gemini",
    prompt: [
      "역할: 리뷰 에이전트",
      "- 변경사항의 버그 가능성, 회귀 위험, 누락 테스트를 우선 점검한다.",
      "- 치명도 순으로 발견사항을 정리한다.",
    ].join("\n"),
  },
];

const PROVIDER_ALIASES = {
  gpt: "chatgpt",
  openai: "chatgpt",
  codex: "codex",
  gemini: "gemini",
  chatgpt: "chatgpt",
};

function normalizeProvider(raw) {
  const key = String(raw || "").trim().toLowerCase();
  return PROVIDER_ALIASES[key] || "gemini";
}

function normalizeAgent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim().toLowerCase();
  if (!id) return null;
  return {
    id,
    name: String(raw.name || id).trim(),
    description: String(raw.description || "").trim(),
    provider: normalizeProvider(raw.provider),
    model: String(raw.model || raw.provider || "").trim() || normalizeProvider(raw.provider),
    prompt: String(raw.prompt || "").trim(),
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
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return { path: registryPath, agents, byId };
}

export function getAgent(agentId, registry = null) {
  const reg = registry || loadAgents();
  const key = String(agentId || "").trim().toLowerCase();
  return reg.byId.get(key) || null;
}

