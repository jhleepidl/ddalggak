function asArray(value){ return Array.isArray(value) ? value : []; }
function clean(value=''){ return String(value||'').trim(); }
function cleanId(value=''){ return clean(value).toLowerCase().replace(/[^a-z0-9._:-]+/g, '_'); }
function unique(values=[], {limit=16, lower=false}={}){ const out=[]; const seen=new Set(); for(const raw of asArray(values)){ const value=clean(raw); if(!value) continue; const normalized=lower ? value.toLowerCase() : value; const key=normalized.toLowerCase(); if(seen.has(key)) continue; seen.add(key); out.push(normalized); if(out.length>=limit) break; } return out; }

function baseRuntimePolicy(){
  return {
    runtime_execution: {
      checkpointing: {
        write_on_turn_end: true,
        write_on_approval_pause: true,
        write_on_resume: true,
      },
      continuous_improvement: {
        enabled: true,
        mode: 'bounded_iteration',
        max_turns: 3,
        min_turns_before_completion: 1,
        progress_update_each_turn: true,
      },
      providers: {
        codex: {
          sandbox_mode: 'workspace-write',
          approval_policy: 'never',
        },
        gemini: {
          approval_mode: 'default',
        },
      },
    },
  };
}

function compactMemoryPlan({ planId, displayName, taskBrief, surfaces }){
  const normalizedSurfaces = surfaces.map((surface, index) => ({
    surface_id: cleanId(surface.surface_id || `surface_${index+1}`) || `surface_${index+1}`,
    file_name: clean(surface.file_name || `${surface.surface_id || `surface_${index+1}`}.md`) || `${surface.surface_id || `surface_${index+1}`}.md`,
    title: clean(surface.title || surface.surface_id || `Surface ${index+1}`) || `Surface ${index+1}`,
    purpose: clean(surface.purpose || 'Team memory surface.') || 'Team memory surface.',
    semantic_slots: unique(surface.semantic_slots || [surface.surface_id], {lower:true, limit:8}),
    target_roles: unique(surface.target_roles || [], {lower:true, limit:8}),
    section_hints: unique(surface.section_hints || [], {limit:8}),
    load_policy: cleanId(surface.load_policy || 'on_demand') || 'on_demand',
    write_policy: cleanId(surface.write_policy || 'shared') || 'shared',
    create_mode: cleanId(surface.create_mode || 'lazy') || 'lazy',
  }));
  return {
    version: 1,
    plan_id: cleanId(planId) || 'team_memory_plan',
    display_name: clean(displayName) || 'Team memory plan',
    task_brief: clean(taskBrief),
    strategy: 'task_archetype_template',
    surfaces: normalizedSurfaces,
    default_load_surface_ids: normalizedSurfaces.filter((surface) => surface.load_policy === 'always').map((surface) => surface.surface_id),
    writable_surface_ids: normalizedSurfaces.filter((surface) => surface.write_policy !== 'readonly').map((surface) => surface.surface_id),
    stable_surface_ids: normalizedSurfaces.filter((surface) => ['final', 'index'].includes(surface.write_policy) || surface.semantic_slots.includes('decisions')).map((surface) => surface.surface_id),
    mutable_surface_ids: normalizedSurfaces.filter((surface) => ['shared', 'append_only'].includes(surface.write_policy)).map((surface) => surface.surface_id),
    system_files: ['knowledge_base_profile.json', 'knowledge_base_contract.md'],
    migration_strategy: 'team_blueprint_surface_preserving',
    preserve_history: true,
    enforce_concrete_file_names_in_prompts: true,
  };
}

function buildSeed(template, { taskBrief = '', title = '', description = '' } = {}){
  const teamName = clean(title || template.title);
  const taskText = clean(taskBrief || description || template.description);
  return {
    team_name: teamName,
    task_brief: taskText,
    composition_mode: 'structured',
    proposal_mode: 'create',
    agents: template.agents.map((agent) => ({ ...agent })),
    interaction_spec: JSON.parse(JSON.stringify(template.interaction_spec)),
    shortcut_policy: {
      enabled: true,
      only_for_followups: true,
      disallow_when_pending_approval: true,
      max_recent_turns: 6,
    },
    expected_outputs: [...template.expected_outputs],
    good_for: [...template.good_for],
    bad_for: [...template.bad_for],
    catalog_tags: [...template.tags],
    memory_plan: compactMemoryPlan({
      planId: template.memory_plan.plan_id,
      displayName: template.memory_plan.display_name,
      taskBrief: taskText,
      surfaces: template.memory_plan.surfaces,
    }),
    runtime_execution: JSON.parse(JSON.stringify(template.runtime_policy.runtime_execution)),
  };
}

const TEMPLATE_DEFS = {
  research: {
    task_archetype: 'research',
    title: 'Research Briefing Team',
    description: 'Investigate a topic, collect evidence, and produce a concise recommendation memo.',
    tags: ['research', 'briefing', 'evidence', 'sequential'],
    good_for: ['market/technical research', 'source-grounded briefs', 'evidence-backed recommendations'],
    bad_for: ['large codebase patching', 'wide parallel build pipelines'],
    agents: [
      { agent_id: 'research_lead', name: 'Research Lead', role: 'researcher', purpose: 'Frame the question, gather evidence, and maintain the evidence ledger.' },
      { agent_id: 'analyst', name: 'Analyst', role: 'synthesizer', purpose: 'Synthesize findings into a concise recommendation memo and gaps list.' },
      { agent_id: 'fact_reviewer', name: 'Fact Reviewer', role: 'reviewer', purpose: 'Challenge unsupported claims and verify the final recommendation before delivery.' },
    ],
    interaction_spec: {
      execution_pattern: 'sequential_pipeline',
      handoffs: [
        { from: 'Research Lead', to: 'Analyst', payload: 'evidence_and_open_questions' },
        { from: 'Analyst', to: 'Fact Reviewer', payload: 'draft_memo' },
      ],
      final_answer_owner: 'Fact Reviewer',
      policies: { require_reviewer_before_final: true, reviewer_visibility: 'summaries_plus_selected_evidence', synthesizer_visibility: 'upstream_outputs_only' },
    },
    expected_outputs: ['recommendation memo', 'evidence summary', 'open questions'],
    runtime_policy: baseRuntimePolicy(),
    memory_plan: {
      plan_id: 'research_memory_plan',
      display_name: 'Research memory plan',
      surfaces: [
        { surface_id: 'mission_brief', file_name: 'mission_brief.md', title: 'Mission Brief', purpose: 'Question framing, success criteria, and scope.', semantic_slots: ['plan'], target_roles: ['researcher', 'synthesizer', 'reviewer'], load_policy: 'always', write_policy: 'shared', create_mode: 'eager' },
        { surface_id: 'working_memory', file_name: 'working_memory.md', title: 'Working Memory', purpose: 'Open questions, interim findings, and next actions.', semantic_slots: ['research', 'progress'], target_roles: ['researcher', 'synthesizer'], load_policy: 'always', write_policy: 'shared' },
        { surface_id: 'evidence_ledger', file_name: 'evidence_ledger.md', title: 'Evidence Ledger', purpose: 'Source-grounded evidence and citations.', semantic_slots: ['research'], target_roles: ['researcher', 'reviewer'], load_policy: 'on_demand', write_policy: 'append_only' },
        { surface_id: 'final_answer', file_name: 'final_answer.md', title: 'Final Answer', purpose: 'User-facing memo and final recommendation.', semantic_slots: ['decisions'], target_roles: ['synthesizer', 'reviewer'], load_policy: 'always', write_policy: 'final' },
        { surface_id: 'artifact_index', file_name: 'artifact_index.md', title: 'Artifact Index', purpose: 'Attached exports and external references.', semantic_slots: ['artifacts'], target_roles: ['synthesizer', 'reviewer'], load_policy: 'on_demand', write_policy: 'index' },
      ],
    },
  },
  implementation: {
    task_archetype: 'implementation',
    title: 'Implementation Strike Team',
    description: 'Inspect a repository, implement a scoped patch, verify it, and deliver a concise changelog.',
    tags: ['implementation', 'repair', 'repo', 'review'],
    good_for: ['repo fixes', 'scoped feature work', 'code review + implementation'],
    bad_for: ['open-ended ideation', 'pure research briefs'],
    agents: [
      { agent_id: 'repo_scout', name: 'Repo Scout', role: 'researcher', purpose: 'Map the codebase, locate relevant files, and identify likely constraints.' },
      { agent_id: 'builder', name: 'Builder', role: 'builder', purpose: 'Make the scoped implementation changes and keep the changelog precise.' },
      { agent_id: 'reviewer', name: 'Reviewer', role: 'reviewer', purpose: 'Verify correctness, regressions, and test coverage before final delivery.' },
      { agent_id: 'delivery_owner', name: 'Delivery Owner', role: 'synthesizer', purpose: 'Summarize the final patch, risks, and next steps for the user.' },
    ],
    interaction_spec: {
      execution_pattern: 'sequential_pipeline',
      handoffs: [
        { from: 'Repo Scout', to: 'Builder', payload: 'repo_map_and_constraints' },
        { from: 'Builder', to: 'Reviewer', payload: 'patch_and_test_results' },
        { from: 'Reviewer', to: 'Delivery Owner', payload: 'review_findings' },
      ],
      final_answer_owner: 'Delivery Owner',
      policies: { require_reviewer_before_final: true, reviewer_visibility: 'full_workspace_summary', synthesizer_visibility: 'upstream_outputs_only' },
    },
    expected_outputs: ['scoped patch', 'verification summary', 'delivery note'],
    runtime_policy: baseRuntimePolicy(),
    memory_plan: {
      plan_id: 'implementation_memory_plan',
      display_name: 'Implementation memory plan',
      surfaces: [
        { surface_id: 'mission_brief', file_name: 'mission_brief.md', title: 'Mission Brief', purpose: 'Scope, acceptance criteria, and patch plan.', semantic_slots: ['plan'], target_roles: ['researcher', 'builder', 'reviewer', 'synthesizer'], load_policy: 'always', write_policy: 'shared', create_mode: 'eager' },
        { surface_id: 'working_memory', file_name: 'working_memory.md', title: 'Working Memory', purpose: 'File map, current status, and next actions.', semantic_slots: ['research', 'progress'], target_roles: ['researcher', 'builder', 'reviewer'], load_policy: 'always', write_policy: 'shared' },
        { surface_id: 'implementation_notes', file_name: 'implementation_notes.md', title: 'Implementation Notes', purpose: 'Patch details, commands, and relevant outputs.', semantic_slots: ['progress'], target_roles: ['builder'], load_policy: 'on_demand', write_policy: 'append_only' },
        { surface_id: 'review_findings', file_name: 'review_findings.md', title: 'Review Findings', purpose: 'Verification notes, risk findings, and required follow-ups.', semantic_slots: ['decisions'], target_roles: ['reviewer', 'synthesizer'], load_policy: 'on_demand', write_policy: 'append_only' },
        { surface_id: 'final_answer', file_name: 'final_answer.md', title: 'Final Answer', purpose: 'User-facing patch summary and next steps.', semantic_slots: ['decisions'], target_roles: ['synthesizer'], load_policy: 'always', write_policy: 'final' },
        { surface_id: 'artifact_index', file_name: 'artifact_index.md', title: 'Artifact Index', purpose: 'Touched files, exports, and supporting outputs.', semantic_slots: ['artifacts'], target_roles: ['builder', 'synthesizer'], load_policy: 'on_demand', write_policy: 'index' },
      ],
    },
  },
  review_repair: {
    task_archetype: 'review_repair',
    title: 'Review & Repair Team',
    description: 'Audit an existing plan or implementation, identify failure modes, and produce a minimal repair plan and patch.',
    tags: ['review_repair', 'audit', 'repair', 'quality'],
    good_for: ['post-failure repair', 'audit + patch follow-up', 'quality-focused regression cleanup'],
    bad_for: ['greenfield implementation', 'broad web research'],
    agents: [
      { agent_id: 'auditor', name: 'Auditor', role: 'reviewer', purpose: 'Identify the most important defects, regressions, and contract gaps.' },
      { agent_id: 'repair_planner', name: 'Repair Planner', role: 'researcher', purpose: 'Translate review findings into a minimal repair plan and bounded scope.' },
      { agent_id: 'repair_builder', name: 'Repair Builder', role: 'builder', purpose: 'Apply the minimal repair patch and record what changed.' },
      { agent_id: 'signoff_owner', name: 'Signoff Owner', role: 'synthesizer', purpose: 'Confirm repaired state and present residual risk clearly to the user.' },
    ],
    interaction_spec: {
      execution_pattern: 'builder_reviewer_loop',
      handoffs: [
        { from: 'Auditor', to: 'Repair Planner', payload: 'defect_report' },
        { from: 'Repair Planner', to: 'Repair Builder', payload: 'repair_plan' },
        { from: 'Repair Builder', to: 'Signoff Owner', payload: 'repair_patch_and_verification' },
      ],
      final_answer_owner: 'Signoff Owner',
      policies: { require_reviewer_before_final: true, reviewer_visibility: 'full_workspace_summary', synthesizer_visibility: 'upstream_outputs_only' },
    },
    expected_outputs: ['defect report', 'minimal repair patch', 'residual risk summary'],
    runtime_policy: baseRuntimePolicy(),
    memory_plan: {
      plan_id: 'review_repair_memory_plan',
      display_name: 'Review/repair memory plan',
      surfaces: [
        { surface_id: 'mission_brief', file_name: 'mission_brief.md', title: 'Mission Brief', purpose: 'Failure context, constraints, and signoff conditions.', semantic_slots: ['plan'], target_roles: ['reviewer', 'researcher', 'builder', 'synthesizer'], load_policy: 'always', write_policy: 'shared', create_mode: 'eager' },
        { surface_id: 'working_memory', file_name: 'working_memory.md', title: 'Working Memory', purpose: 'Current defect state, repair progress, and next actions.', semantic_slots: ['research', 'progress'], target_roles: ['reviewer', 'researcher', 'builder'], load_policy: 'always', write_policy: 'shared' },
        { surface_id: 'defect_log', file_name: 'defect_log.md', title: 'Defect Log', purpose: 'Concrete defects, evidence, and severity.', semantic_slots: ['research'], target_roles: ['reviewer', 'researcher'], load_policy: 'on_demand', write_policy: 'append_only' },
        { surface_id: 'repair_log', file_name: 'repair_log.md', title: 'Repair Log', purpose: 'Repair steps, commands, and bounded patch notes.', semantic_slots: ['progress'], target_roles: ['builder'], load_policy: 'on_demand', write_policy: 'append_only' },
        { surface_id: 'final_answer', file_name: 'final_answer.md', title: 'Final Answer', purpose: 'Signoff summary, remaining risks, and user-facing guidance.', semantic_slots: ['decisions'], target_roles: ['synthesizer'], load_policy: 'always', write_policy: 'final' },
        { surface_id: 'artifact_index', file_name: 'artifact_index.md', title: 'Artifact Index', purpose: 'Patched files, defect exports, and verification artifacts.', semantic_slots: ['artifacts'], target_roles: ['builder', 'synthesizer'], load_policy: 'on_demand', write_policy: 'index' },
      ],
    },
  },
};

export function listTeamBlueprintTemplateSeeds(){
  return Object.values(TEMPLATE_DEFS).map((template) => ({
    task_archetype: template.task_archetype,
    title: template.title,
    description: template.description,
    tags: [...template.tags],
    good_for: [...template.good_for],
    bad_for: [...template.bad_for],
    seed: buildSeed(template),
  }));
}

export function buildTeamSeedFromTaskArchetype(taskArchetype='implementation', overrides={}){
  const key = cleanId(taskArchetype || 'implementation');
  const template = TEMPLATE_DEFS[key] || TEMPLATE_DEFS.implementation;
  const seed = buildSeed(template, overrides);
  if (clean(overrides.title)) seed.team_name = clean(overrides.title);
  if (clean(overrides.taskBrief || overrides.description)) seed.task_brief = clean(overrides.taskBrief || overrides.description);
  if (Array.isArray(overrides.good_for) && overrides.good_for.length > 0) seed.good_for = unique(overrides.good_for, {limit:8});
  if (Array.isArray(overrides.bad_for) && overrides.bad_for.length > 0) seed.bad_for = unique(overrides.bad_for, {limit:8});
  seed.task_archetype = template.task_archetype;
  return seed;
}
