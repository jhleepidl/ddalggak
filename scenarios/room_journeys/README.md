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
- `model_role_map.example.json`: role-fit provider defaults for repeatable portfolio execution.
- `staging_room_map.example.json`: optional deployed GoC command-path integration only. Identity requirements depend on that deployment; the default headless suites need no room map or Telegram identity.

Plan mode makes no provider, Telegram, or GoC calls:

```bash
npm run room:journey-bench -- \
  --suite scenarios/room_journeys/core_suite.json
```

Execute the core suite headlessly:

```bash
mkdir -p /home/jhlee/tmp/ai_rooms_room_journeys

npm run room:journey-bench -- \
  --suite scenarios/room_journeys/core_suite.json \
  --execute \
  --out /home/jhlee/tmp/ai_rooms_room_journeys
```

Prepare an explicit role-to-model map for portfolio runs:

```bash
cp scenarios/room_journeys/model_role_map.example.json \
  /home/jhlee/tmp/model-role-map.json
```

Provider-only entries use each authenticated CLI's configured default model. Add exact discovered model selectors when a fixed reproducible matrix is required.

```bash
npm run room:journey-bench -- \
  --suite scenarios/room_journeys/model_portfolio_suite.json \
  --execute \
  --model-role-map /home/jhlee/tmp/model-role-map.json \
  --judge-provider claude \
  --judge-reasoning-effort high \
  --out /home/jhlee/tmp/ai_rooms_room_journeys
```

A multi-model arm is not promotable merely because it called more models. It must beat the strongest suitable solo baseline under the configured semantic quality, required assertion, cost, and latency gates. Only successful local CLI finishes count as evidence. Runtime events must prove that claimed model roles and distinct `provider:model` nodes actually completed and match the supplied model-role map. If either arm has a CLI failure or no successful completion, the comparison is `invalid_execution` and no quality/cost/latency ratio is calculated.

`--sync-goc` in headless mode uploads the completed evaluation summary to GoC; it does not require a GoC Room and does not route the test through Telegram. Use `--transport goc` plus a room map only when explicitly testing the GoC runtime-command boundary.

Journey tracing is disabled globally and leased only for synthetic benchmark Rooms. During benchmark stabilization, raw provider prompts are intentionally retained under `_runtime/<job-id>/llm_traces/<trace-id>/prompt.txt` for local debugging. These files may contain user text, Room rules, projected memory, and orchestration instructions. Treat the output directory as sensitive and review/redact it before external sharing.
