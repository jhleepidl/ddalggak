# UI Usage Guide

이 문서는 Telegram 운영자 관점에서 ddalggak 사용 흐름을 빠르게 정리한 가이드입니다.

## 1) Telegram 기본 사용 흐름

1. 일반 요청: `/chat <요청>` 또는 일반 텍스트로 지시
2. 배치 실행: `/run <goal>` 또는 `/continue <jobId>`
3. 상태 확인: `/status`, `/running`
4. 컨텍스트/팀 확인: `/context`, `/agents`

핵심은 Telegram이 제어면(control surface)이고, 실제 실행/기록은 job/workspace + GoC graph에 누적된다는 점입니다.

## 2) Thread Team 이란?

- Thread Team은 현재 대화 스레드에서 사용 가능한 agent 멤버십입니다.
- Agent는 역할(role) 단위 실행 주체이며, Skill은 해당 role에 붙는 재사용 절차 패키지입니다.
- `add/remove/enable/disable` 액션은 이 Thread Team 구성에 영향을 줍니다.
- 같은 agent라도 conversation membership 상태에 따라 실행 가능 여부가 달라질 수 있습니다.
- 멤버십 변경 확인은 canonical target(`thread_id + conversation_id`) 기준으로 수행됩니다.
- `/agents`도 같은 source-of-truth(readback 경로)를 사용하므로, 확인 로직과 표시 결과가 일치해야 합니다.

## 3) Run Studio / Graph / Execution 뷰

- Run/Execution 뷰: 각 run의 route, step, 결과를 확인
- Graph 뷰: Run/Step과 context 연결 관계를 추적
- runtime team metadata:
  - `runtime_team_snapshot`
  - `team_plan`
  - `runtime_agents`
  - `context_packs`
  - `selected_skill_ids`
  - `skill_load_levels`
  - `selection_reason_summary`
  - `skill_usage_events`
  - `action_source`

이 메타데이터로 "실제로 어떤 팀 구성이 선택되어 실행되었는지"를 사후 점검할 수 있습니다.

추가로 각 runtime role은 `attached_skills`를 가지며, skill 로딩 레벨은 다음 중 하나입니다:
- `metadata_only`
- `instructions`
- `resources`

## 4) 승인(Approval) 처리

- mutating 액션(예: 팀 멤버십 변경, agent 설정 변경)은 승인 단계를 거칠 수 있습니다.
- Telegram 버튼:
  - `Approve`: 승인 후 남은 플랜 재개
  - `Cancel`: 승인 대기 중 액션 취소
  - `Work instead`: 작업 실행 중심으로 재라우팅

## 5) Team 구성 요청 vs 일반 작업 요청

- Team 구성 요청(예: "팀 재구성해줘"):
  - add/enable 뿐 아니라 remove/disable도 포함될 수 있음
  - 팀 설정만 끝내고 종료될 수 있음(정상 동작)
- 일반 작업 요청(예: 분석/구현/작성):
  - 팀 설정 액션만 있는 플랜이면, 승인 후 실제 작업 실행 경로로 한 번 더 재라우팅
  - 단, 멤버십 변경이 readback으로 확인된 경우에만 재라우팅
  - 즉, "팀만 구성하고 작업을 안 하는" 조기 종료를 방지

## 6) Troubleshooting

### 증상: 팀 구성 로그만 나오고 실제 작업 실행이 안 됨

- 최신 패치에서는 일반 작업 요청에 대해 mutation-only 플랜이면 자동 후속 reroute를 시도합니다.
- 멤버십 readback 확인이 실패하면 reroute 대신 fail-fast로 멈추고 진단 로그를 남깁니다.
- `ensureConversation` 결과 thread가 요청 thread와 다르면 mismatch 진단을 기록하고 자동 실행은 중단됩니다.
- 여전히 반복되면:
  1. 요청을 더 구체적으로 다시 지시 (`무엇을 산출해야 하는지` 명시)
  2. `/status`, `/context`로 현재 상태 확인
  3. 필요 시 `/chat <작업지시>`로 재요청

### 참고: Graph "Now"가 오래된 queued step을 보일 때

- reroute/approval/interruption으로 대체된 queued step은 가능한 범위에서 `skipped`로 정리됩니다.
- 그래프를 새로고침한 뒤에도 오래된 queued가 남으면 최근 run의 `summary/status`와 `skip_reason`을 함께 확인하세요.
