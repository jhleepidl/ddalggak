# Self-improvement runtime guide

This runtime can now run a **fully automated forge loop** from Telegram.

## Flow

1. `/improve auto ddalggak <instruction>` or `/improve auto goc <instruction>`
2. ddalggak pushes a fresh raw history snapshot into GoC.
3. ddalggak reads the current GoC board and creates an `improvement_job`.
4. ddalggak captures a repo snapshot for the target forge workspace.
5. ddalggak builds a context bundle under `.self_improve/jobs/<jobId>/`.
6. ddalggak runs the configured patch command inside the forge workspace.
7. ddalggak collects git diff metadata and writes it back to GoC.
8. ddalggak runs configured test commands.
9. ddalggak runs configured canary commands.
10. If requested, ddalggak runs the configured promote command.
11. All artifacts are written back to GoC Board lanes:
    - improvement_jobs
    - code_snapshots
    - code_diffs
    - test_reports
    - canary_results

## Telegram commands

- `/improve <ddalggak|goc> <instruction>`
- `/improve auto <ddalggak|goc> <instruction>`
- `/improve full <ddalggak|goc> <instruction>`
- `/improve execute <jobId> [full]`
- `/improve status <jobId>`
- `/improve test <jobId>`
- `/improve canary <jobId>`
- `/improve promote <jobId>`

## Required environment variables

Use separate stable/forge workspaces or git worktrees.

- `/srv/ddalggak-stable`
- `/srv/ddalggak-forge`
- `/srv/goc-stable`
- `/srv/goc-forge`

### Workspace + runtime

- `SELF_IMPROVE_DDALGGAK_WORKSPACE`
- `SELF_IMPROVE_GOC_WORKSPACE`
- `SELF_IMPROVE_DDALGGAK_RUNTIME`
- `SELF_IMPROVE_GOC_RUNTIME`

### Patch generation/apply

These commands are executed **inside the forge workspace**.

- `SELF_IMPROVE_DDALGGAK_PATCH_CMD`
- `SELF_IMPROVE_GOC_PATCH_CMD`
- `SELF_IMPROVE_DDALGGAK_PATCH_TIMEOUT_MS`
- `SELF_IMPROVE_GOC_PATCH_TIMEOUT_MS`

The patch command receives these env vars automatically:

- `SELF_IMPROVE_JOB_ID`
- `SELF_IMPROVE_TARGET`
- `SELF_IMPROVE_THREAD_ID`
- `SELF_IMPROVE_WORKSPACE_ROOT`
- `SELF_IMPROVE_BUNDLE_ROOT`
- `SELF_IMPROVE_MANIFEST_PATH`
- `SELF_IMPROVE_INSTRUCTION_PATH`
- `SELF_IMPROVE_REPORTS_PATH`
- `SELF_IMPROVE_PATCH_PLAN_PATH`
- `SELF_IMPROVE_PATCH_STDOUT_PATH`
- `SELF_IMPROVE_PATCH_STDERR_PATH`
- `SELF_IMPROVE_DIFF_STAT_PATH`
- `SELF_IMPROVE_DIFF_PATCH_PATH`
- `SELF_IMPROVE_INSTRUCTION`

### Validation / promote

- `SELF_IMPROVE_DDALGGAK_TEST_CMD`
- `SELF_IMPROVE_GOC_TEST_CMD`
- `SELF_IMPROVE_DDALGGAK_CANARY_CMD`
- `SELF_IMPROVE_GOC_CANARY_CMD`
- `SELF_IMPROVE_DDALGGAK_PROMOTE_CMD`
- `SELF_IMPROVE_GOC_PROMOTE_CMD`
- `SELF_IMPROVE_DDALGGAK_AUTO_PROMOTE`
- `SELF_IMPROVE_GOC_AUTO_PROMOTE`

Each `*_CMD` can contain multiple shell commands separated by `;;`.

## Notes

- `auto` stops after patch/test/canary and leaves the job in `ready_for_promote` unless auto-promote is enabled.
- `full` runs the same loop and then executes the configured promote command.
- Raw history remains visible in GoC, but improvement artifacts are marked `learning_excluded` and `promotion_blocked` so they do not contaminate skill/team learning layers.
