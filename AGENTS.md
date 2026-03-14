# Agent Guidance

- `telegram_runner.js` is the stable bootstrap shell only. Keep it limited to env/bootstrap, starting the Telegram app, and top-level fatal handling.
- Telegram app assembly, bot creation, and handler wiring belong in `src/adapters/telegram/app.js`.
- Telegram command logic belongs in `src/adapters/telegram/commands.js`.
- Telegram callback query logic belongs in `src/adapters/telegram/callbacks.js`.
- Telegram message flow belongs in `src/adapters/telegram/messages.js`.
- Telegram upload/media ingress belongs in `src/adapters/telegram/uploads.js`.
- Telegram lifecycle, polling, single-instance lock, and shutdown handling belong in `src/adapters/telegram/lifecycle.js`.
- Business logic, runtime composition, planner behavior, team behavior, and supervisor logic belong in `src/application/*`.
- Do not add new business logic directly to `telegram_runner.js` unless it is true bootstrap code.
