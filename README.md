# telegram-orchestrator-cli v2 (End-to-End)

목표:
- **유료 LLM API(OpenAI/Gemini API)를 직접 호출하지 않고**
- Telegram 메시지로 트리거 → Codex CLI + Gemini CLI 실행 → 결과/상태/승인을 Telegram에서 처리
- 복잡한 판단은 **중앙 통제 AI(=ChatGPT)**에게 물어보고, 답을 붙여넣으면 자동 실행(액션 플랜 JSON)

## Architecture (v2 Runtime Refactor)

외부 Telegram UX/명령은 유지하면서 내부 런타임을 모듈화했습니다.

- `telegram_runner.js`: bootstrap + 이벤트 수신 + 오케스트레이션 위임
- `src/shared/json_extract.js`: JSON 추출/파싱 공통 헬퍼
- `src/shared/normalize.js`: 문자열/리스트/provider 정규화 공통 헬퍼
- `src/domain/lens.js`: lens spec 정규화/기본값/검증
- `src/domain/route_plan.js`: route plan/action 정규화 및 sanitize
- `src/domain/agent_templates.js`: `AgentTemplate`, `RuntimeAgentInstance` 정규화/생성
- `src/domain/team_plan.js`: `TeamPlan` 정규화/검증
- `src/application/team_builder.js`: 목표 기반 runtime role 구성
- `src/application/orchestrator.js`: route + team 조합
- `src/application/runtime_metadata.js`: runtime team snapshot 표준 구조
- `src/application/job_runtime.js`: job lifecycle(중단/컨트롤러) 헬퍼
- `src/application/route_executor.js`: `/run`, `/continue` 라우트 실행 glue
- `src/application/approval_flow.js`: 승인/거절/재개 플로우
- `src/adapters/telegram/send.js`: Telegram 전송 어댑터
- `src/adapters/telegram/commands.js`: Telegram 명령 디스패치
- `src/adapters/telegram/callbacks.js`: Telegram callback_query 디스패치

### Internal Runtime Concepts

- `AgentTemplate`
  - `{ id, name, role_type, description, capability_tags, provider, model, prompt, tools, meta }`
- `RuntimeAgentInstance`
  - `{ instance_id, template_id, role_label, assigned_goal, capability_tags, provider, model, lens_spec, status }`
- `TeamPlan`
  - `{ mode, roles, dependencies, execution_order, reason, budget }`

기존 `agents.json` / `src/agents.js` / `src/agent_registry.js`는 그대로 사용 가능하며, 내부적으로 `AgentTemplate`로 정규화됩니다.

### Routing Precedence

- 명시적 route plan(`actions`)이 있으면 그것이 우선입니다.
- team builder는 route를 덮어쓰는 것이 아니라 `team_plan/runtime_agents/runtime_team_snapshot`으로 보강합니다.
- team-generated actions는 명시적 route action이 비어있거나 fallback-only일 때만 사용됩니다.

### Team Reconfiguration Behavior

- 사용자 요청이 명시적 팀 재구성 의도일 때만(team composition intent) thread team diff를 계산합니다.
- 이 경우 `add/enable`뿐 아니라 필요 시 `remove_agent_from_conversation`(또는 경로별 disable)도 포함될 수 있습니다.
- 일반 작업 요청에서는 기존처럼 보수적으로 동작하며, 불필요한 자동 제거를 하지 않습니다.

### Mutation-Only Plan Safeguard

- 승인 후 재개된 plan이 팀 설정 mutation만 포함하고 실제 실행 액션(`run_agent`/`spawn_agents` 등)이 없으면:
  - 팀 설정 전용 요청이 아닌 경우, 작업 실행 모드로 1회 post-mutation reroute를 시도합니다.
  - 루프 방지를 위해 reroute guard(1회 제한)를 둡니다.
  - guard에 막힌 경우 사용자에게 명시적으로 안내 메시지를 보냅니다.

추가 메타데이터(가산형):
- `post_mutation_reroute: true|false`
- `reroute_reason: mutation_only_plan_for_work_request` (해당 시)

### Runtime Team Observability

실행 중 canonical 메타데이터 계약은 아래와 같습니다:

```json
{
  "runtime_team_snapshot": {
    "team_plan": {},
    "runtime_agents": [],
    "generated_at": "2026-03-10T00:00:00.000Z",
    "source": "team_builder"
  },
  "action_source": "explicit_route_plan | generated_team_actions | default_fallback_route"
}
```

step payload의 runtime role 필드는 아래 canonical 키를 사용합니다:
- `role_label`
- `runtime_instance_id`
- `template_id`
- `provider`
- `model`
- `capability_tags`
- `runtime_status`
- `ephemeral`
- `fallback`

`MEMORY_MODE=goc`에서 execution graph recorder가 활성화된 경우, 같은 metadata가 GOC `Run`/`Step` payload와 `recordMeta` 리소스 노드에 additive 방식으로 저장됩니다.

입력 호환성:
- `runtime_team_snapshot`(권장 canonical)과 `runtimeTeamSnapshot`(legacy/camelCase) 모두 허용
- `action_source`와 `actionSource` 모두 허용
- downstream은 `runtime_team_snapshot`과 canonical `action_source` enum을 우선 사용 권장

그래서 graph-of-context-ui/control-plane에서 실제 런타임 팀 구성과 action 생성 출처를 사후 조회할 수 있습니다.

외부 Telegram 명령 UX(`/run`, `/continue`, `/gptprompt`, `/gptapply`, `/gptdone`, `/commit`, `/context`, `/agents`, `/memory`)은 그대로 유지됩니다.

운영자 UI 가이드는 [`UI_USAGE_GUIDE.md`](./UI_USAGE_GUIDE.md)를 참고하세요.

---

## A. Telegram 앱 설치 & 봇 만들기 (모바일/데스크톱)

### 1) Telegram 설치
- iOS/Android 앱스토어에서 Telegram 설치
- PC가 편하면 Telegram Desktop도 같이 설치(복붙 편함)

### 2) BotFather로 봇 생성 (필수)
1. Telegram에서 `@BotFather` 검색 → 대화 시작
2. `/newbot`
3. 봇 이름 입력 (예: `My Orchestrator`)
4. 봇 username 입력 (반드시 `...bot`으로 끝나야 함) 예: `my_orchestrator_bot`
5. BotFather가 `TELEGRAM_BOT_TOKEN` (형태: `123456:ABC...`)을 줌 → **이걸 .env에 넣기**

### 3) 봇과 대화 시작
- 생성한 봇 username을 검색해서 대화 시작
- `/start` 한 번 보내기

### 4) Chat ID / User ID 확인 (권장)
이 봇에는 `/whoami` 명령이 있습니다.
- 봇에게 `/whoami` 를 보내면:
  - `chat_id`, `user_id`를 알려줍니다.
- 보안을 위해 서버의 `.env`에 아래를 설정하는 것을 추천:
  - `TELEGRAM_ALLOWED_USER_IDS=<user_id>`
  - `TELEGRAM_ALLOWED_CHAT_IDS`는 deprecated(더 이상 검사하지 않음)

> 그룹에서 멘션 기반으로만 반응시키고 싶다면:
> - `.env`에 `TELEGRAM_REQUIRE_MENTION_IN_GROUP=true`
> - 그룹에서 `@botname ...` 또는 `! ...` 형태로 메시지 전송

---

## B. Ubuntu 서버 세팅 (Codex/Gemini CLI + 봇 러너)

### 1) 코드 배치
```bash
sudo mkdir -p /opt/telegram-orchestrator
sudo unzip telegram-orchestrator-cli-v2.zip -d /opt/telegram-orchestrator
cd /opt/telegram-orchestrator
npm install
cp .env.example .env
```

`.env` 최소 설정:
- `RUNS_DIR=runs`  (선택: 다른 루트로 바꾸고 싶을 때만 지정)
- `TELEGRAM_BOT_TOKEN=...`
- `MEMORY_MODE=local|goc`

참고:
- job workspace는 자동 생성되며 규칙은 `RUNS_DIR/<jobId>/workspace`
- Gemini/Codex/파일 업로드는 job workspace 하위만 사용
- `plan.md / research.md / progress.md / decisions.md`는 `RUNS_DIR/<jobId>/shared/`에서 관리
- CWD가 repo 루트로 잡히면 컨텍스트 스캔이 커질 수 있으므로 job workspace CWD를 유지하는 것이 권장됨
- 에이전트 레지스트리 파일을 쓰려면 `agents.json.sample`을 복사해서 `agents.json`을 만들고 `AGENTS_REGISTRY_PATH`로 지정

GoC 모드(`MEMORY_MODE=goc`) 추가 설정:
- `GOC_API_BASE`, `GOC_UI_BASE`
- `GOC_SERVICE_KEY`
- `GOC_UI_TOKEN_TTL_SEC` (기본 21600 = 6시간)
- `GOC_UI_LINK_MODE` (`telegram_auth` 기본, `bearer_token` legacy)
- `GOC_AUTO_ACTIVATE_PROGRESS` (기본 false)
- `GOC_JOB_THREAD_TITLE_PREFIX` (기본: `job:`)

운영 모델:
- 서비스 인스턴스 1개 = 사용자 1명
- ddalggak은 ServiceKey로 GoC backend를 호출하고, `/context`에서 UI Bearer 토큰을 민팅해 링크를 전달
- ServiceKey는 서버 환경변수로만 보관하고 사용자/브라우저로 노출하지 않음

### 2) Codex CLI (ChatGPT 계정/Plus 로그인 기반)
```bash
npm i -g @openai/codex
codex login --device-auth
```

중요:
- 서버 환경변수에 `OPENAI_API_KEY` / `CODEX_API_KEY`가 있으면 **API 키 과금 경로**로 갈 수 있어요.
  - 확인/제거:
```bash
env | grep -E 'OPENAI_API_KEY|CODEX_API_KEY'
```

### 3) Gemini CLI (Google 로그인 기반)
```bash
npm i -g @google/gemini-cli
gemini   # 1회 로그인
```

권장 설정:
- 기본은 `.env`에 `GEMINI_APPROVAL_MODE=default` 사용
- `plan` 모드를 쓰려면 `~/.gemini/settings.json`에 `{"experimental":{"plan":true}}`를 켜야 함

### 4) 실행 (개발용)
```bash
npm start
```

테스트:
```bash
npm test
```

### 5) systemd로 상시 실행
```bash
sudo cp deploy/telegram-orchestrator.service /etc/systemd/system/telegram-orchestrator.service
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-orchestrator
sudo systemctl status telegram-orchestrator
```

---

## C. Telegram에서 사용법

### 1) 기본 자동화
- `/run <goal>`
  - job 생성
  - **Multi-Agent 라우터가 목표 기반으로 필요한 에이전트만 선택**
  - 예: Gemini 조사 / Codex 구현 / ChatGPT 프롬프트 생성 / git 요약 중 필요한 단계만 실행
  - 이후 **다음 단계용 ChatGPT 프롬프트 자동 제안** (AUTO_SUGGEST_GPT_PROMPT=true)

- `/continue <jobId>`
  - plan.md(“Codex 지시문” 섹션이 있으면 우선) + 누적 문맥 기반으로 라우팅 재결정
  - 필요한 에이전트만 실행 후 다음 단계용 ChatGPT 프롬프트 제안

### 2) 중앙 통제 AI(=ChatGPT)에게 “다음 단계” 질문하기
- `/gptprompt <jobId> <question>`
  - 현재까지의 shared docs + 최근 대화 로그를 모아 **ChatGPT에 붙여넣을 프롬프트**를 생성
  - ChatGPT는 반드시 `actions` JSON을 포함하도록 유도됨

- ChatGPT에서 답을 받은 후:
  - 봇 메시지의 `🟣 답변 붙여넣기 시작` 버튼을 누르거나 `/gptapply [jobId]` 실행
  - ChatGPT 답을 그대로 붙여넣기
  - 답에 JSON이 있으면 자동으로:
    - gemini/codex 실행
    - 문서 업데이트(track_append)
    - git_summary
    - commit_request(승인 필요)

붙여넣기 모드 종료:
- `/gptdone`

### 3) 커밋 승인
- `/commit <jobId> <message>` → 승인 요청 생성
- 승인/거절:
  - `/approve <jobId> <token>`
  - `/deny <jobId> <token>`
또는 봇이 보내는 버튼(Approve/Deny) 클릭으로도 가능

### 4) 상태 확인/보안
- `/whoami` → chat_id/user_id 확인
- `/help` → 명령 목록

### 5) 파일 업로드/다운로드
- Telegram 첨부(document/photo/video/audio/voice)는 `workspace/uploads/`에 저장
- 표준 Bot API 한계:
  - 다운로드: 기본 20MB (`TELEGRAM_UPLOAD_MAX_MB`, `TELEGRAM_DOWNLOAD_MAX_BYTES`)
  - 전송(sendDocument): 50MB
- 업로드 확장자 제한: `TELEGRAM_UPLOAD_ALLOWED_EXTS` (비우면 전체 허용)
- `/files [uploads|outputs|all] [limit]` : workspace 파일 목록 조회
- `/outputs [send]` : outputs 목록 조회 또는 즉시 전송
- `/sendfile <relative_path>` : `uploads/` 또는 `outputs/` 파일 1개 전송

### 6) GoC 명령
- `/agents` : 현재 agent registry 목록 출력
- `/context <jobId|global>` : GoC UI 링크 반환 (`jobId` 생략 시 현재 job 사용)
- `GOC_UI_LINK_MODE=telegram_auth`면 기본적으로 `#token` 없는 링크를 제공 (Telegram SSO)
- `GOC_UI_LINK_MODE=bearer_token`일 때만 UI 토큰을 민팅해 링크에 포함

### 7) Multi-Agent 메모리 커스터마이즈
- `/memory show` : 전체 요약(반성 프롬프트 + 라우터 프롬프트 + 에이전트 역할)
- `/memory agents` : Gemini/Codex/ChatGPT 역할 메모리 확인
- `/memory routing <자연어>` : 라우팅 기준 프롬프트 수정
- `/memory role <gemini|codex|chatgpt> <자연어>` : 에이전트별 역할 수정
- `/memory md` : 원문 markdown 확인

### 8) MEMORY_MODE 동작
- `local`: 기존 local 메모리 동작 유지
- `goc`: 로컬 md는 계속 기록하되, 프롬프트 컨텍스트는 GoC `compiled_text`를 우선 사용
- `goc` 모드에서 에이전트 호출 직전마다 `compiled_text`를 매번 새로 가져오므로, UI 편집/활성 토글/삭제가 다음 스텝부터 반영됨
- GoC API/UI 실패 시 local 컨텍스트로 자동 폴백

---

## D. 트래킹 파일 구조

각 jobId 폴더:
- `workspace/`
- `workspace/uploads/`
- `workspace/outputs/`
- `workspace/tmp/`
- `workspace/.gemini/settings.json`
- `shared/research.md`
- `shared/plan.md`
- `shared/progress.md`
- `shared/decisions.md`
- `conversation.jsonl` (Telegram/Codex/Gemini/ChatGPT 텍스트 로그)
- `goc.json` (`MEMORY_MODE=goc`에서 thread/ctx 매핑)

Slack/Telegram 히스토리 제한에 의존하지 않습니다.
