## User-facing Room continuity

The primary Telegram experience is `/home`, `/brief`, `/continue`, `/sources`, `/rules`, `/correct`, and `/branch`. Agent/model/collaboration commands are advanced controls. Implement continuity from general Room state and contracts; do not add domain-keyword or scenario-specific routing rules. Treat strongest-current-single-model plus native subagents as the default quality baseline.

# Agent Guidance

- `telegram_runner.js` is the stable bootstrap shell only. Keep it limited to env/bootstrap, starting the Telegram app, and top-level fatal handling.
- `src/adapters/telegram/app.js` is assembly-only. Keep it limited to bot configuration, grouped dependency assembly, handler wiring, lifecycle registration, and polling start.
- `src/application/telegram_runtime_ops.js` is compatibility-only. Keep it as a re-export surface for existing callers, not an implementation file.
- Telegram command logic belongs in `src/adapters/telegram/commands.js`.
- Telegram callback query logic belongs in `src/adapters/telegram/callbacks.js`.
- Telegram message flow belongs in `src/adapters/telegram/messages.js`.
- Telegram upload/media ingress belongs in `src/adapters/telegram/uploads.js`.
- Telegram lifecycle, polling, single-instance lock, and shutdown handling belong in `src/adapters/telegram/lifecycle.js`.
- Do not add new business logic, planner logic, mutation logic, runtime orchestration, or formatting helpers directly to `src/adapters/telegram/app.js`.
- Transport behavior belongs in `src/adapters/telegram/messages.js`, `src/adapters/telegram/uploads.js`, `src/adapters/telegram/lifecycle.js`, `src/adapters/telegram/commands.js`, and `src/adapters/telegram/callbacks.js`.
- Application/business logic belongs in `src/application/*`.
- Put runtime state/session/job helpers in `src/application/telegram_runtime_state.js`.
- Put workspace/context/file IO helpers in `src/application/telegram_runtime_io.js`.
- Put routing, prompt suggestion, action parsing, and team recommendation logic in `src/application/telegram_route_planning.js`.
- Put execution orchestration and action execution in `src/application/telegram_chat_execution.js`.
- Put GoC runtime/resource/draft/membership logic in `src/application/telegram_goc_runtime.js`.
- Keep user-facing Telegram runtime formatting in `src/application/telegram_runtime_ui.js`.
- Do not add new implementations directly back into `src/application/telegram_runtime_ops.js`.
- Do not add new business logic directly to `telegram_runner.js` unless it is true bootstrap code.
- Canonical worker roles are only `researcher`, `builder`, `reviewer`, `synthesizer`, and `operator`.
- `planner` is control-plane compatibility metadata only. Do not introduce it as a runtime worker role.
- Human-authored preset specs belong under `presets/*` and should remain text-first (`preset.yaml` + `prompt.md`).
- Conversation-level `/agents` semantics are preference-based: pin/ban presets, suppress roles/skills, and adjust control/review settings. Legacy commands remain aliases over that preference state.
- `SupervisorRuntime` is a control actor layered on runtime execution, not a worker role.

## Cross-repository development workflow

- Canonical architecture and development coordination live in the separate AI Rooms docs repository, not in this repository's ignored `docs/` directory.
- Before implementation, read the active `TASK-####` contract from `coordination/active/` in the docs repository.
- Work only in an isolated task branch/worktree. Do not import ZIP snapshots into `main`, the management checkout, or a deployed release.
- A task has one writer. When assigned as reviewer, do not edit the writer's worktree.
- Source-development agents and Telegram runtime agents are separate. Runtime runs must not modify development repositories, task worktrees, or releases.
- External patches must carry `PATCH_MANIFEST.json` and pass the docs repository's `scripts/dev/import-patch.sh` checks.

## Routing and scenario generalization

- Do not add scenario-specific keyword-to-Recipe, keyword-to-agent, or keyword-to-topology tables.
- Represent recurring task forms as explicit contracts/capabilities and evaluate them through Live Scenario suites.
- Keep deterministic branching for hard safety, authority, compatibility, and schema constraints.
- New collaboration behavior must be explicit, inspectable, budget-bounded, and preserve provider-native orchestration where appropriate.
