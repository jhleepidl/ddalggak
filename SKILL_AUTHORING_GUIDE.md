# Skill Authoring Guide

ddalggak의 preset은 `presets/*` 아래에서 text-first로 작성되고, skill은 그 위에 additive하게 붙는 절차 패키지입니다.

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
  "compatible_roles": ["researcher", "reviewer"],
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

`compatible_roles`에는 stable worker role만 사용하세요:
- `researcher`
- `builder`
- `reviewer`
- `synthesizer`
- `operator`

`planner`는 worker role이 아니므로 skill compatibility target으로 쓰지 않습니다.

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

## 6) Runtime 연동 시 canonical 포인트

- role에 붙는 런타임 attachment shape:

```json
{
  "skill_id": "skill.example_skill.v1",
  "selected_by": "skill_resolver",
  "selection_reason": "trigger_matches:2",
  "load_level": "metadata_only|instructions|resources",
  "status": "selected"
}
```

- `load_level`은 manifest가 아니라 런타임에서 결정됩니다.
  - 기본: `metadata_only`
  - 실행 직전 필요 시 `instructions`/`resources`로 승격
- ContextPack에는 `skill_items[{ skill_id, load_level }]`가 기록됩니다.
- runtime/GOC 메타데이터에는 `selected_skill_ids`, `skill_load_levels`, `selection_reason_summary`, `skill_usage_events`가 additive 필드로 노출됩니다.
