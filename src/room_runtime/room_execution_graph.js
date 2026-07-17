import { cleanText } from './fs_utils.js';

const BASE_STAGES = {
  plan: { role: 'planner', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Create an executable plan grounded only in the Room workspace.', context_policy: { prior_stage_ids: [] } },
  implement: { role: 'builder', provider: 'codex', access: 'workspace_write', purpose: 'Implement the requested change inside the Room workspace.', context_policy: { prior_stage_ids: [] } },
  review: { role: 'reviewer', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Independently review the current workspace for defects, missed requirements, and risks.', context_policy: { prior_stage_ids: [], include_working_memory: false } },
  revise: { role: 'builder', provider: 'codex', access: 'workspace_write', purpose: 'Resolve every currently open blocking issue and improve the implementation.', context_policy: { prior_stage_ids: [], detail: 'full' } },
  verify: { role: 'verifier', provider: 'codex', access: 'workspace_write', purpose: 'Run targeted validation and fix only issues required for the requested task.', context_policy: { prior_stage_ids: [] } },
  synthesize: { role: 'synthesizer', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Produce the final user-facing result from verified workspace state and structured run memory.', context_policy: { mode: 'summaries' } },
  propose_a: { role: 'proposer', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Produce an independent solution proposal without seeing other proposals.', context_policy: { prior_stage_ids: [], include_working_memory: false } },
  propose_b: { role: 'challenger', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Produce a second independent proposal emphasizing alternatives and failure modes.', context_policy: { prior_stage_ids: [], include_working_memory: false } },
  adjudicate: { role: 'adjudicator', provider: 'antigravity', access: 'read_only_snapshot', purpose: 'Compare independent proposals and select a justified execution plan.', context_policy: { prior_stage_ids: ['propose_a', 'propose_b'], detail: 'full', include_working_memory: false } },
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
        ? 'Independently review the implementation and report only blocking defects, missed requirements, and risks.'
        : `Independently re-review the workspace after revision round ${round - 1} and report only remaining blocking defects, missed requirements, and risks.`,
    }),
    stage('revise', `revise_${round}`, {
      review_round: round,
      run_if: { kind: 'open_blockers' },
      context_policy: { prior_stage_ids: [reviewId], detail: 'full' },
      purpose: `Resolve the exact open blocking issues reported in review round ${round}.`,
    }),
  ];
}

export function normalizeTopology(value = '') {
  const clean = cleanText(value).toLowerCase().replaceAll('-', '_');
  if (['solo', 'single'].includes(clean)) return 'solo';
  if (['deliberate', 'deliberation', 'discussion', 'multi_agent'].includes(clean)) return 'deliberate';
  return 'review_loop';
}

export function recommendTopology(objective = '') {
  const text = cleanText(objective).toLowerCase();
  if (/(비교|trade.?off|대안|토론|논쟁|architecture|설계안|여러 관점|alternative)/i.test(text)) return 'deliberate';
  if (/(간단히|한 번|짧게|오타|rename|문구 수정)/i.test(text) && text.length < 180) return 'solo';
  return 'review_loop';
}

export function buildExecutionGraph({ objective = '', topology = '', maxStages = 16, maxReviewRounds = 2 } = {}) {
  const topologyId = topology ? normalizeTopology(topology) : recommendTopology(objective);
  const rounds = Math.max(1, Math.min(3, Number(maxReviewRounds) || 2));
  let stages;
  if (topologyId === 'solo') {
    stages = [
      stage('implement', 'implement'),
      stage('verify', 'verify'),
      stage('synthesize', 'synthesize'),
    ];
  } else if (topologyId === 'deliberate') {
    stages = [
      stage('propose_a', 'propose_a'),
      stage('propose_b', 'propose_b'),
      stage('adjudicate', 'adjudicate'),
      stage('implement', 'implement', { context_policy: { prior_stage_ids: ['adjudicate'], detail: 'full' } }),
      ...Array.from({ length: rounds }, (_, index) => reviewCycle(index + 1)).flat(),
      stage('verify', 'verify'),
      stage('synthesize', 'synthesize'),
    ];
  } else {
    stages = [
      stage('plan', 'plan'),
      stage('implement', 'implement', { context_policy: { prior_stage_ids: ['plan'], detail: 'full' } }),
      ...Array.from({ length: rounds }, (_, index) => reviewCycle(index + 1)).flat(),
      stage('verify', 'verify'),
      stage('synthesize', 'synthesize'),
    ];
  }
  const bounded = stages.slice(0, Math.max(1, Number(maxStages) || 16)).map((row, index) => ({ ...row, order: index + 1 }));
  return {
    schema_version: 'ai_rooms.execution_graph/v4',
    topology_id: topologyId,
    review_round_limit: topologyId === 'solo' ? 0 : rounds,
    stages: bounded,
    stop_conditions: ['all_required_stages_completed_or_conditionally_skipped', 'cancelled_by_user', 'fatal_boundary_violation'],
  };
}
