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

test("planAgentFollowupShortcut only bypasses router when reply is anchored to an answer capsule", () => {
  const shortcut = planAgentFollowupShortcut({
    message: "그 답변의 이유를 조금 더 자세히 설명해줘",
    session: {
      answer_capsules: [
        {
          telegram_message_id: 123,
          agent_id: "researcher",
          answer_summary: "수요 회복과 재고 정상화 때문에 개선될 가능성이 높다",
          answer_excerpt: "메모리 업황은 점진적으로 회복 중이다.",
          original_goal_summary: "삼성전자 업황을 분석",
        },
      ],
      recent_agent_turns: [
        {
          agent_id: "reviewer",
          agent_name: "Reviewer",
          role: "reviewer",
          provider: "gemini",
          goal: "별도 검토",
          output: "별도 검토 출력",
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
  assert.match(shortcut.action.goal, /PREVIOUS ANSWER SUMMARY/);
});

test("planAgentFollowupShortcut keeps reply-anchored routing even when the reply text looks like a new task", () => {
  const shortcut = planAgentFollowupShortcut({
    message: "그럼 이 구조로 실제 구현도 진행해줘",
    session: {
      answer_capsules: [
        {
          telegram_message_id: 456,
          agent_id: "reviewer",
          answer_summary: "이전 답변에서는 reviewer가 구조 리스크를 설명했다.",
          answer_excerpt: "핵심 문제는 capability contract drift였다.",
          original_goal_summary: "구조 문제를 설명해줘",
        },
      ],
    },
    runtime: {},
    teamConfig: { shortcut_policy: { enabled: true } },
    replyToMessageId: 456,
  });

  assert.equal(shortcut.matched, true);
  assert.equal(shortcut.target_agent_id, "reviewer");
  assert.equal(shortcut.reason, "reply_anchor_capsule");
});

test("planAgentFollowupShortcut routes through router when reply target is not an agent answer capsule", () => {
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
  assert.equal(shortcut.reason, "reply_not_agent_answer");
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
