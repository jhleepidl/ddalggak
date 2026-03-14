# Agent Guidance

- `telegram_runner.js` is the stable bootstrap shell only. Keep it limited to env/bootstrap, starting the Telegram app, and top-level fatal handling.
- `src/adapters/telegram/app.js` is assembly-only. Keep it limited to bot configuration, grouped dependency assembly, handler wiring, lifecycle registration, and polling start.
- Telegram command logic belongs in `src/adapters/telegram/commands.js`.
- Telegram callback query logic belongs in `src/adapters/telegram/callbacks.js`.
- Telegram message flow belongs in `src/adapters/telegram/messages.js`.
- Telegram upload/media ingress belongs in `src/adapters/telegram/uploads.js`.
- Telegram lifecycle, polling, single-instance lock, and shutdown handling belong in `src/adapters/telegram/lifecycle.js`.
- Do not add new business logic, planner logic, mutation logic, runtime orchestration, or formatting helpers directly to `src/adapters/telegram/app.js`.
- Transport behavior belongs in `src/adapters/telegram/messages.js`, `src/adapters/telegram/uploads.js`, `src/adapters/telegram/lifecycle.js`, `src/adapters/telegram/commands.js`, and `src/adapters/telegram/callbacks.js`.
- Application/business logic belongs in `src/application/*`.
- Do not add new business logic directly to `telegram_runner.js` unless it is true bootstrap code.
