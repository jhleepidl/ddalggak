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

function parseSection(text, heading) {
  const esc = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|\\n)##\\s+${esc}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`);
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

export class OrchestratorMemory {
  constructor({ baseDir }) {
    this.baseDir = path.resolve(baseDir);
    this.filePath = path.join(this.baseDir, "settings.md");
    this.state = this._load();
  }

  _normalize(input) {
    return {
      policyPrompt: String(input?.policyPrompt || DEFAULT_POLICY_PROMPT).trim(),
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
    const operatorNotes = parseBullets(parseSection(text, "Operator Notes"));
    const recentLessons = parseBullets(parseSection(text, "Recent Lessons"));
    return this._normalize({
      policyPrompt: policyPrompt || DEFAULT_POLICY_PROMPT,
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
    const parsed = this._parse(raw);
    const legacyNotes = tryParseLegacyNotes(raw);
    if (legacyNotes.length > 0) {
      parsed.operatorNotes = ensureBulletList([...parsed.operatorNotes, ...legacyNotes], parsed.operatorNotes);
    }
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
    return {
      filePath: this.filePath,
      policyPreview: preview,
      noteCount: this.state.operatorNotes.length,
      lessonCount: this.state.recentLessons.length,
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
