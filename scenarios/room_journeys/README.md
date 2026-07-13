# Room journey scenarios

These scenarios exercise the actual GoC → ddalggak Room runtime path. They are separate from `scenarios/live`, which measures isolated provider/model fixture execution, and from `scenarios/continuity`, which is an operator-guided transcript protocol.

- `core_suite.json`: governed memory and correction journeys.
- `model_portfolio_suite.json`: solo baseline versus builder/reviewer, parallel ideation, and evidence panel.
- `operational_continuity_suite.json`: restart and model-swap journeys requiring operator adapters.
- `staging_room_map.example.json`: one dedicated staging Room identity per scenario/arm cell.

Plan mode is safe and makes no external calls:

```bash
npm run room:journey-bench -- --suite scenarios/room_journeys/core_suite.json
```

Use `--room-map scenarios/room_journeys/staging_room_map.example.json` as a template and replace every placeholder before execution. All core, operational, and portfolio cells must have isolated Room identities; `{{scenario}}`/`{{arm}}` templates are an alternative only when those IDs already exist in staging. A multi-model arm is not promotable merely because it called more models; it must beat the solo baseline under the configured quality, cost, latency, and safety gates.

Operational restart/model-swap scenarios are in `operational_continuity_suite.json` and require explicit staging-safe shell adapters. Journey tracing is leased per benchmark Room for two hours rather than enabled globally.
