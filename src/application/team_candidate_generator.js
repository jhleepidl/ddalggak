import { inferUserOrchestrationIntent, summarizeUserOrchestrationIntent, candidateSatisfiesUserOrchestrationIntent } from './team_user_orchestration_intent.js';
import { summarizeTaskAttemptPlan, candidateSatisfiesTaskAttempt } from './task_attempt_planner.js';
import { summarizeMemoryImportIntent } from './team_memory_import_intent.js';
import { summarizeWorkModeConfig, rolesForWorkMode, candidateSatisfiesWorkMode } from './work_mode.js';
import { buildTeamMotifRegistry } from './team_motif_registry.js';

function asArray(value) { return Array.isArray(value) ? value : []; }
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function clean(value = '') { return String(value || '').trim(); }
function cleanId(value = '') { return clean(value).toLowerCase().replace(/[^a-z0-9_:\-]+/g, '_').replace(/^_+|_+$/g, ''); }

function uniq(values = [], max = 16) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function inferRequiresFromMotif(motif = {}, stress = {}) {
  const roles = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
  const tags = uniq([...(motif.coverage_tags || []), ...(motif.task_types || [])], 16);
  const requires = {};
  if (roles.includes('builder') || Number(stress.workspace_mutation || 0) >= 0.6) requires.workspace_write = true;
  if (roles.includes('reviewer') || Number(stress.verification_need || 0) >= 0.65) requires.verifier = true;
  if (Number(stress.current_info_need || 0) >= 0.7 || tags.includes('evidence')) requires.web_browse = false;
  if (Number(stress.artifact_pressure || 0) >= 0.55 || tags.includes('implementation')) requires.artifact_delivery = true;
  return requires;
}

function motifMatchesStress(motif = {}, stress = {}, request = '') {
  const roles = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
  const tags = uniq([...(motif.coverage_tags || []), ...(motif.task_types || [])], 16);
  const text = clean(request).toLowerCase();
  let score = Number(motif.default_weight || 1);
  if (roles.includes('builder') && (Number(stress.artifact_pressure || 0) >= 0.35 || Number(stress.workspace_mutation || 0) >= 0.35)) score += 0.6;
  if (roles.includes('reviewer') && Number(stress.verification_need || 0) >= 0.4) score += 0.35;
  if (roles.includes('researcher') && Number(stress.current_info_need || 0) >= 0.35) score += 0.3;
  if (roles.length === 1 && Number(stress.overall || 0) < 0.35) score += 0.45;
  if (roles.length >= 4 && Number(stress.overall || 0) < 0.35) score -= 0.45;
  for (const tag of tags) {
    if (tag && text.includes(tag.replace(/_/g, ' '))) score += 0.08;
  }
  return score;
}

function rolesForTargetTeam(targetTeam = 'general') {
  const target = cleanId(targetTeam || 'general');
  if (target === 'coding') return ['researcher', 'builder', 'reviewer'];
  if (target === 'paper') return ['researcher', 'synthesizer', 'reviewer'];
  if (target === 'presentation') return ['researcher', 'synthesizer', 'reviewer'];
  if (target === 'review') return ['reviewer', 'synthesizer'];
  return ['researcher', 'synthesizer'];
}

function buildTaskAttemptCandidateBlueprints({ request = '', stress = {}, taskAttemptPlan = null } = {}) {
  const plan = summarizeTaskAttemptPlan(taskAttemptPlan || {});
  const memory = summarizeMemoryImportIntent(plan.memory_import || {});
  const targetTeam = cleanId(plan.target_team || memory.target_team || 'general') || 'general';
  const shouldBuild = ['branch', 'parallel_branch'].includes(plan.run_mode) || targetTeam !== 'general' || memory.import_intent !== 'none';
  if (!shouldBuild) return [];
  const roles = rolesForTargetTeam(targetTeam);
  const roleSlots = roles.map((role, index) => ({
    slot_id: `attempt_${targetTeam}_${role}_${index + 1}`,
    role_id: role,
    label: role,
    purpose: `${targetTeam} attempt role using ${memory.projection_profile || 'general'} memory projection`,
  }));
  const labelMap = {
    coding: 'GoC branch: coding team',
    paper: 'GoC branch: paper-writing team',
    presentation: 'GoC branch: presentation team',
    review: 'GoC branch: review team',
    general: 'GoC branch: general team',
  };
  const pattern = targetTeam === 'coding' ? 'sequential' : (targetTeam === 'review' ? 'debate' : 'sequential');
  return [{
    candidate_id: cleanId(`attempt:${plan.run_mode}:${targetTeam}:${memory.projection_profile}`),
    source: 'task_attempt_branch',
    motif_id: cleanId(`attempt_${targetTeam}_${plan.run_mode}`),
    label: labelMap[targetTeam] || 'GoC branch attempt team',
    pattern,
    role_slots: roleSlots,
    roles,
    target_team: targetTeam,
    memory_import_intent: memory,
    task_attempt_plan: plan,
    previous_result_policy: plan.previous_result_policy,
    tags: uniq([
      'task_attempt', `run_mode_${plan.run_mode}`, `target_${targetTeam}`,
      `mem_profile_${memory.projection_profile}`, `prev_result_${plan.previous_result_policy}`,
      ...plan.reason_codes,
    ], 16),
    task_types: uniq([targetTeam === 'coding' ? 'implementation' : (targetTeam === 'paper' ? 'writing' : targetTeam)], 4),
    coordination_cost: Math.max(1, roles.length - 1),
    prior_weight: plan.run_mode === 'branch' || plan.run_mode === 'parallel_branch' ? 2.45 : 1.75,
    default_weight: 1.7,
    requires: {
      verifier: roles.includes('reviewer'),
      workspace_write: targetTeam === 'coding' && Number(stress.workspace_mutation || 0) >= 0.25,
      artifact_delivery: ['coding', 'paper', 'presentation'].includes(targetTeam),
    },
    task_attempt_satisfaction: { satisfied: true, reason: 'target_team_satisfied', target_team: targetTeam, candidate_target_team: targetTeam },
  }];
}


function buildWorkModeCandidateBlueprints({ request = '', stress = {}, taskAttemptPlan = null } = {}) {
  const plan = summarizeTaskAttemptPlan(taskAttemptPlan || {});
  const workMode = summarizeWorkModeConfig(plan.work_mode || {});
  const mode = cleanId(workMode.work_mode || 'quick_answer');
  if (!['team_review', 'project_task', 'research_campaign', 'customize'].includes(mode)) return [];
  const targetTeam = cleanId(plan.target_team || plan.memory_import?.target_team || 'general') || 'general';
  const roles = rolesForWorkMode(mode, { request, targetTeam });
  const roleSlots = roles.map((role, index) => ({
    slot_id: `work_${mode}_${role}_${index + 1}`,
    role_id: role,
    label: role,
    purpose: `${workMode.label || mode} role for bounded observable work cycle`,
  }));
  const labelMap = {
    team_review: 'Work Mode: team review',
    project_task: 'Work Mode: project task team',
    research_campaign: 'Work Mode: staged research campaign',
    customize: 'Work Mode: custom governed team',
  };
  const pattern = mode === 'research_campaign' ? 'staged' : (mode === 'team_review' ? 'sequential' : 'sequential');
  return [{
    candidate_id: cleanId(`work_mode:${mode}:${targetTeam}:${roles.join('_')}`),
    source: 'work_mode',
    motif_id: cleanId(`work_mode_${mode}`),
    label: labelMap[mode] || 'Work Mode team',
    pattern,
    role_slots: roleSlots,
    roles,
    work_mode: workMode,
    task_attempt_plan: plan,
    memory_import_intent: summarizeMemoryImportIntent(plan.memory_import || {}),
    target_team: targetTeam !== 'general' ? targetTeam : undefined,
    previous_result_policy: plan.previous_result_policy,
    tags: uniq([
      'work_mode', `work_mode_${mode}`, `loop_budget_${workMode.loop_budget}`,
      `review_${workMode.review_policy}`, `memory_mode_${workMode.memory_mode}`, `goc_${workMode.goc_mode}`,
      targetTeam !== 'general' ? `target_${targetTeam}` : '',
      ...workMode.reason_codes,
    ], 16),
    task_types: uniq([mode === 'research_campaign' ? 'research' : (targetTeam === 'coding' ? 'implementation' : mode)], 4),
    coordination_cost: Math.max(1, roles.length - 1),
    prior_weight: mode === 'research_campaign' ? 2.8 : (mode === 'project_task' ? 2.55 : 2.25),
    default_weight: 1.8,
    requires: {
      verifier: roles.includes('reviewer') || roles.includes('tester') || roles.includes('artifact_verifier'),
      workspace_write: roles.includes('builder') && Number(stress.workspace_mutation || 0) >= 0.25,
      artifact_delivery: ['project_task', 'research_campaign'].includes(mode),
    },
    work_mode_satisfaction: candidateSatisfiesWorkMode({ roles, agent_count: roles.length }, workMode),
  }];
}


function rolesForUserRequestedTeam(intent = {}, request = '', stress = {}) {
  const required = uniq(intent.required_roles || [], 8);
  const roles = [];
  const add = (role) => { const value = cleanId(role); if (value && !roles.includes(value)) roles.push(value); };
  if (/code|patch|구현|코드|수정|repo|workspace/i.test(request) || Number(stress.workspace_mutation || 0) >= 0.35) add('builder');
  else if (/research|조사|분석|evidence/i.test(request)) add('researcher');
  else add('builder');
  for (const role of required) add(role);
  if (roles.length < Number(intent.min_team_size || 2)) {
    if (!roles.includes('reviewer')) add('reviewer');
    if (roles.length < Number(intent.min_team_size || 2) && !roles.includes('synthesizer')) add('synthesizer');
  }
  return roles.slice(0, 6);
}

function buildUserIntentCandidateBlueprints({ request = '', stress = {}, userIntent = {} } = {}) {
  const intent = summarizeUserOrchestrationIntent(userIntent || inferUserOrchestrationIntent(request));
  if (!['explicit', 'preferred'].includes(cleanId(intent.team_intent))) return [];
  const roles = rolesForUserRequestedTeam(intent, request, stress);
  const roleSlots = roles.map((role, index) => ({
    slot_id: `user_${role}_${index + 1}`,
    role_id: role,
    label: role,
    purpose: index === 0 ? 'primary work role requested by user orchestration intent' : 'supporting role requested by user orchestration intent',
  }));
  const style = cleanId(intent.team_style || 'team') || 'team';
  const label = style === 'debate' ? 'User-requested debate team'
    : style === 'red_team' ? 'User-requested red-team review'
    : style === 'parallel' ? 'User-requested parallel team'
    : style === 'review' ? 'User-requested review team'
    : 'User-requested team';
  return [{
    candidate_id: cleanId(`user_intent:${style}:${roles.join('_')}`),
    source: 'user_orchestration_intent',
    motif_id: cleanId(`user_${style}_team`),
    label,
    pattern: style === 'debate' ? 'debate' : (style === 'parallel' ? 'parallel' : 'sequential'),
    role_slots: roleSlots,
    roles,
    tags: uniq(['user_requested_team', `user_style_${style}`, ...intent.reason_codes], 12),
    task_types: uniq([/code|patch|구현|코드|수정|repo|workspace/i.test(request) ? 'implementation' : 'research'], 4),
    coordination_cost: Math.max(1, roles.length - 1),
    prior_weight: intent.team_intent === 'explicit' ? 2.25 : 1.55,
    default_weight: 1.5,
    requires: {
      verifier: roles.includes('reviewer') || roles.includes('tester'),
      workspace_write: roles.includes('builder') && Number(stress.workspace_mutation || 0) >= 0.35,
      artifact_delivery: roles.includes('builder') && Number(stress.artifact_pressure || 0) >= 0.35,
    },
    user_orchestration_intent: intent,
    user_intent_satisfaction: candidateSatisfiesUserOrchestrationIntent({ roles, agent_count: roles.length }, intent),
  }];
}

export function generateTeamCandidateBlueprints({ request = '', runtime = null, stress = {}, activeTeam = null, runtimeTeamSnapshot = null, motifFeedbackSummary = null, promotionSummary = null, limit = 8, userOrchestrationIntent = null, taskAttemptPlan = null } = {}) {
  const userIntent = summarizeUserOrchestrationIntent(userOrchestrationIntent || inferUserOrchestrationIntent(request));
  const attemptPlan = summarizeTaskAttemptPlan(taskAttemptPlan || {});
  const workMode = summarizeWorkModeConfig(attemptPlan.work_mode || {});
  const memoryImport = summarizeMemoryImportIntent(attemptPlan.memory_import || {});
  const motifs = buildTeamMotifRegistry({ runtimeTeamSnapshot, activeTeam, motifFeedbackSummary, promotionSummary, channel: 'stable' });
  const rows = motifs.map((motif) => {
    const roleIds = uniq(asArray(motif.role_slots).map((slot) => slot.role_id), 12);
    const prior = motifMatchesStress(motif, stress, request);
    return {
      candidate_id: cleanId(`motif:${motif.motif_id}`),
      source: motif.source || 'motif_registry',
      motif_id: motif.motif_id,
      label: motif.label,
      pattern: motif.pattern || 'sequential',
      role_slots: motif.role_slots,
      roles: roleIds,
      tags: uniq(motif.coverage_tags || [], 12),
      task_types: uniq(motif.task_types || [], 8),
      coordination_cost: Number(motif.coordination_cost || Math.max(0, roleIds.length - 1)),
      prior_weight: Number(prior.toFixed(3)),
      default_weight: Number(motif.default_weight || 1),
      requires: inferRequiresFromMotif(motif, stress),
      user_orchestration_intent: userIntent,
      task_attempt_plan: attemptPlan,
      memory_import_intent: memoryImport,
      work_mode: workMode,
      target_team: memoryImport.target_team !== 'general' ? memoryImport.target_team : undefined,
      user_intent_satisfaction: candidateSatisfiesUserOrchestrationIntent({ roles: roleIds, agent_count: roleIds.length }, userIntent),
      task_attempt_satisfaction: candidateSatisfiesTaskAttempt({ roles: roleIds, agent_count: roleIds.length, tags: motif.coverage_tags || [], target_team: memoryImport.target_team !== 'general' ? memoryImport.target_team : undefined }, attemptPlan),
      work_mode_satisfaction: candidateSatisfiesWorkMode({ roles: roleIds, agent_count: roleIds.length }, workMode),
    };
  });
  const attemptRequested = buildTaskAttemptCandidateBlueprints({ request, stress, taskAttemptPlan: attemptPlan });
  const workModeRequested = buildWorkModeCandidateBlueprints({ request, stress, taskAttemptPlan: attemptPlan });
  const userRequested = buildUserIntentCandidateBlueprints({ request, stress, userIntent });
  const allRows = [...attemptRequested, ...workModeRequested, ...userRequested, ...rows];
  const sorted = allRows.sort((a, b) => Number(b.prior_weight || 0) - Number(a.prior_weight || 0));
  return sorted.slice(0, Math.max(1, limit));
}

function summarizeSkeletonAdvisoryForTrace(advisory = {}) {
  const row = asObject(advisory);
  if (!Object.keys(row).length) return null;
  return {
    status: row.status || null,
    source: row.source || null,
    labels: row.labels || {},
    confidence: row.confidence ?? null,
    capacity_gaps: asArray(row.capacity_gaps),
    warnings: asArray(row.warnings),
    diagnostics: row.diagnostics || {},
    request: row.request ? {
      kind: row.request.kind,
      candidate_id: row.request.candidate_id,
      tokens: asArray(row.request.tokens).slice(0, 120),
      text: String(row.request.text || '').slice(0, 3000),
    } : null,
  };
}

export function buildTeamCandidateSummary(candidate = {}) {
  const row = asObject(candidate);
  return {
    candidate_id: row.candidate_id,
    motif_id: row.motif_id,
    label: row.label,
    source: row.source,
    pattern: row.pattern,
    roles: row.roles,
    agent_count: Number(row.agent_count || row.team?.agents?.length || asArray(row.roles).length || 0),
    selected: row.selected === true,
    gate: row.gate,
    score: row.score,
    skeleton_advisory: summarizeSkeletonAdvisoryForTrace(row.skeleton_advisory),
    user_orchestration_intent: row.user_orchestration_intent || null,
    user_intent_satisfaction: row.user_intent_satisfaction || null,
    task_attempt_plan: row.task_attempt_plan || null,
    work_mode: row.work_mode || row.task_attempt_plan?.work_mode || null,
    work_mode_satisfaction: row.work_mode_satisfaction || null,
    task_attempt_satisfaction: row.task_attempt_satisfaction || null,
    memory_import_intent: row.memory_import_intent || null,
    target_team: row.target_team || null,
    previous_result_policy: row.previous_result_policy || null,
    rationale: row.rationale || [],
  };
}
