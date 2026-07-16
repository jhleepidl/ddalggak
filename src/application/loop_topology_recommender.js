function clean(value = '') { return String(value || '').replace(/\s+/g, ' ').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }

function priorStats(priorRuns = []) {
  const rows = asArray(priorRuns).map((row) => row?.state || row).filter(Boolean);
  const byTopology = {};
  for (const state of rows) {
    const topology = clean(state.spec?.topology?.topology_id || 'unknown');
    const bucket = byTopology[topology] || { runs: 0, completed: 0, failures: 0, blocking_found: 0, resolved: 0, calls: 0, revisions: 0 };
    bucket.runs += 1;
    if (state.status === 'completed') bucket.completed += 1;
    bucket.failures += Number(state.counters?.failures || 0);
    bucket.blocking_found += Number(state.counters?.blocking_issues || 0);
    bucket.resolved += Number(state.counters?.resolved_issues || 0);
    bucket.calls += Number(state.counters?.model_calls || 0);
    bucket.revisions += Number(state.counters?.revisions || 0);
    byTopology[topology] = bucket;
  }
  return byTopology;
}

export function recommendLoopTopology({ taskText = '', workflowContract = null, priorRuns = [], risk = 0, userPreference = '' } = {}) {
  const text = clean(taskText).toLowerCase();
  const workflowKind = clean(workflowContract?.workflow_kind || workflowContract?.workflowKind).toLowerCase();
  const scores = { solo: 0.25, review_loop: 0.35, deliberation: 0.15 };
  const reasons = [];

  if (workflowKind === 'bounded_continuous_loop' || workflowKind === 'review_gated_pipeline') {
    scores.review_loop += 0.55;
    reasons.push('workflow_requires_review_or_iteration');
  }
  if (workflowKind === 'explore_then_synthesize') {
    scores.deliberation += 0.6;
    reasons.push('workflow_requires_exploration_and_synthesis');
  }
  if (/구현|코드|패치|리팩터|버그|테스트|배포|implementation|code|patch|refactor|bug|test/.test(text)) {
    scores.review_loop += 0.35;
    reasons.push('engineering_task_benefits_from_independent_review');
  }
  if (/토론|찬반|대안|비교|의견|전략|의사결정|debate|tradeoff|alternative|strategy/.test(text)) {
    scores.deliberation += 0.4;
    reasons.push('multiple_reasonable_positions_detected');
  }
  if (/간단|짧게|빠르게|단순|simple|quick|brief/.test(text)) {
    scores.solo += 0.4;
    reasons.push('user_signaled_low_execution_depth');
  }
  if (Number(risk || 0) >= 0.55 || /고위험|중요|보안|금융|법률|삭제|운영 반영|high risk|security|production/.test(text)) {
    scores.review_loop += 0.35;
    scores.deliberation += 0.15;
    reasons.push('risk_requires_independent_check');
  }
  const preference = clean(userPreference).toLowerCase();
  if (['solo', 'review_loop', 'deliberation'].includes(preference)) {
    scores[preference] += 0.5;
    reasons.push(`user_preference_${preference}`);
  }

  const stats = priorStats(priorRuns);
  for (const topology of ['solo', 'review_loop', 'deliberation']) {
    const row = stats[topology];
    if (!row?.runs) continue;
    const completionRate = row.completed / row.runs;
    const defectYield = row.blocking_found / Math.max(1, row.runs);
    const resolutionRate = row.resolved / Math.max(1, row.blocking_found);
    const meanCalls = row.calls / row.runs;
    scores[topology] += clamp(completionRate, 0, 1) * 0.18;
    if (topology !== 'solo') scores[topology] += clamp(defectYield / 2, 0, 1) * 0.12 * clamp(resolutionRate, 0.2, 1);
    if (meanCalls > 8) scores[topology] -= 0.08;
  }

  const ranking = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topology, topScore] = ranking[0];
  const margin = topScore - ranking[1][1];
  const confidence = clamp(0.5 + margin / 2, 0.5, 0.95);
  return {
    kind: 'loop_topology_recommendation_v1',
    topology_id: topology,
    confidence: Math.round(confidence * 1000) / 1000,
    auto_apply: confidence >= 0.62,
    scores: Object.fromEntries(Object.entries(scores).map(([key, value]) => [key, Math.round(value * 1000) / 1000])),
    reasons,
    alternatives: ranking.slice(1).map(([id, score]) => ({ topology_id: id, score: Math.round(score * 1000) / 1000 })),
    history_used: asArray(priorRuns).length,
  };
}

export function formatLoopTopologyRecommendation(rec = {}) {
  const labels = { solo: 'Solo', review_loop: 'Review Loop', deliberation: 'Deliberate and Adjudicate' };
  return [
    `권장 topology: ${labels[rec.topology_id] || rec.topology_id || 'review_loop'}`,
    `confidence: ${Math.round(Number(rec.confidence || 0) * 100)}%`,
    rec.history_used ? `history: prior loop ${rec.history_used}개 반영` : 'history: 초기 규칙 기반 추천',
    rec.reasons?.length ? `근거: ${rec.reasons.slice(0, 4).join(', ')}` : '',
  ].filter(Boolean).join('\n');
}

export default { recommendLoopTopology, formatLoopTopologyRecommendation };
