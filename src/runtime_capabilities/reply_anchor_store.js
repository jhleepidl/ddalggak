import { appendAnswerCapsules, findAnswerCapsuleByTelegramMessageId, normalizeAnswerCapsules } from "../application/answer_capsules.js";

export class ReplyAnchorStore {
  constructor({ sessionStore } = {}) {
    if (!sessionStore || typeof sessionStore.get !== "function" || typeof sessionStore.upsert !== "function") {
      throw new Error("ReplyAnchorStore requires sessionStore");
    }
    this.sessionStore = sessionStore;
  }

  list(chatId) {
    const session = this.sessionStore.get(chatId);
    return normalizeAnswerCapsules(session?.answer_capsules || []);
  }

  find(chatId, telegramMessageId) {
    const session = this.sessionStore.get(chatId);
    return findAnswerCapsuleByTelegramMessageId(session, telegramMessageId);
  }

  append(chatId, entries = []) {
    const normalized = normalizeAnswerCapsules(entries);
    if (normalized.length === 0) return this.list(chatId);
    let nextCapsules = [];
    this.sessionStore.upsert(chatId, (session) => {
      nextCapsules = appendAnswerCapsules(session?.answer_capsules || [], normalized);
      return {
        ...session,
        answer_capsules: nextCapsules,
      };
    });
    return nextCapsules;
  }
}
