# Trace handoff guide for manual debugging

이 문서는 **자동 self-improve를 본격 운영하지 않고**, ddalggak이 남긴 LLM raw trace를 ChatGPT에게 전달해서 사람이 함께 코드를 개선하는 운영 절차를 설명합니다.

## Recommended mode

당분간은 아래처럼 운영합니다.

```text
ChatGPT + 사람의 수동 코드 개선
+ ddalggak raw trace 저장
+ trace handoff bundle 업로드
+ 테스트와 GoC summary로 검증
```

`/improve auto`와 auto-promote는 충분히 안정화되기 전까지 기본 개발 경로로 사용하지 않는 것을 권장합니다.

## 1. Enable trace recording

`/srv/ddalggak-stable/.env`에 아래 옵션을 켭니다.

```bash
LLM_TRACE_ENABLED=true
LLM_TRACE_SAVE_PROMPTS=true
LLM_TRACE_SAVE_OUTPUTS=true
LLM_TRACE_SAVE_STDERR=true
LLM_TRACE_REDACT_SECRETS=true
LLM_TRACE_MAX_PROMPT_CHARS=300000
LLM_TRACE_MAX_OUTPUT_CHARS=300000
LLM_TRACE_MAX_STDERR_CHARS=150000
LLM_TRACE_UNSCOPED=false
```

권장 사항:

- `LLM_TRACE_REDACT_SECRETS=true`는 항상 유지합니다.
- `.env`, token, API key, service key 파일은 절대 업로드하지 않습니다.
- `LLM_TRACE_UNSCOPED=false`를 기본으로 둡니다. jobId 없는 호출까지 모두 저장하고 싶을 때만 임시로 true를 켭니다.

## 2. Where traces are stored

jobId가 있는 실행은 기본적으로 아래에 저장됩니다.

```text
runs/<jobId>/llm_traces/
  index.jsonl
  <traceId>/
    request.json
    response.json
    prompt.txt
    stdout.txt
    stderr.txt
```

self-improvement job bundle 안에서는 아래에도 저장될 수 있습니다.

```text
.self_improve/jobs/<jobId>/llm_traces/
```

명시적으로 한 위치에 저장하고 싶으면 실행 전에 설정합니다.

```bash
LLM_TRACE_DIR=/absolute/path/to/llm_traces
```

## 3. Check whether trace settings are correct

```bash
cd /srv/ddalggak-stable
node scripts/trace_doctor.js
```

특정 job 기준으로 확인하려면:

```bash
node scripts/trace_doctor.js --job-id <jobId>
```

## 4. Create a handoff bundle for ChatGPT

가장 쉬운 방법:

```bash
cd /srv/ddalggak-stable
node scripts/trace_handoff_bundle.js --job-id <jobId> --out /tmp/ddalggak_trace_<jobId>
tar -czf /tmp/ddalggak_trace_<jobId>.tar.gz -C /tmp ddalggak_trace_<jobId>
```

trace 디렉터리를 직접 지정할 수도 있습니다.

```bash
node scripts/trace_handoff_bundle.js \
  --trace-dir /srv/ddalggak-stable/runs/<jobId>/llm_traces \
  --out /tmp/ddalggak_trace_handoff
```

최근 trace 수를 줄이고 싶으면:

```bash
node scripts/trace_handoff_bundle.js --job-id <jobId> --max-traces 8 --out /tmp/ddalggak_trace_small
```

## 5. What to upload to ChatGPT

가능하면 handoff bundle 전체를 압축해서 업로드합니다.

```text
/tmp/ddalggak_trace_<jobId>.tar.gz
```

용량이 크면 아래 파일부터 업로드합니다.

1. `HANDOFF_MANIFEST.json`
2. `llm_traces/index.jsonl`
3. 실패/이상 응답과 관련된 `<traceId>/request.json`
4. 같은 `<traceId>/response.json`
5. 같은 `<traceId>/prompt.txt`
6. 같은 `<traceId>/stdout.txt`
7. 같은 `<traceId>/stderr.txt`
8. 있으면 `run_context/conversation_tail.jsonl`
9. 있으면 `run_context/runtime_events_tail.jsonl`
10. 있으면 `run_context/latest_checkpoint.md`

함께 알려주면 좋은 정보:

```text
- 어떤 Telegram 명령을 보냈는지
- 기대한 동작
- 실제 동작
- jobId 또는 traceId
- 서버에서 적용 중인 zip/commit
- 재현 방법
```

## 6. What not to upload

업로드 금지:

```text
.env
.env.*
API key
Telegram bot token
GOC_SERVICE_KEY
database password
private key / certificate
server SSH key
```

## 7. Suggested Telegram flow while self-improve is paused

```text
/chat 실제 작업 또는 테스트 질문
/goc history push
```

문제가 생기면 서버에서:

```bash
node scripts/trace_doctor.js --job-id <jobId>
node scripts/trace_handoff_bundle.js --job-id <jobId> --out /tmp/ddalggak_trace_<jobId>
tar -czf /tmp/ddalggak_trace_<jobId>.tar.gz -C /tmp ddalggak_trace_<jobId>
```

그 압축 파일과 증상을 ChatGPT에게 전달해서 수동 패치를 진행합니다.
