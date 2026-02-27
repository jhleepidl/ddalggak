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

참고:
- `WORKSPACE_ROOT`도 하위호환으로 동작하지만, 혼동 방지를 위해 `CODEX_WORKSPACE_ROOT` 사용 권장
- `plan.md / research.md / progress.md / decisions.md`는 `RUNS_DIR/runs/<jobId>/shared/`에서만 관리

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
- `.env`에 `GEMINI_APPROVAL_MODE=plan` 설정 (Gemini를 리서치/점검 위주로 사용, 코딩 액션 최소화)

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
  - Gemini 조사 → research.md
  - Codex 구현 → progress.md
  - git diff/status 요약 전송
  - 이후 **다음 단계용 ChatGPT 프롬프트 자동 제안** (AUTO_SUGGEST_GPT_PROMPT=true)

- `/continue <jobId>`
  - plan.md(“Codex 지시문” 섹션이 있으면 그걸 우선) + research.md 기반으로 Codex 재실행
  - git 요약 전송 + 다음 단계용 ChatGPT 프롬프트 제안

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

---

## D. 트래킹 파일 구조

각 jobId 폴더:
- `shared/research.md`
- `shared/plan.md`
- `shared/progress.md`
- `shared/decisions.md`
- `conversation.jsonl` (Telegram/Codex/Gemini/ChatGPT 텍스트 로그)

Slack/Telegram 히스토리 제한에 의존하지 않습니다.
