import "dotenv/config";

import { startTelegramApp } from "./src/adapters/telegram/app.js";

try {
  await startTelegramApp();
} catch (error) {
  if (error?.code !== "telegram_single_instance_conflict") {
    console.error("[telegram_runner] fatal error");
    console.error(error?.stack || String(error?.message ?? error));
  }
  process.exitCode = Number.isInteger(error?.exitCode) ? error.exitCode : 1;
}
