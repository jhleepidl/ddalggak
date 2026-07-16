# Room journey scenarios

These scenarios exercise AI Room configuration, multi-turn user requests, governed memory, context projection, and provider CLI calls without requiring Telegram or a pre-created GoC Room. Headless Room commands are applied by a narrow adapter over the shared Room profile, memory, and correction services rather than by the Telegram transport handler.

The default `headless` transport creates one synthetic Room identity per scenario/arm and invokes the real in-process Room runtime:

```text
synthetic user turn / Room command
  → ChatRunManager
  → runSupervisorChat
  → Room package, rules, collaboration profile, and context projection
  → provider CLI calls
  → conversation ledger and governed memory lifecycle
  → local runtime events, governed-memory traces, and debug LLM prompt traces
```

Suites:

- `core_suite.json`: Room settings, multi-turn CLI calls, approved-memory reuse, unapproved-memory suppression, and correction uptake.
- `model_portfolio_suite.json`: solo baseline versus builder/reviewer, parallel ideation, and evidence panel.
- `operational_continuity_suite.json`: restart and model-swap journeys requiring explicit operator adapters.
- `../../config/model_roles/portfolio_benchmark.json`: version-controlled default role policy for repeatable portfolio execution.
- `staging_room_map.example.json`: optional deployed GoC command-path integration only. Identity requirements depend on that deployment; the default headless suites need no room map or Telegram identity.

Plan mode makes no provider, Telegram, or GoC calls:

```bash
npm run room:journey-bench -- \
  --suite scenarios/room_journeys/core_suite.json
```

Execute the core suite headlessly:

```bash
mkdir -p experiments/room_journeys

npm run room:journey-bench -- \
  --suite scenarios/room_journeys/core_suite.json \
  --execute \
  --out experiments/room_journeys
```

The portfolio suite automatically loads `config/model_roles/portfolio_benchmark.json`. Provider-only entries use each authenticated CLI's configured default model. Use `--model-role-policy <path>` only for an intentional fixed or experimental override.

```bash
npm run room:journey-bench -- \
  --suite scenarios/room_journeys/model_portfolio_suite.json \
  --execute \
  --judge-provider claude \
  --judge-reasoning-effort high \
  --out experiments/room_journeys
```

A multi-model arm is not promotable merely because it called more models. It must beat the strongest suitable solo baseline under the configured semantic quality, required assertion, cost, and latency gates. Only successful local CLI finishes count as evidence. Runtime events must prove that claimed model roles and distinct `provider:model` nodes actually completed and match the active audited model-role policy. If either arm has a CLI failure or no successful completion, the comparison is `invalid_execution` and no quality/cost/latency ratio is calculated.

`--sync-goc` in headless mode uploads the completed evaluation summary to GoC; it does not require a GoC Room and does not route the test through Telegram. Use `--transport goc` plus a room map only when explicitly testing the GoC runtime-command boundary.

Journey tracing is disabled globally and leased only for synthetic benchmark Rooms. During benchmark stabilization, raw provider prompts are intentionally retained under `_runtime/<job-id>/llm_traces/<trace-id>/prompt.txt` for local debugging. These files may contain user text, Room rules, projected memory, and orchestration instructions. Treat the output directory as sensitive and review/redact it before external sharing.

## Model-role policy

`model_portfolio_suite.json` automatically loads `config/model_roles/portfolio_benchmark.json`. No external `/home/jhlee/tmp/model-role-map.json` is required. Use `--model-role-policy <path>` only for an intentional experiment override. The legacy `--model-role-map` spelling remains accepted as an alias.

The repository policy is copied into each synthetic benchmark Room as an ephemeral Room policy. In real Rooms, `agent_room_profile.model_policy` is the role-by-role override layer; future learned changes should be proposed, trialed, and approved before becoming durable.
## 2026-07-15 comparison execution contract

Comparison scenarios with a designated target step now use **common buildup once -> immutable frozen pre-target snapshot -> per-arm target fork**. The snapshot copies canonical session state and non-volatile job-local Room state; volatile runtime logs and provider traces are excluded from snapshot equivalence.

Scenarios may declare required authoritative source steps. The runner creates one benchmark evidence manifest, injects it into every target arm, and verifies that every executed target role received the manifest marker and all required `source_step_id` markers in its actual role goal. Team route repair preserves this full evidence block beyond the ordinary compact request-summary limit.

Comparison semantic judging is target-only and topology-blind. Outcome quality, process assurance, and execution efficiency are separate. `collaboration_process_evidence.json` is diagnostic process evidence, not quality credit. Portfolio comparison latency uses target/comparison duration rather than snapshot setup time.

The `state_update` research shape now has a deterministic benchmark execution path with zero provider calls. This does not change production Concierge routing.

The high-impact routing experiment is not statically forced to a winner or permanently quarantined: it emits a label only when frozen snapshot parity, common evidence parity, complete required-context delivery, runtime execution-contract validity, provider/role/collaboration validity, and semantic evidence all pass.

