import { computeProjectionStress } from './projection_stress.js';

function cleanText(value = '') {
  return String(value || '').trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function countMatches(text, patterns = []) {
  return patterns.reduce((sum, pattern) => sum + (pattern.test(text) ? 1 : 0), 0);
}

function maybePush(out, condition, item) {
  if (condition) out.push(item);
}

export function scoreTaskAutonomy({
  userText = '',
  availableAgents = 1,
  attachedSkills = [],
  traceStats = {},
  recentFailures = 0,
  memoryStats = {},
  projectionContext = {},
} = {}) {
  const text = cleanText(userText);
  const lower = text.toLowerCase();
  const reasons = [];
  let score = 0;

  const length = text.length;
  const deliverableHints = countMatches(lower, [
    /그리고|동시에|각각|비교|검토|리뷰|구현|패치|테스트|검색|정리|요약/g,
    /and|compare|review|implement|patch|test|search|summarize/g,
  ]);
  const externalInfo = /검색|찾아|주변|최신|가격|일정|예약|주문|배달|api|웹|근처|nearby|latest|search|order|delivery/i.test(text);
  const skillNeed = /skill|스킬|도구|tool|api|검색|다운로드|설치|탑재|사용해/i.test(text);
  const memoryNeed = /기억|기록|저장|선호|이력|앞으로|계속|매번|remember|preference|history|log/i.test(text);
  const sideEffect = /예약|구매|주문|전송|삭제|수정|배포|commit|promote|install|delete|send|book|buy|order/i.test(text);
  const implementation = /코드|구현|패치|수정|테스트|버그|에러|stack|trace|repo|파일|zip|diff|code|patch|bug|error/i.test(text);
  const ambiguity = /어떻게|가능|추천|설계|전략|고민|분석|maybe|should|가능할까/i.test(text);

  if (length > 220) { score += 1; reasons.push('long_request'); }
  if (length > 600) { score += 1; reasons.push('very_long_request'); }
  if (deliverableHints >= 2) { score += 1; reasons.push('multiple_deliverable_hints'); }
  if (externalInfo) { score += 1; reasons.push('external_info_or_search'); }
  if (skillNeed) { score += 1; reasons.push('skill_or_tool_needed'); }
  if (memoryNeed) { score += 1; reasons.push('typed_memory_needed'); }
  if (sideEffect) { score += 1; reasons.push('side_effect_or_install_risk'); }
  if (implementation) { score += 1; reasons.push('implementation_or_debugging'); }
  if (ambiguity && (externalInfo || implementation || memoryNeed)) { score += 1; reasons.push('ambiguous_complex_work'); }

  const promptChars = Number(traceStats.prompt_chars || traceStats.promptChars || 0);
  const traceCount = Number(traceStats.trace_count || traceStats.traceCount || 0);
  if (promptChars > 30000) { score += 1; reasons.push('prompt_pressure'); }
  if (promptChars > 80000) { score += 1; reasons.push('high_prompt_pressure'); }
  if (traceCount > 8) { score += 1; reasons.push('many_model_calls'); }
  if (Number(recentFailures || 0) > 0) { score += 1; reasons.push('recent_failure'); }

  const memoryBytes = Number(memoryStats.bytes || memoryStats.total_bytes || 0);
  const memoryFiles = Number(memoryStats.files || memoryStats.file_count || 0);
  if (memoryBytes > 250000 || memoryFiles > 40) { score += 1; reasons.push('memory_pressure'); }

  const projectionStress = computeProjectionStress({
    ...projectionContext,
    promptChars: projectionContext.promptChars || projectionContext.prompt_chars || promptChars,
  });
  const projectionScore = Number(projectionStress.score || 0);
  const projectionScoreBoost = projectionScore >= 8.5 ? 5
    : projectionScore >= 5 ? 5
      : projectionScore >= 3 ? 3
        : projectionScore >= 1.5 ? 4
          : 0;
  if (projectionScoreBoost > 0) {
    score += projectionScoreBoost;
    reasons.push('projection_stress');
    for (const reason of projectionStress.reasons || []) reasons.push(`psi_${reason}`);
  }

  const agentCount = Math.max(1, Math.floor(Number(availableAgents || 1)));
  const skillCount = asArray(attachedSkills).length;
  const projectionSkillNeed = (projectionStress.reasons || []).includes('missing_skill_pressure')
    || (projectionStress.reasons || []).includes('active_artifact_context');
  let mode = 'single';
  if (score >= 7 && agentCount >= 3) mode = 'multi';
  else if (score >= 5 && agentCount >= 2) mode = 'hybrid';
  else if (score >= 4 && (skillNeed || projectionSkillNeed || skillCount > 0)) mode = 'single_with_skill';
  else mode = 'single';

  return {
    score: clamp(score, 0, 12),
    mode,
    reasons: [...new Set(reasons)],
    projection_stress: projectionStress,
    thresholds: {
      single_with_skill: 4,
      hybrid: 5,
      multi: 7,
    },
  };
}

export function inferTypedMemoryNeeds({ userText = '', currentTaskKind = '' } = {}) {
  const text = cleanText(userText);
  const slots = [];
  maybePush(slots, /기억|기록|저장|먹었|섭취|운동|수면|지출|일정|방문|로그|history|log|record/i.test(text), {
    slot: 'event_log',
    operation: 'append',
    reason: 'user_supplied_record_or_history',
  });
  maybePush(slots, /좋아|싫어|선호|취향|알레르기|avoid|prefer|preference|like|dislike/i.test(text), {
    slot: 'user_preferences',
    operation: 'upsert',
    reason: 'preference_signal',
  });
  maybePush(slots, /목표|계획|프로젝트|작업|마감|요구사항|goal|project|deadline|requirement/i.test(text), {
    slot: 'project_state',
    operation: 'upsert',
    reason: 'project_or_goal_state',
  });
  maybePush(slots, /결정|정했|취소|변경|승인|거절|approve|reject|decision|changed/i.test(text), {
    slot: 'decisions',
    operation: 'append',
    reason: 'decision_or_change_signal',
  });
  maybePush(slots, /skill|스킬|도구|tool|api|credential|토큰|키/i.test(text), {
    slot: 'capability_registry',
    operation: 'propose',
    reason: 'capability_or_skill_signal',
  });
  if (slots.length === 0 && currentTaskKind) {
    slots.push({ slot: 'task_notes', operation: 'append', reason: `fallback_for_${currentTaskKind}` });
  }
  return {
    slots,
    shouldWriteTypedMemory: slots.length > 0,
  };
}

export function shouldRunIdleMaintenance({
  lastActivityAt = '',
  now = new Date(),
  runStats = {},
  minIdleMinutes = 20,
} = {}) {
  const ts = Date.parse(String(lastActivityAt || ''));
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const idleMinutes = Number.isFinite(ts) && Number.isFinite(nowMs)
    ? Math.max(0, Math.floor((nowMs - ts) / 60000))
    : 0;
  const promptChars = Number(runStats.prompt_chars || runStats.promptChars || 0);
  const eventCount = Number(runStats.event_count || runStats.eventCount || 0);
  const memoryBytes = Number(runStats.memory_bytes || runStats.memoryBytes || 0);
  const traceCount = Number(runStats.trace_count || runStats.traceCount || 0);
  const pressure = (
    (promptChars > 30000 ? 1 : 0)
    + (promptChars > 80000 ? 1 : 0)
    + (eventCount > 80 ? 1 : 0)
    + (memoryBytes > 250000 ? 1 : 0)
    + (traceCount > 10 ? 1 : 0)
  );
  return {
    due: idleMinutes >= Number(minIdleMinutes || 20) && pressure > 0,
    idle_minutes: idleMinutes,
    pressure_score: pressure,
    recommended_actions: pressure > 0 ? [
      'summarize_recent_turns_to_typed_memory',
      'deduplicate_role_summaries',
      'compact_prompt_surfaces_preserving_latest_tail',
      'publish_gc_report_to_goc',
    ] : [],
  };
}
