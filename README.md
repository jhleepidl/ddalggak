# DdalGgak runtime

`ddalggak/` is the executable Room runtime for AI Rooms.

The canonical component documentation is centralized under:

- [`../docs/components/ddalggak/README.md`](../docs/components/ddalggak/README.md) — architecture, runtime model, commands, and operating notes.
- [`../docs/components/ddalggak/guides/`](../docs/components/ddalggak/guides/) — component guides and model/trace/skill policies.
- [`../docs/ROOM_USER_JOURNEY_AND_MODEL_PORTFOLIO_BENCHMARK.md`](../docs/ROOM_USER_JOURNEY_AND_MODEL_PORTFOLIO_BENCHMARK.md) — headless Room journey and model portfolio benchmark.
- [`../docs/CHATGPT_HANDOFF.md`](../docs/CHATGPT_HANDOFF.md) — current cross-project handoff.

Local files intentionally kept beside executable assets:

- `AGENTS.md` — local agent/runtime instructions discovered from the component root.
- `skills/*/SKILL.md` and related checklists — executable skill package contracts.
- `scenarios/**/README.md` — scenario-local execution contracts.
- `experiments/README.md` — experiment-code entrypoint; generated results belong in `experiments/room_journeys/` and are gitignored.
- `presets/*/prompt.md` — runtime prompt assets, not general documentation.

Do not add new general-purpose Markdown guides to the `ddalggak/` root. Put living documentation under the repository-level `docs/` tree.
