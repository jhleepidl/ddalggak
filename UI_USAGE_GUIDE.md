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
- `add/remove/enable/disable` 액션은 이 Thread Team 구성에 영향을 줍니다.
- 같은 agent라도 conversation membership 상태에 따라 실행 가능 여부가 달라질 수 있습니다.

## 3) Run Studio / Graph / Execution 뷰

- Run/Execution 뷰: 각 run의 route, step, 결과를 확인
- Graph 뷰: Run/Step과 context 연결 관계를 추적
- runtime team metadata:
  - `runtime_team_snapshot`
  - `team_plan`
  - `runtime_agents`
  - `action_source`

이 메타데이터로 "실제로 어떤 팀 구성이 선택되어 실행되었는지"를 사후 점검할 수 있습니다.

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
  - 즉, "팀만 구성하고 작업을 안 하는" 조기 종료를 방지

## 6) Troubleshooting

### 증상: 팀 구성 로그만 나오고 실제 작업 실행이 안 됨

- 최신 패치에서는 일반 작업 요청에 대해 mutation-only 플랜이면 자동 후속 reroute를 시도합니다.
- 여전히 반복되면:
  1. 요청을 더 구체적으로 다시 지시 (`무엇을 산출해야 하는지` 명시)
  2. `/status`, `/context`로 현재 상태 확인
  3. 필요 시 `/chat <작업지시>`로 재요청
