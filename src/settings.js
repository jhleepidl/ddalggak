import fs from "node:fs";
import path from "node:path";

const DEFAULT_POLICY_PROMPT = [
  "아래 조건 중 하나 이상이 명확하면 ChatGPT에 다음 단계 질문 프롬프트를 자동 생성한다.",
  "- 구현이 같은 문제를 반복하거나, 수정-실패 루프가 감지된다.",
  "- 문제가 복잡해져 상위 수준의 재설계/세부 계획이 필요하다.",
  "- 누적된 변경사항이 커서 점검(테스트 전략, 회귀 위험, 리뷰 체크리스트)이 필요하다.",
  "- 현재 정보만으로 결정을 내리기 어렵고, 의사결정 근거 정리가 필요하다.",
  "",
  "반대로 아래이면 자동 생성하지 않는다.",
  "- 작업이 직선적으로 잘 진행되고 있고, 다음 단계가 명확하다.",
  "- 단순한 후속 작업(문구 수정, 사소한 포맷 수정 등)만 남아 있다.",
  "",
  "판단은 보수적으로 하되, 루프/복잡도/검증 필요 신호가 있으면 적극적으로 true를 선택한다.",
].join("\n");

const DEFAULT_ROUTER_PROMPT = [
  "최신 사용자 요청을 먼저 처리하고, 기본은 single-agent fast path로 둔다.",
  "- 단순 질의/추천/요약은 현재 활성 agent 1명에게 직접 맡긴다.",
  "- multi-agent는 정량 autonomy score가 threshold를 넘거나, 명확한 병렬 하위작업/구현+검토/외부 skill 조합/반복 실패가 있을 때만 사용한다.",
  "- 중복 작업 금지: 같은 분석/계획/코딩을 여러 에이전트에게 반복시키지 않는다.",
  "- stale memory/template보다 최신 user_message를 우선한다.",
  "- skill이 필요하면 현재 catalog/attached skills를 먼저 확인하고, 없으면 사용자 승인용 skill draft를 제안한다.",
  "- typed memory는 task domain에 맞게 event_log, user_preferences, project_state, decisions, capability_registry 등으로 분류한다.",
].join("\n");

const DEFAULT_AGENT_ROLES = {
  gemini: [
    "역할: 기본 실행/리서치 agent",
    "- 최신 사용자 요청에 직접 답하고, 필요한 경우 짧은 근거와 다음 선택지를 제시한다.",
    "- 기술 검토가 아닌 일반 요청에서는 구현 리스크 템플릿을 출력하지 않는다.",
  ].join("\n"),
  codex: [
    "역할: 코드 변경 agent",
    "- 사용자가 코드 수정/패치를 원하거나 self-improvement job에서만 호출한다.",
    "- 변경 이유, 영향, 검증 명령을 간결히 보고한다.",
  ].join("\n"),
  chatgpt: [
    "역할: 상위 조정/리뷰 agent",
    "- multi-agent 분해, 반복 실패, 큰 방향 전환, 최종 synthesis가 필요할 때만 호출한다.",
    "- 단순 요청에는 끼어들지 않는다.",
  ].join("\n"),
};

function parseSection(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)##\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
  const m = String(text || "").match(re);
  return (m?.[1] || "").trim();
}

function parseSubSection(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)###\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n###\\s+|$)`);
  const m = String(text || "").match(re);
  return (m?.[1] || "").trim();
}

function parseBullets(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("- "))
    .map(line => line.slice(2).trim())
    .filter(Boolean);
}

function ensureBulletList(items, fallback) {
  const out = (Array.isArray(items) ? items : [])
    .map(v => String(v || "").trim())
    .filter(Boolean);
  return out.length > 0 ? out : [...fallback];
}

function tryParseLegacyNotes(text) {
  const lines = String(text || "").split(/\r?\n/);
  const notes = [];
  for (const line of lines) {
    if (line.includes("autosuggest.enabled")) notes.push(`Legacy: ${line.trim()}`);
    if (line.includes("autosuggest.cooldown_sec")) notes.push(`Legacy: ${line.trim()} (deprecated)`);
    if (line.includes("autosuggest.events")) notes.push(`Legacy: ${line.trim()} (deprecated)`);
  }
  return notes;
}

function looksLikeLegacyRouterPrompt(text = "") {
  const raw = String(text || "");
  return /Gemini는 리서치\/리스크\/검증 전략 중심|Codex는 실제 코드 변경|ChatGPT는 상위 의사결정|같은 분석\/계획\/코딩을 여러 에이전트/i.test(raw);
}

function looksLikeLegacyAgentRole(text = "") {
  const raw = String(text || "");
  return /기술 리서처\/검토자|코드 작성\/수정 대신|테스트는 직접 실행하지 말고 필요한 테스트를 제안/i.test(raw);
}

function maybeMigrateLegacyMemoryState(state = {}, raw = "") {
  const next = { ...state, agentRoles: { ...(state.agentRoles || {}) } };
  const migrated = [];
  const rawText = String(raw || "");
  if (looksLikeLegacyRouterPrompt(next.routerPrompt) || /##\s+Multi-Agent Router Prompt/.test(rawText)) {
    next.routerPrompt = DEFAULT_ROUTER_PROMPT;
    migrated.push("router_prompt: legacy multi-agent template replaced with single-first autonomy policy");
  }
  for (const key of ["gemini", "codex", "chatgpt"]) {
    if (looksLikeLegacyAgentRole(next.agentRoles[key])) {
      next.agentRoles[key] = DEFAULT_AGENT_ROLES[key];
      migrated.push(`agent_role.${key}: legacy role template replaced`);
    }
  }
  if (migrated.length > 0) {
    next.operatorNotes = ensureBulletList([
      ...(Array.isArray(next.operatorNotes) ? next.operatorNotes : []),
      `Auto-migrated legacy memory template at ${new Date().toISOString()}: ${migrated.join("; ")}`,
    ], ["Legacy memory template auto-migrated."]);
  }
  return next;
}

function normalizeAgentName(name) {
  const key = String(name || "").trim().toLowerCase();
  if (["gemini", "g"].includes(key)) return "gemini";
  if (["codex", "c"].includes(key)) return "codex";
  if (["chatgpt", "chatgpt_prompt", "gpt", "chat"].includes(key)) return "chatgpt";
  return null;
}

export class OrchestratorMemory {
  constructor({ baseDir }) {
    this.baseDir = path.resolve(baseDir);
    this.filePath = path.join(this.baseDir, "settings.md");
    this.state = this._load();
  }

  _normalize(input) {
    const rolesInput = input?.agentRoles || {};
    return {
      policyPrompt: String(input?.policyPrompt || DEFAULT_POLICY_PROMPT).trim(),
      routerPrompt: String(input?.routerPrompt || DEFAULT_ROUTER_PROMPT).trim(),
      agentRoles: {
        gemini: String(rolesInput.gemini || DEFAULT_AGENT_ROLES.gemini).trim(),
        codex: String(rolesInput.codex || DEFAULT_AGENT_ROLES.codex).trim(),
        chatgpt: String(rolesInput.chatgpt || DEFAULT_AGENT_ROLES.chatgpt).trim(),
      },
      operatorNotes: ensureBulletList(input?.operatorNotes, [
        "필요하면 /memory policy <text> 로 판단 기준을 더 엄격/완화한다.",
      ]),
      recentLessons: ensureBulletList(input?.recentLessons, [
        "루프나 막힘이 감지되면 큰 그림(계획/검증) 질문을 먼저 생성한다.",
      ]),
    };
  }

  _render(state) {
    const s = this._normalize(state);
    const notesMd = s.operatorNotes.map(v => `- ${v}`).join("\n");
    const lessonsMd = s.recentLessons.map(v => `- ${v}`).join("\n");
    return [
      "# Orchestrator Memory",
      "",
      `> updatedAt: ${new Date().toISOString()}`,
      "> 이 파일은 자연어 메모리이며, 오케스트레이터의 자기반성/자동질문 트리거에 사용됩니다.",
      "",
      "## Auto-Suggest Reflection Prompt",
      s.policyPrompt,
      "",
      "## Agent Routing Prompt",
      s.routerPrompt,
      "",
      "## Agent Roles",
      "### Gemini",
      s.agentRoles.gemini,
      "",
      "### Codex",
      s.agentRoles.codex,
      "",
      "### ChatGPT",
      s.agentRoles.chatgpt,
      "",
      "## Operator Notes",
      notesMd,
      "",
      "## Recent Lessons",
      lessonsMd,
      "",
    ].join("\n");
  }

  _parse(text) {
    const policyPrompt = parseSection(text, "Auto-Suggest Reflection Prompt");
    const routerPrompt = parseSection(text, "Agent Routing Prompt") || parseSection(text, "Multi-Agent Router Prompt");
    const roleSection = parseSection(text, "Agent Roles");
    const geminiRole = parseSubSection(roleSection, "Gemini");
    const codexRole = parseSubSection(roleSection, "Codex");
    const chatgptRole = parseSubSection(roleSection, "ChatGPT");
    const operatorNotes = parseBullets(parseSection(text, "Operator Notes"));
    const recentLessons = parseBullets(parseSection(text, "Recent Lessons"));
    return this._normalize({
      policyPrompt: policyPrompt || DEFAULT_POLICY_PROMPT,
      routerPrompt: routerPrompt || DEFAULT_ROUTER_PROMPT,
      agentRoles: {
        gemini: geminiRole || DEFAULT_AGENT_ROLES.gemini,
        codex: codexRole || DEFAULT_AGENT_ROLES.codex,
        chatgpt: chatgptRole || DEFAULT_AGENT_ROLES.chatgpt,
      },
      operatorNotes,
      recentLessons,
    });
  }

  _load() {
    fs.mkdirSync(this.baseDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      const init = this._normalize({});
      this._save(init);
      return init;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    let parsed = this._parse(raw);
    const legacyNotes = tryParseLegacyNotes(raw);
    if (legacyNotes.length > 0) {
      parsed.operatorNotes = ensureBulletList([...parsed.operatorNotes, ...legacyNotes], parsed.operatorNotes);
    }
    parsed = this._normalize(maybeMigrateLegacyMemoryState(parsed, raw));
    this._save(parsed);
    return parsed;
  }

  _save(state) {
    const normalized = this._normalize(state);
    fs.writeFileSync(this.filePath, this._render(normalized), "utf8");
    this.state = normalized;
    return normalized;
  }

  getPolicyPrompt() {
    return this.state.policyPrompt;
  }

  getSummary() {
    const preview = this.state.policyPrompt.split(/\r?\n/).slice(0, 5).join("\n");
    const routerPreview = this.state.routerPrompt.split(/\r?\n/).slice(0, 5).join("\n");
    return {
      filePath: this.filePath,
      policyPreview: preview,
      routerPreview,
      noteCount: this.state.operatorNotes.length,
      lessonCount: this.state.recentLessons.length,
    };
  }

  getRouterPrompt() {
    return this.state.routerPrompt;
  }

  setRouterPrompt(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("router prompt cannot be empty");
    return this._save({ ...this.state, routerPrompt: value });
  }

  getAgentRoles() {
    return { ...this.state.agentRoles };
  }

  getAgentRole(name) {
    const key = normalizeAgentName(name);
    if (!key) throw new Error("unknown agent");
    return this.state.agentRoles[key];
  }

  setAgentRole(name, text) {
    const key = normalizeAgentName(name);
    if (!key) throw new Error("unknown agent (use: gemini|codex|chatgpt)");
    const value = String(text || "").trim();
    if (!value) throw new Error("agent role text cannot be empty");
    return this._save({
      ...this.state,
      agentRoles: {
        ...this.state.agentRoles,
        [key]: value,
      },
    });
  }

  getAgentRoleSummary() {
    const roles = this.getAgentRoles();
    return {
      geminiPreview: roles.gemini.split(/\r?\n/).slice(0, 3).join("\n"),
      codexPreview: roles.codex.split(/\r?\n/).slice(0, 3).join("\n"),
      chatgptPreview: roles.chatgpt.split(/\r?\n/).slice(0, 3).join("\n"),
    };
  }

  readMarkdown() {
    if (!fs.existsSync(this.filePath)) this._save(this.state);
    return fs.readFileSync(this.filePath, "utf8");
  }

  setPolicyPrompt(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("policy prompt cannot be empty");
    return this._save({ ...this.state, policyPrompt: value });
  }

  addOperatorNote(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("note cannot be empty");
    return this._save({ ...this.state, operatorNotes: [...this.state.operatorNotes, value] });
  }

  addRecentLesson(text) {
    const value = String(text || "").trim();
    if (!value) throw new Error("lesson cannot be empty");
    return this._save({ ...this.state, recentLessons: [...this.state.recentLessons, value] });
  }

  reset() {
    return this._save(this._normalize({}));
  }
}
