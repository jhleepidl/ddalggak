# Codex model policy for self-improvement

This project keeps automatic self-improvement conservative. When you enable
`SELF_IMPROVE_<TARGET>_PATCH_CMD`, `scripts/self_improve/patch-with-codex.sh`
chooses a Codex model from environment settings instead of relying on an
implicit CLI default.

## Recommended defaults

```bash
SELF_IMPROVE_CODEX_MODEL_POLICY=balanced
SELF_IMPROVE_CODEX_AUTH_MODE=auto
SELF_IMPROVE_CODEX_FRONTIER_MODEL=gpt-5.5
SELF_IMPROVE_CODEX_API_MODEL=gpt-5.4
SELF_IMPROVE_CODEX_MINI_MODEL=gpt-5.4-mini
SELF_IMPROVE_CODEX_FALLBACK_MODEL=gpt-5.4
SELF_IMPROVE_CODEX_FALLBACK_ON_MODEL_ERROR=true
```

## How routing works

| Situation | Recommended model | Why |
| --- | --- | --- |
| Normal or complex code patch, ChatGPT-login Codex | `gpt-5.5` | Strongest default for Codex coding, planning, validation, and multi-step debugging. |
| API-key automation or CI | `gpt-5.4` | `gpt-5.5` may not be available with API-key authentication. |
| Documentation, wording, typo, comment-only, or test-name-only patch | `gpt-5.4-mini` | Faster/lower-cost option for light coding tasks. |
| High-risk refactor, runtime, auth, GoC sync, Telegram, rollback, or debugging | `gpt-5.5` when available, otherwise `gpt-5.4` | Use a frontier model for ambiguous or high-risk changes. |
| Need complete reproducibility | Fixed model via `SELF_IMPROVE_CODEX_MODEL=...` | Avoids model drift across runs. |

## Policy values

- `balanced` — default. Uses `gpt-5.4-mini` for obviously light/documentation-only tasks, otherwise frontier (`gpt-5.5` unless `SELF_IMPROVE_CODEX_AUTH_MODE=api_key`).
- `quality` — always frontier (`gpt-5.5` for ChatGPT auth, `gpt-5.4` for API-key auth).
- `economy` — always `gpt-5.4-mini`.
- `api_key` — always `gpt-5.4` unless you override `SELF_IMPROVE_CODEX_API_MODEL`.
- `fixed` or `cli-default` — do not pass `--model`; let the Codex CLI config decide.

`SELF_IMPROVE_CODEX_MODEL=<model>` overrides all policy routing. Set it only when
you intentionally want to pin a model.

## Dry-run check

You can verify model selection without running Codex:

```bash
SELF_IMPROVE_CODEX_DRY_RUN=true \
SELF_IMPROVE_JOB_ID=dryrun \
SELF_IMPROVE_WORKSPACE_ROOT=/srv/ddalggak-forge \
SELF_IMPROVE_INSTRUCTION_PATH=/tmp/instruction.txt \
SELF_IMPROVE_MANIFEST_PATH=/tmp/manifest.json \
SELF_IMPROVE_REPORTS_PATH=/tmp/reports.json \
./scripts/self_improve/patch-with-codex.sh ddalggak
```

The script writes `.self_improve/jobs/<jobId>/codex-model-decision.json` with the
selected model, policy, auth mode, and inferred task tier.

## Notes

- Keep fast mode off by default. Fast mode can increase speed but consumes credits faster.
- Keep auto-promote off. Model choice does not replace human review and tests.
- For manual trace-based debugging, the Codex patch command can stay disabled entirely.
