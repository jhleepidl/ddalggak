#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-${SELF_IMPROVE_TARGET:-unknown}}"
WORKSPACE="${SELF_IMPROVE_WORKSPACE_ROOT:?missing SELF_IMPROVE_WORKSPACE_ROOT}"
JOB_ID="${SELF_IMPROVE_JOB_ID:?missing SELF_IMPROVE_JOB_ID}"

clean() {
  local value="${1:-}"
  # Bash-only trim to avoid nested external-command pipelines in non-interactive runtimes.
  value="${value#"${value%%[!$' \t\r\n']*}"}"
  value="${value%"${value##*[!$' \t\r\n']}"}"
  printf '%s' "$value"
}

lower() {
  local value
  value="$(clean "${1:-}")"
  printf '%s' "${value,,}"
}

truthy() {
  case "$(lower "${1:-}")" in
    1|true|yes|on) return 0 ;;
    *) return 1 ;;
  esac
}

write_json_string() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  printf '"%s"' "$value"
}

file_text_for_classification() {
  local file="${1:-}"
  if [ -f "$file" ]; then
    head -c 20000 "$file" 2>/dev/null || true
  fi
}

classify_task_tier() {
  local explicit="$(lower "${SELF_IMPROVE_CODEX_TASK_TIER:-auto}")"
  case "$explicit" in
    light|standard|complex|heavy) printf '%s' "$explicit"; return ;;
  esac

  local text
  text="$(
    {
      printf '%s\n' "${SELF_IMPROVE_INSTRUCTION:-}"
      file_text_for_classification "${SELF_IMPROVE_INSTRUCTION_PATH:-}"
    }
  )"
  text="${text,,}"

  if printf '%s' "$text" | grep -Eiq '(readme|docs?|documentation|guide|runbook|typo|wording|copy|comment|comments|test name|rename test|formatting|lint only|문서|가이드|오타|문구|주석|테스트 이름)'; then
    printf 'light'
    return
  fi

  if printf '%s' "$text" | grep -Eiq '(refactor|architecture|orchestrator|runtime|telegram|goc|database|migration|auth|credential|security|rollback|promote|self[- ]?improve|multi[- ]?agent|debug|failure|integration|리팩토링|아키텍처|런타임|텔레그램|데이터베이스|마이그레이션|인증|보안|롤백|디버그|실패)'; then
    printf 'complex'
    return
  fi

  printf 'standard'
}

choose_codex_model() {
  local task_tier="${1:-standard}"
  local policy="$(lower "${SELF_IMPROVE_CODEX_MODEL_POLICY:-balanced}")"
  local auth_mode="$(lower "${SELF_IMPROVE_CODEX_AUTH_MODE:-auto}")"
  local fixed_model="$(clean "${SELF_IMPROVE_CODEX_MODEL:-}")"
  local frontier_model="$(clean "${SELF_IMPROVE_CODEX_FRONTIER_MODEL:-gpt-5.5}")"
  local api_model="$(clean "${SELF_IMPROVE_CODEX_API_MODEL:-gpt-5.4}")"
  local mini_model="$(clean "${SELF_IMPROVE_CODEX_MINI_MODEL:-gpt-5.4-mini}")"

  if [ -n "$fixed_model" ] && [ "$(lower "$fixed_model")" != "auto" ]; then
    printf '%s' "$fixed_model"
    return
  fi

  case "$policy" in
    fixed|cli-default|codex-default|none)
      printf ''
      return
      ;;
    economy|cost|cheap|mini|light)
      printf '%s' "$mini_model"
      return
      ;;
    quality|frontier|max)
      if [ "$auth_mode" = "api_key" ] || [ "$auth_mode" = "api-key" ]; then
        printf '%s' "$api_model"
      else
        printf '%s' "$frontier_model"
      fi
      return
      ;;
    api|api_key|api-key)
      printf '%s' "$api_model"
      return
      ;;
  esac

  if [ "$task_tier" = "light" ]; then
    printf '%s' "$mini_model"
    return
  fi
  if [ "$auth_mode" = "api_key" ] || [ "$auth_mode" = "api-key" ]; then
    printf '%s' "$api_model"
  else
    printf '%s' "$frontier_model"
  fi
}

model_error_text() {
  grep -Eih '(model.*(not available|not found|unknown|unsupported|access|unauthorized)|not.*available.*model|unrecognized model|invalid.*model|no access.*model)' "$@" 2>/dev/null || true
}

write_model_decision() {
  local fallback_used="${1:-false}"
  local fallback_reason="${2:-}"
  {
    printf '{\n'
    printf '  "selected_model": %s,\n' "$(write_json_string "$SELECTED_MODEL")"
    printf '  "fallback_model": %s,\n' "$(write_json_string "$FALLBACK_MODEL")"
    printf '  "model_policy": %s,\n' "$(write_json_string "$MODEL_POLICY")"
    printf '  "auth_mode": %s,\n' "$(write_json_string "$AUTH_MODE")"
    printf '  "task_tier": %s,\n' "$(write_json_string "$TASK_TIER")"
    printf '  "target": %s,\n' "$(write_json_string "$TARGET")"
    printf '  "job_id": %s,\n' "$(write_json_string "$JOB_ID")"
    if [ -z "$SELECTED_MODEL" ]; then
      printf '  "used_cli_default": true,\n'
    else
      printf '  "used_cli_default": false,\n'
    fi
    if truthy "$FALLBACK_ON_MODEL_ERROR"; then
      printf '  "fallback_on_model_error": true,\n'
    else
      printf '  "fallback_on_model_error": false,\n'
    fi
    printf '  "fallback_used": %s,\n' "$fallback_used"
    printf '  "fallback_reason": %s\n' "$(write_json_string "$fallback_reason")"
    printf '}\n'
  } > "$MODEL_DECISION_FILE"
}

write_prompt_file() {
  {
    printf 'You are patching the %s repository in a forge workspace.\n\n' "$TARGET"
    printf 'Instruction:\n'
    cat "${SELF_IMPROVE_INSTRUCTION_PATH:?missing SELF_IMPROVE_INSTRUCTION_PATH}"
    printf '\n\nContext manifest:\n'
    cat "${SELF_IMPROVE_MANIFEST_PATH:?missing SELF_IMPROVE_MANIFEST_PATH}"
    printf '\n\nReports:\n'
    cat "${SELF_IMPROVE_REPORTS_PATH:?missing SELF_IMPROVE_REPORTS_PATH}" 2>/dev/null || true
    printf '\n\nDebug bundle:\n%s\n' "${SELF_IMPROVE_DEBUG_DIR:-}"
    printf '\nScoped reviewer input path, if present:\n%s\n' "${SELF_IMPROVE_REVIEW_INPUT_PATH:-}"
    printf '\nCodex model policy:\n'
    cat "$MODEL_DECISION_FILE"
    printf '\nRules:\n'
    printf -- '- Modify only the minimum necessary files.\n'
    printf -- '- Do not edit credentials, .env files, auth tokens, deployment secrets, stable runtime directories, or production deployment scripts.\n'
    printf -- '- Do not perform large refactors.\n'
    printf -- '- Prefer tests with the smallest relevant scope.\n'
    printf -- '- Stop after producing a coherent patch.\n'
  } > "$PROMPT_FILE"
}

run_codex_exec() {
  local model="${1:-}"
  local stderr_path="${2:-/tmp/codex-stderr.$$}"
  local -a args=(exec --cd "$WORKSPACE" --json --full-auto --sandbox workspace-write --output-last-message "$FINAL_MESSAGE")
  if [ -n "$model" ]; then
    args+=(--model "$model")
  fi
  codex "${args[@]}" - < "$PROMPT_FILE" > "$JSONL_LOG" 2> "$stderr_path"
}

workspace_changes_outside_self_improve() {
  local line path_part normalized
  while IFS= read -r line; do
    path_part="${line:3}"
    if [[ "$path_part" == *" -> "* ]]; then
      path_part="${path_part##* -> }"
    fi
    normalized="${path_part#./}"
    case "$normalized" in
      .self_improve|.self_improve/*) continue ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < <(git status --porcelain 2>/dev/null || true)
}

cd "$WORKSPACE"

branch="$(git branch --show-current 2>/dev/null || git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ "$branch" != "forge" ]; then
  echo "Refusing to patch non-forge branch: ${branch:-unknown}" >&2
  exit 10
fi

dirty_changes="$(workspace_changes_outside_self_improve)"
if [ -n "$dirty_changes" ]; then
  echo "Workspace dirty. Refusing to patch." >&2
  printf '%s\n' "$dirty_changes" >&2
  exit 11
fi

PROMPT_FILE="${SELF_IMPROVE_PROMPT_PATH:-$WORKSPACE/.self_improve/jobs/$JOB_ID/prompt.md}"
FINAL_MESSAGE="${SELF_IMPROVE_FINAL_MESSAGE_PATH:-$WORKSPACE/.self_improve/jobs/$JOB_ID/codex-final.md}"
JSONL_LOG="${SELF_IMPROVE_JSONL_LOG_PATH:-$WORKSPACE/.self_improve/jobs/$JOB_ID/codex-events.jsonl}"
CODEX_STDERR_LOG="${SELF_IMPROVE_CODEX_STDERR_LOG_PATH:-$WORKSPACE/.self_improve/jobs/$JOB_ID/codex-cli-stderr.txt}"
MODEL_DECISION_FILE="${SELF_IMPROVE_CODEX_MODEL_DECISION_PATH:-$WORKSPACE/.self_improve/jobs/$JOB_ID/codex-model-decision.json}"
mkdir -p "${PROMPT_FILE%/*}" "${FINAL_MESSAGE%/*}" "${JSONL_LOG%/*}" "${CODEX_STDERR_LOG%/*}" "${MODEL_DECISION_FILE%/*}"

TASK_TIER="$(classify_task_tier)"
SELECTED_MODEL="$(choose_codex_model "$TASK_TIER")"
FALLBACK_MODEL="$(clean "${SELF_IMPROVE_CODEX_FALLBACK_MODEL:-${SELF_IMPROVE_CODEX_API_MODEL:-gpt-5.4}}")"
MODEL_POLICY="$(clean "${SELF_IMPROVE_CODEX_MODEL_POLICY:-balanced}")"
AUTH_MODE="$(clean "${SELF_IMPROVE_CODEX_AUTH_MODE:-auto}")"
FALLBACK_ON_MODEL_ERROR="${SELF_IMPROVE_CODEX_FALLBACK_ON_MODEL_ERROR:-true}"

write_model_decision false ''
write_prompt_file

if truthy "${SELF_IMPROVE_CODEX_DRY_RUN:-false}"; then
  cat "$MODEL_DECISION_FILE"
  exit 0
fi

set +e
run_codex_exec "$SELECTED_MODEL" "$CODEX_STDERR_LOG"
status=$?
set -e

if [ "$status" -ne 0 ] \
  && truthy "$FALLBACK_ON_MODEL_ERROR" \
  && [ -n "$FALLBACK_MODEL" ] \
  && [ "$FALLBACK_MODEL" != "$SELECTED_MODEL" ]; then
  model_error="$(model_error_text "$JSONL_LOG" "$CODEX_STDERR_LOG" "$FINAL_MESSAGE")"
  workspace_changes="$(workspace_changes_outside_self_improve)"
  if [ -n "$model_error" ] && [ -z "$workspace_changes" ]; then
    echo "Codex model '${SELECTED_MODEL:-cli-default}' failed before modifying the workspace; retrying with fallback model '$FALLBACK_MODEL'." >&2
    echo "$model_error" >&2
    SELECTED_MODEL="$FALLBACK_MODEL"
    write_model_decision true 'primary model unavailable or inaccessible'
    write_prompt_file
    set +e
    run_codex_exec "$SELECTED_MODEL" "$CODEX_STDERR_LOG"
    status=$?
    set -e
  fi
fi

exit "$status"
