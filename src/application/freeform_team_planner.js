import { spawnSync } from 'node:child_process';

import { runCodexExec } from '../codex.js';
import { parseJsonObjectFromText } from '../shared/json_extract.js';
import { listSupportedModels } from '../catalog/model_catalog.js';

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

function resolvePlannerMode(envKey = 'TEAM_CREATE_PLANNER_MODE') {
  return cleanId(process.env[envKey] || process.env.TEAM_CREATE_PLANNER_MODE || 'auto');
}

function resolvePlannerModel(envKey = 'TEAM_CREATE_PLANNER_MODEL') {
  return clean(process.env[envKey] || process.env.TEAM_CREATE_PLANNER_MODEL || 'gpt-5.4') || 'gpt-5.4';
}

export function isCodexPlannerEnabled(envKey = 'TEAM_CREATE_PLANNER_MODE') {
  const mode = resolvePlannerMode(envKey);
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
  })).filter((row) => row.preset_id);
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
    '- team must have 1 to 6 agents',
    '- each agent role must be one of: researcher, builder, reviewer, synthesizer, operator',
    '- if the user asks for opposing views, counterarguments, debate, discussion, devil\'s advocate, or back-and-forth, DO NOT collapse to a single generalist researcher',
    '- if multiple upstream agents exist, include a synthesizer unless the user explicitly rejects it',
    '- prefer existing executable skill ids from the registry for attached_skill_ids',
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
    '      "recommended_tool_ids": ["..."],',
    '      "context_policy": {',
    '        "reads": {"grants": ["shared_summary"], "context_types": ["evidence"], "query_template": "..."},',
    '        "writes": {"private_targets": ["scratch"], "publish_targets": ["handoff_summary"]},',
    '        "can_request_grants": ["conversation_tail"],',
    '        "default_budget": {"soft_tokens": 1600, "hard_tokens": 2600}',
    '      }',
    '    }',
    '  ],',
    '  "interaction_spec": {',
    '    "execution_pattern": "parallel_research_then_review_then_synthesize|multi_research_adjudication|sequential_pipeline",',
    '    "final_answer_owner": "agent name",',
    '    "handoffs": [{"from":"...","to":"...","payload":"summary_plus_key_evidence"}],',
    '    "policies": {"reviewer_visibility":"...","synthesizer_visibility":"..."}',
    '  },',
    '  "shortcut_policy": {"enabled": true, "only_for_followups": true}',
    '}',
    '',
    `User request: ${clean(taskText)}`,
    '',
    `Supported models: ${models.join(', ')}`,
    `Available tools: ${asArray(availableToolIds).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 24).join(', ') || '(none listed)'}`,
    '',
    `Runtime catalog: ${JSON.stringify(catalog)}`,
    `Skill registry sample: ${JSON.stringify(skills)}`,
    `Preset registry sample: ${JSON.stringify(presets)}`,
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

function normalizePlannerPlan(raw = {}) {
  const row = asObject(raw);
  return {
    team_name: clean(row.team_name || row.teamName || 'freeform_team'),
    reasoning_summary: asArray(row.reasoning_summary || row.rationale || row.why).map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
    agents: asArray(row.agents).map((agent) => {
      const item = asObject(agent);
      return {
        name: clean(item.name || item.display_name || item.agent_name),
        role: cleanId(item.role || item.role_id || item.roleId || 'researcher') || 'researcher',
        purpose: clean(item.purpose || item.goal || item.description),
        model: clean(item.model),
        provider: cleanId(item.provider || ''),
        capabilities: asArray(item.capabilities || item.skill_labels).map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
        attached_skill_ids: asArray(item.attached_skill_ids || item.attachedSkillIds || item.skills).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        generated_skill_briefs: normalizeGeneratedSkillBriefs(item.generated_skill_briefs || item.generatedSkillBriefs || []),
        recommended_tool_ids: asArray(item.recommended_tool_ids || item.recommendedToolIds || item.tools).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
        context_policy: asObject(item.context_policy || item.contextPolicy),
      };
    }).filter((agent) => agent.name),
    interaction_spec: asObject(row.interaction_spec || row.interactionSpec),
    shortcut_policy: asObject(row.shortcut_policy || row.shortcutPolicy),
  };
}


function summarizeCurrentTeam(currentTeam = null) {
  const team = asObject(currentTeam);
  return {
    team_name: clean(team.team_name || team.teamName || ''),
    task_brief: clean(team.task_brief || team.taskBrief || team.task || ''),
    composition_mode: cleanId(team.composition_mode || team.compositionMode || ''),
    proposal_mode: cleanId(team.proposal_mode || team.proposalMode || ''),
    agents: asArray(team.agents).map((agent) => ({
      agent_id: cleanId(agent?.agent_id || agent?.agentId || agent?.id || ''),
      name: clean(agent?.name || agent?.display_name || ''),
      role: cleanId(agent?.role || agent?.role_id || agent?.roleId || 'researcher') || 'researcher',
      purpose: clean(agent?.purpose || ''),
      model: clean(agent?.model || ''),
      provider: cleanId(agent?.provider || ''),
      capabilities: asArray(agent?.capabilities || agent?.skills).map((entry) => clean(entry)).filter(Boolean).slice(0, 6),
      attached_skill_ids: asArray(agent?.attached_skill_ids || agent?.attachedSkillIds || []).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
      generated_skill_briefs: normalizeGeneratedSkillBriefs(agent?.generated_skill_briefs || agent?.generatedSkillBriefs || []),
      recommended_tool_ids: asArray(agent?.recommended_tool_ids || agent?.recommendedToolIds || []).map((entry) => cleanId(entry)).filter(Boolean).slice(0, 6),
      context_policy: asObject(agent?.context_policy || agent?.contextPolicy),
    })),
    interaction_spec: asObject(team.interaction_spec || team.interactionSpec),
    shortcut_policy: asObject(team.shortcut_policy || team.shortcutPolicy),
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
  const basePrompt = buildPlannerPrompt({
    taskText: clean(instruction),
    runtime,
    availableToolIds,
    skillRegistry,
    presetRegistry,
  });
  const summarizedTeam = summarizeCurrentTeam(currentTeam);
  return [
    basePrompt,
    '',
    'You are revising an EXISTING team proposal, not creating from scratch unless the instruction clearly demands a full redesign.',
    'Revise the full team configuration so that it respects the user refinement instruction.',
    'Important refinement rules:',
    '- preserve good existing agents unless the instruction clearly implies removal or replacement',
    '- consider BOTH agent lineup changes and interaction changes',
    '- if the instruction asks for debate, opposition, counterargument, rebuttal, adjudication, or discussion, update interaction_spec and handoffs accordingly',
    '- if the instruction asks for a simpler team, you may remove agents and simplify handoffs',
    '- if the instruction asks for a new specialist, add that agent and reflect the new handoffs',
    '- final_answer_owner must remain executable and must reference a real agent name in the revised roster',
    '- return the FULL revised team, not a patch',
    '',
    `Current team: ${JSON.stringify(summarizedTeam)}`,
    `Refinement instruction: ${clean(instruction)}`,
  ].join('\n');
}

export async function planFreeformTeamWithCodex({
  taskText = '',
  runtime = null,
  availableToolIds = [],
  skillRegistry = null,
  presetRegistry = null,
  workspaceRoot = process.cwd(),
} = {}) {
  if (!isCodexPlannerEnabled()) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildPlannerPrompt({ taskText, runtime, availableToolIds, skillRegistry, presetRegistry });
  let result;
  try {
    result = await runCodexExec({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: 'team-create-planner',
      model: resolvePlannerModel('TEAM_CREATE_PLANNER_MODEL'),
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
      planner_model: resolvePlannerModel('TEAM_CREATE_PLANNER_MODEL'),
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
} = {}) {
  if (!isCodexPlannerEnabled('TEAM_REFINE_PLANNER_MODE')) {
    return { ok: false, reason: 'planner_disabled_or_codex_unavailable' };
  }
  const prompt = buildRefinementPlannerPrompt({ currentTeam, instruction, runtime, availableToolIds, skillRegistry, presetRegistry });
  let result;
  try {
    result = await runCodexExec({
      workspaceRoot,
      cwd: workspaceRoot,
      prompt,
      jobId: 'team-refine-planner',
      model: resolvePlannerModel('TEAM_REFINE_PLANNER_MODEL'),
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
      planner_model: resolvePlannerModel('TEAM_REFINE_PLANNER_MODEL'),
      planning_source: 'codex_gpt_5_4_refine',
      reasoning_summary: normalized.reasoning_summary,
    },
  };
}

