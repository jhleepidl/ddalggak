import { clip } from '../textutil.js';
import {
  formatChatAgentDisplayName,
  resolveActionAgentId,
  resolveActionAgentNameHint,
} from '../shared/agent_labels.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value = '', { lower = false, maxLen = 240 } = {}) {
  const text = String(value || '').trim();
  if (!text) return '';
  const clipped = text.length > maxLen ? text.slice(0, maxLen) : text;
  return lower ? clipped.toLowerCase() : clipped;
}

function actionType(action = {}) {
  return cleanText(action?.type, { lower: true, maxLen: 64 });
}

function isAgentActionType(type = '') {
  return ['run_agent', 'agent_run', 'synthesize_final'].includes(cleanText(type, { lower: true, maxLen: 64 }));
}

const BACKEND_ONLY_ACTION_TYPES = new Set([
  'checkpoint',
  'supervisor_decision',
  'gate_wait',
  'human_checkpoint',
  'tool_proxy_call',
  'memory_sync',
  'committee_consensus',
  'summarize',
]);

const SELF_IMPROVE_TYPES = new Set([
  'improve',
  'self_improve',
  'patch_cmd',
  'review_report',
  'eval_gate',
  'rollback_report',
]);

function actionGoal(action = {}) {
  const inputs = asObject(action?.inputs);
  return cleanText(
    action?.goal || action?.prompt || action?.task || action?.summary || inputs.goal || inputs.prompt || '',
    { maxLen: 280 },
  );
}

function agentRole(action = {}) {
  const inputs = asObject(action?.inputs);
  return cleanText(
    inputs.role_id || inputs.roleId || action?.role_id || action?.roleId || '',
    { lower: true, maxLen: 64 },
  );
}

function providerKey(action = {}) {
  const inputs = asObject(action?.inputs);
  return cleanText(inputs.provider || action?.provider || '', { lower: true, maxLen: 64 });
}

function modelKey(action = {}) {
  const inputs = asObject(action?.inputs);
  return cleanText(inputs.model || action?.model || '', { maxLen: 96 });
}

function isReviewerLike(action = {}) {
  const role = agentRole(action);
  const agentId = cleanText(resolveActionAgentId(action), { lower: true, maxLen: 96 });
  const label = cleanText(resolveActionAgentNameHint(action), { lower: true, maxLen: 120 });
  return [role, agentId, label].some((value) => /review|critic|skeptic|검토|리뷰|비평/.test(value));
}

function isBuilderLike(action = {}) {
  const role = agentRole(action);
  const agentId = cleanText(resolveActionAgentId(action), { lower: true, maxLen: 96 });
  const label = cleanText(resolveActionAgentNameHint(action), { lower: true, maxLen: 120 });
  return [role, agentId, label].some((value) => /build|coder|codex|implement|builder|구현|코더/.test(value));
}

function makeAgentLabel(action = {}, agentIndex = new Map()) {
  const id = cleanText(resolveActionAgentId(action), { lower: true, maxLen: 96 });
  const nameHint = resolveActionAgentNameHint(action);
  if (!id && !nameHint) return '';
  return formatChatAgentDisplayName(id || nameHint, agentIndex, { nameHint, fallbackLabel: 'Agent' });
}

function flattenActionActors(actions = [], agentIndex = new Map()) {
  const actors = [];
  const systemActions = [];
  const visit = (action = {}, { parentType = '', parallel = false } = {}) => {
    const type = actionType(action);
    if (!type) return;
    if (type === 'spawn_agents' || type === 'spawn_parallel') {
      const children = asArray(action?.agents);
      for (const child of children) visit(child, { parentType: type, parallel: true });
      if (children.length === 0) systemActions.push({ type, goal: actionGoal(action), parentType, parallel });
      return;
    }
    if (isAgentActionType(type)) {
      const label = makeAgentLabel(action, agentIndex);
      const id = cleanText(resolveActionAgentId(action), { lower: true, maxLen: 96 }) || label;
      actors.push({
        id,
        label: label || id || 'Agent',
        role: agentRole(action),
        provider: providerKey(action),
        model: modelKey(action),
        goal: actionGoal(action),
        type,
        parentType,
        parallel,
        reviewer: isReviewerLike(action),
        builder: isBuilderLike(action),
        finalSynthesis: type === 'synthesize_final',
      });
      return;
    }
    systemActions.push({ type, goal: actionGoal(action), parentType, parallel });
  };
  for (const action of asArray(actions)) visit(action);
  return { actors, systemActions };
}

function uniqueActors(actors = []) {
  const out = [];
  const seen = new Set();
  for (const actor of asArray(actors)) {
    const key = cleanText(actor.id || actor.label, { lower: true, maxLen: 160 });
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(actor);
  }
  return out;
}

function inferPattern(actors = [], systemActions = []) {
  const unique = uniqueActors(actors);
  const hasParallel = actors.some((actor) => actor.parallel) || systemActions.some((action) => action.type === 'spawn_parallel' || action.type === 'spawn_agents');
  const hasReviewer = actors.some((actor) => actor.reviewer);
  const hasBuilder = actors.some((actor) => actor.builder);
  const hasSynth = actors.some((actor) => actor.finalSynthesis);
  if (hasParallel && hasReviewer) return 'parallel + review';
  if (hasParallel) return 'parallel fan-out';
  if (hasBuilder && hasReviewer && hasSynth) return 'build → review → synthesize';
  if (hasBuilder && hasReviewer) return 'build → review';
  if (unique.length > 1) return 'sequential handoff';
  if (unique.length === 1) return 'single-agent fast path';
  return 'system-only';
}

function inferIndependentReview(actors = []) {
  const builders = actors.filter((actor) => actor.builder);
  const reviewers = actors.filter((actor) => actor.reviewer);
  if (builders.length === 0 || reviewers.length === 0) return { status: 'not_applicable', label: '' };
  for (const builder of builders) {
    for (const reviewer of reviewers) {
      if (builder.provider && reviewer.provider && builder.provider !== reviewer.provider) {
        return { status: 'independent_provider', label: `${builder.provider} → ${reviewer.provider}` };
      }
      if (builder.model && reviewer.model && builder.model !== reviewer.model) {
        return { status: 'independent_model', label: `${builder.model} → ${reviewer.model}` };
      }
    }
  }
  return { status: 'same_or_unknown', label: '' };
}

function visibleValue(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function buildAgencyFocusSummary({
  actions = [],
  agentIndex = new Map(),
  routeReason = '',
  routeReadiness = '',
} = {}) {
  const { actors, systemActions } = flattenActionActors(actions, agentIndex);
  const unique = uniqueActors(actors);
  const backendOnlyCount = systemActions.filter((action) => BACKEND_ONLY_ACTION_TYPES.has(action.type)).length;
  const selfImproveCount = systemActions.filter((action) => SELF_IMPROVE_TYPES.has(action.type)).length;
  const pattern = inferPattern(actors, systemActions);
  const independentReview = inferIndependentReview(actors);
  const reviewerCount = unique.filter((actor) => actor.reviewer).length;
  const userVisibleAgentCount = unique.length;
  const communicationVisible = userVisibleAgentCount > 1 || reviewerCount > 0 || pattern !== 'single-agent fast path';
  const focusStatus = selfImproveCount > 0 || backendOnlyCount > userVisibleAgentCount + 2
    ? 'needs_compaction'
    : 'agency_first';
  const participantLabels = unique.map((actor) => actor.label).filter(Boolean).slice(0, 5);
  const overflow = Math.max(0, unique.length - participantLabels.length);
  const routeReasonText = visibleValue(routeReason);
  const readinessText = visibleValue(routeReadiness);

  const lines = [
    `- 협업 방식: ${pattern}`,
    `- 참여 agent: ${participantLabels.join(', ') || '(none)'}${overflow > 0 ? ` 외 ${overflow}` : ''}`,
  ];
  if (reviewerCount > 0) {
    lines.push(`- 리뷰 구조: ${reviewerCount} reviewer${independentReview.label ? ` · ${independentReview.label}` : ''}`);
  } else if (userVisibleAgentCount > 1) {
    lines.push('- 리뷰 구조: 명시 reviewer 없음');
  }
  if (backendOnlyCount > 0) lines.push(`- 숨긴 내부 단계: ${backendOnlyCount}`);
  if (readinessText) lines.push(`- 준비 상태: ${clip(readinessText, 120)}`);
  if (routeReasonText) lines.push(`- 선택 근거: ${clip(routeReasonText, 160)}`);

  return {
    pattern,
    focus_status: focusStatus,
    communication_visible: communicationVisible,
    user_visible_agent_count: userVisibleAgentCount,
    reviewer_count: reviewerCount,
    backend_only_count: backendOnlyCount,
    self_improve_overhead_count: selfImproveCount,
    independent_review: independentReview.status,
    independent_review_label: independentReview.label,
    participant_labels: participantLabels,
    lines,
  };
}

export function buildAgencyFocusLines(options = {}) {
  return buildAgencyFocusSummary(options).lines;
}
