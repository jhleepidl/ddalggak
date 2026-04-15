import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runCodexExec } from '../codex.js';
import { parseJsonObjectFromText } from '../shared/json_extract.js';
import { listSupportedModels } from '../catalog/model_catalog.js';
import { normalizeTeamStructureV2, deriveTeamConfigFromStructureV2 } from '../shared/team_structure_v2.js';
import { buildPlannerSchemaHintText } from '../shared/team_schema_catalog.js';
import { appendPromptTelemetry } from './prompt_telemetry.js';
import { runDir, runSharedDir } from './telegram_runtime_state.js';
import { compactPromptJson } from './prompt_surface_builder.js';
import { normalizeParticipantExecutionSchema } from '../shared/participant_schema.js';
import { inferExecutionRoleFromText } from '../shared/work_intent.js';
import { buildPlannerCreateConstraintLines, buildPlannerOutputSchemaLines, buildPlannerRefinementRuleLines } from './planner_prompt_fragments.js';

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

function codexCandidateNames() {
  if (process.platform !== 'win32') return ['codex'];
  const exts = clean(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((entry) => clean(entry).toLowerCase())
    .filter(Boolean);
  const out = ['codex'];
  for (const ext of exts) out.push(`codex${ext}`);
  return out;
}

function isExecutableFile(target) {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    fs.accessSync(target, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function hasCodexBinaryOnPath() {
  const pathValue = clean(process.env.PATH);
  if (!pathValue) return false;
  const entries = pathValue.split(path.delimiter).map((entry) => clean(entry)).filter(Boolean);
  const candidates = codexCandidateNames();
  for (const entry of entries) {
    for (const candidate of candidates) {
      if (isExecutableFile(path.join(entry, candidate))) return true;
    }
  }
  return false;
}

export function resetFreeformPlannerAvailabilityCache() {
  codexAvailabilityCache = null;
}

export function isCodexPlannerEnabled() {
  const mode = cleanId(process.env.TEAM_CREATE_PLANNER_MODE || 'auto');
  if (mode === 'off' || mode === 'disabled' || mode === 'false' || mode === '0') return false;
  if (mode === 'on' || mode === 'enabled' || mode === 'true' || mode === '1' || mode === 'codex') return true;
  if (codexAvailabilityCache !== null) return codexAvailabilityCache;
  codexAvailabilityCache = hasCodexBinaryOnPath();
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
      role: cleanId(row.role || row.system_key || row.role_id || row.roleId || 'researcher') || 'researcher',
      provider: cleanId(row.provider || ''),
      model: clean(row.model || ''),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function summarizeSkills(skillRegistry = null) {
  const rows = skillRegistry?.list?.({ includeDisabled: false }) || [];
  return rows.slice(0, 8).map((skill) => ({
    skill_id: cleanId(skill?.id || skill?.skill_id || ''),
    label: clean(skill?.label || skill?.display_name || skill?.title || skill?.id),
    compatible_roles: asArray(skill?.compatible_roles).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 4),
  })).filter((row) => row.skill_id);
}

function summarizeRefinementCurrentTeam(team = null) {
  const current = summarizeTeamForPlanner(team);
  const interaction = asObject(current.interaction_spec);
  const policies = asObject(interaction.policies);
  return {
    team_name: clean(current.team_name),
    task_brief: clean(current.task_brief),
    agents: asArray(current.agents).slice(0, 8).map((agent) => ({
      name: clean(agent.name),
      role: cleanId(agent.role),
      provider: cleanId(agent.provider),
      model: clean(agent.model),
      purpose: clean(agent.purpose),
      attached_skill_ids: asArray(agent.attached_skill_ids).slice(0, 3),
      runtime_capabilities_required: asArray(agent.runtime_capabilities_required).slice(0, 3),
      runtime_capabilities_optional: asArray(agent.runtime_capabilities_optional).slice(0, 2),
      external_tool_requirements: asArray(agent.external_tool_requirements).slice(0, 3),
      external_tool_preferences: asArray(agent.external_tool_preferences).slice(0, 2),
    })),
    interaction_spec: {
      execution_pattern: cleanId(interaction.execution_pattern),
      final_answer_owner: clean(interaction.final_answer_owner),
      handoffs: asArray(interaction.handoffs).slice(0, 5).map((handoff) => ({
        from: clean(handoff?.from),
        to: clean(handoff?.to),
        payload: cleanId(handoff?.payload),
      })),
      policies: {
        reviewer_visibility: cleanId(policies.reviewer_visibility),
        synthesizer_visibility: cleanId(policies.synthesizer_visibility),
        builder_direct_response: policies.builder_direct_response === true,
      },
    },
  };
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
  preferredTaskArchetype = '',
} = {}) {
  const catalog = summarizeRuntimeAgents(runtime);
  const skills = summarizeSkills(skillRegistry);
  const models = listSupportedModels().map((row) => clean(row.id)).filter(Boolean);
  return [
    'You are designing a multi-agent team for a runtime called ddalggak.',
    'Return JSON only. No markdown. No commentary outside JSON.',
    'Goal: translate the user request into a concrete team configuration.',
    '',
    'Hard constraints:',
    buildPlannerSchemaHintText(),
    ...buildPlannerCreateConstraintLines(),
    '',
    ...buildPlannerOutputSchemaLines({ proposalMode: 'create' }),
    '',
    `User request: ${clean(taskText)}`,
    '',
    `Supported models: ${models.join(', ')}`,
    `Available tools: ${asArray(availableToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 10).join(', ') || '(none listed)'}`,
    catalog.length ? `Runtime catalog (compact): ${compactPromptJson(catalog, { maxDepth: 2, maxItems: 6, maxStringChars: 72 })}` : '',
    skills.length ? `Skill registry sample (compact): ${compactPromptJson(skills, { maxDepth: 2, maxItems: 6, maxStringChars: 72 })}` : '',
  ].filter(Boolean).join('\n');
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
      ...(() => { const execution = normalizeParticipantExecutionSchema(agent); return { runtime_capabilities_required: execution.runtime_capabilities_required.slice(0, 4), runtime_capabilities_optional: execution.runtime_capabilities_optional.slice(0, 4), external_tool_requirements: execution.external_tool_requirements.slice(0, 4), external_tool_preferences: execution.external_tool_preferences.slice(0, 4) }; })(),
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
  preferredTaskArchetype = '',
} = {}) {
  const catalog = summarizeRuntimeAgents(runtime);
  const skills = summarizeSkills(skillRegistry);
  const models = listSupportedModels().map((row) => clean(row.id)).filter(Boolean);
  const current = summarizeRefinementCurrentTeam(currentTeam);
  return [
    'You are refining an existing ddalggak multi-agent team.',
    'Return JSON only. No markdown. No commentary outside JSON.',
    'Goal: update the current team in response to the refinement instruction while preserving useful existing agents and revising roster/interaction only when necessary.',
    '',
    'Refinement rules:',
    buildPlannerSchemaHintText(),
    ...buildPlannerRefinementRuleLines(),
    '',
    ...buildPlannerOutputSchemaLines({ proposalMode: 'refine', compactParticipants: true }),
    '',
    `Current team (compact): ${compactPromptJson(current, { maxDepth: 3, maxItems: 10, maxStringChars: 110 })}`,
    `Current roster (preserve unless explicit removal):
${buildCurrentRosterSummaryLines(currentTeam)}`,
    `Refinement instruction: ${clean(instruction)}`,
    '',
    `Supported models: ${models.join(', ')}`,
    `Available tools: ${asArray(availableToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 10).join(', ') || '(none listed)'}`,
    catalog.length ? `Runtime catalog (compact): ${compactPromptJson(catalog, { maxDepth: 2, maxItems: 6, maxStringChars: 72 })}` : '',
    skills.length ? `Skill registry sample (compact): ${compactPromptJson(skills, { maxDepth: 2, maxItems: 6, maxStringChars: 72 })}` : '',
  ].filter(Boolean).join('\n');
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
  return inferExecutionRoleFromText([
    item.name,
    item.display_name,
    item.agent_name,
    item.purpose,
    item.goal,
    item.description,
    item.model,
  ].filter(Boolean).join(' '), { fallback: normalizeDeclaredPlannerRole(item.role || item.role_id || item.roleId || 'researcher') || 'researcher' }) || 'researcher';
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
        ...(() => { const execution = normalizeParticipantExecutionSchema(item); return { runtime_capabilities_required: execution.runtime_capabilities_required.slice(0, 6), runtime_capabilities_optional: execution.runtime_capabilities_optional.slice(0, 6), external_tool_requirements: execution.external_tool_requirements.slice(0, 6), external_tool_preferences: execution.external_tool_preferences.slice(0, 6) }; })(),
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
  preferredTaskArchetype = '',
  workspaceRoot = process.cwd(),
  jobId = '',
} = {}) {
  if (!isCodexPlannerEnabled()) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildPlannerPrompt({ taskText, runtime, availableToolIds, skillRegistry, preferredTaskArchetype });
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
          runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
          skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
          available_tools: asArray(availableToolIds).slice(0, 10).join(', '),
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
  preferredTaskArchetype = '',
  workspaceRoot = process.cwd(),
  jobId = '',
} = {}) {
  if (!isCodexPlannerEnabled()) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildRefinementPlannerPrompt({ currentTeam, instruction, runtime, availableToolIds, skillRegistry, preferredTaskArchetype });
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
          current_team: compactPromptJson(summarizeTeamForPlanner(currentTeam), { maxDepth: 3, maxItems: 10, maxStringChars: 100 }),
          current_roster_lines: buildCurrentRosterSummaryLines(currentTeam),
          runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
          skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
          available_tools: asArray(availableToolIds).slice(0, 10).join(', '),
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
