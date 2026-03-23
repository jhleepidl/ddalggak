import { spawnSync } from 'node:child_process';

import { runCodexExec } from '../codex.js';
import { parseJsonObjectFromText } from '../shared/json_extract.js';
import { listSupportedModels } from '../catalog/model_catalog.js';
import { normalizeTeamStructureV2, deriveTeamConfigFromStructureV2 } from '../shared/team_structure_v2.js';
import { buildPlannerSchemaHintText } from '../shared/team_schema_catalog.js';
import { appendPromptTelemetry } from './prompt_telemetry.js';
import { runDir, runSharedDir } from './telegram_runtime_state.js';
import { compactPromptJson } from './prompt_surface_builder.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

let codexAvailabilityCache = null;

export function resetFreeformPlannerAvailabilityCache() {
  codexAvailabilityCache = null;
}

export function isCodexPlannerEnabled() {
  const mode = cleanId(process.env.TEAM_CREATE_PLANNER_MODE || 'auto');
  if (mode === 'off' || mode === 'disabled' || mode === 'false' || mode === '0') return false;
  if (mode === 'on' || mode === 'enabled' || mode === 'true' || mode === '1' || mode === 'codex') return true;
  if (codexAvailabilityCache !== null) return codexAvailabilityCache;
  try {
    const probe = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 1500 });
    codexAvailabilityCache = !probe.error && probe.status === 0;
  } catch {
    codexAvailabilityCache = false;
  }
  return codexAvailabilityCache;
}

function summarizeRuntimeAgents(runtime = null) {
  const rows = [
    ...asArray(runtime?.agentsCatalog),
    ...asArray(runtime?.agents),
  ];
  const seen = new Set();
  const out = [];
  for (const raw of rows) {
    const row = asObject(raw);
    const id = cleanId(row.id || row.agent_id || row.agentId || row.name);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: clean(row.name || row.id || row.agent_id || row.agentId),
      role: cleanId(row.role || row.system_key || row.role_id || row.roleId || 'researcher') || 'researcher',
      provider: cleanId(row.provider || ''),
      model: clean(row.model || ''),
      tools: asArray(row.tools || row.tool_ids || row.toolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
      skills: asArray(row.skills).map((entry) => cleanId(entry?.id || entry)).filter(Boolean).slice(0, 6),
    });
    if (out.length >= 18) break;
  }
  return out;
}

function summarizeSkills(skillRegistry = null) {
  const rows = skillRegistry?.list?.({ includeDisabled: false }) || [];
  return rows.slice(0, 24).map((skill) => ({
    skill_id: cleanId(skill?.id || skill?.skill_id || ''),
    label: clean(skill?.label || skill?.display_name || skill?.title || skill?.id),
    compatible_roles: asArray(skill?.compatible_roles).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 5),
    required_tools: asArray(skill?.required_tools).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 5),
  })).filter((row) => row.skill_id);
}

function summarizePresets(presetRegistry = null) {
  const rows = asArray(presetRegistry?.presets || presetRegistry?.list?.() || []);
  return rows.slice(0, 18).map((preset) => ({
    preset_id: cleanId(preset?.preset_id || preset?.id || ''),
    display_name: clean(preset?.display_name || preset?.label || preset?.name || preset?.preset_id),
    role: cleanId(preset?.role || preset?.role_id || ''),
    default_skill_ids: asArray(preset?.default_skill_ids).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 5),
    tool_hints: asArray(preset?.selection_features?.tool_hints).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 5),
    template_family: clean(preset?.template_family || ''),
    benchmark_source: clean(preset?.benchmark_source || ''),
  })).filter((row) => row.preset_id);
}

function buildCurrentRosterSummaryLines(team = null) {
  const agents = asArray(asObject(team).agents).map((agent) => ({
    name: clean(agent?.name),
    role: cleanId(agent?.role || agent?.role_id || agent?.roleId || 'researcher') || 'researcher',
    provider: cleanId(agent?.provider || ''),
    model: clean(agent?.model || ''),
    purpose: clean(agent?.purpose),
  })).filter((agent) => agent.name);
  if (agents.length === 0) return '(none)';
  return agents.map((agent, index) => `${index + 1}. ${agent.name} | ${agent.role} | ${agent.provider || 'provider?'} | ${agent.model || 'model?'} | ${agent.purpose || 'purpose?'}`).join('\n');
}

function normalizeDeclaredPlannerRole(raw = '') {
  const value = cleanId(raw);
  if (!value) return '';
  if (value === 'coder') return 'builder';
  if (value === 'critic_or_reviewer' || value === 'critic' || value === 'verifier') return 'reviewer';
  if (value === 'planner') return 'researcher';
  if (value === 'writer' || value === 'summarizer') return 'synthesizer';
  if (['researcher', 'builder', 'reviewer', 'synthesizer', 'operator'].includes(value)) return value;
  return '';
}

function buildPlannerPrompt({
  taskText = '',
  runtime = null,
  availableToolIds = [],
  skillRegistry = null,
  presetRegistry = null,
} = {}) {
  const catalog = summarizeRuntimeAgents(runtime);
  const skills = summarizeSkills(skillRegistry);
  const presets = summarizePresets(presetRegistry);
  const models = listSupportedModels().map((row) => clean(row.id)).filter(Boolean);
  return [
    'You are designing a multi-agent team for a runtime called ddalggak.',
    'Return JSON only. No markdown. No commentary outside JSON.',
    'Goal: translate the user\'s natural-language team request into a concrete team configuration that preserves interaction requirements, opposition requirements, and handoff structure.',
    '',
    'Hard constraints:',
    buildPlannerSchemaHintText(),
    '- team must have 1 to 6 agents',
    '- each agent role must be one of: researcher, builder, reviewer, synthesizer, operator',
    '- if the user asks for opposing views, counterarguments, debate, discussion, devil\'s advocate, or back-and-forth, DO NOT collapse to a single generalist researcher',
    '- if the request is about building or shipping software artifacts such as a web service, web app, frontend, backend, API, repository change, notebook, script, or implementation, include a builder with a concrete delivery purpose',
    '- for implementation/build teams, do not return a research-only roster; include builder coverage unless the user explicitly rejects code-writing agents',
    '- if multiple upstream agents exist, include a synthesizer unless the user explicitly rejects it',
    '- the declared final_answer_owner must name a real agent that can plausibly deliver the final answer; prefer a synthesizer or reviewer unless the user clearly asks otherwise',
    '- ensure the team can satisfy publish contract expectations: someone must be able to publish final_answer and at least one participant should be able to publish artifact_index (usually builder, synthesizer, reviewer, or operator)',
    '- when you emit structure_v2 participants, preserve provider, model, required_tool_ids, optional_tool_ids, recommended_tool_ids, and context_policy so install/apply does not lose execution metadata',
    '- prefer existing executable skill ids from the registry for attached_skill_ids',
    '- do not attach irrelevant domain-specific skills (for example KR equity analysis) unless the request actually targets that domain',
    '- when the registry does not fully cover the task, create generated_skill_briefs as inline non-executable protocols',
    '- choose models only from the supported model list',
    '- reviewer and synthesizer should usually prefer gpt-5.4; builder should usually prefer gpt-5-codex; researchers usually prefer gemini-2.5-pro unless the task requires heavier reasoning',
    '',
    'Output schema:',
    '{',
    '  "team_name": "...",',
    '  "reasoning_summary": ["..."] ,',
    '  "agents": [',
    '    {',
    '      "name": "...",',
    '      "role": "researcher|builder|reviewer|synthesizer|operator",',
    '      "purpose": "...",',
    '      "model": "...",',
    '      "provider": "gemini|codex|chatgpt",',
    '      "capabilities": ["human-readable capability labels"],',
    '      "attached_skill_ids": ["skill...."],',
    '      "generated_skill_briefs": [',
    '        {"label":"...","goal":"...","checklist":["...","..."]}',
    '      ],',
    '      "required_tool_ids": ["..."],',
    '      "optional_tool_ids": ["..."],',
    '      "context_policy": {',
    '        "reads": {"grants": ["shared_summary"], "context_types": ["evidence"], "query_template": "..."},',
    '        "writes": {"private_targets": ["scratch"], "publish_targets": ["handoff_summary"]},',
    '        "can_request_grants": ["conversation_tail"],',
    '        "default_budget": {"soft_tokens": 1600, "hard_tokens": 2600}',
    '      }',
    '    }',
    '  ],',
    '  "interaction_spec": {',
    '    "execution_pattern": "parallel_research_then_review_then_synthesize|multi_research_adjudication|sequential_pipeline|builder_reviewer_loop|operator_gated_workflow",',
    '    "final_answer_owner": "agent name",',
    '    "handoffs": [{"from":"...","to":"...","payload":"summary_plus_key_evidence"}],',
    '    "policies": {"reviewer_visibility":"...","synthesizer_visibility":"..."}',
    '  },',
    '  "shortcut_policy": {"enabled": true, "only_for_followups": true, "disallow_when_pending_approval": true},',
    '  "structure_v2": {',
    '    "kind": "team_structure_v2",',
    '    "version": 2,',
    '    "metadata": {"team_name": "...", "composition_mode": "freeform", "proposal_mode": "create"},',
    '    "participants": [{"participant_id": "...", "kind": "agent", "name": "...", "role": "researcher", "provider": "gemini|codex|chatgpt", "model": "...", "required_tool_ids": ["..."], "optional_tool_ids": ["..."], "recommended_tool_ids": ["..."], "context_policy": {"reads": {"grants": ["shared_summary"]}, "writes": {"publish_targets": ["handoff_summary"]}}}],',
    '    "topology": {"pattern": "router|supervisor|sequential|parallel|debate|committee|graph|hybrid", "execution_pattern": "...", "edges": [{"from": "...", "to": "...", "payload": "summary_plus_key_evidence"}]},',
    '    "interaction_policy": {"visibility": {"reviewer_visibility": "...", "synthesizer_visibility": "..."}},',
    '    "knowledge_surface": {"profile_id": "...", "display_name": "...", "docs": [{"doc_id": "plan", "file_name": "..."}]},',
    '    "memory_policy": {"stable_semantic_slots": ["decisions", "artifacts"], "migration_strategy": "semantic_slot_preserving"},',
    '    "control_policy": {"runtime_execution": {"continuous_improvement": {"enabled": false, "max_turns": 8}}}',
    '  }',
    '}',
    '',
    `User request: ${clean(taskText)}`,
    '',
    `Supported models: ${models.join(', ')}`,
    `Available tools: ${asArray(availableToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 24).join(', ') || '(none listed)'}`,
    '',
    `Runtime catalog: ${compactPromptJson(catalog, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
    `Skill registry sample: ${compactPromptJson(skills, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
    `Preset registry sample: ${compactPromptJson(presets, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
  ].join('\n');
}


function summarizeTeamForPlanner(team = null) {
  const row = asObject(team);
  const structure = row.structure_v2 || row.structureV2;
  const source = structure && typeof structure === 'object' ? { ...row, ...deriveTeamConfigFromStructureV2(structure) } : row;
  const interactionSpec = asObject(source.interaction_spec || source.interactionSpec);
  const runtimeExecution = asObject(source.runtime_execution || source.runtimeExecution || structure?.control_policy?.runtime_execution || structure?.control_policy?.runtimeExecution);
  const memoryPlan = asObject(source.memory_plan || source.memoryPlan || structure?.memory_plan || structure?.memoryPlan);
  return {
    team_name: clean(source.team_name || source.teamName || ''),
    task_brief: clean(source.task_brief || source.taskBrief || source.task || source.design_prompt || source.designPrompt || ''),
    agents: asArray(source.agents).slice(0, 10).map((agent) => ({
      name: clean(agent?.name),
      role: cleanId(agent?.role || agent?.role_id || agent?.roleId || 'researcher') || 'researcher',
      purpose: clean(agent?.purpose),
      model: clean(agent?.model),
      provider: cleanId(agent?.provider || ''),
      attached_skill_ids: asArray(agent?.attached_skill_ids || agent?.attachedSkillIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 4),
      generated_skill_labels: asArray(agent?.generated_skill_briefs || agent?.generatedSkillBriefs).map((entry) => clean(entry?.label || entry?.name || entry?.title)).filter(Boolean).slice(0, 2),
      required_tool_ids: asArray(agent?.required_tool_ids || agent?.requiredToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 4),
      optional_tool_ids: asArray(agent?.optional_tool_ids || agent?.optionalToolIds || agent?.recommended_tool_ids || agent?.recommendedToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 4),
      context_policy: asObject(agent?.context_policy || agent?.contextPolicy),
    })).filter((agent) => agent.name),
    interaction_spec: {
      execution_pattern: cleanId(interactionSpec.execution_pattern || interactionSpec.executionPattern || ''),
      reviewer_visibility: cleanId(interactionSpec.reviewer_visibility || interactionSpec.reviewerVisibility || ''),
      builder_direct_response: interactionSpec.builder_direct_response === true,
      final_answer_owner: clean(interactionSpec.final_answer_owner || interactionSpec.finalAnswerOwner || ''),
      handoffs: asArray(interactionSpec.handoffs).slice(0, 12).map((handoff) => ({
        from: clean(handoff?.from),
        to: clean(handoff?.to),
        payload: clean(handoff?.payload),
      })),
    },
    shortcut_policy: asObject(source.shortcut_policy || source.shortcutPolicy),
    memory_surfaces: asArray(memoryPlan.surfaces).slice(0, 10).map((surface) => ({
      surface_id: cleanId(surface?.surface_id || surface?.surfaceId || ''),
      target_roles: asArray(surface?.target_roles || surface?.targetRoles).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 4),
      load_policy: cleanId(surface?.load_policy || surface?.loadPolicy || ''),
      write_policy: cleanId(surface?.write_policy || surface?.writePolicy || ''),
    })),
    runtime_execution: {
      approval_mode: cleanId(runtimeExecution.approval_mode || runtimeExecution.approvalMode || ''),
      provider_runtime_policy: cleanId(runtimeExecution.provider_runtime_policy || runtimeExecution.providerRuntimePolicy || ''),
      memory_strategy: cleanId(runtimeExecution.memory_strategy || runtimeExecution.memoryStrategy || ''),
    },
    publish_contract: {
      final_answer_owner: clean(interactionSpec.final_answer_owner || interactionSpec.finalAnswerOwner || ''),
      final_answer_publish_roles: asArray(memoryPlan.surfaces).filter((surface) => cleanId(surface?.surface_id || surface?.surfaceId || '') === 'final_answer' || asArray(surface?.semantic_slots || surface?.semanticSlots).map((entry) => cleanId(entry)).includes('final_answer')).flatMap((surface) => asArray(surface?.target_roles || surface?.targetRoles)).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
      artifact_publish_roles: asArray(memoryPlan.surfaces).filter((surface) => cleanId(surface?.surface_id || surface?.surfaceId || '') === 'artifact_index' || asArray(surface?.semantic_slots || surface?.semanticSlots).map((entry) => cleanId(entry)).includes('artifact_index')).flatMap((surface) => asArray(surface?.target_roles || surface?.targetRoles)).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
    },
    topology: structure && typeof structure === 'object'
      ? {
          pattern: cleanId(structure?.topology?.pattern || ''),
          execution_pattern: cleanId(structure?.topology?.execution_pattern || structure?.topology?.executionPattern || ''),
          final_participant_id: cleanId(structure?.topology?.final_participant_id || structure?.topology?.finalParticipantId || ''),
          participant_count: asArray(structure?.participants).length,
        }
      : undefined,
    planner_metadata: {
      planner_type: clean(source?.planner_metadata?.planner_type || source?.plannerMetadata?.planner_type || source?.plannerMetadata?.plannerType || ''),
      planning_source: clean(source?.planner_metadata?.planning_source || source?.plannerMetadata?.planning_source || source?.plannerMetadata?.planningSource || ''),
      reasoning_summary: asArray(source?.planner_metadata?.reasoning_summary || source?.plannerMetadata?.reasoning_summary || source?.plannerMetadata?.reasoningSummary).map((entry) => clean(entry)).filter(Boolean).slice(0, 6),
    },
  };
}

function buildRefinementPlannerPrompt({
  currentTeam = null,
  instruction = '',
  runtime = null,
  availableToolIds = [],
  skillRegistry = null,
  presetRegistry = null,
} = {}) {
  const catalog = summarizeRuntimeAgents(runtime);
  const skills = summarizeSkills(skillRegistry);
  const presets = summarizePresets(presetRegistry);
  const models = listSupportedModels().map((row) => clean(row.id)).filter(Boolean);
  const current = summarizeTeamForPlanner(currentTeam);
  return [
    'You are refining an existing ddalggak multi-agent team.',
    'Return JSON only. No markdown. No commentary outside JSON.',
    'Goal: update the current team in response to the refinement instruction while preserving useful existing agents and revising both agent roster and interaction design when necessary.',
    '',
    'Refinement rules:',
    buildPlannerSchemaHintText(),
    '- return the full next team, not a patch',
    '- preserve existing strong agents unless the instruction clearly asks to remove or replace them',
    '- if the user asks for coding, notebook work, IPython, Jupyter, implementation, a web service, web app, frontend, backend, API, repository work, or a Coder Agent, include a builder agent with a concrete delivery purpose',
    '- if the refinement still describes a build/implementation team, do not keep a research-only roster; preserve or add builder coverage unless the user explicitly removes code-writing roles',
    '- consider interaction_spec as first-class: update handoffs, execution_pattern, rebuttal/adjudication shape, reviewer_visibility, synthesizer_visibility, builder_direct_response, and final_answer_owner when the refinement implies a new workflow',
    '- if multiple upstream agents remain, keep or add a synthesizer unless the user rejects it',
    '- keep publish contract alignment intact: final_answer_owner should remain an actual publish-capable agent, and the resulting team should still have at least one artifact_index publisher',
    '- when you omit an existing agent, that omission is treated as removal; for minor edits like model/provider/tool changes preserve the rest of the roster and its required/optional tools',
    '- if the instruction only changes the model/provider/tools of one existing agent, keep the roster identical: same agent count, same agent names, same roles, same final_answer_owner, same handoff structure unless the instruction explicitly says otherwise',
    '- do not summarize preserved agents away in refine mode; untouched agents must still be returned in the full agents array',
    '- prefer existing executable skill ids from the registry for attached_skill_ids',
    '- do not attach irrelevant domain-specific skills (for example KR equity analysis) unless the refinement actually asks for that domain',
    '- when the registry does not fully cover the task, create generated_skill_briefs as inline non-executable protocols',
    '- choose models only from the supported model list',
    '',
    'Output schema:',
    '{',
    '  "team_name": "...",',
    '  "reasoning_summary": ["..."],',
    '  "agents": [',
    '    {',
    '      "name": "...",',
    '      "role": "researcher|builder|reviewer|synthesizer|operator",',
    '      "purpose": "...",',
    '      "model": "...",',
    '      "provider": "gemini|codex|chatgpt",',
    '      "capabilities": ["human-readable capability labels"],',
    '      "attached_skill_ids": ["skill...."],',
    '      "generated_skill_briefs": [{"label":"...","goal":"...","checklist":["...","..."]}],',
    '      "required_tool_ids": ["..."],',
    '      "optional_tool_ids": ["..."],',
    '      "context_policy": {',
    '        "reads": {"grants": ["shared_summary"], "context_types": ["evidence"], "query_template": "..."},',
    '        "writes": {"private_targets": ["scratch"], "publish_targets": ["handoff_summary"]},',
    '        "can_request_grants": ["conversation_tail"],',
    '        "default_budget": {"soft_tokens": 1600, "hard_tokens": 2600}',
    '      }',
    '    }',
    '  ],',
    '  "interaction_spec": {',
    '    "execution_pattern": "parallel_research_then_review_then_synthesize|multi_research_adjudication|sequential_pipeline|builder_reviewer_loop",',
    '    "final_answer_owner": "agent name",',
    '    "handoffs": [{"from":"...","to":"...","payload":"summary_plus_key_evidence"}],',
    '    "policies": {"reviewer_visibility":"...","synthesizer_visibility":"...","builder_direct_response":false}',
    '  },',
    '  "shortcut_policy": {"enabled": true, "only_for_followups": true, "disallow_when_pending_approval": true},',
    '  "knowledge_surface": {"profile_id": "...", "display_name": "...", "docs": [{"doc_id": "plan", "file_name": "..."}]},',
    '  "memory_policy": {"stable_semantic_slots": ["decisions", "artifacts"], "migration_strategy": "semantic_slot_preserving"},',
    '  "runtime_execution": {"continuous_improvement": {"enabled": false, "max_turns": 8}}',
    '}',
    '',
    `Current team: ${compactPromptJson(current, { maxDepth: 4, maxItems: 14, maxStringChars: 140 })}`,
    `Current roster count: ${asArray(current.agents).length}`,
    `Current roster (preserve unless explicit removal):
${buildCurrentRosterSummaryLines(currentTeam)}`,
    `Refinement instruction: ${clean(instruction)}`,
    '',
    `Supported models: ${models.join(', ')}`,
    `Available tools: ${asArray(availableToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 24).join(', ') || '(none listed)'}`,
    '',
    `Runtime catalog: ${compactPromptJson(catalog, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
    `Skill registry sample: ${compactPromptJson(skills, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
    `Preset registry sample: ${compactPromptJson(presets, { maxDepth: 3, maxItems: 12, maxStringChars: 120 })}`,
  ].join('\n');
}

function normalizeGeneratedSkillBriefs(rows = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(rows)) {
    const row = asObject(raw);
    const label = clean(row.label || row.name || row.title);
    if (!label) continue;
    const key = cleanId(label);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      label,
      goal: clean(row.goal || row.objective || row.description),
      checklist: asArray(row.checklist || row.steps).map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
      selected_by: 'gpt_5_4_team_planner',
      executable: false,
    });
  }
  return out.slice(0, 3);
}

function inferPlannerRole(raw = {}) {
  const item = asObject(raw);
  for (const candidate of [item.role, item.role_id, item.roleId]) {
    const explicit = normalizeDeclaredPlannerRole(candidate);
    if (explicit) return explicit;
  }
  const value = [item.name, item.display_name, item.agent_name, item.purpose, item.goal, item.description, item.model].filter(Boolean).join(' ').toLowerCase();
  if (/(^|[^a-z])(builder|coder|developer|implementer|frontend|backend|fullstack|engineer)([^a-z]|$)|구현|코더|개발자|빌더/.test(value)) return 'builder';
  if (/(^|[^a-z])(reviewer|review|critic|verifier|quality|qa)([^a-z]|$)|리뷰어|검토|검수|비평|품질/.test(value)) return 'reviewer';
  if (/(^|[^a-z])(synthesizer|synth|summarizer|summary|writer|delivery)([^a-z]|$)|요약|정리|합성|전달/.test(value)) return 'synthesizer';
  if (/(^|[^a-z])(operator|coordinator|orchestrator|router|manager)([^a-z]|$)|운영|조정|오퍼레이터/.test(value)) return 'operator';
  if (/(^|[^a-z])(researcher|scout|analyst|investigator|planner|research)([^a-z]|$)|조사|연구|분석|스카우트/.test(value)) return 'researcher';
  return normalizeDeclaredPlannerRole(item.role || item.role_id || item.roleId || 'researcher') || 'researcher';
}

function normalizePlannerPlan(raw = {}) {
  const row = asObject(raw);
  const rawStructure = row.structure_v2 || row.structureV2;
  const structure = rawStructure && typeof rawStructure === 'object' ? normalizeTeamStructureV2(rawStructure) : null;
  const derived = structure ? deriveTeamConfigFromStructureV2(structure) : {};
  const source = structure ? { ...row, ...derived } : row;
  return {
    team_name: clean(source.team_name || source.teamName || 'freeform_team'),
    reasoning_summary: asArray(source.reasoning_summary || source.rationale || source.why).map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
    agents: asArray(source.agents).map((agent) => {
      const item = asObject(agent);
      return {
        name: clean(item.name || item.display_name || item.agent_name),
        role: inferPlannerRole(item),
        purpose: clean(item.purpose || item.goal || item.description),
        model: clean(item.model),
        provider: cleanId(item.provider || ''),
        capabilities: asArray(item.capabilities || item.skill_labels).map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
        attached_skill_ids: asArray(item.attached_skill_ids || item.attachedSkillIds || item.skills).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        generated_skill_briefs: normalizeGeneratedSkillBriefs(item.generated_skill_briefs || item.generatedSkillBriefs || []),
        required_tool_ids: asArray(item.required_tool_ids || item.requiredToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        optional_tool_ids: asArray(item.optional_tool_ids || item.optionalToolIds || item.recommended_tool_ids || item.recommendedToolIds || item.tools).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        recommended_tool_ids: asArray(item.recommended_tool_ids || item.recommendedToolIds || item.tools || [...asArray(item.required_tool_ids || item.requiredToolIds), ...asArray(item.optional_tool_ids || item.optionalToolIds)]).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        context_policy: asObject(item.context_policy || item.contextPolicy),
      };
    }).filter((agent) => agent.name),
    interaction_spec: asObject(source.interaction_spec || source.interactionSpec),
    shortcut_policy: asObject(source.shortcut_policy || source.shortcutPolicy),
    memory_plan: asObject(source.memory_plan || source.memoryPlan || structure?.memory_plan || structure?.memoryPlan),
    knowledge_surface: asObject(source.knowledge_surface || source.knowledgeSurface || structure?.knowledge_surface || structure?.knowledgeSurface),
    memory_policy: asObject(source.memory_policy || source.memoryPolicy || structure?.memory_policy || structure?.memoryPolicy),
    runtime_execution: asObject(source.runtime_execution || source.runtimeExecution || structure?.control_policy?.runtime_execution || structure?.control_policy?.runtimeExecution),
    structure_v2: structure || undefined,
  };
}

export async function planFreeformTeamWithCodex({
  taskText = '',
  runtime = null,
  availableToolIds = [],
  skillRegistry = null,
  presetRegistry = null,
  workspaceRoot = process.cwd(),
  jobId = '',
} = {}) {
  if (!isCodexPlannerEnabled()) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildPlannerPrompt({ taskText, runtime, availableToolIds, skillRegistry, presetRegistry });
  const cleanJobId = clean(jobId);
  if (cleanJobId) {
    appendPromptTelemetry({
      jobDir: runDir(cleanJobId),
      sharedDir: runSharedDir(cleanJobId),
      row: {
        kind: 'planner_prompt',
        surface_id: 'team_create_planner',
        surface_label: 'team_create_planner',
        provider: 'codex',
        model: process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4',
        agent_id: 'team_create_planner',
        role_id: 'planner',
        prompt_text: prompt,
        components: {
          user_request: clean(taskText),
          runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          preset_registry: compactPromptJson(summarizePresets(presetRegistry), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          available_tools: asArray(availableToolIds).join(', '),
        },
      },
    });
  }
  let result;
  try {
    result = await runCodexExec({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: 'team-create-planner',
      model: process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4',
    });
  } catch (error) {
    return { ok: false, reason: `planner_exec_exception:${String(error?.message || error)}` };
  }
  if (!result?.ok) {
    return { ok: false, reason: `planner_exec_failed:${clean(result?.stderr || result?.stdout || 'unknown')}` };
  }
  const parsed = parseJsonObjectFromText(result.stdout || result.stderr || '');
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'planner_parse_failed', raw_output: clean(result.stdout || result.stderr || '') };
  }
  const normalized = normalizePlannerPlan(parsed);
  if (!normalized.agents.length) {
    return { ok: false, reason: 'planner_returned_no_agents', raw_output: clean(result.stdout || result.stderr || '') };
  }
  return {
    ok: true,
    plan: normalized,
    planner_metadata: {
      planner_type: 'codex_cli',
      planner_model: clean(process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4') || 'gpt-5.4',
      planning_source: 'codex_gpt_5_4',
      reasoning_summary: normalized.reasoning_summary,
    },
  };
}


export async function planTeamRefinementWithCodex({
  currentTeam = null,
  instruction = '',
  runtime = null,
  availableToolIds = [],
  skillRegistry = null,
  presetRegistry = null,
  workspaceRoot = process.cwd(),
  jobId = '',
} = {}) {
  if (!isCodexPlannerEnabled()) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildRefinementPlannerPrompt({ currentTeam, instruction, runtime, availableToolIds, skillRegistry, presetRegistry });
  const cleanJobId = clean(jobId);
  if (cleanJobId) {
    appendPromptTelemetry({
      jobDir: runDir(cleanJobId),
      sharedDir: runSharedDir(cleanJobId),
      row: {
        kind: 'planner_prompt',
        surface_id: 'team_refine_planner',
        surface_label: 'team_refine_planner',
        provider: 'codex',
        model: process.env.TEAM_REFINE_PLANNER_MODEL || process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4',
        agent_id: 'team_refine_planner',
        role_id: 'planner',
        prompt_text: prompt,
        components: {
          refinement_instruction: clean(instruction),
          current_team: compactPromptJson(summarizeTeamForPlanner(currentTeam), { maxDepth: 4, maxItems: 12, maxStringChars: 140 }),
          current_roster_lines: buildCurrentRosterSummaryLines(currentTeam),
          runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          preset_registry: compactPromptJson(summarizePresets(presetRegistry), { maxDepth: 3, maxItems: 10, maxStringChars: 120 }),
          available_tools: asArray(availableToolIds).join(', '),
        },
      },
    });
  }
  let result;
  try {
    result = await runCodexExec({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: 'team-refine-planner',
      model: process.env.TEAM_REFINE_PLANNER_MODEL || process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4',
    });
  } catch (error) {
    return { ok: false, reason: `planner_exec_exception:${String(error?.message || error)}` };
  }
  if (!result?.ok) {
    return { ok: false, reason: `planner_exec_failed:${clean(result?.stderr || result?.stdout || 'unknown')}` };
  }
  const parsed = parseJsonObjectFromText(result.stdout || result.stderr || '');
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'planner_parse_failed', raw_output: clean(result.stdout || result.stderr || '') };
  }
  const normalized = normalizePlannerPlan(parsed);
  if (!normalized.agents.length) {
    return { ok: false, reason: 'planner_returned_no_agents', raw_output: clean(result.stdout || result.stderr || '') };
  }
  return {
    ok: true,
    plan: normalized,
    planner_metadata: {
      planner_type: 'codex_cli',
      planner_model: clean(process.env.TEAM_REFINE_PLANNER_MODEL || process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4') || 'gpt-5.4',
      planning_source: 'codex_gpt_5_4_refine',
      reasoning_summary: normalized.reasoning_summary,
    },
  };
}
