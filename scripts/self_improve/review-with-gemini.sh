#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-${SELF_IMPROVE_TARGET:-unknown}}"
WORKSPACE="${SELF_IMPROVE_WORKSPACE_ROOT:?missing SELF_IMPROVE_WORKSPACE_ROOT}"
JOB_ID="${SELF_IMPROVE_JOB_ID:-manual}"
BUNDLE_ROOT="${SELF_IMPROVE_BUNDLE_ROOT:-$WORKSPACE/.self_improve/jobs/$JOB_ID}"
DEBUG_DIR="${SELF_IMPROVE_DEBUG_DIR:-$BUNDLE_ROOT/debug}"
REVIEW_INPUT="${SELF_IMPROVE_REVIEW_INPUT_PATH:-$DEBUG_DIR/review_input.md}"
REPORT_PATH="${SELF_IMPROVE_REVIEW_REPORT_PATH:-$DEBUG_DIR/review_report.md}"

cd "$WORKSPACE"
mkdir -p "$DEBUG_DIR" "$(dirname "$REPORT_PATH")"

if [ ! -f "$REVIEW_INPUT" ]; then
  cat > "$REVIEW_INPUT" <<REVIEW_INPUT_FALLBACK
# Scoped review input for ${JOB_ID}

No generated review_input.md was found. Review the current workspace diff using the commands below and classify risk conservatively.

## Git status
$(git status --short --branch 2>/dev/null || true)

## Diff stat
$(git --no-pager diff --stat --no-ext-diff 2>/dev/null || true)
$(git --no-pager diff --cached --stat --no-ext-diff 2>/dev/null || true)

## Required output format
Use this exact line near the top of your answer: Risk: low|medium|high
REVIEW_INPUT_FALLBACK
fi

PROMPT_FILE="${DEBUG_DIR}/gemini-review-prompt.md"
cat > "$PROMPT_FILE" <<PROMPT
Review the latest self-improvement patch for ${TARGET}.

Focus on:
- forbidden path changes
- credential/auth/deployment risk
- missing tests
- diff size and rollback risk
- whether to recommend promote, reject, or request changes

Use this exact line near the top of your answer:
Risk: low|medium|high

Scoped review input follows. Do not ask for raw prompts, raw traces, credentials, or full runtime logs unless the summary is insufficient.

$(sed -e 's/\r$//' "$REVIEW_INPUT" | head -c 60000)
PROMPT

gemini -p "$(cat "$PROMPT_FILE")" | tee "$REPORT_PATH"
