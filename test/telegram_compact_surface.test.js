import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRoutedDashboardText,
  buildCompactRoutedDashboardText,
} from "../src/adapters/telegram/preview_formatting.js";
import { buildChatStatusCard } from "../src/application/telegram_runtime_ui.js";
import { chatSessionStore, activeJobByChat, jobs } from "../src/application/telegram_runtime_state.js";

test("compact routed dashboard keeps the default preview short", () => {
  const text = buildCompactRoutedDashboardText({
    actions: [
      { type: "run_agent", agent_id: "researcher", goal: "Scan the repo and identify likely notebook files" },
      { type: "run_agent", agent_id: "builder", goal: "Patch the notebook and tighten the lab flow" },
    ],
    agentStatus: {
      researcher: { state: "queued" },
      builder: { state: "queued" },
    },
  });

  assert.match(text, /🧭 이번 턴 계획/);
  assert.match(text, /agents:/);
  assert.match(text, /status:/);
  assert.match(text, /자세히 보려면 버튼 또는 \/status full/);
  assert.doesNotMatch(text, /🧭 핵심 agent/);
});

test("full routed dashboard still exposes detailed sections on demand", () => {
  const text = buildRoutedDashboardText({
    actions: [
      { type: "run_agent", agent_id: "researcher", goal: "Inspect files" },
    ],
    agentStatus: {
      researcher: { state: "running" },
    },
  });

  assert.match(text, /🧭 분담 · 이번 턴 팀 구성/);
  assert.match(text, /📡 상태/);
});

test("chat status card defaults to a compact operator-facing summary", () => {
  const chatId = "status-test-compact";
  chatSessionStore.clear(chatId);
  activeJobByChat.delete(chatId);
  try {
    chatSessionStore.upsert(chatId, {
      state: "executing",
      team_config: {
        active_team: {
          team_name: "Iterative Improvement Studio",
          archetype: "iterative_improvement",
          agents: [
            { name: 'Builder', role: 'builder', agency_overlay_id: 'agency:engineering/frontend-developer', agency_overlay: { display: { title: 'Frontend Developer' } } },
            { name: 'Critic', role: 'reviewer', agency_overlay_id: 'agency:engineering/code-reviewer', agency_overlay: { display: { title: 'Code Reviewer' } } },
          ],
        },
      },
      last_route: { turn: 2 },
      recent_agent_turns: [
        { agent_id: "builder", agent_name: "Builder", output: "Created the first notebook draft and updated the exercises." },
        { agent_id: "critic", agent_name: "Critic", role: "reviewer", output: "The flow is better, but one more polish pass would help." },
      ],
    });

    const card = buildChatStatusCard(chatId, null);
    assert.match(card.text, /phase: executing/);
    assert.match(card.text, /team: Iterative Improvement Studio · iterative_improvement/);
    assert.match(card.text, /role_profiles:/);
    assert.match(card.text, /Builder\(base=구현 · overlay=Frontend Developer\)/);
    assert.match(card.text, /iteration: 2/);
    assert.match(card.text, /recent:/);
    assert.match(card.text, /critic:/);
    assert.ok(card.reply_markup);
    assert.equal(card.reply_markup.inline_keyboard[0][0].text, "더 보기");
    assert.doesNotMatch(card.text, /job_id:/);
  } finally {
    chatSessionStore.clear(chatId);
    activeJobByChat.delete(chatId);
  }
});

test("chat status card can still render the full debug view on demand", () => {
  const chatId = "status-test-full";
  chatSessionStore.clear(chatId);
  activeJobByChat.delete(chatId);
  try {
    chatSessionStore.upsert(chatId, {
      state: "idle",
      jobId: "job-demo-1",
      team_config: {
        active_team: {
          team_name: "Iterative Improvement Studio",
          agents: [
            { name: 'Builder', role: 'builder', agency_overlay_id: 'agency:engineering/frontend-developer', agency_overlay: { display: { title: 'Frontend Developer' } } },
          ],
        },
      },
    });

    const card = buildChatStatusCard(chatId, null, { detail: "full" });
    assert.match(card.text, /job_id: job-demo-1/);
    assert.match(card.text, /active_team: Iterative Improvement Studio/);
    assert.match(card.text, /role_profiles:/);
    assert.match(card.text, /Builder\(base=구현 · overlay=Frontend Developer\)/);
    assert.ok(card.reply_markup);
    assert.equal(card.reply_markup.inline_keyboard[0][0].text, "요약 보기");
  } finally {
    chatSessionStore.clear(chatId);
    activeJobByChat.delete(chatId);
  }
});


test("chat status compact view includes heartbeat and active agents for live runs", () => {
  const chatId = "status-test-activity-compact";
  const created = jobs.createJob({ title: "job-status-activity-compact" });
  const jobId = created.jobId;
  const jobDir = created.dir;
  const eventFile = path.join(jobDir, "runtime_events.jsonl");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.writeFileSync(eventFile, `${JSON.stringify({ ts: new Date().toISOString(), event_type: "run.queue_steps", payload: { actions: [{ display_label: "Notebook Builder" }] } })}
`, "utf8");
  chatSessionStore.clear(chatId);
  activeJobByChat.delete(chatId);
  try {
    activeJobByChat.set(chatId, jobId);
    chatSessionStore.upsert(chatId, {
      state: "executing",
      jobId,
      team_config: { active_team: { team_name: "Iterative Improvement Studio", archetype: "iterative_improvement" } },
      agent_status: {
        notebook_builder: { state: "running", started_at: new Date().toISOString(), goal: "Patch the notebook" },
      },
    });

    const card = buildChatStatusCard(chatId, null);
    assert.match(card.text, /heartbeat:/);
    assert.match(card.text, /active:/);
    assert.match(card.text, /Notebook Builder|notebook_builder/);
    assert.ok(card.reply_markup);
    assert.ok(card.reply_markup.inline_keyboard[0].some((button) => button.text === "최근 작업"));
  } finally {
    chatSessionStore.clear(chatId);
    activeJobByChat.delete(chatId);
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});

test("chat status recent view shows concrete runtime activity from files and events", () => {
  const chatId = "status-test-recent";
  const created = jobs.createJob({ title: "job-status-recent" });
  const jobId = created.jobId;
  const jobDir = created.dir;
  const sharedDir = path.join(jobDir, "shared");
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(path.join(jobDir, "runtime_events.jsonl"), [
    JSON.stringify({ ts: new Date().toISOString(), event_type: "run.queue_steps", payload: { actions: [{ display_label: "Notebook Builder" }, { display_label: "Critic" }] } }),
  ].join("\n") + "\n", "utf8");
  fs.writeFileSync(path.join(sharedDir, "progress.md"), "# Progress\n\n> createdAt: 2026-03-21T00:00:00.000Z\n\n---\n\n**2026-03-21T10:00:00.000Z**\n\nExecuted notebook smoke test and updated the workshop flow.\n", "utf8");
  chatSessionStore.clear(chatId);
  activeJobByChat.delete(chatId);
  try {
    activeJobByChat.set(chatId, jobId);
    chatSessionStore.upsert(chatId, {
      state: "executing",
      jobId,
      recent_agent_turns: [
        { agent_id: "builder", agent_name: "Builder", output: "Created a cleaner notebook draft." },
      ],
    });

    const card = buildChatStatusCard(chatId, null, { detail: "recent" });
    assert.match(card.text, /최근 작업/);
    assert.match(card.text, /steps queued/);
    assert.match(card.text, /Executed notebook smoke test/);
    assert.match(card.text, /Builder: Created a cleaner notebook draft/);
  } finally {
    chatSessionStore.clear(chatId);
    activeJobByChat.delete(chatId);
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});


test("chat status prompt view shows recent prompt telemetry and savings", () => {
  const chatId = "status-test-prompt";
  const created = jobs.createJob({ title: "job-status-prompt" });
  const jobId = created.jobId;
  const jobDir = created.dir;
  fs.writeFileSync(path.join(jobDir, 'prompt_metrics.jsonl'), [
    JSON.stringify({ ts: new Date().toISOString(), provider: 'codex', model: 'gpt-5-codex', agent_id: 'builder', actual_prompt_tokens: 900, baseline: { conversation_only_tokens: 10000, conversation_plus_shared_tokens: 20000 }, overlay: { overlay_id: 'agency:engineering/frontend-developer', overlay_title: 'Frontend Developer', tokens: 96, share_pct: 10.7 } }),
    JSON.stringify({ ts: new Date().toISOString(), provider: 'gemini', model: 'gemini-2.5-pro', agent_id: 'critic', actual_prompt_tokens: 1100, baseline: { conversation_only_tokens: 10000, conversation_plus_shared_tokens: 20000 } }),
  ].join('\n') + '\n', 'utf8');
  chatSessionStore.clear(chatId);
  activeJobByChat.delete(chatId);
  try {
    activeJobByChat.set(chatId, jobId);
    chatSessionStore.upsert(chatId, { state: 'executing', jobId });
    const card = buildChatStatusCard(chatId, null, { detail: 'prompt' });
    assert.match(card.text, /Prompt 상태/);
    assert.match(card.text, /avg_prompt_tokens:/);
    assert.match(card.text, /savings_vs_full:/);
    assert.match(card.text, /overlay_overhead_avg:/);
    assert.match(card.text, /overlay_memo:/);
    assert.match(card.text, /builder · codex\/gpt-5-codex/);
    assert.ok(card.reply_markup);
    assert.ok(card.reply_markup.inline_keyboard[0].some((button) => button.text === 'Prompt'));
  } finally {
    chatSessionStore.clear(chatId);
    activeJobByChat.delete(chatId);
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
});
