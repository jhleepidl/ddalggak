# Skill Authoring Guide

ddalggak의 skill은 role 기반 runtime 위에 additive하게 붙는 절차 패키지입니다.

## 1) 디렉터리 규칙

기본 위치:

```text
skills/
  <skill_slug>/
    manifest.json
    SKILL.md
    ...optional resources/scripts
```

- `<skill_slug>`는 소문자 snake_case 권장
- `manifest.json`과 `SKILL.md`는 필수

## 2) Manifest 필드

권장 canonical shape:

```json
{
  "id": "skill.example_skill.v1",
  "slug": "example_skill",
  "name": "Example Skill",
  "version": "1.0.0",
  "description": "One-line procedural purpose.",
  "category": "orchestration",
  "capability_tags": ["tag_a", "tag_b"],
  "trigger_terms": ["keyword a", "keyword b"],
  "compatible_roles": ["planner", "researcher"],
  "input_contract": {},
  "output_contract": {},
  "instructions_ref": "SKILL.md",
  "resource_refs": ["checklist.md"],
  "utility_refs": ["helper.py"],
  "default_context_policy": {},
  "validation_policy": {},
  "safety_policy": {},
  "ranking_metadata": { "success_rate": 0.6, "usage_count": 0, "risk": "low" },
  "visibility": "internal",
  "status": "active"
}
```

## 3) SKILL.md 작성 기대치

필수로 들어갈 내용:
- 목적(왜 이 스킬을 쓰는지)
- 절차(실행 순서, 3~7 단계 권장)
- 안전 규칙(잘못된 실행 방지)
- 출력 기대치(최소 산출물)

짧고 명확하게 유지하고, role이 바로 실행 가능한 수준으로 작성합니다.

## 4) 네이밍 가이드

- `id`: `skill.<slug>.v<major>` 권장
- `description`: 1문장, 동사 중심
- `capability_tags`: 넓은 capability
- `trigger_terms`: 실제 user/task 문구에 등장할 단어

## 5) Utility Script 사용 시점

`utility_refs`에는 다음 조건에서만 스크립트를 추가합니다:
- 동일 검증/정규화 로직을 반복 실행할 때
- 수작업 대비 오류 가능성이 줄어들 때
- 실패 시 명확한 exit code/메시지를 제공할 수 있을 때

과도한 스크립트화보다, 단순한 절차는 `SKILL.md`/체크리스트로 유지하는 것을 우선합니다.

