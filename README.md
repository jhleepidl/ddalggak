# telegram-orchestrator-cli v2 (End-to-End)

목표:
- **유료 LLM API(OpenAI/Gemini API)를 직접 호출하지 않고**
- Telegram 메시지로 트리거 → Codex CLI + Gemini CLI 실행 → 결과/상태/승인을 Telegram에서 처리
- 복잡한 판단은 **중앙 통제 AI(=ChatGPT)**에게 물어보고, 답을 붙여넣으면 자동 실행(액션 플랜 JSON)

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
  - `TELEGRAM_ALLOWED_CHAT_IDS=<chat_id>`
  - `TELEGRAM_ALLOWED_USER_IDS=<user_id>`

> 그룹에서 쓰고 싶다면:
> - 봇을 그룹에 추가하고, 그룹에서 `/whoami` 실행 → 그룹 chat_id를 allowlist에 넣으면 됨.

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
- `CODEX_WORKSPACE_ROOT=/path/to/your/repo`  (Codex가 코드 수정할 워크스페이스)
- `RUNS_DIR=/path/to/your/repo/.orchestrator`
- `TELEGRAM_BOT_TOKEN=...`
- `MEMORY_MODE=local|goc`

참고:
- `WORKSPACE_ROOT`도 하위호환으로 동작하지만, 혼동 방지를 위해 `CODEX_WORKSPACE_ROOT` 사용 권장
- `plan.md / research.md / progress.md / decisions.md`는 `RUNS_DIR/runs/<jobId>/shared/`에서만 관리
- 에이전트 레지스트리 파일을 쓰려면 `agents.json.sample`을 복사해서 `agents.json`을 만들고 `AGENTS_REGISTRY_PATH`로 지정

GoC 모드(`MEMORY_MODE=goc`) 추가 설정:
- `GOC_API_BASE`, `GOC_UI_BASE`
- `GOC_SERVICE_KEY`
- `GOC_UI_TOKEN_TTL_SEC` (기본 21600 = 6시간)
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
  - `/gptapply <jobId>` 를 먼저 보내고
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

### 5) GoC 명령
- `/agents` : 현재 agent registry 목록 출력
- `/context <jobId|global>` : GoC UI 링크 반환 (`jobId` 생략 시 현재 job 사용)
- `/context`로 발급되는 UI 토큰은 쓰기 권한 포함이므로 TTL을 짧게 두고 필요 시 재발급 권장

### 6) Multi-Agent 메모리 커스터마이즈
- `/memory show` : 전체 요약(반성 프롬프트 + 라우터 프롬프트 + 에이전트 역할)
- `/memory agents` : Gemini/Codex/ChatGPT 역할 메모리 확인
- `/memory routing <자연어>` : 라우팅 기준 프롬프트 수정
- `/memory role <gemini|codex|chatgpt> <자연어>` : 에이전트별 역할 수정
- `/memory md` : 원문 markdown 확인

### 7) MEMORY_MODE 동작
- `local`: 기존 local 메모리 동작 유지
- `goc`: 로컬 md는 계속 기록하되, 프롬프트 컨텍스트는 GoC `compiled_text`를 우선 사용
- `goc` 모드에서 에이전트 호출 직전마다 `compiled_text`를 매번 새로 가져오므로, UI 편집/활성 토글/삭제가 다음 스텝부터 반영됨
- GoC API/UI 실패 시 local 컨텍스트로 자동 폴백

---

## D. 트래킹 파일 구조

각 jobId 폴더:
- `shared/research.md`
- `shared/plan.md`
- `shared/progress.md`
- `shared/decisions.md`
- `conversation.jsonl` (Telegram/Codex/Gemini/ChatGPT 텍스트 로그)
- `goc.json` (`MEMORY_MODE=goc`에서 thread/ctx 매핑)

Slack/Telegram 히스토리 제한에 의존하지 않습니다.
