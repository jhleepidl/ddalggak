import path from "node:path";
import process from "node:process";

import { ChatSessionStore } from "../chat/session.js";

const chatSessionStore = new ChatSessionStore({
  baseDir: process.env.RUNS_DIR
    ? path.resolve(process.env.RUNS_DIR)
    : path.resolve("runs"),
});

export function updateAgentStatus(chatId, agentId, patch = {}) {
  const cleanAgentId = String(agentId || "").trim().toLowerCase();
  if (!cleanAgentId) return { changed: false, previousState: "", nextState: "" };
  let previousState = "";
  let nextState = "";
  chatSessionStore.upsert(chatId, (session) => {
    const currentMap = session?.agent_status && typeof session.agent_status === "object"
      ? session.agent_status
      : {};
    const previous = currentMap[cleanAgentId] && typeof currentMap[cleanAgentId] === "object"
      ? currentMap[cleanAgentId]
      : {};
    previousState = String(previous.state || "").trim().toLowerCase();
    const nextRow = {
      ...previous,
      ...patch,
    };
    if (!nextRow.goal && previous.goal) nextRow.goal = previous.goal;
    nextState = String(nextRow.state || "").trim().toLowerCase();
    return {
      ...session,
      agent_status: {
        ...currentMap,
        [cleanAgentId]: nextRow,
      },
    };
  });
  return {
    changed: previousState !== nextState,
    previousState,
    nextState,
  };
}
