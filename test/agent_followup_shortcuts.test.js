import test from "node:test";
import assert from "node:assert/strict";

import {
  appendRecentAgentTurn,
  inferAgentFollowupIntent,
  planAgentFollowupShortcut,
} from "../src/application/agent_followup_shortcuts.js";

test("inferAgentFollowupIntent matches short why-question followups", () => {
  const matched = inferAgentFollowupIntent("왜 그렇게 봤어?");
  assert.equal(matched.matched, true);
  assert.ok(matched.score >= 3);

  const notMatched = inferAgentFollowupIntent("이제 이 내용을 기준으로 구현 패치랑 테스트 코드도 작성해줘");
  assert.equal(notMatched.matched, false);
});

test("appendRecentAgentTurn keeps newest unique agent turns first", () => {
  const turns = appendRecentAgentTurn([{ agent_id: "researcher", goal: "g1", output: "o1" }], {
    agent_id: "reviewer",
    goal: "g2",
    output: "o2",
  });
  assert.equal(turns[0].agent_id, "reviewer");
  assert.equal(turns[1].agent_id, "researcher");
});

test("planAgentFollowupShortcut targets the most recent eligible agent turn when reply is used", () => {
  const shortcut = planAgentFollowupShortcut({
    message: "그 답변의 이유를 조금 더 자세히 설명해줘",
    session: {
      recent_agent_turns: [
        {
          agent_id: "researcher",
          agent_name: "Researcher",
          role: "researcher",
          provider: "gemini",
          model: "gemini-2.5-pro",
          goal: "삼성전자 업황을 분석",
          output: "수요 회복과 재고 정상화 때문에 개선될 가능성이 높다",
        },
      ],
    },
    runtime: {
      agentsCatalog: [{ id: "researcher", name: "Researcher", role: "researcher", provider: "gemini" }],
    },
    teamConfig: { shortcut_policy: { enabled: true } },
    replyToMessageId: 123,
  });

  assert.equal(shortcut.matched, true);
  assert.equal(shortcut.target_agent_id, "researcher");
  assert.equal(shortcut.action.agent_id, "researcher");
  assert.match(shortcut.action.goal, /FOLLOW-UP SHORTCUT/);
  assert.match(shortcut.action.goal, /YOUR PREVIOUS ANSWER/);
});

test("planAgentFollowupShortcut ignores recent codex builder turns", () => {
  const shortcut = planAgentFollowupShortcut({
    message: "왜 그렇게 수정했어?",
    session: {
      recent_agent_turns: [
        {
          agent_id: "builder",
          role: "builder",
          provider: "codex",
          goal: "패치 적용",
          output: "diff applied",
        },
      ],
    },
    runtime: {
      agentsCatalog: [{ id: "builder", name: "Builder", role: "builder", provider: "codex" }],
    },
    teamConfig: { shortcut_policy: { enabled: true } },
    replyToMessageId: 123,
  });

  assert.equal(shortcut.matched, false);
  assert.equal(shortcut.reason, "no_eligible_recent_agent_turn");
});

test("planAgentFollowupShortcut now requires an explicit Telegram reply target", () => {
  const shortcut = planAgentFollowupShortcut({
    message: "그 답변의 이유를 조금 더 자세히 설명해줘",
    session: {
      recent_agent_turns: [
        {
          agent_id: "researcher",
          agent_name: "Researcher",
          role: "researcher",
          provider: "gemini",
          goal: "분석",
          output: "요약",
        },
      ],
    },
    runtime: {
      agentsCatalog: [{ id: "researcher", name: "Researcher", role: "researcher", provider: "gemini" }],
    },
    teamConfig: { shortcut_policy: { enabled: true } },
  });

  assert.equal(shortcut.matched, false);
  assert.equal(shortcut.reason, "reply_required");
});
