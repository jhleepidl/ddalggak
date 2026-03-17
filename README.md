# telegram-orchestrator-cli v2 (End-to-End)

목표:
- **유료 LLM API(OpenAI/Gemini API)를 직접 호출하지 않고**
- Telegram 메시지로 트리거 → Codex CLI + Gemini CLI 실행 → 결과/상태/승인을 Telegram에서 처리
- 복잡한 판단은 **중앙 통제 AI(=ChatGPT)**에게 물어보고, 답을 붙여넣으면 자동 실행(액션 플랜 JSON)
- ddalggak은 **standalone-first 실행 런타임**이며, GoC는 선택적 업그레이드 모드

## Architecture (v2 Runtime Refactor)

외부 Telegram UX/명령은 유지하면서 내부 런타임을 모듈화했습니다.

- `telegram_runner.js`: bootstrap + 이벤트 수신 + 오케스트레이션 위임
- `src/shared/json_extract.js`: JSON 추출/파싱 공통 헬퍼
- `src/shared/normalize.js`: 문자열/리스트/provider 정규화 공통 헬퍼
- `src/domain/route_plan.js`: route plan/action 정규화 및 sanitize
- `src/domain/agent_templates.js`: `AgentTemplate`, `RuntimeAgentInstance` 정규화/생성
- `src/domain/team_plan.js`: `TeamPlan` 정규화/검증
- `src/domain/skill_packages.js`: `SkillPackage` 정규화
- `src/domain/skill_attachment.js`: role/agent `attached_skills` 정규화
- `src/domain/context_pack.js`: `ContextPack` 정규화
- `src/application/team_builder.js`: 목표 기반 runtime role 구성
- `src/application/skill_registry.js`: `skills/*/manifest.json` 파일 기반 registry
- `src/application/skill_resolver.js`: role/task 기준 skill 선택(heuristic, top 0-2)
- `src/application/skill_loader.js`: progressive load(`metadata_only`/`instructions`/`resources`)
- `src/application/context_pack_builder.js`: shared/role/skill context pack 생성
- `src/application/skill_feedback.js`: skill usage event 기록(JSON payload/JSONL)
- `src/application/orchestrator.js`: route + team 조합
- `src/application/runtime_metadata.js`: runtime team snapshot 표준 구조
- `src/application/job_runtime.js`: job lifecycle(중단/컨트롤러) 헬퍼
- `src/application/route_executor.js`: `/run`, `/continue` 라우트 실행 glue
- `src/application/approval_flow.js`: 승인/거절/재개 플로우
- `src/application/run_status_cleanup.js`: interrupted/superseded/awaiting-approval skip 정리 헬퍼
- `src/application/runtime_snapshot_display.js`: runtime snapshot 표시용 요약 헬퍼
- `src/adapters/telegram/send.js`: Telegram 전송 어댑터
- `src/adapters/telegram/context_links.js`: GoC 링크/버튼 조립 헬퍼
- `src/adapters/telegram/preview_formatting.js`: route/approval/autopilot/chat-fallback 공통 포맷터
- `src/adapters/telegram/status_messages.js`: Gemini retry/switch/fail 알림 포맷터
- `src/adapters/telegram/commands.js`: Telegram 명령 디스패치
- `src/adapters/telegram/callbacks.js`: Telegram callback_query 디스패치
- `src/runtime_capabilities/context_store.js`: ContextStore capability 어댑터(local/goc)
- `src/runtime_capabilities/agent_catalog.js`: AgentCatalog capability 어댑터(local/goc)
- `src/runtime_capabilities/conversation_team_store.js`: ConversationTeamStore capability 어댑터(local filesystem/goc)
- `src/runtime_capabilities/skill_catalog.js`: SkillCatalog capability 어댑터(local authority)
- `src/runtime_capabilities/planner.js`: Planner capability(`LocalPlanner` compatibility facade + remote placeholder)
- `src/runtime_capabilities/run_event_sink.js`: RunEventSink capability(local/goc)
- `src/runtime_capabilities/index.js`: capability composition + run authority metadata
- `src/control_plane/*`: task interpretation, slot planning, preset/skill/context resolution, execution coordination
- `src/catalog/*`: text-first preset loading/compiler/registries
- `src/compatibility/*`: legacy role/plan/registry alias layers

### Canonical Runtime Model

- Human-authored preset specs live under `presets/*` and stay text-first (`preset.yaml` + `prompt.md`).
- Internal runtime planning is structured and normalized: `TaskInterpretation -> TeamPlan v2 -> RuntimeAgentInstance -> ContextPack`.
- Stable worker roles are only `researcher`, `builder`, `reviewer`, `synthesizer`, `operator`.
- `planner` is not a worker role. It is compatibility-only control-plane metadata.
- `SupervisorRuntime` is a runtime control actor, not a worker role.
- `RuntimeAgent = Role + Attached Skills + Context Pack`.
- Collaboration cells represent patterns such as `parallel_fanout`, `reflection`, and `manager_as_tool`.
- Conversation configuration is preference-based: pinned presets, banned presets, preferred domains/locales, suppressed roles/skills, review policy, and control mode.

### Internal Runtime Concepts (Preset + Runtime Agent)

- `AgentPreset`
  - `{ preset_id, display_name, role_id, default_skill_ids, optional_skill_ids, personality_profile, selection_features, retrieval_text, ... }`
- `RuntimeAgentInstance`
  - `{ instance_id, slot_id, role_id, display_label, preset_id, synthesized, attached_skill_ids, attached_skills, context_pack_id, authority_profile_id, selection_reason, template_id, provider, model, ... }`
- `TeamPlan`
  - `{ team_plan_id, task_interpretation, supervisor_runtime, slots[], runtime_agents[], collaboration_cells[], authority_graph[], execution_graph, checkpoints[], selection_explanations[] }`
- `SkillPackage`
  - `{ skill_id, kind, title, description, tags, required_tools, required_context_types, compatible_roles, conflicts_with, cost_weight, quality_weight, ...legacy fields }`
- `ContextPack`
  - `{ context_pack_id, target_instance_id, context_types, evidence_node_ids, budget_tokens, load_level, selection_reason, ...compat aliases }`

핵심 모델:
- Preset = human-authored role/personality/instruction bundle
- Skill = 재사용 가능한 절차 지식 패키지
- TeamPlan = capability slots + runtime/control metadata
- RuntimeAgentInstance = 실제 실행 단위(role + attached skills)
- ContextPack = shared + role + skill 로딩 계획

### Canonical Schema (Implemented)

`SkillPackage` (manifest 정규화 결과):

```json
{
  "id": "skill.example.v1",
  "slug": "example",
  "name": "Example",
  "version": "1.0.0",
  "description": "",
  "category": "general",
  "capability_tags": [],
  "trigger_terms": [],
  "compatible_roles": [],
  "input_contract": {},
  "output_contract": {},
  "instructions_ref": "SKILL.md",
  "resource_refs": [],
  "utility_refs": [],
  "default_context_policy": {},
  "validation_policy": {},
  "safety_policy": {},
  "ranking_metadata": {},
  "visibility": "internal",
  "status": "active"
}
```

`TeamPlan.role` skill 확장:

```json
{
  "role_type": "researcher",
  "template_id": "researcher",
  "role_label": "researcher",
  "attached_skills": [
    {
      "skill_id": "skill.claim_evidence_audit.v1",
      "selected_by": "skill_resolver",
      "selection_reason": "trigger_matches:2",
      "load_level": "metadata_only|instructions|resources",
      "status": "selected|active|disabled|skipped|error"
    }
  ]
}
```

`RuntimeAgentInstance` skill 필드:

```json
{
  "instance_id": "inst_x",
  "template_id": "researcher",
  "role_label": "researcher",
  "attached_skills": [],
  "context_pack_id": "ctxp_x",
  "status": "ready"
}
```

`ContextPack.skill_items`:

```json
{
  "id": "ctxp_x",
  "target_runtime_agent_instance_id": "inst_x",
  "shared_items": [],
  "role_specific_items": [],
  "skill_items": [
    { "skill_id": "skill.claim_evidence_audit.v1", "load_level": "instructions" }
  ],
  "excluded_items": [],
  "missing_items": [],
  "conflicts": []
}
```

runtime/GOC additive 메타데이터:
- `runtime_team_snapshot`
- `runtime_authority`
- `selected_skill_ids`
- `skill_load_levels`
- `context_packs`
- `selection_reason_summary`
- `skill_usage_events`
- `skill_usage_summary`
- `action_source`

기존 `agents.json` / `src/agents.js` / `src/agent_registry.js`는 그대로 사용 가능하며, 내부적으로 `AgentTemplate`로 정규화됩니다.

### Routing Precedence

- 명시적 route plan(`actions`)이 있으면 그것이 우선입니다.
- team builder는 route를 덮어쓰는 것이 아니라 `team_plan/runtime_agents/runtime_team_snapshot`으로 보강합니다.
- team-generated actions는 명시적 route action이 비어있거나 fallback-only일 때만 사용됩니다.
- skill 레이어는 위 precedence를 깨지 않고 additive하게 붙습니다.
  - `team_builder -> skill_resolver -> context_pack_builder -> runtime snapshot`
  - skill 미선택 시 기존 동작과 동일하게 실행됩니다.

### Progressive Skill Loading

- `metadata_only`: 기본값. skill 식별/설명/태그/contract만 사용
- `instructions`: 실행 직전 `SKILL.md` 로딩
- `resources`: 체크리스트/템플릿/유틸 스크립트 참조 로딩

기본은 lightweight metadata이며, role/action 필요도에 따라 load level을 올립니다.

### Conversation Configuration Behavior

- `/agents` 명령은 이제 conversation-level preference surface입니다.
- `/agents add <preset>` / `/agents enable <preset>` 는 preset pin 선호로 해석됩니다.
- `/agents remove <preset>` / `/agents disable <preset>` 는 preset ban 선호로 해석됩니다.
- `/agents remove reviewer` 같은 legacy role command는 해당 canonical role suppression으로 해석됩니다.
- 기존 conversation membership write/readback 흐름은 runtime transport compatibility용으로 유지됩니다.
- compatibility membership mutation(`add/remove/enable/disable`)은 write 이후 readback 확인이 성공해야만 성공으로 처리됩니다.
- readback 확인 실패 시 팀 변경 성공으로 간주하지 않고, 진단 메타데이터를 기록한 뒤 후속 실행을 중단합니다.
- membership write/readback과 `/agents` 조회는 동일한 canonical target을 사용합니다:
  - `{ thread_id, conversation_id, workspace_id, account_id, source }`
  - `ensureConversation` 응답의 `thread_id`가 요청 thread와 다르면 mismatch로 기록하고, 자동으로 다른 thread scope로 전환하지 않습니다.

### Mutation-Only Plan Safeguard

- 승인 후 재개된 plan이 팀 설정 mutation만 포함하고 실제 실행 액션(`run_agent`/`spawn_agents` 등)이 없으면:
  - 팀 설정 전용 요청이 아니고, membership 변경이 readback으로 확인된 경우에만 작업 실행 모드로 1회 post-mutation reroute를 시도합니다.
  - 루프 방지를 위해 reroute guard(1회 제한)를 둡니다.
  - guard에 막힌 경우 사용자에게 명시적으로 안내 메시지를 보냅니다.
- 동일 unresolved membership 실패는 fail-fast로 안내하며, 같은 세션에서 자동 반복 루프를 만들지 않도록 차단합니다.

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
    "context_packs": [],
    "selected_skill_ids": [],
    "skill_load_levels": {},
    "selection_reason_summary": {},
    "skill_usage_events": [],
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
- `attached_skills`
- `selected_skill_ids`
- `skill_load_levels`
- `context_pack_id`
- `runtime_status`
- `ephemeral`
- `fallback`

`MEMORY_MODE=goc`에서 execution graph recorder가 활성화된 경우, 같은 metadata가 GOC `Run`/`Step` payload와 `recordMeta` 리소스 노드에 additive 방식으로 저장됩니다.

추가로 reroute/approval/interruption으로 더 이상 활성 상태가 아닌 queued step은 가능한 범위에서 `skipped`(reason 포함)로 정리하여 "Now" 오염을 줄입니다.

membership 진단 로그에는 최소 아래 정보가 포함됩니다(가산형):
- `action`, `target_agent_id`
- `membership_target`(canonical target 요약)
- `mutation_response` 요약
- `readback` 요약(대상 agent 존재/활성, readback thread 샘플)
- `ensured_thread_mismatch` 여부

입력 호환성:
- `runtime_team_snapshot`(권장 canonical)과 `runtimeTeamSnapshot`(legacy/camelCase) 모두 허용
- `action_source`와 `actionSource` 모두 허용
- downstream은 `runtime_team_snapshot`과 canonical `action_source` enum을 우선 사용 권장
- skill 관련 확장 키(`context_packs`, `selected_skill_ids`, `skill_load_levels`, `selection_reason_summary`, `skill_usage_events`)는 additive 필드입니다.

그래서 graph-of-context-ui/control-plane에서 실제 런타임 팀 구성과 action 생성 출처를 사후 조회할 수 있습니다.

### Capability Authority (Runtime-to-GoC Contract)

각 실행(run)마다 capability authority를 명시적으로 기록합니다. 이 필드들은 ddalggak이 GoC/backend projection으로 내보내는 canonical interoperability contract이며, `Run`/`Step` payload와 `context_meta` 리소스에서 동일한 shape로 소비할 수 있어야 합니다. 동일 capability에 local/GoC가 동시에 authority가 되지 않도록 합니다.

- `mode`: `standalone | goc`
- `plan_source`: `local | goc | local_fallback`
- `context_source`: `local | goc`
- `agent_catalog_source`: `local | goc`
- `conversation_team_source`: `local | goc`
- `skill_catalog_source`: `local | goc | mixed`
- `degraded_mode`: `boolean`
- `fallback_reason`: `string | null`

현재 정책:
- standalone 모드: context/agent/team/planner/skill/event 모두 local authority
- GoC 모드: context/agent/team/event는 GoC authority, planner는 기본 local, skill package content authority는 runtime(local; metadata는 `mixed` 가능)
- GoC unavailable 시: degraded local fallback으로 전환하고 authority 메타데이터에 원인을 기록

emission 규칙:
- canonical path는 항상 `runtime_authority` + flattened authority fields를 함께 emit합니다.
- legacy/camelCase 입력(`runtimeAuthority`, `planSource` 등)은 내부적으로만 허용하고, outward payload는 canonical snake_case로 normalize합니다.
- 같은 authority state에서는 run-level / step-level / context_meta payload가 서로 모순되지 않아야 합니다.
- 실제 transition이 있는 경우에만 authority가 바뀔 수 있으며, 그때는 updated run payload와 이후 step/event payload가 동일한 normalized state를 공유해야 합니다.

fallback semantics:
- standalone run: `mode=standalone`, `plan_source=local`, `context_source=local`, `agent_catalog_source=local`, `conversation_team_source=local`, `skill_catalog_source=local`, `degraded_mode=false`
- goc-enhanced run: `mode=goc`, `context_source=goc`, `agent_catalog_source=goc`, `conversation_team_source=goc`, planner authority는 실제 실행 주체에 맞게 `plan_source`에 기록
- goc unavailable -> local fallback: actual runtime authority를 기준으로 `mode=standalone`, `plan_source=local_fallback`, capability source는 실제 fallback source로 normalize, `degraded_mode=true`, `fallback_reason` populated
- goc runtime + local planner fallback: `mode=goc`를 유지하고 `plan_source=local_fallback`, `degraded_mode=true`, `fallback_reason`으로 planner fallback 원인을 기록

### Skills Directory

- 기본 registry 경로: `skills/`
- 초기 skill 패키지:
  - `skill.thread_team_reconciliation.v1`
  - `skill.claim_evidence_audit.v1`
  - `skill.context_selection_policy.v1`
  - `skill.telegram_briefing.v1`
  - `skill.run_trace_debugging.v1`
  - `skill.kr_equity_analysis.v1`

새 skill 작성 방법은 [`SKILL_AUTHORING_GUIDE.md`](./SKILL_AUTHORING_GUIDE.md)를 참고하세요.

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
- `/agents` : 현재 preset catalog / team view / preference 상태 출력
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
- `local`: standalone capability composition 사용 (local context + local agent catalog + local conversation team + local planner)
- `goc`: GoC-enhanced capability composition 사용 (GoC context/agent/team/event + local planner + local/mixed skill catalog)
- `goc` 모드에서도 control-plane planner는 기본 local이며, remote planner가 있을 때만 `plan_source=goc`로 전환
- GoC API/UI 실패 시 degraded local fallback으로 전환되며 metadata에 `degraded_mode=true`, `fallback_reason`이 기록됨
- standalone 모드에서도 `/agents add|remove|enable|disable`로 conversation preset/preferences를 파일 기반으로 관리 가능

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
