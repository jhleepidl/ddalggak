import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { runCodexExec } from '../codex.js';
import { runGeminiPrompt } from '../gemini.js';
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

let plannerAvailabilityCache = new Map();

function executableCandidateNames(baseName = '') {
  const root = clean(baseName);
  if (!root) return [];
  if (process.platform !== 'win32') return [root];
  const exts = clean(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
    .split(';')
    .map((entry) => clean(entry).toLowerCase())
    .filter(Boolean);
  return [root, ...exts.map((ext) => root + ext)];
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

function hasExecutableOnPath(binaryName = '') {
  const pathValue = clean(process.env.PATH);
  if (!pathValue) return false;
  const entries = pathValue.split(path.delimiter).map((entry) => clean(entry)).filter(Boolean);
  const candidates = executableCandidateNames(binaryName);
  for (const entry of entries) {
    for (const candidate of candidates) {
      if (isExecutableFile(path.join(entry, candidate))) return true;
    }
  }
  return false;
}

export function resetFreeformPlannerAvailabilityCache() {
  plannerAvailabilityCache = new Map();
}

function normalizedPlannerMode() {
  const value = cleanId(process.env.TEAM_CREATE_PLANNER_MODE || process.env.TEAM_PLANNER_MODE || 'auto');
  if (value === 'off' || value === 'disabled' || value === 'false' || value === '0' || value === 'none') return 'off';
  if (value === 'on' || value === 'enabled' || value === 'true' || value === '1') return 'auto';
  if (['auto', 'codex', 'gemini', 'llm'].includes(value)) return value;
  return 'auto';
}

function plannerProviderPreference(kind = 'create') {
  const specific = kind === 'refine' ? process.env.TEAM_REFINE_PLANNER_PROVIDER : process.env.TEAM_CREATE_PLANNER_PROVIDER;
  const raw = cleanId(specific || process.env.TEAM_PLANNER_PROVIDER || 'auto');
  if (raw === 'off' || raw === 'disabled' || raw === 'none') return [];
  if (raw === 'gemini') return ['gemini'];
  if (raw === 'codex' || raw === 'chatgpt' || raw === 'openai') return ['codex'];
  // Team design is a reasoning task, not a code-writing task. Prefer Gemini when
  // available so /team suggest does not silently degrade to static templates on
  // servers where Codex is only installed for workspace execution or is absent.
  return ['gemini', 'codex'];
}

function isPlannerProviderAvailable(provider = '') {
  const key = cleanId(provider);
  if (!key) return false;
  const mode = normalizedPlannerMode();
  if (mode === 'off') return false;
  if (mode === 'codex' && key !== 'codex') return false;
  if (mode === 'gemini' && key !== 'gemini') return false;
  const cacheKey = mode + ':' + key + ':' + (process.env.PATH || '');
  if (plannerAvailabilityCache.has(cacheKey)) return plannerAvailabilityCache.get(cacheKey);
  const binary = key === 'gemini' ? 'gemini' : key === 'codex' ? 'codex' : '';
  const available = Boolean(binary && hasExecutableOnPath(binary));
  plannerAvailabilityCache.set(cacheKey, available);
  return available;
}

export function isLlmTeamPlannerEnabled(kind = 'create') {
  return plannerProviderPreference(kind).some((provider) => isPlannerProviderAvailable(provider));
}

export function isCodexPlannerEnabled() {
  return isPlannerProviderAvailable('codex');
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


function plannerModelForProvider(provider = '', kind = 'create') {
  const key = cleanId(provider);
  const specific = kind === 'refine'
    ? process.env.TEAM_REFINE_PLANNER_MODEL
    : process.env.TEAM_CREATE_PLANNER_MODEL;
  if (key === 'gemini') {
    return clean((kind === 'refine' ? process.env.TEAM_REFINE_GEMINI_PLANNER_MODEL : process.env.TEAM_CREATE_GEMINI_PLANNER_MODEL)
      || process.env.TEAM_GEMINI_PLANNER_MODEL
      || (/^gemini/i.test(clean(specific)) ? specific : '')
      || process.env.GEMINI_MODEL
      || 'gemini-3-flash-preview');
  }
  if (key === 'codex') {
    return clean((kind === 'refine' ? process.env.TEAM_REFINE_CODEX_PLANNER_MODEL : process.env.TEAM_CREATE_CODEX_PLANNER_MODEL)
      || process.env.TEAM_CODEX_PLANNER_MODEL
      || specific
      || 'gpt-5.4');
  }
  return clean(specific || '');
}

function plannerTimeoutMs(kind = 'create') {
  const raw = kind === 'refine'
    ? (process.env.TEAM_REFINE_PLANNER_TIMEOUT_MS || process.env.TEAM_CREATE_PLANNER_TIMEOUT_MS)
    : process.env.TEAM_CREATE_PLANNER_TIMEOUT_MS;
  const value = Number(raw || 0);
  return Number.isFinite(value) && value > 0 ? value : 30000;
}

function plannerSourceForProvider(provider = '', kind = 'create') {
  const key = cleanId(provider);
  const suffix = kind === 'refine' ? '_refine' : '';
  if (key === 'gemini') return 'gemini_cli_team_planner' + suffix;
  if (key === 'codex') return 'codex_cli_team_planner' + suffix;
  return 'llm_team_planner' + suffix;
}

function appendPlannerPromptTelemetry({ kind = 'create', provider = '', model = '', prompt = '', jobId = '', taskText = '', instruction = '', currentTeam = null, runtime = null, availableToolIds = [], skillRegistry = null } = {}) {
  const cleanJobId = clean(jobId);
  if (!cleanJobId) return;
  const isRefine = kind === 'refine';
  appendPromptTelemetry({
    jobDir: runDir(cleanJobId),
    sharedDir: runSharedDir(cleanJobId),
    row: {
      kind: 'planner_prompt',
      surface_id: isRefine ? 'team_refine_planner' : 'team_create_planner',
      surface_label: isRefine ? 'team_refine_planner' : 'team_create_planner',
      provider: cleanId(provider),
      model: clean(model),
      agent_id: isRefine ? 'team_refine_planner' : 'team_create_planner',
      role_id: 'planner',
      prompt_text: prompt,
      components: isRefine ? {
        refinement_instruction: clean(instruction),
        current_team: compactPromptJson(summarizeTeamForPlanner(currentTeam), { maxDepth: 3, maxItems: 10, maxStringChars: 100 }),
        current_roster_lines: buildCurrentRosterSummaryLines(currentTeam),
        runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
        skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
        available_tools: asArray(availableToolIds).slice(0, 10).join(', '),
      } : {
        user_request: clean(taskText),
        runtime_catalog: compactPromptJson(summarizeRuntimeAgents(runtime), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
        skill_registry: compactPromptJson(summarizeSkills(skillRegistry), { maxDepth: 2, maxItems: 6, maxStringChars: 72 }),
        available_tools: asArray(availableToolIds).slice(0, 10).join(', '),
      },
    },
  });
}

async function runPlannerProvider({ provider = '', kind = 'create', prompt = '', workspaceRoot = process.cwd(), jobId = '' } = {}) {
  const key = cleanId(provider);
  const model = plannerModelForProvider(key, kind);
  const timeoutMs = plannerTimeoutMs(kind);
  if (key === 'gemini') {
    return await runGeminiPrompt({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: kind === 'refine' ? 'team-refine-planner' : 'team-create-planner',
      model,
      timeoutMs,
      surface: kind === 'refine' ? 'team_refine_planner' : 'team_create_planner',
      agentId: kind === 'refine' ? 'team_refine_planner' : 'team_create_planner',
      roleId: 'planner',
      approvalMode: 'default',
      traceMetadata: { planner_provider: key, requested_job_id: clean(jobId) || null },
    });
  }
  if (key === 'codex') {
    return await runCodexExec({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: kind === 'refine' ? 'team-refine-planner' : 'team-create-planner',
      model,
      timeoutMs,
      surface: kind === 'refine' ? 'team_refine_planner' : 'team_create_planner',
      agentId: kind === 'refine' ? 'team_refine_planner' : 'team_create_planner',
      roleId: 'planner',
    });
  }
  return { ok: false, stdout: '', stderr: 'unsupported planner provider: ' + key };
}

async function planTeamWithLlm({ kind = 'create', prompt = '', taskText = '', instruction = '', currentTeam = null, runtime = null, availableToolIds = [], skillRegistry = null, workspaceRoot = process.cwd(), jobId = '' } = {}) {
  const providers = plannerProviderPreference(kind).filter((provider) => isPlannerProviderAvailable(provider));
  if (providers.length === 0) return { ok: false, reason: 'llm_planner_unavailable' };
  const errors = [];
  for (const provider of providers) {
    const model = plannerModelForProvider(provider, kind);
    appendPlannerPromptTelemetry({ kind, provider, model, prompt, jobId, taskText, instruction, currentTeam, runtime, availableToolIds, skillRegistry });
    let result;
    try {
      result = await runPlannerProvider({ provider, kind, prompt, workspaceRoot, jobId });
    } catch (error) {
      errors.push(provider + ':planner_exec_exception:' + String(error?.message || error));
      continue;
    }
    if (!result?.ok) {
      errors.push(provider + ':planner_exec_failed:' + clean(result?.stderr || result?.stdout || 'unknown').slice(0, 240));
      continue;
    }
    const parsed = parseJsonObjectFromText(result.stdout || result.stderr || '');
    if (!parsed || typeof parsed !== 'object') {
      errors.push(provider + ':planner_parse_failed');
      continue;
    }
    const normalized = normalizePlannerPlan(parsed);
    if (!normalized.agents.length) {
      errors.push(provider + ':planner_returned_no_agents');
      continue;
    }
    return {
      ok: true,
      plan: normalized,
      planner_metadata: {
        planner_type: cleanId(provider) + '_cli',
        planner_model: model,
        planning_source: plannerSourceForProvider(provider, kind),
        reasoning_summary: normalized.reasoning_summary,
      },
    };
  }
  return { ok: false, reason: errors.join('; ') || 'llm_planner_failed' };
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
  const prompt = buildPlannerPrompt({ taskText, runtime, availableToolIds, skillRegistry, preferredTaskArchetype });
  return await planTeamWithLlm({ kind: 'create', prompt, taskText, runtime, availableToolIds, skillRegistry, workspaceRoot, jobId });
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
  const prompt = buildRefinementPlannerPrompt({ currentTeam, instruction, runtime, availableToolIds, skillRegistry, preferredTaskArchetype });
  return await planTeamWithLlm({ kind: 'refine', prompt, instruction, currentTeam, runtime, availableToolIds, skillRegistry, workspaceRoot, jobId });
}
