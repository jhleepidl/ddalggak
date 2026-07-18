import { cleanText } from './fs_utils.js';

const BASE_STAGES = {
  execute: {
    kind: 'execute',
    role: 'builder',
    provider: 'codex',
    access: 'workspace_write',
    purpose: 'Use the provider-native coding loop, tools, skills, and internal planning to complete the Room contract in the canonical workspace.',
    context_policy: { prior_stage_ids: [] },
    required_capabilities: ['provider_native_planning', 'workspace_write', 'command_execution', 'validation'],
  },
  research: {
    kind: 'research',
    role: 'researcher',
    provider: 'antigravity',
    access: 'read_only_snapshot',
    purpose: 'Research and ground the execution approach using provider-native tools while respecting the Room source boundary.',
    context_policy: { prior_stage_ids: [], include_working_memory: false },
    required_capabilities: ['provider_native_planning', 'workspace_read', 'research'],
  },
  review: {
    kind: 'review',
    role: 'reviewer',
    provider: 'antigravity',
    access: 'read_only_snapshot',
    purpose: 'Independently inspect the current workspace against the Room contract and report only externally verifiable blocking defects and risks.',
    context_policy: { prior_stage_ids: [], include_working_memory: false },
    required_capabilities: ['workspace_read', 'snapshot_review'],
  },
  revise: {
    kind: 'revise',
    role: 'builder',
    provider: 'codex',
    access: 'workspace_write',
    purpose: 'Resolve the exact open review blockers in the canonical workspace using the provider-native coding loop.',
    context_policy: { prior_stage_ids: [], detail: 'full' },
    required_capabilities: ['provider_native_planning', 'workspace_write', 'command_execution', 'validation'],
  },
  verify: {
    kind: 'verify',
    role: 'operator',
    provider: 'codex',
    access: 'workspace_write',
    purpose: 'Perform final provider-native validation, apply only bounded fixes required by the Room contract, and produce the user-facing completion report.',
    context_policy: { mode: 'summaries' },
    required_capabilities: ['workspace_write', 'command_execution', 'validation'],
  },
  propose_a: {
    kind: 'proposal',
    role: 'researcher',
    provider: 'antigravity',
    access: 'read_only_snapshot',
    purpose: 'Produce an independent proposal from the Room contract without seeing another proposal.',
    context_policy: { prior_stage_ids: [], include_working_memory: false },
    required_capabilities: ['provider_native_planning', 'workspace_read', 'research'],
  },
  propose_b: {
    kind: 'proposal',
    role: 'researcher',
    provider: 'antigravity',
    access: 'read_only_snapshot',
    purpose: 'Produce a second independent proposal emphasizing different assumptions, risks, and trade-offs.',
    context_policy: { prior_stage_ids: [], include_working_memory: false },
    required_capabilities: ['provider_native_planning', 'workspace_read', 'research'],
  },
  adjudicate: {
    kind: 'adjudicate',
    role: 'reviewer',
    provider: 'antigravity',
    access: 'read_only_snapshot',
    purpose: 'Compare the independent proposals and publish a structured implementation handoff.',
    context_policy: { prior_stage_ids: ['propose_a', 'propose_b'], detail: 'full', include_working_memory: false },
    required_capabilities: ['provider_native_planning', 'workspace_read', 'snapshot_review'],
  },
};

function stage(kind, stageId, extra = {}) {
  return { stage_id: stageId, ...BASE_STAGES[kind], ...extra };
}

function reviewCycle(round) {
  const reviewId = `review_${round}`;
  const priorReviewId = round > 1 ? `review_${round - 1}` : '';
  return [
    stage('review', reviewId, {
      review_round: round,
      ...(priorReviewId ? { run_if: { kind: 'stage_reported_blockers', stage_id: priorReviewId } } : {}),
      purpose: round === 1
        ? 'Independently inspect the implementation against the Room contract and report only blocking defects, missed completion criteria, and material risks.'
        : `Independently re-inspect the workspace after revision round ${round - 1} and report only remaining blockers.`,
    }),
    stage('revise', `revise_${round}`, {
      review_round: round,
      run_if: { kind: 'open_blockers' },
      context_policy: { prior_stage_ids: [reviewId], detail: 'full' },
      purpose: `Resolve the exact blockers reported in review round ${round}; preserve unrelated working behavior.`,
    }),
  ];
}

const PROFILE_ALIASES = new Map([
  ['solo', 'solo'],
  ['single', 'solo'],
  ['provider_native', 'solo'],
  ['single_specialist', 'solo'],
  ['review', 'builder_reviewer'],
  ['review_loop', 'builder_reviewer'],
  ['execute_and_verify', 'builder_reviewer'],
  ['builder_reviewer', 'builder_reviewer'],
  ['builder_reviewer_loop', 'builder_reviewer'],
  ['research_then_execute', 'research_then_execute'],
  ['research_execute', 'research_then_execute'],
  ['iterative_project', 'research_then_execute'],
  ['operator_gated_workflow', 'research_then_execute'],
  ['deliberate', 'parallel_ideation'],
  ['deliberation', 'parallel_ideation'],
  ['discussion', 'parallel_ideation'],
  ['multi_agent', 'parallel_ideation'],
  ['compare_and_decide', 'parallel_ideation'],
  ['parallel_ideation', 'parallel_ideation'],
  ['parallel_research_then_review_then_synthesize', 'parallel_ideation'],
]);

export function normalizeCollaborationProfile(value = '') {
  const clean = cleanText(value).toLowerCase().replaceAll('-', '_');
  return PROFILE_ALIASES.get(clean) || 'solo';
}

// Backward-compatible export. The returned value is now the collaboration profile ID.
export function normalizeTopology(value = '') {
  return normalizeCollaborationProfile(value);
}

// No scenario keyword routing: default to one provider-native execution capsule.
export function recommendTopology() {
  return 'solo';
}

export function buildExecutionGraph({
  objective = '',
  topology = '',
  collaborationProfile = '',
  maxStages = 16,
  maxReviewRounds = 2,
} = {}) {
  const profileId = normalizeCollaborationProfile(collaborationProfile || topology || 'solo');
  const rounds = Math.max(1, Math.min(3, Number(maxReviewRounds) || 2));
  let stages;
  if (profileId === 'solo') {
    stages = [
      stage('execute', 'execute', {
        purpose: 'Own the task end-to-end inside one provider-native coding capsule: inspect, plan internally, implement, validate, and report against the Room contract.',
      }),
    ];
  } else if (profileId === 'parallel_ideation') {
    stages = [
      stage('propose_a', 'propose_a'),
      stage('propose_b', 'propose_b'),
      stage('adjudicate', 'adjudicate'),
      stage('execute', 'execute', { context_policy: { prior_stage_ids: ['adjudicate'], detail: 'full' } }),
      ...Array.from({ length: rounds }, (_, index) => reviewCycle(index + 1)).flat(),
      stage('verify', 'verify'),
    ];
  } else if (profileId === 'research_then_execute') {
    stages = [
      stage('research', 'research'),
      stage('execute', 'execute', { context_policy: { prior_stage_ids: ['research'], detail: 'full' } }),
      ...Array.from({ length: rounds }, (_, index) => reviewCycle(index + 1)).flat(),
      stage('verify', 'verify'),
    ];
  } else {
    stages = [
      stage('execute', 'execute'),
      ...Array.from({ length: rounds }, (_, index) => reviewCycle(index + 1)).flat(),
      stage('verify', 'verify'),
    ];
  }
  const bounded = stages.slice(0, Math.max(1, Number(maxStages) || 16)).map((row, index) => ({ ...row, order: index + 1 }));
  return {
    schema_version: 'ai_rooms.execution_graph/v5',
    collaboration_profile_id: profileId,
    topology_id: profileId,
    provider_native_default: profileId === 'solo',
    objective_excerpt: cleanText(objective).slice(0, 500),
    review_round_limit: ['builder_reviewer', 'research_then_execute', 'parallel_ideation'].includes(profileId) ? rounds : 0,
    stages: bounded,
    stop_conditions: ['all_required_stages_completed_or_conditionally_skipped', 'cancelled_by_user', 'fatal_boundary_violation', 'approval_required'],
  };
}
