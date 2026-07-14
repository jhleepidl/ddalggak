# Live Scenario fixtures

`live/*.json` contains product-level scenarios. `fixtures/` contains disposable baselines copied into a new evaluation workspace for every run.

Do not put a `test/` directory containing intentionally failing `*.test.js` files under this repository tree unless the root test command explicitly excludes it. The example fixture uses `checks/clamp_check.js` and an explicit fixture-local `npm test` command so the intentionally incomplete baseline is not discovered by ddalggak's own `node --test` suite.

See `../../docs/LIVE_SCENARIO_LAB.md` in the source bundle for the full workflow.

## General task examples

The bundle also includes non-coding task-form scenarios:

```text
live/file_grounding.json
live/contextual_recommendation.json
live/parallel_ideas.json
```

They test general contracts rather than product-domain keyword routing. Each fixture requires a reviewable JSON artifact and an explicit deterministic checker. These scenarios are evaluation candidates; Recipe status remains Experimental until real CLI runs provide sufficient evidence.

## Room continuity scenarios

`scenarios/continuity/` contains multi-turn, restart/model-change, correction, source-boundary, stale-plan, and branch tests. They are guided staging protocols rather than domain keyword rules.

```bash
npm run continuity:test -- --suite scenarios/continuity/core_suite.json --plan-only
npm run continuity:test -- --resume runs/continuity/<run-id>
```

See [`../../docs/CONTINUITY_EVALUATION_AND_HANDOFF.md`](../../docs/CONTINUITY_EVALUATION_AND_HANDOFF.md).
