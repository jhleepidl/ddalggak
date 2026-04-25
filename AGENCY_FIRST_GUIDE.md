# Agency-first 운영 가이드

이 프로젝트의 1순위 제품 가치는 self-improve 자동 패치가 아니라 **여러 agent가 자율적으로 분담·검토·합성하고, 사용자가 그 의사소통을 Telegram과 GoC Run Studio에서 보기 쉽게 관찰하는 것**이다.

## 운영 기본값

권장 운영 모드:

```bash
LLM_TRACE_ENABLED=true
LLM_TRACE_REDACT_SECRETS=true
LLM_TRACE_UNSCOPED=false
SELF_IMPROVE_DDALGGAK_AUTO_PROMOTE=false
SELF_IMPROVE_GOC_AUTO_PROMOTE=false
```

trace-first 안정화 기간에는 아래 PATCH_CMD를 비워두거나 실험 때만 켠다.

```bash
# SELF_IMPROVE_DDALGGAK_PATCH_CMD=
# SELF_IMPROVE_GOC_PATCH_CMD=
```

## Telegram에서 사용자가 봐야 하는 것

`/chat ...` 실행 시 기본 preview는 다음을 먼저 보여줘야 한다.

1. 이번 턴에 참여하는 핵심 agent
2. 병렬 fan-out / handoff / build→review→synthesize 같은 협업 방식
3. reviewer가 있는지, builder와 다른 provider/model로 cross-check하는지
4. GoC Run Studio에서 볼 수 있는 handoff/review 흐름

checkpoint, memory sync, eval gate, debug bundle 같은 내부 단계는 필요하지만 기본 경험에서는 보조 정보로 숨긴다.

## GoC에서 사용자가 먼저 봐야 하는 것

Run Studio 첫 화면은 다음 순서를 우선한다.

1. Agency Cockpit: team, execution map, collaboration cells
2. Why this team: 왜 이 agent들이 선택됐는지
3. Recent activity: 최신 handoff/review/output 흐름
4. Context/evidence와 diagnostics는 필요할 때만 펼친다

## 지금의 self-improve 위치

self-improve는 아직 주 기능이 아니다. 현재는 다음 용도로만 사용한다.

- trace 저장
- test/canary 실행
- review/gate 보조
- 사람이 ChatGPT에게 trace bundle을 넘겨 수동 패치

자동 patch/promote는 충분한 Telegram canary와 integration test가 생긴 뒤에 넓힌다.

## 빠른 점검

```bash
npm run agency:doctor
npm run trace:doctor
```
