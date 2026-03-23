
import { buildTeamSeedFromTaskArchetype } from './team_blueprint_templates.js';

function clean(value=''){ return String(value||'').trim(); }
function cleanId(value=''){ return clean(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '_'); }
function clone(value){ return JSON.parse(JSON.stringify(value)); }

const BENCHMARK_TEMPLATES = {
  deep_research_trio: {
    template_id: 'deep_research_trio',
    title: 'Deep Research Trio',
    benchmark_source: 'open_deep_research + AutoResearchClaw inspired',
    description: 'Breadth-first research, skeptical evidence review, and concise final synthesis for source-grounded briefs.',
    good_for: ['deep research', 'literature review', 'evidence map', 'market/technical briefing'],
    seed: (() => {
      const seed = buildTeamSeedFromTaskArchetype('research', { title: 'Deep Research Trio' });
      seed.agents = [
        { agent_id: 'deep_research_scout', name: 'Deep Research Scout', role: 'researcher', provider: 'gemini', model: 'gemini-2.5-pro', purpose: 'Expand the search space, cluster sources, and maintain an evidence ledger before synthesis.', runtime_capabilities_required: ['web_browse'], runtime_capabilities_optional: ['filesystem_read'], attached_skill_ids: ['skill.deep_research_workflow.v1', 'skill.claim_evidence_audit.v1'] },
        { agent_id: 'evidence_gate_reviewer', name: 'Evidence Gate Reviewer', role: 'reviewer', provider: 'openai', model: 'gpt-5.4', purpose: 'Challenge unsupported claims, collapse duplicates, and mark unresolved contradictions.', runtime_capabilities_required: ['web_browse'], runtime_capabilities_optional: ['filesystem_read'], attached_skill_ids: ['skill.claim_evidence_audit.v1', 'skill.deep_research_workflow.v1'] },
        { agent_id: 'brief_synthesizer', name: 'Brief Synthesizer', role: 'synthesizer', provider: 'openai', model: 'gpt-5.4', purpose: 'Produce the final brief, open questions, and next actions in operator-friendly form.', runtime_capabilities_optional: ['filesystem_read'], external_tool_preferences: ['telegram'], attached_skill_ids: ['skill.telegram_briefing.v1', 'skill.deep_research_workflow.v1'] },
      ];
      seed.interaction_spec.execution_pattern = 'sequential_pipeline';
      seed.interaction_spec.final_answer_owner = 'Brief Synthesizer';
      seed.interaction_spec.handoffs = [
        { from: 'Deep Research Scout', to: 'Evidence Gate Reviewer', payload: 'evidence_clusters_and_gaps' },
        { from: 'Evidence Gate Reviewer', to: 'Brief Synthesizer', payload: 'validated_claims_and_open_questions' },
      ];
      seed.catalog_tags = [...(seed.catalog_tags || []), 'benchmark', 'deep_research'];
      seed.planner_metadata = { benchmark_template_id: 'deep_research_trio', benchmark_source: 'open_deep_research + AutoResearchClaw inspired' };
      return seed;
    })(),
  },
  repo_delivery_loop: {
    template_id: 'repo_delivery_loop',
    title: 'Repo Delivery Loop',
    benchmark_source: 'OpenClaw multi-agent coding inspired',
    description: 'Repo scout → builder → safety reviewer → delivery owner loop for scoped software delivery.',
    good_for: ['repo patch', 'implementation + review', 'scoped feature delivery'],
    seed: (() => {
      const seed = buildTeamSeedFromTaskArchetype('iterative_improvement', { title: 'Repo Delivery Loop' });
      seed.agents = [
        { agent_id: 'repo_scout', name: 'Repo Scout', role: 'researcher', provider: 'gemini', model: 'gemini-2.5-pro', purpose: 'Map the codebase, locate affected files, and prepare a bounded implementation brief.', runtime_capabilities_required: ['filesystem_read'], runtime_capabilities_optional: ['web_browse'], attached_skill_ids: ['skill.run_trace_debugging.v1', 'skill.context_selection_policy.v1'] },
        { agent_id: 'client_companion_builder', name: 'Client Companion Builder', role: 'builder', provider: 'codex', model: 'gpt-5-codex', purpose: 'Implement the scoped patch, run checks, and keep implementation notes precise.', runtime_capabilities_required: ['filesystem_write'], runtime_capabilities_optional: ['shell_exec'], attached_skill_ids: ['skill.run_trace_debugging.v1'] },
        { agent_id: 'safety_and_quality_reviewer', name: 'Safety And Quality Reviewer', role: 'reviewer', provider: 'openai', model: 'gpt-5.4', purpose: 'Review the patch for correctness, regressions, and delivery risks before finalization.', runtime_capabilities_required: ['filesystem_read'], runtime_capabilities_optional: ['web_browse'], attached_skill_ids: ['skill.claim_evidence_audit.v1', 'skill.run_trace_debugging.v1'] },
        { agent_id: 'delivery_synthesizer', name: 'Delivery Synthesizer', role: 'synthesizer', provider: 'gemini', model: 'gemini-2.5-pro', purpose: 'Package the final answer, touched files, residual risks, and artifact index for the user.', attached_skill_ids: ['skill.telegram_briefing.v1'] },
      ];
      seed.interaction_spec.execution_pattern = 'builder_reviewer_loop';
      seed.interaction_spec.final_answer_owner = 'Delivery Synthesizer';
      seed.interaction_spec.handoffs = [
        { from: 'Repo Scout', to: 'Client Companion Builder', payload: 'repo_map_and_constraints' },
        { from: 'Client Companion Builder', to: 'Safety And Quality Reviewer', payload: 'patch_and_checks' },
        { from: 'Safety And Quality Reviewer', to: 'Client Companion Builder', payload: 'repair_requests_if_needed' },
        { from: 'Safety And Quality Reviewer', to: 'Delivery Synthesizer', payload: 'signoff_and_residual_risk' },
      ];
      seed.catalog_tags = [...(seed.catalog_tags || []), 'benchmark', 'software_delivery'];
      seed.planner_metadata = { benchmark_template_id: 'repo_delivery_loop', benchmark_source: 'OpenClaw multi-agent coding inspired' };
      return seed;
    })(),
  },
  skeptical_briefing_trio: {
    template_id: 'skeptical_briefing_trio',
    title: 'Skeptical Briefing Trio',
    benchmark_source: 'operator briefing best-practice',
    description: 'Fast researcher + skeptical reviewer + concise synthesizer for Telegram-friendly decision briefs.',
    good_for: ['exec briefing', 'news digestion', 'daily operating summary'],
    seed: (() => {
      const seed = buildTeamSeedFromTaskArchetype('research', { title: 'Skeptical Briefing Trio' });
      seed.agents = [
        { agent_id: 'market_news_researcher', name: 'Market News Researcher', role: 'researcher', provider: 'gemini', model: 'gemini-2.5-pro', purpose: 'Find the strongest source-backed developments quickly and separate signal from noise.', attached_skill_ids: ['skill.deep_research_workflow.v1', 'skill.claim_evidence_audit.v1'] },
        { agent_id: 'skeptical_claim_reviewer', name: 'Skeptical Claim Reviewer', role: 'reviewer', provider: 'openai', model: 'gpt-5.4', purpose: 'Challenge overreach, compress uncertainty, and keep the brief evidence-first.', attached_skill_ids: ['skill.claim_evidence_audit.v1'] },
        { agent_id: 'telegram_brief_owner', name: 'Telegram Brief Owner', role: 'synthesizer', provider: 'openai', model: 'gpt-5.4', purpose: 'Turn validated findings into an operator-friendly short brief with next actions.', attached_skill_ids: ['skill.telegram_briefing.v1'] },
      ];
      seed.interaction_spec.final_answer_owner = 'Telegram Brief Owner';
      seed.catalog_tags = [...(seed.catalog_tags || []), 'benchmark', 'briefing'];
      seed.planner_metadata = { benchmark_template_id: 'skeptical_briefing_trio', benchmark_source: 'operator briefing best-practice' };
      return seed;
    })(),
  },
};

export function listBenchmarkTeamTemplates() {
  return Object.values(BENCHMARK_TEMPLATES).map((row) => ({
    template_id: row.template_id,
    title: row.title,
    benchmark_source: row.benchmark_source,
    description: row.description,
    good_for: [...(row.good_for || [])],
    task_archetype: cleanId(row.seed?.task_archetype || ''),
    execution_pattern: cleanId(row.seed?.interaction_spec?.execution_pattern || ''),
    participant_roles: [...new Set((row.seed?.agents || []).map((agent) => cleanId(agent.role)).filter(Boolean))],
  }));
}

export function getBenchmarkTeamTemplateDescriptor(templateId = '') {
  const key = cleanId(templateId);
  const row = BENCHMARK_TEMPLATES[key];
  if (!row) return null;
  return listBenchmarkTeamTemplates().find((entry) => entry.template_id === key) || null;
}

export function buildBenchmarkTeamTemplate(templateId = '', overrides = {}) {
  const key = cleanId(templateId);
  const row = BENCHMARK_TEMPLATES[key];
  if (!row) return null;
  const seed = clone(row.seed);
  if (clean(overrides.title)) seed.team_name = clean(overrides.title);
  if (clean(overrides.taskBrief || overrides.description)) seed.task_brief = clean(overrides.taskBrief || overrides.description);
  seed.planner_metadata = {
    ...(seed.planner_metadata || {}),
    benchmark_template_id: row.template_id,
    benchmark_source: row.benchmark_source,
  };
  return seed;
}

export function buildBenchmarkTemplateCatalogText() {
  const lines = [
    'Benchmark team templates',
    '- /team template benchmark <id> 로 pending team으로 불러올 수 있습니다.',
  ];
  for (const row of listBenchmarkTeamTemplates()) {
    lines.push(`- ${row.template_id}: ${row.title} · ${row.benchmark_source}`);
    if (row.description) lines.push(`  ${row.description}`);
    if ((row.good_for || []).length > 0) lines.push(`  good_for: ${row.good_for.join(', ')}`);
  }
  return lines.join('\n');
}

