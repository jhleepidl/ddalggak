import fs from 'node:fs';
import path from 'node:path';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function cleanId(value = '') {
  return cleanLower(value).replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, '');
}

function uniq(values = [], { lower = true, max = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const entry of asArray(values)) {
    const text = clean(entry);
    if (!text) continue;
    const key = lower ? text.toLowerCase() : text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(lower ? key : text);
    if (out.length >= max) break;
  }
  return out;
}

function round1(value = 0) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function safeReadJson(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function safeReadJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function safeAppendJsonl(filePath = '', row = {}) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

function roleIdsFromRuntimeTeamSnapshot(runtimeTeamSnapshot = null) {
  const snapshot = asObject(runtimeTeamSnapshot);
  const runtimeAgents = asArray(snapshot.runtime_agents || snapshot.runtimeAgents);
  const executionGraph = asObject(snapshot.execution_graph || snapshot.executionGraph);
  const slotOrder = uniq(executionGraph.order || executionGraph.role_order || executionGraph.roleOrder || [], { lower: false, max: 16 });
  const slotToRole = new Map();
  for (const agent of runtimeAgents) {
    const slotId = clean(agent?.slot_id || agent?.slotId);
    const roleId = cleanLower(agent?.role_id || agent?.roleId || agent?.role_label || agent?.roleLabel);
    if (slotId && roleId) slotToRole.set(slotId, roleId);
  }
  const orderedRoles = [];
  if (slotOrder.length > 0) {
    for (const slotId of slotOrder) {
      const roleId = slotToRole.get(slotId);
      if (roleId) orderedRoles.push(roleId);
    }
  }
  if (orderedRoles.length > 0) return orderedRoles.slice(0, 8);
  return uniq(runtimeAgents.map((agent) => cleanLower(agent?.role_id || agent?.roleId || agent?.role_label || agent?.roleLabel)).filter(Boolean), { lower: true, max: 8 });
}

function buildDerivedMotifId(runtimeTeamSnapshot = null) {
  const snapshot = asObject(runtimeTeamSnapshot);
  const roles = roleIdsFromRuntimeTeamSnapshot(snapshot);
  if (roles.length === 0) return '';
  const executionGraph = asObject(snapshot.execution_graph || snapshot.executionGraph);
  const pattern = cleanLower(executionGraph.pattern || 'sequential') || 'sequential';
  return cleanId(`derived:${roles.join('-')}:${pattern}`);
}

function deriveMotifIds(plannerMetadata = null, runtimeTeamSnapshot = null) {
  const planner = asObject(plannerMetadata);
  const motifIds = uniq((planner.selected_motif_ids || planner.selectedMotifIds || []).map((entry) => cleanId(entry)), { lower: true, max: 16 });
  if (motifIds.length > 0) return motifIds;
  const derived = buildDerivedMotifId(runtimeTeamSnapshot);
  return derived ? [derived] : [];
}

function classifyRecommendation(row = {}) {
  const runs = Number(row.run_count || 0);
  const successRate = Number(row.success_rate_pct || 0);
  const participation = Number(row.avg_participation_pct || 0);
  const avgScore = Number(row.avg_score || 0);
  if (runs >= 2 && successRate >= 75 && participation >= 70 && avgScore >= 0.6) {
    return { recommendation: 'recommended', default_weight: 1.3 };
  }
  if (runs >= 2 && (successRate < 45 || avgScore < 0.2 || participation < 45)) {
    return { recommendation: 'discouraged', default_weight: 0.78 };
  }
  if (runs >= 1 && avgScore >= 0.55) {
    return { recommendation: 'promising', default_weight: 1.12 };
  }
  return { recommendation: 'neutral', default_weight: 1.0 };
}

export function buildTeamMotifFeedbackRecord({
  runId = '',
  goal = '',
  status = 'done',
  plannerMetadata = null,
  runtimeTeamSnapshot = null,
  executionInsights = null,
  executionFeedback = null,
} = {}) {
  const snapshot = asObject(runtimeTeamSnapshot);
  const planner = asObject(plannerMetadata || snapshot.team_plan?.planner_metadata || snapshot.team_plan?.plannerMetadata);
  const execution = asObject(executionInsights?.execution);
  const feedback = asObject(executionFeedback?.summary || executionFeedback);
  const patternFeedback = asObject(asArray(feedback.patterns)[0]);
  const executionGraph = asObject(snapshot.execution_graph || snapshot.executionGraph);
  const motifIds = deriveMotifIds(planner, snapshot);
  const roleIds = roleIdsFromRuntimeTeamSnapshot(snapshot);
  if (motifIds.length === 0 && roleIds.length === 0) return null;
  const participationPct = Number.isFinite(Number(execution.participation_pct || execution.participationPct))
    ? Number(execution.participation_pct || execution.participationPct)
    : (Number.isFinite(Number(patternFeedback.avg_participation_pct || patternFeedback.avgParticipationPct))
      ? Number(patternFeedback.avg_participation_pct || patternFeedback.avgParticipationPct)
      : 0);
  const completionRatePct = Number.isFinite(Number(patternFeedback.completion_rate_pct || patternFeedback.completionRatePct))
    ? Number(patternFeedback.completion_rate_pct || patternFeedback.completionRatePct)
    : (cleanLower(status) === 'done' ? 100 : 0);
  const outcomeScore = cleanLower(status) === 'done'
    ? 1
    : (cleanLower(status) === 'await_user' ? 0.55 : 0.15);
  const participationScore = Math.min(1, Math.max(0, participationPct / 100));
  const completionScore = Math.min(1, Math.max(0, completionRatePct / 100));
  const score = round1((outcomeScore * 0.5) + (participationScore * 0.25) + (completionScore * 0.25));
  return {
    ts: new Date().toISOString(),
    run_id: clean(runId) || undefined,
    goal_excerpt: clean(goal).slice(0, 280) || undefined,
    status: cleanLower(status) || 'done',
    motif_ids: motifIds,
    pattern: cleanLower(executionGraph.pattern || patternFeedback.execution_pattern || 'sequential') || 'sequential',
    role_ids: roleIds,
    task_type: cleanLower(snapshot.task_interpretation?.task_type || snapshot.task_interpretation?.taskType || '') || undefined,
    deliverable_type: cleanLower(snapshot.task_interpretation?.deliverable_type || snapshot.task_interpretation?.deliverableType || '') || undefined,
    participation_pct: participationPct,
    completion_rate_pct: completionRatePct,
    planned_agent_count: Number(execution.planned_agent_count || execution.plannedAgentCount || 0),
    observed_agent_count: Number(execution.observed_agent_count || execution.observedAgentCount || 0),
    score,
    selected_motif_ids: uniq((planner.selected_motif_ids || planner.selectedMotifIds || []).map((entry) => cleanId(entry)), { lower: true, max: 16 }),
  };
}

export function summarizeTeamMotifFeedback(records = []) {
  const rows = asArray(records).filter((row) => row && typeof row === 'object');
  const motifs = new Map();
  for (const row of rows) {
    const motifIds = uniq(row.motif_ids || row.selected_motif_ids || [], { lower: true, max: 16 });
    const roleIds = uniq(row.role_ids || [], { lower: true, max: 12 });
    for (const motifId of motifIds) {
      const current = motifs.get(motifId) || {
        motif_id: motifId,
        pattern: cleanLower(row.pattern || 'sequential') || 'sequential',
        role_ids: roleIds,
        task_types: [],
        deliverable_types: [],
        run_count: 0,
        success_count: 0,
        await_user_count: 0,
        error_count: 0,
        total_participation_pct: 0,
        total_completion_rate_pct: 0,
        total_score: 0,
        last_goal_excerpt: undefined,
      };
      current.run_count += 1;
      const status = cleanLower(row.status);
      if (status === 'done') current.success_count += 1;
      else if (status === 'await_user') current.await_user_count += 1;
      else current.error_count += 1;
      current.total_participation_pct += Number(row.participation_pct || 0);
      current.total_completion_rate_pct += Number(row.completion_rate_pct || 0);
      current.total_score += Number(row.score || 0);
      current.last_goal_excerpt = clean(row.goal_excerpt) || current.last_goal_excerpt;
      current.role_ids = current.role_ids.length > 0 ? current.role_ids : roleIds;
      const taskType = cleanLower(row.task_type || '');
      const deliverableType = cleanLower(row.deliverable_type || '');
      if (taskType && !current.task_types.includes(taskType)) current.task_types.push(taskType);
      if (deliverableType && !current.deliverable_types.includes(deliverableType)) current.deliverable_types.push(deliverableType);
      motifs.set(motifId, current);
    }
  }

  const motifRows = Array.from(motifs.values())
    .map((row) => {
      const avgScore = row.run_count > 0 ? round1(row.total_score / row.run_count) : 0;
      const avgParticipation = row.run_count > 0 ? round1(row.total_participation_pct / row.run_count) : 0;
      const avgCompletion = row.run_count > 0 ? round1(row.total_completion_rate_pct / row.run_count) : 0;
      const successRate = row.run_count > 0 ? round1((row.success_count / row.run_count) * 100) : 0;
      const recommendation = classifyRecommendation({
        run_count: row.run_count,
        success_rate_pct: successRate,
        avg_participation_pct: avgParticipation,
        avg_score: avgScore,
      });
      return {
        motif_id: row.motif_id,
        pattern: row.pattern,
        role_ids: row.role_ids,
        task_types: row.task_types.slice(0, 8),
        deliverable_types: row.deliverable_types.slice(0, 8),
        run_count: row.run_count,
        success_count: row.success_count,
        await_user_count: row.await_user_count,
        error_count: row.error_count,
        success_rate_pct: successRate,
        avg_participation_pct: avgParticipation,
        avg_completion_rate_pct: avgCompletion,
        avg_score: avgScore,
        recommendation: recommendation.recommendation,
        default_weight: recommendation.default_weight,
        last_goal_excerpt: row.last_goal_excerpt,
      };
    })
    .sort((a, b) => (b.avg_score - a.avg_score) || (b.run_count - a.run_count) || String(a.motif_id || '').localeCompare(String(b.motif_id || '')));

  const stableMotifs = motifRows.filter((row) => row.recommendation === 'recommended').slice(0, 12);
  const candidateMotifs = motifRows.filter((row) => row.recommendation === 'recommended' || row.recommendation === 'promising').slice(0, 12);
  return {
    updated_at: new Date().toISOString(),
    run_count: rows.length,
    motifs: motifRows,
    recommended_motifs: candidateMotifs,
    stable_motifs: stableMotifs,
    candidate_motifs: candidateMotifs,
    discouraged_motifs: motifRows.filter((row) => row.recommendation === 'discouraged').slice(0, 12),
    channels: {
      stable: {
        channel: 'stable',
        motifs: stableMotifs,
      },
      candidate: {
        channel: 'candidate',
        motifs: candidateMotifs,
      },
    },
  };
}

export function motifFeedbackPaths({ runsDir = '', jobDir = '' } = {}) {
  const cleanRunsDir = clean(runsDir);
  const cleanJobDir = clean(jobDir);
  return {
    globalJsonl: cleanRunsDir ? path.join(cleanRunsDir, 'team_motif_feedback.jsonl') : '',
    globalSummary: cleanRunsDir ? path.join(cleanRunsDir, 'team_motif_feedback_summary.json') : '',
    jobJsonl: cleanJobDir ? path.join(cleanJobDir, 'team_motif_feedback.jsonl') : '',
    jobSummary: cleanJobDir ? path.join(cleanJobDir, 'team_motif_feedback_summary.json') : '',
  };
}

export function loadTeamMotifFeedbackSummary({ runsDir = '', jobDir = '' } = {}) {
  const paths = motifFeedbackPaths({ runsDir, jobDir });
  return safeReadJson(paths.jobSummary) || safeReadJson(paths.globalSummary) || null;
}

export function recordTeamMotifFeedback({
  runsDir = '',
  jobDir = '',
  runId = '',
  goal = '',
  status = 'done',
  plannerMetadata = null,
  runtimeTeamSnapshot = null,
  executionInsights = null,
  executionFeedback = null,
} = {}) {
  const record = buildTeamMotifFeedbackRecord({
    runId,
    goal,
    status,
    plannerMetadata,
    runtimeTeamSnapshot,
    executionInsights,
    executionFeedback,
  });
  if (!record) return null;
  const paths = motifFeedbackPaths({ runsDir, jobDir });
  if (paths.jobJsonl) {
    safeAppendJsonl(paths.jobJsonl, record);
    const jobSummary = summarizeTeamMotifFeedback(safeReadJsonl(paths.jobJsonl));
    try {
      fs.writeFileSync(paths.jobSummary, JSON.stringify(jobSummary, null, 2), 'utf8');
    } catch {}
  }
  let globalSummary = null;
  if (paths.globalJsonl) {
    safeAppendJsonl(paths.globalJsonl, record);
    globalSummary = summarizeTeamMotifFeedback(safeReadJsonl(paths.globalJsonl));
    try {
      fs.writeFileSync(paths.globalSummary, JSON.stringify(globalSummary, null, 2), 'utf8');
    } catch {}
  }
  return {
    record,
    summary: globalSummary || (paths.jobSummary ? safeReadJson(paths.jobSummary) : null),
  };
}
