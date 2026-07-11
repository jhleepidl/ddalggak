# Live Scenario fixtures

`live/*.json` contains product-level scenarios. `fixtures/` contains disposable baselines copied into a new evaluation workspace for every run.

Do not put a `test/` directory containing intentionally failing `*.test.js` files under this repository tree unless the root test command explicitly excludes it. The example fixture uses `checks/clamp_check.js` and an explicit fixture-local `npm test` command so the intentionally incomplete baseline is not discovered by ddalggak's own `node --test` suite.

See `../../docs/LIVE_SCENARIO_LAB.md` in the source bundle for the full workflow.
