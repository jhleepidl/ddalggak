# UI Usage Guide

운영자 빠른 참고용 문서입니다. 상세 아키텍처/설정/런타임 메타데이터 설명은 `README.md`를 기준 문서로 사용하세요.

## 1) Telegram Quick Flow

1. 실행 지시: `/chat <요청>` 또는 일반 텍스트
2. 배치 실행: `/run <goal>`, `/continue <jobId>`
3. 상태 확인: `/status`, `/running`
4. 컨텍스트/팀/프리셋 상태 확인: `/context`, `/agents`

## 2) Approval Buttons

- `Approve`: 대기 액션 승인 후 잔여 플랜 재개
- `Cancel`: 승인 대기 액션 취소
- `Work instead`: 팀 변경 중심 플랜 대신 작업 실행 중심으로 재라우팅 시도

## 3) Team/Preference Notes

- `/agents`는 team membership UI가 아니라 preset/preferences UI입니다.
- `add|enable <preset>` 는 preset pin 선호로, `remove|disable <preset>` 는 preset ban 선호로 동작합니다.
- `remove reviewer` 같은 legacy role 명령은 해당 canonical role suppression으로 해석됩니다.
- compatibility membership 변경이 실제로 일어나는 경우에는 readback 확인이 끝나야 확정됩니다.
- `/agents` 표시와 compatibility mutation 검증은 동일한 canonical target(`thread_id + conversation_id`)을 사용합니다.

## 4) Runtime Metadata to Inspect

GoC Run/Step 또는 decisions 로그에서 우선 확인:
- `runtime_team_snapshot`
- `action_source`
- `task_interpretation`
- `team_plan`
- `runtime_agents`
- `collaboration_cells`
- `authority_graph`
- `checkpoints`
- `execution_graph`
- `selected_skill_ids`
- `skill_load_levels`
- `context_packs`
- `skill_usage_events`
- `runtime_authority`

## 5) Quick Troubleshooting

### 증상: 팀 변경 후 작업 실행이 안 이어짐

1. `/status`로 `pending_approval`, `interrupt`, 최근 route 상태 확인
2. `/context`로 현재 thread/context 링크 열기
3. run/graph에서 membership readback mismatch, checkpoint 상태, 또는 `membership_confirmation_failed` 확인

### 증상: 그래프 Now에 오래된 queued step이 남음

1. 최신 run의 `summary/status` 확인
2. 해당 step의 `skip_reason` 확인 (`awaiting_approval`, `superseded_by_replan` 등)
