import { loadAgents } from '../agents.js';
import { recommendTeamForTask } from './telegram_route_planning.js';
import { inferProviderForModel, listSupportedModels, resolveSupportedModel } from '../catalog/model_catalog.js';
import { detectTeamCapabilityGaps, normalizeCapabilityGapList } from './capability_gap_detector.js';
import { buildManifestRequirements, formatManifestRequirementLines, normalizeManifestRequirements } from '../shared/manifest_requirements.js';
import { SkillRegistry } from './skill_registry.js';
import { SkillResolver, scoreSkillForTask } from './skill_resolver.js';
import { PresetRegistry } from '../catalog/preset_registry.js';
import { PresetResolver } from '../control_plane/preset_resolver.js';
import { interpretTask } from '../control_plane/task_interpreter.js';
import { planFreeformTeamWithCodex, planTeamRefinementWithCodex } from './freeform_team_planner.js';
import {
  buildDefaultInteractionSpec,
  buildAgentLocalInteractionContract,
  buildInteractionSummaryLines,
  normalizeInteractionSpec,
  parseNaturalLanguageInteractionPatch,
  validateInteractionSpec,
} from '../domain/interaction_spec.js';
import {
  autoPurposeForAgent,
  buildReadableInteractionLines,
  defaultSkillsForAgent,
  formatRoleOverlayProfile,
  formatSkillLabels,
  formatToolLabels,
  humanizeExecutionPattern,
  humanizeModel,
  humanizeVisibility,
  inferAgentSpecialty,
  inferTaskDomain,
  roleLabel,
  shouldAutoRenameAgent,
  suggestAgentDisplayName,
} from './team_presentation.js';
import { hasExplicitSkillDomainMatch, requiresExplicitDomainMatch } from '../shared/skill_relevance.js';
import { buildTeamStructureV2, normalizeTeamStructureV2, deriveTeamConfigFromStructureV2, buildRuntimeExecutionProfileFromStructureV2 } from '../shared/team_structure_v2.js';
import { deriveKnowledgeBaseDesign, summarizeKnowledgeBaseProfile, formatKnowledgeBaseMemoryMap, formatMemoryPlanMap } from '../knowledge_base/profile.js';
import { attachTeamBlueprint, buildTaskArchetypeBlueprintDocument, inferTaskArchetype } from './team_blueprint.js';
import { buildTeamSeedFromTaskArchetype } from './team_blueprint_templates.js';
import { collectEffectiveAvailableToolIds } from './runtime_tool_availability.js';
import { buildTeamCapabilityContract, formatTeamCapabilityContractLines } from './team_capability_contract.js';

function asArray(v){return Array.isArray(v)?v:[]}
function asObject(v){return v&&typeof v==='object'?v:{}}
function clean(v=''){return String(v||'').trim()}
function cleanId(v=''){return clean(v).toLowerCase()}
function nowIso(){return new Date().toISOString();}

const COMPOSITION_MODES = new Set(['structured', 'freeform']);
const PROPOSAL_MODES = new Set(['suggest', 'create', 'refine', 'validate', 'apply']);
const SUPPORTED_ROLES = new Set(['researcher', 'builder', 'reviewer', 'synthesizer', 'operator']);
const SUPPORTED_TASK_ARCHETYPES = new Set(['research', 'implementation', 'review_repair', 'iterative_improvement']);

let _skillRegistry = null;
let _presetRegistry = null;
let _skillResolver = null;
let _presetResolver = null;

function uniqueIds(values = [], { max = 16 } = {}) {
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

function tokenize(text = '') {
  return uniqueIds(clean(text).split(/[^a-z0-9가-힣._-]+/g), { max: 64 });
}

function overlapScore(left = '', right = '') {
  const a = new Set(tokenize(left));
  let score = 0;
  for (const token of tokenize(right)) {
    if (a.has(token)) score += 1;
  }
  return score;
}

function getSkillRegistry() {
  if (!_skillRegistry) {
    _skillRegistry = new SkillRegistry();
    _skillRegistry.load?.();
  }
  return _skillRegistry;
}

function getPresetRegistry() {
  if (!_presetRegistry) {
    _presetRegistry = new PresetRegistry();
    _presetRegistry.load?.();
  }
  return _presetRegistry;
}

function getSkillResolver() {
  if (!_skillResolver) _skillResolver = new SkillResolver({ registry: getSkillRegistry(), maxSkillsPerRole: 3, minScore: 12 });
  return _skillResolver;
}

function getPresetResolver() {
  if (!_presetResolver) _presetResolver = new PresetResolver({ presetRegistry: getPresetRegistry(), registry: loadAgents(), threshold: 18 });
  return _presetResolver;
}

function collectAvailableToolIds(runtime = null, registry = null) {
  return uniqueIds([...collectEffectiveAvailableToolIds(runtime, registry && typeof registry === 'object' ? registry : loadAgents())], { max: 32 });
}

function buildPlanningContext(taskText = '', runtime = null) {
  const registry = loadAgents();
  const availableToolIds = collectAvailableToolIds(runtime, registry);
  const taskInterpretation = interpretTask({
    goal: taskText,
    task: taskText,
    message: taskText,
    mode: 'run',
    registry,
    toolHints: availableToolIds,
  });
  return {
    registry,
    availableToolIds,
    taskInterpretation,
    skillRegistry: getSkillRegistry(),
    presetRegistry: getPresetRegistry(),
    skillResolver: getSkillResolver(),
    presetResolver: getPresetResolver(),
    taskText,
  };
}


function normalizeTaskArchetype(raw = '', fallback = 'research') {
  const value = cleanId(raw);
  if (SUPPORTED_TASK_ARCHETYPES.has(value)) return value;
  const fallbackValue = cleanId(fallback);
  return SUPPORTED_TASK_ARCHETYPES.has(fallbackValue) ? fallbackValue : 'research';
}

function selectTaskArchetypeTemplate({ taskText = '', currentTeam = null, plannerPlan = null, preferredTaskArchetype = '' } = {}) {
  const preferred = cleanId(
    plannerPlan?.task_archetype
    || plannerPlan?.taskArchetype
    || plannerPlan?.blueprint_archetype
    || plannerPlan?.blueprintArchetype
    || preferredTaskArchetype
    || currentTeam?.task_archetype
    || currentTeam?.taskArchetype
    || currentTeam?.team_blueprint?.task_archetype
    || currentTeam?.teamBlueprint?.task_archetype
    || ''
  );
  if (SUPPORTED_TASK_ARCHETYPES.has(preferred)) {
    return { archetype: preferred, reason: 'explicit_or_preserved' };
  }
  const text = clean(`${taskText} ${plannerPlan?.goal || ''}`);
  const hints = inferTaskStructureHints(text);
  const planning = buildPlanningContext(text);
  const taskType = cleanId(planning?.taskInterpretation?.task_type || planning?.taskInterpretation?.taskType || '');
  const currentArchetype = cleanId(currentTeam?.task_archetype || currentTeam?.taskArchetype || currentTeam?.team_blueprint?.task_archetype || currentTeam?.teamBlueprint?.task_archetype || '');
  const repairSignals = hints.review && /(repair|regression|incident|postmortem|bug|failure|stalled|audit|triage|root cause|fixup|회귀|장애|오류|감사|원인|수습|복구|수정)/i.test(text);
  const improvementSignals = (hints.build || hints.review) && /(iterate|iterative|iteration|improve|improvement|optimi[sz]e|refine repeatedly|keep improving|계속 개선|반복 개선|지속 개선|계속 발전|여러 모델|multi-model|자동 개선|반복적으로)/i.test(text);
  const implementationSignals = hints.build || ['code_change', 'implementation', 'workspace_change'].includes(taskType) || /(implement|patch|refactor|code|repo|repository|workspace|script|prototype|web\s*service|web\s*app|frontend|backend|api|server|client|full[- ]?stack|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|구현|패치|리팩터|코드|레포|저장소|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발)/i.test(text);
  const researchSignals = hints.compare || hints.debate || hints.discussion || hints.news || hints.filings || /(research|analysis|analy|brief|memo|investigate|market|survey|source-grounded|조사|분석|브리프|리서치|시장)/i.test(text);
  if (repairSignals) return { archetype: 'review_repair', reason: 'repair_or_audit_signals' };
  if (implementationSignals && hints.review && /(repair|regression|bug|fixup|회귀|장애|오류|복구|수습)/i.test(text)) return { archetype: 'review_repair', reason: 'review_then_repair' };
  if (improvementSignals) return { archetype: 'iterative_improvement', reason: 'iterative_improvement_signals' };
  if (implementationSignals) return { archetype: 'implementation', reason: 'implementation_signals' };
  if (currentArchetype === 'review_repair' && hints.review) return { archetype: 'review_repair', reason: 'preserve_review_repair' };
  if (researchSignals) return { archetype: 'research', reason: 'research_signals' };
  return { archetype: currentArchetype || 'research', reason: currentArchetype ? 'preserve_current_archetype' : 'default_research' };
}

function buildTaskArchetypeSeed({ taskText = '', title = '', preferredTaskArchetype = '', currentTeam = null, plannerPlan = null } = {}) {
  const selection = selectTaskArchetypeTemplate({ taskText, currentTeam, plannerPlan, preferredTaskArchetype });
  const seed = buildTeamSeedFromTaskArchetype(selection.archetype || 'research', {
    taskBrief: taskText,
    title: title || '',
    description: taskText,
  });
  seed.task_archetype = selection.archetype;
  return { selection, seed };
}

function extendPlannerReasoningSummary(metadata = null, selection = null) {
  const row = asObject(metadata);
  const base = asArray(row.reasoning_summary || row.reasoningSummary || []).map((entry) => clean(entry)).filter(Boolean);
  const archetype = clean(selection?.archetype);
  const reason = clean(selection?.reason);
  const addition = archetype ? `task archetype template: ${archetype}${reason ? ` (${reason})` : ''}` : '';
  return [...new Set([...base, addition].filter(Boolean))].slice(0, 5);
}

function buildFallbackSelectionSlot(agent = {}, planning = {}) {
  const roleId = normalizeTeamRole(agent.role);
  const purpose = clean(agent.purpose || planning.taskText || roleId) || roleId;
  const taskText = clean(planning.taskText);
  const preferredSkillIds = [];
  const requiredContextTypes = uniqueIds(agent?.context_policy?.reads?.context_types || agent?.contextPolicy?.reads?.context_types || []);
  if (roleId === 'operator') preferredSkillIds.push('skill.thread_team_reconciliation.v1', 'skill.context_selection_policy.v1');
  if (roleId === 'reviewer' && /claim|evidence|citation|fact|투자|주식|공시|뉴스/i.test(`${taskText} ${purpose}`)) preferredSkillIds.push('skill.claim_evidence_audit.v1');
  if (roleId === 'researcher' && /주식시장|증시|금융시장|투자|종목|equity|stock|filing|공시|earnings|실적/i.test(`${taskText} ${purpose}`)) preferredSkillIds.push('skill.kr_equity_analysis.v1');
  if (roleId === 'synthesizer' && /brief|telegram|요약|브리핑/i.test(`${taskText} ${purpose}`)) preferredSkillIds.push('skill.telegram_briefing.v1');
  if ((roleId === 'reviewer' || roleId === 'operator') && /debug|stalled|queued|reroute|trace|run/i.test(`${taskText} ${purpose}`)) preferredSkillIds.push('skill.run_trace_debugging.v1');
  return {
    slot_id: `draft_${cleanId(agent.agent_id || agent.name || roleId) || roleId}`,
    role_id: roleId,
    purpose,
    preferred_skill_ids: uniqueIds(preferredSkillIds),
    required_skill_ids: [],
    forbidden_skill_ids: [],
    required_context_types: requiredContextTypes,
    required_tool_ids: [],
    parallelizable: roleId === 'researcher',
    deliverable_type: roleId === 'builder' ? 'code_patch' : (roleId === 'reviewer' ? 'review_findings' : (roleId === 'synthesizer' ? 'report' : 'research_notes')),
    selection_reason: 'team_config_fallback_slot',
  };
}

function scoreSlotForAgent(slot = {}, agent = {}, taskText = '') {
  const roleScore = normalizeTeamRole(slot?.role_id || slot?.roleId) === normalizeTeamRole(agent?.role) ? 20 : -20;
  const semantic = overlapScore(`${taskText} ${agent?.purpose || ''} ${agent?.name || ''}`, `${slot?.purpose || ''} ${(slot?.required_context_types || []).join(' ')} ${(slot?.preferred_skill_ids || []).join(' ')}`);
  const specialty = inferAgentSpecialty({ name: agent?.name, purpose: agent?.purpose, taskText, skills: agent?.skills || agent?.capabilities || [] });
  let bonus = 0;
  const bag = `${slot?.purpose || ''} ${(slot?.required_context_types || []).join(' ')} ${(slot?.preferred_skill_ids || []).join(' ')}`.toLowerCase();
  if (specialty === 'news' && /news/.test(bag)) bonus += 10;
  if (specialty === 'filings' && /filing|financial/.test(bag)) bonus += 10;
  if (specialty === 'review' && /risk|contradiction/.test(bag)) bonus += 8;
  return roleScore + semantic + bonus;
}

function matchSelectionSlot(agent = {}, planning = {}) {
  const candidates = asArray(planning?.taskInterpretation?.candidate_capability_slots);
  let best = null;
  for (const slot of candidates) {
    const score = scoreSlotForAgent(slot, agent, planning.taskText || '');
    if (!best || score > best.score) best = { slot, score };
  }
  if (best && best.score >= 8) return best.slot;
  return buildFallbackSelectionSlot(agent, planning);
}

function deriveCapabilityLabels({ role = '', taskText = '', purpose = '', name = '' } = {}) {
  return uniqueIds(defaultSkillsForAgent({ role, taskText, purpose, name }), { max: 4 });
}


function roleAliasesForSkillCompatibility(role = '') {
  const roleId = normalizeTeamRole(role);
  const aliases = new Set([cleanId(role), roleId]);
  if (roleId === 'synthesizer') {
    aliases.add('writer');
    aliases.add('summarizer');
    aliases.add('messenger');
    aliases.add('planner');
  }
  if (roleId === 'operator') {
    aliases.add('planner');
    aliases.add('context_curator');
  }
  if (roleId === 'builder') aliases.add('coder');
  if (roleId === 'reviewer') {
    aliases.add('critic');
    aliases.add('critic_or_reviewer');
    aliases.add('verifier');
  }
  if (roleId === 'researcher') aliases.add('planner');
  return aliases;
}

function isSkillCompatibleWithAgentRole(skill = {}, role = '') {
  const compatibleRoles = uniqueIds(asArray(skill?.compatible_roles || skill?.compatibleRoles || []), { max: 12 });
  if (compatibleRoles.length === 0) return true;
  const aliases = roleAliasesForSkillCompatibility(role);
  return compatibleRoles.some((entry) => aliases.has(cleanId(entry)));
}



function filterRelevantAttachedSkillIds(skillIds = [], { role = '', taskText = '', purpose = '', capabilities = [], contextPolicy = null, planning = null } = {}) {
  const registry = planning?.skillRegistry || getSkillRegistry();
  const interpretation = planning?.taskInterpretation || interpretTask({
    goal: taskText,
    task: taskText,
    message: taskText,
    mode: 'run',
    registry: planning?.registry || loadAgents(),
    toolHints: planning?.availableToolIds || [],
  });
  const hints = [purpose, ...asArray(capabilities)].filter(Boolean);
  const slot = {
    purpose,
    required_context_types: uniqueIds(
      contextPolicy?.reads?.context_types
      || contextPolicy?.reads?.contextTypes
      || contextPolicy?.required_context_types
      || contextPolicy?.requiredContextTypes
      || [],
      { max: 12 }
    ),
  };
  const out = [];
  for (const skillId of uniqueIds(skillIds || [], { max: 8 })) {
    const skill = registry.resolve?.(skillId);
    if (!skill) continue;
    if (!isSkillCompatibleWithAgentRole(skill, role)) continue;
    const scored = scoreSkillForTask({
      skill,
      goal: taskText,
      roleType: role,
      contextHints: hints,
      taskInterpretation: interpretation,
      slot,
    });
    const reasons = asArray(scored?.reasons || []);
    const semanticMatch = reasons.some((entry) => /^trigger_matches:|^capability_matches:|^name_matches:/.test(String(entry || '')));
    const explicitMatch = hasExplicitSkillDomainMatch({
      skill,
      skillId,
      text: [taskText, purpose, ...hints].join('\n'),
      taskInterpretation: interpretation,
    });
    if (requiresExplicitDomainMatch(skill) && !explicitMatch) continue;
    const score = Number(scored?.score || 0);
    if (semanticMatch || explicitMatch || score >= 58) out.push(skillId);
  }
  return out;
}

function resolveAgentExecutionProfile(agent = {}, planning = {}) {
  const roleId = normalizeTeamRole(agent.role);
  const slot = matchSelectionSlot(agent, planning);
  const presetResult = planning.presetResolver.resolveForSlot({
    slot,
    taskInterpretation: planning.taskInterpretation,
    goal: planning.taskText,
    registry: planning.registry,
    availableToolIds: planning.availableToolIds,
    reusePresetIds: planning.taskInterpretation?.pinned_preset_ids || [],
  });
  const preset = presetResult?.preset || null;
  const skillResult = planning.skillResolver.resolveForRole({
    roleType: agent.role,
    goal: planning.taskText,
    contextHints: [agent.purpose, ...(slot?.required_context_types || [])],
    taskInterpretation: planning.taskInterpretation,
    slot,
    availableToolIds: planning.availableToolIds,
  });
  const attachmentIds = filterRelevantAttachedSkillIds(uniqueIds([
    ...asArray(preset?.default_skill_ids),
    ...asArray(skillResult?.attachments).map((row) => row?.skill_id),
  ], { max: 6 }), {
    role: agent.role,
    taskText: planning.taskText,
    purpose: agent.purpose,
    capabilities: deriveCapabilityLabels({ role: agent.role, taskText: planning.taskText, purpose: agent.purpose, name: agent.name }),
    contextPolicy: agent.context_policy || agent.contextPolicy || {},
    planning,
  });
  const skillRequiredToolIds = [];
  for (const skillId of attachmentIds) {
    const skill = planning.skillRegistry.resolve?.(skillId);
    skillRequiredToolIds.push(...asArray(skill?.required_tools));
  }
  const codeLikeTask = /ipynb|notebook|jupyter|file|json|python|script|workspace|코드|노트북|파일/.test(`${planning.taskText} ${agent.purpose}`.toLowerCase());
  const explicitRequiredToolIds = uniqueIds([
    ...asArray(agent?.required_tool_ids || agent?.requiredToolIds),
    ...asArray(slot?.required_tool_ids),
    ...skillRequiredToolIds,
  ], { max: 6 });
  const explicitOptionalToolIds = uniqueIds([
    ...asArray(agent?.optional_tool_ids || agent?.optionalToolIds),
    ...asArray(agent?.recommended_tool_ids || agent?.recommendedToolIds),
    ...asArray(preset?.selection_features?.tool_hints),
    ...(roleId === 'builder' && codeLikeTask ? ['workspace_fs', 'shell'] : []),
  ], { max: 6 }).filter((toolId) => !explicitRequiredToolIds.includes(toolId));
  const recommendedToolIds = uniqueIds([
    ...explicitRequiredToolIds,
    ...explicitOptionalToolIds,
  ], { max: 6 });
  const capabilities = deriveCapabilityLabels({ role: agent.role, taskText: planning.taskText, purpose: agent.purpose, name: agent.name });
  return {
    capabilities,
    attached_skill_ids: attachmentIds,
    required_tool_ids: explicitRequiredToolIds,
    optional_tool_ids: explicitOptionalToolIds,
    recommended_tool_ids: recommendedToolIds,
    matched_preset_id: cleanId(preset?.preset_id || ''),
    matched_preset_name: clean(preset?.display_name || ''),
    slot,
  };
}

function agentSpecialtyKey(agent = {}, taskText = '') {
  const local = `${clean(agent?.name)} ${clean(agent?.purpose)}`.toLowerCase();
  if (/counter|skeptic|반대\s*의견|반론|devil'?s advocate|adversarial/i.test(local)) return 'counterpoint';
  if (/lead|thesis|핵심\s*주장/i.test(local)) return 'lead_thesis';
  const specialty = inferAgentSpecialty({ name: agent?.name, purpose: agent?.purpose, taskText, skills: [...asArray(agent?.skills), ...asArray(agent?.capabilities), ...asArray(agent?.attached_skill_ids)] });
  return specialty || normalizeTeamRole(agent?.role);
}

function shouldKeepRole(roleId = '', taskText = '', planning = null) {
  const role = normalizeTeamRole(roleId);
  const hints = inferTaskStructureHints(taskText);
  const interpretedType = cleanId(planning?.taskInterpretation?.task_type || '');
  const controlMode = cleanId(planning?.taskInterpretation?.control_mode || '');
  if (role === 'operator') return /operator|승인|gate|workflow|context|handoff|coord|run state/i.test(taskText) || controlMode === 'supervised' || controlMode === 'checkpointed';
  if (role === 'builder') return hints.build || interpretedType === 'code_change';
  return true;
}

function pruneAgentLineup(agents = [], taskText = '', planning = null) {
  const kept = [];
  const researcherKeys = new Set();
  const singletons = new Set();
  const structureHints = inferTaskStructureHints(taskText);
  const allowMultiResearch = planning?.taskInterpretation?.parallelism_preference === 'parallel' || structureHints.compare || structureHints.debate || structureHints.discussion;
  for (const agent of asArray(agents)) {
    const roleId = normalizeTeamRole(agent.role);
    if (!shouldKeepRole(roleId, taskText, planning)) continue;
    if (roleId === 'researcher') {
      const key = agentSpecialtyKey(agent, taskText);
      if (researcherKeys.has(key)) continue;
      researcherKeys.add(key);
      if (!allowMultiResearch && researcherKeys.size > 2) continue;
      kept.push(agent);
      continue;
    }
    if (singletons.has(roleId)) continue;
    singletons.add(roleId);
    kept.push(agent);
  }
  return kept.slice(0, 6);
}

function enrichAgentDraft(agent = {}, planning = {}) {
  const executionProfile = resolveAgentExecutionProfile(agent, planning);
  return {
    ...agent,
    capabilities: executionProfile.capabilities,
    skills: executionProfile.capabilities,
    attached_skill_ids: executionProfile.attached_skill_ids,
    required_tool_ids: executionProfile.required_tool_ids,
    optional_tool_ids: executionProfile.optional_tool_ids,
    recommended_tool_ids: executionProfile.recommended_tool_ids,
    matched_preset_id: executionProfile.matched_preset_id || undefined,
    matched_preset_name: executionProfile.matched_preset_name || undefined,
    generated_skill_briefs: inferGeneratedSkillBriefs({ ...agent, attached_skill_ids: executionProfile.attached_skill_ids, capabilities: executionProfile.capabilities }, planning),
    planning_slot: executionProfile.slot,
  };
}

function buildStructuredAgentDrafts({ taskText = '', runtime = null, preferredTaskArchetype = '', currentTeam = null } = {}) {
  const effectiveRuntime = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  const planning = buildPlanningContext(taskText, effectiveRuntime);
  const recommendation = recommendTeamForTask(taskText, effectiveRuntime);
  const { seed } = buildTaskArchetypeSeed({ taskText, preferredTaskArchetype, currentTeam });
  const templateAgents = asArray(seed.agents);
  if (templateAgents.length === 0) {
    const drafts = [];
    const seen = new Set();
    const slots = asArray(planning.taskInterpretation?.candidate_capability_slots);
    for (const [index, slot] of slots.entries()) {
      const roleId = normalizeTeamRole(slot?.role_id || slot?.roleId);
      const draft = agentDraft({
        name: roleId,
        role: roleId,
        model: defaultModelForRole(roleId),
        purpose: clean(slot?.purpose || taskText),
        provider: '',
      }, { seen, taskText, index: index + 1 });
      drafts.push(enrichAgentDraft(draft, planning));
    }
    return pruneAgentLineup(drafts, taskText, planning);
  }
  const selectedExisting = asArray(recommendation?.selected_existing_agents).map((entry) => {
    const runtimeAgent = findCatalogAgent(effectiveRuntime, entry.agent_id) || {};
    return {
      agent_id: cleanId(entry.agent_id),
      role: normalizeTeamRole(runtimeAgent.role || runtimeAgent.system_key || entry.role || 'researcher'),
      model: resolveSupportedModel(runtimeAgent.model || '') || defaultModelForRole(runtimeAgent.role || entry.role, runtimeAgent.provider),
      provider: cleanId(runtimeAgent.provider || inferProviderForModel(runtimeAgent.model || '') || ''),
      skills: asArray(runtimeAgent.skills).map((skill) => cleanId(skill?.id || skill)).filter(Boolean),
      purpose: clean(entry.why || runtimeAgent.description || ''),
    };
  });
  const reuseBuckets = new Map();
  for (const row of selectedExisting) {
    const roleId = normalizeTeamRole(row.role);
    const bucket = reuseBuckets.get(roleId) || [];
    bucket.push(row);
    reuseBuckets.set(roleId, bucket);
  }
  const drafts = [];
  const seen = new Set();
  for (const [index, templateAgent] of templateAgents.entries()) {
    const roleId = normalizeTeamRole(templateAgent.role);
    const bucket = reuseBuckets.get(roleId) || [];
    const reused = bucket.shift() || null;
    if (bucket.length === 0) reuseBuckets.delete(roleId); else reuseBuckets.set(roleId, bucket);
    const draft = agentDraft({
      name: clean(templateAgent.name || roleId),
      role: roleId,
      model: clean(reused?.model || templateAgent.model || ''),
      purpose: clean(templateAgent.purpose || reused?.purpose || taskText),
      skills: asArray(reused?.skills).length > 0 ? asArray(reused.skills) : asArray(templateAgent.skills || templateAgent.capabilities || []),
      provider: cleanId(reused?.provider || templateAgent.provider || ''),
    }, { seen, taskText, index: index + 1 });
    drafts.push(enrichAgentDraft(draft, planning));
  }
  return pruneAgentLineup(drafts, taskText, planning);
}

function buildFreeformAgentDrafts({ taskText = '', runtime = null, blueprints = [], structuredAgents = [] } = {}) {
  const seen = new Set();
  const planning = buildPlanningContext(taskText, runtime);
  const covered = ensureFreeformBlueprintCoverage(blueprints, taskText, structuredAgents);
  const drafts = covered.map((item, index) => enrichAgentDraft(agentDraft(item, { seen, taskText, index: index + 1 }), planning));
  return pruneAgentLineup(drafts, taskText, planning);
}

function inferTeamRoleFromText(raw = '') {
  const value = clean(raw).toLowerCase();
  if (!value) return '';
  if (/(^|[^a-z])(builder|coder|developer|implementer|frontend|backend|fullstack|engineer)([^a-z]|$)|구현|코더|개발자|빌더/.test(value)) return 'builder';
  if (/(^|[^a-z])(reviewer|review|critic|verifier|quality|qa)([^a-z]|$)|리뷰어|검토|검수|비평|품질/.test(value)) return 'reviewer';
  if (/(^|[^a-z])(synthesizer|synth|summarizer|summary|writer|delivery)([^a-z]|$)|요약|정리|합성|전달/.test(value)) return 'synthesizer';
  if (/(^|[^a-z])(operator|coordinator|orchestrator|router|manager)([^a-z]|$)|운영|조정|오퍼레이터/.test(value)) return 'operator';
  if (/(^|[^a-z])(researcher|scout|analyst|investigator|planner|research)([^a-z]|$)|조사|연구|분석|스카우트/.test(value)) return 'researcher';
  return '';
}

function normalizeTeamRole(raw = '') {
  const value = cleanId(raw);
  if (value === 'coder') return 'builder';
  if (value === 'critic_or_reviewer' || value === 'critic' || value === 'verifier') return 'reviewer';
  if (value === 'planner') return 'researcher';
  if (value === 'writer' || value === 'summarizer') return 'synthesizer';
  if (SUPPORTED_ROLES.has(value)) return value;
  const inferred = inferTeamRoleFromText(raw);
  if (inferred) return inferred;
  return 'researcher';
}

function resolvePreferredTeamRole(...values) {
  for (const raw of values) {
    const value = cleanId(raw);
    if (!value) continue;
    if (value === 'coder') return 'builder';
    if (value === 'critic_or_reviewer' || value === 'critic' || value === 'verifier') return 'reviewer';
    if (value === 'planner') return 'researcher';
    if (value === 'writer' || value === 'summarizer') return 'synthesizer';
    if (SUPPORTED_ROLES.has(value)) return value;
  }
  for (const raw of values) {
    const inferred = inferTeamRoleFromText(raw);
    if (inferred) return inferred;
  }
  return 'researcher';
}

function normalizeCompositionMode(raw = '', fallback = 'structured') {
  const value = cleanId(raw);
  if (COMPOSITION_MODES.has(value)) return value;
  return COMPOSITION_MODES.has(cleanId(fallback)) ? cleanId(fallback) : 'structured';
}

function shouldAutoRewritePurposeText(text = '') {
  const value = clean(text);
  if (!value) return false;
  return /^(research the task and gather supporting evidence|collect evidence to validate claims|assemble upstream findings into a concise final output|stress-test claims, risks, and quality before final output|coordinate workflow, runtime state, and tool-heavy execution details|implement the requested code or artifact changes|review the implementation for regressions and missing tests|gather upstream evidence needed before implementation|collect filing-based evidence)$/i.test(value);
}

function normalizeProposalMode(raw = '', fallback = 'suggest') {
  const value = cleanId(raw);
  if (PROPOSAL_MODES.has(value)) return value;
  return PROPOSAL_MODES.has(cleanId(fallback)) ? cleanId(fallback) : 'suggest';
}

function slugify(text = '') {
  const value = clean(text)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return value || 'agent';
}

function uniqueSlug(base = '', seen = new Set()) {
  let candidate = slugify(base);
  if (!seen.has(candidate)) {
    seen.add(candidate);
    return candidate;
  }
  let idx = 2;
  while (seen.has(`${candidate}_${idx}`)) idx += 1;
  const out = `${candidate}_${idx}`;
  seen.add(out);
  return out;
}

function ensureUniqueDisplayName(name = '', seen = new Set()) {
  const base = clean(name) || 'Agent';
  let candidate = base;
  let idx = 2;
  while (seen.has(cleanId(candidate))) {
    candidate = `${base} ${idx}`;
    idx += 1;
  }
  seen.add(cleanId(candidate));
  return candidate;
}

function normalizeStoredTeamEnvelope(raw = {}) {
  const row = asObject(raw);
  const active = row.active_team && typeof row.active_team === 'object' && Object.keys(row.active_team).length > 0 ? row.active_team : null;
  const pending = row.pending_team && typeof row.pending_team === 'object' && Object.keys(row.pending_team).length > 0 ? row.pending_team : null;
  return {
    status: cleanId(row.status || (active ? 'active' : (pending ? 'suggested' : 'none'))) || 'none',
    active_team: active,
    pending_team: pending,
    composition_mode: normalizeCompositionMode(row.composition_mode || active?.composition_mode || pending?.composition_mode || 'structured'),
    proposal_mode: normalizeProposalMode(row.proposal_mode || active?.proposal_mode || pending?.proposal_mode || 'suggest'),
    updated_at: clean(row.updated_at || nowIso()),
  };
}

function buildFallbackRuntime() {
  const registry = loadAgents();
  const catalog = asArray(registry?.agents).map((row) => ({
    id: cleanId(row?.id || row?.agent_id || row?.agentId),
    name: clean(row?.name),
    provider: cleanId(row?.provider || inferProviderForModel(row?.model || '') || 'gemini'),
    model: clean(row?.model || ''),
    role: cleanId(row?.role || row?.system_key || row?.id),
    tools: asArray(row?.tools),
    skills: asArray(row?.skills).map((entry) => cleanId(entry?.id || entry)),
  })).filter((row) => row.id);
  return { agentsCatalog: catalog, agents: catalog, enabledAgentIds: catalog.map((row) => row.id) };
}

function teamStoreTarget(runtime = null, { source = '' } = {}) {
  if (!runtime || typeof runtime !== 'object') return {};
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  const storeSource = cleanId(teamStore?.source || teamStore?.storeSource || '');
  const threadId = clean(runtime?.map?.threadId || runtime?.threadId || '');
  const explicitJobId = clean(runtime?.jobId || runtime?.currentJobId || '');
  const inferredLocalJobId = storeSource === 'local' && threadId.startsWith('local:')
    ? clean(threadId.slice('local:'.length))
    : '';
  const jobId = explicitJobId || inferredLocalJobId;
  const target = storeSource === 'goc'
    ? (threadId ? { threadId } : (jobId ? { jobId } : {}))
    : (jobId ? { jobId } : (threadId ? { threadId } : {}));
  if (source) target.source = source;
  return target;
}

function runtimeCatalog(runtime = null) {
  const base = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  return [...asArray(base?.agentsCatalog), ...asArray(base?.agents), ...asArray(buildFallbackRuntime().agentsCatalog)]
    .map((row) => ({
      ...row,
      id: cleanId(row?.id || row?.agent_id || row?.agentId),
      name: clean(row?.name),
      provider: cleanId(row?.provider || inferProviderForModel(row?.model || '') || ''),
      model: clean(row?.model || ''),
      role: cleanId(row?.role || row?.system_key || row?.role_id || row?.id),
      skills: asArray(row?.skills).map((entry) => cleanId(entry?.id || entry)).filter(Boolean),
    }))
    .filter((row) => row.id);
}

function findCatalogAgent(runtime = {}, agentId = '') {
  const key = cleanId(agentId);
  const rows = runtimeCatalog(runtime);
  return rows.find((row) => row.id === key) || null;
}

function buildKnowledgeBaseMemoryMapLines(profileOrPlan = null, { maxLines = 7 } = {}) {
  if (!profileOrPlan) return [];
  const formatter = profileOrPlan && typeof profileOrPlan === 'object' && Array.isArray(profileOrPlan.surfaces)
    ? formatMemoryPlanMap(profileOrPlan, { maxSurfaces: Math.max(3, maxLines - 3), includePolicy: true })
    : formatKnowledgeBaseMemoryMap(profileOrPlan, { maxDocs: Math.max(3, maxLines - 3), includePolicy: true });
  return formatter
    .split('\n')
    .map((line) => clean(line))
    .filter(Boolean)
    .slice(0, maxLines);
}

function defaultModelForRole(role = '', provider = '') {
  const roleId = cleanId(role);
  const providerId = cleanId(provider);
  if ((providerId === 'openai' || providerId === 'codex') && roleId === 'builder') return 'gpt-5-codex';
  if (roleId === 'builder') return 'gpt-5-codex';
  if (roleId === 'reviewer' || roleId === 'synthesizer') return 'gpt-5.4';
  return 'gemini-2.5-pro';
}

function defaultContextPolicyForRole(role = '', { taskText = '', purpose = '' } = {}) {
  const roleId = normalizeTeamRole(role);
  const task = clean(taskText || purpose);
  const common = {
    base_mode: 'scoped_context',
    default_budget: roleId === 'synthesizer'
      ? { soft_tokens: 2000, hard_tokens: 3200 }
      : (roleId === 'reviewer'
        ? { soft_tokens: 1800, hard_tokens: 2800 }
        : { soft_tokens: 1600, hard_tokens: 2600 }),
    can_request_grants: ['conversation_tail', 'explicit_uploaded_files'],
  };
  if (roleId === 'builder') {
    return {
      ...common,
      reads: {
        grants: ['shared_summary', 'explicit_uploaded_files', 'upstream_summaries'],
        context_types: ['workspace', 'requirements', 'diff', 'evidence'],
        query_template: task || '구현 대상, 파일 경로, 변경 제약을 읽는다',
      },
      writes: {
        private_targets: ['scratch', 'implementation_notes'],
        publish_targets: ['patch_plan', 'artifact_delta_summary'],
      },
    };
  }
  if (roleId === 'reviewer') {
    return {
      ...common,
      reads: {
        grants: ['shared_summary', 'upstream_results', 'upstream_summaries', 'explicit_uploaded_files'],
        context_types: ['evidence', 'claims', 'diff', 'risks'],
        query_template: task || '상위 결과를 검토하고 모순과 리스크를 찾는다',
      },
      writes: {
        private_targets: ['scratch'],
        publish_targets: ['review_findings', 'blocked_issues'],
      },
    };
  }
  if (roleId === 'synthesizer') {
    return {
      ...common,
      reads: {
        grants: ['shared_summary', 'upstream_summaries'],
        context_types: ['summary', 'evidence', 'decisions'],
        query_template: task || '공유 요약과 handoff 결과를 묶어 최종 답변을 쓴다',
      },
      writes: {
        private_targets: ['scratch'],
        publish_targets: ['final_answer_draft', 'handoff_summary'],
      },
    };
  }
  if (roleId === 'operator') {
    return {
      ...common,
      reads: {
        grants: ['shared_summary', 'conversation_tail', 'upstream_summaries'],
        context_types: ['status', 'approval', 'control'],
        query_template: task || '진행 상태와 승인 상태를 관리한다',
      },
      writes: {
        private_targets: ['scratch'],
        publish_targets: ['handoff_summary', 'run_control_notes'],
      },
    };
  }
  return {
    ...common,
    reads: {
      grants: ['shared_summary', 'user_pinned_nodes'],
      context_types: ['evidence', 'citations', 'notes'],
      query_template: task || '관련 evidence를 찾고 정리한다',
    },
    writes: {
      private_targets: ['scratch'],
      publish_targets: ['evidence_bundle', 'handoff_summary'],
    },
  };
}

function normalizeContextPolicy(raw = null, { role = '', taskText = '', purpose = '' } = {}) {
  const defaults = defaultContextPolicyForRole(role, { taskText, purpose });
  const row = asObject(raw);
  const reads = asObject(row.reads);
  const writes = asObject(row.writes);
  return {
    ...defaults,
    ...row,
    base_mode: cleanId(row.base_mode || row.baseMode || defaults.base_mode || 'scoped_context') || 'scoped_context',
    reads: {
      ...defaults.reads,
      ...reads,
      grants: asArray(reads.grants || defaults.reads?.grants).map((entry) => cleanId(entry)).filter(Boolean),
      context_types: asArray(reads.context_types || reads.contextTypes || defaults.reads?.context_types).map((entry) => cleanId(entry)).filter(Boolean),
      query_template: clean(reads.query_template || reads.queryTemplate || defaults.reads?.query_template || ''),
    },
    writes: {
      ...defaults.writes,
      ...writes,
      private_targets: asArray(writes.private_targets || writes.privateTargets || defaults.writes?.private_targets).map((entry) => cleanId(entry)).filter(Boolean),
      publish_targets: asArray(writes.publish_targets || writes.publishTargets || defaults.writes?.publish_targets).map((entry) => cleanId(entry)).filter(Boolean),
    },
    can_request_grants: asArray(row.can_request_grants || row.canRequestGrants || defaults.can_request_grants).map((entry) => cleanId(entry)).filter(Boolean),
    default_budget: {
      soft_tokens: Number.isFinite(Number(row?.default_budget?.soft_tokens ?? row?.defaultBudget?.softTokens))
        ? Math.max(200, Math.floor(Number(row.default_budget?.soft_tokens ?? row.defaultBudget?.softTokens)))
        : Number(defaults.default_budget?.soft_tokens || 1600),
      hard_tokens: Number.isFinite(Number(row?.default_budget?.hard_tokens ?? row?.defaultBudget?.hardTokens))
        ? Math.max(300, Math.floor(Number(row.default_budget?.hard_tokens ?? row.defaultBudget?.hardTokens)))
        : Number(defaults.default_budget?.hard_tokens || 2600),
    },
  };
}

function buildDefaultShortcutPolicy() {
  return {
    enabled: true,
    only_for_followups: true,
    disallow_when_pending_approval: true,
    max_recent_turns: 6,
  };
}

function normalizeShortcutPolicy(raw = null) {
  const row = asObject(raw);
  const defaults = buildDefaultShortcutPolicy();
  return {
    ...defaults,
    ...row,
    enabled: row.enabled !== false,
    only_for_followups: row.only_for_followups !== false,
    disallow_when_pending_approval: row.disallow_when_pending_approval !== false,
    max_recent_turns: Number.isFinite(Number(row.max_recent_turns))
      ? Math.max(1, Math.min(12, Math.floor(Number(row.max_recent_turns))))
      : defaults.max_recent_turns,
  };
}

function inferTaskStructureHints(taskText = '') {
  const text = clean(taskText);
  const lower = text.toLowerCase();
  return {
    compare: /비교|상반|찬반|여러 관점|양쪽|trade[- ]?off|pros?\s+and\s+cons?|debate|versus|vs\.?/i.test(text),
    debate: /반대\s*의견|반론|반박\s*의견|악마의\s*변호인|devil'?s advocate|counter(?:-?| )argument|opposing view|skeptic|adversarial|토론|토의|논쟁/i.test(text),
    discussion: /서로\s*(토의|논의|질의응답)|back[- ]?and[- ]?forth|토의하듯|discuss with each other|debate each other/i.test(text),
    review: /review|검토|검수|반박|critic|judge|검증|verify|fact check|red[ -]?team/i.test(text),
    synthesize: /요약|정리|synth|summary|memo|보고서|final/i.test(text),
    build: /코드|구현|build|builder|coder|coding|programming|notebook|ipython|jupyter|refactor|리팩토|patch|fix|web\s*service|web\s*app|frontend|backend|api|server|client|full[- ]?stack|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발/i.test(text),
    news: /뉴스|news|이벤트|발표|headline/i.test(text),
    filings: /공시|filing|dart|financial|실적|10-k|10q/i.test(text),
    parallel: /각각|나눠서|분담|병렬|parallel/i.test(text),
    multiAgentPrompt: /여러\s*agent|여러\s*에이전트|team|팀/i.test(text),
    explicitGeneralistOnly: /generalist/i.test(lower),
  };
}

function mergeBlueprints(base = [], extra = []) {
  const out = [];
  const seen = new Set();
  for (const row of [...asArray(base), ...asArray(extra)]) {
    const item = asObject(row);
    const label = clean(item.name || item.display_name || item.agent_name);
    const key = cleanId(label || item.role || item.agent_id);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: label || clean(item.role || item.agent_id || 'Researcher'),
      role: normalizeTeamRole(item.role || item.role_id || item.roleId || item.agent_id || 'researcher'),
      purpose: clean(item.purpose || item.why || item.description || ''),
      model: clean(item.model || ''),
      provider: cleanId(item.provider || ''),
      context_policy: item.context_policy || item.contextPolicy || null,
    });
  }
  return out;
}

function ensureFreeformBlueprintCoverage(blueprints = [], taskText = '', structuredAgents = []) {
  const hints = inferTaskStructureHints(taskText);
  let next = mergeBlueprints(blueprints, []);
  const hasRole = (roleId) => next.some((row) => normalizeTeamRole(row.role) === normalizeTeamRole(roleId));
  const pushRole = (name, role, purpose, model = '') => {
    next = mergeBlueprints(next, [{ name, role, purpose, model }]);
  };

  if ((next.length <= 1 && !hints.explicitGeneralistOnly) || hints.multiAgentPrompt || hints.parallel || hints.debate || hints.discussion) {
    const filteredStructuredAgents = asArray(structuredAgents).filter((agent) => {
      const roleId = normalizeTeamRole(agent?.role);
      if (roleId === 'builder') return hints.build;
      if (roleId === 'reviewer') return hints.review || hints.compare || hints.parallel || hints.debate || hints.discussion;
      if (roleId === 'synthesizer') return hints.synthesize || hints.review || hints.compare || hints.parallel || hints.debate || hints.discussion || next.length >= 2;
      if (roleId === 'operator') return /approve|승인|gate|operator|배포/i.test(taskText);
      return roleId === 'researcher';
    });
    if (
      next.length === 1
      && /generalist research/i.test(clean(next[0]?.name))
      && filteredStructuredAgents.some((agent) => normalizeTeamRole(agent?.role) === 'researcher')
    ) {
      next = [];
    }
    next = mergeBlueprints(next, filteredStructuredAgents.map((agent) => ({
      name: agent.name,
      role: agent.role,
      purpose: agent.purpose || 'structured fallback candidate',
      model: agent.model,
      provider: agent.provider,
      context_policy: agent.context_policy || null,
    })));
  }

  if (hints.compare && !hasRole('reviewer')) {
    pushRole('Reviewer', 'reviewer', '여러 관점의 주장과 근거를 검토한다', 'gpt-5.4');
  }
  if ((hints.compare || hints.debate || hints.discussion || hints.review || hints.parallel || next.length >= 2) && !hasRole('synthesizer')) {
    pushRole('Synthesizer', 'synthesizer', '병렬 결과와 검토 결과를 최종 답변으로 합친다', 'gpt-5.4');
  }
  if ((hints.review || hints.debate || hints.discussion) && !hasRole('reviewer')) {
    pushRole('Reviewer', 'reviewer', '결과를 검토하고 리스크를 정리한다', 'gpt-5.4');
  }
  if (hints.build && !hasRole('builder')) {
    pushRole('Builder', 'builder', /web\s*service|web\s*app|frontend|backend|api|server|client|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발/i.test(taskText)
      ? '웹 서비스/애플리케이션 구현과 코드 산출물을 만든다'
      : '구현 또는 코드 수정 초안을 만든다', 'gpt-5-codex');
  }
  if (hints.build && !hasRole('reviewer')) {
    pushRole('Reviewer', 'reviewer', '구현 결과와 회귀 위험을 검토한다', 'gpt-5.4');
  }
  if (hints.build && next.length >= 2 && !hasRole('synthesizer')) {
    pushRole('Synthesizer', 'synthesizer', '구현 결과와 검토 결과를 사용자 전달용으로 정리한다', 'gpt-5.4');
  }
  if (hints.news && !next.some((row) => /news/i.test(clean(row.name)) || /news/i.test(clean(row.purpose)))) {
    pushRole('News Researcher', 'researcher', '최근 뉴스와 이벤트를 수집한다');
  }
  if (hints.filings && !next.some((row) => /filing|공시|dart/i.test(`${clean(row.name)} ${clean(row.purpose)}`))) {
    pushRole('Filings Analyst', 'researcher', '공시와 수치 근거를 확인한다');
  }
  if (next.length === 0) {
    pushRole('Generalist Researcher', 'researcher', '문제를 빠르게 파악하고 필요한 증거를 모은다');
  }
  return next.slice(0, 6);
}

function skillsForRole(role = '', { taskText = '', agentName = '', purpose = '' } = {}) {
  return defaultSkillsForAgent({ role, taskText, purpose, name: agentName });
}

function agentDraft({ name = '', role = 'researcher', model = '', purpose = '', skills = [], provider = '' } = {}, { seen = new Set(), taskText = '', index = 1 } = {}) {
  const cleanRole = normalizeTeamRole(role);
  const proposedName = suggestAgentDisplayName({ name, role: cleanRole, purpose, taskText, skills, index }) || cleanRole.replace(/^./, (c) => c.toUpperCase());
  const displayName = ensureUniqueDisplayName(proposedName, seen.__displayNames || (seen.__displayNames = new Set()));
  const resolvedPurpose = autoPurposeForAgent({ role: cleanRole, purpose: shouldAutoRewritePurposeText(purpose) ? '' : purpose, taskText, name: displayName, skills });
  const resolvedSkills = asArray(skills).map((skill) => cleanId(skill)).filter(Boolean).length > 0
    ? asArray(skills).map((skill) => cleanId(skill)).filter(Boolean)
    : skillsForRole(cleanRole, { taskText, agentName: displayName, purpose: resolvedPurpose });
  const resolvedModel = resolveSupportedModel(model || '') || defaultModelForRole(cleanRole, provider);
  const resolvedProvider = cleanId(provider || inferProviderForModel(resolvedModel) || '');
  return {
    agent_id: uniqueSlug(displayName, seen),
    name: displayName,
    role: cleanRole,
    model: resolvedModel,
    purpose: clean(resolvedPurpose),
    skills: resolvedSkills,
    provider: resolvedProvider,
    context_policy: normalizeContextPolicy({}, { role: cleanRole, taskText, purpose: resolvedPurpose }),
  };
}

function remapInteractionSpecAgentNames(rawSpec = {}, aliasMap = new Map()) {
  const spec = normalizeInteractionSpec(rawSpec);
  const mapName = (value = '') => aliasMap.get(cleanId(value)) || clean(value);
  return normalizeInteractionSpec({
    ...spec,
    final_answer_owner: mapName(spec.final_answer_owner),
    handoffs: asArray(spec.handoffs).map((handoff) => ({ ...handoff, from: mapName(handoff.from), to: mapName(handoff.to) })),
  });
}

function reconcileInteractionSpecWithRoster(rawSpec = {}, agents = [], aliasMap = new Map()) {
  const remapped = remapInteractionSpecAgentNames(rawSpec, aliasMap);
  const roster = asArray(agents);
  const rosterNames = roster.map((agent) => clean(agent?.name)).filter(Boolean);
  const aliasToRoster = new Map();

  for (const agent of roster) {
    const canonical = clean(agent?.name);
    if (!canonical) continue;
    for (const candidate of [
      canonical,
      agent?.agent_id,
      agent?.agentId,
      agent?.id,
      agent?.role,
      agent?.role_id,
      agent?.roleId,
    ]) {
      const key = cleanId(candidate);
      if (!key || aliasToRoster.has(key)) continue;
      aliasToRoster.set(key, canonical);
    }
  }

  for (const [alias, mapped] of aliasMap.entries()) {
    const canonical = aliasToRoster.get(cleanId(mapped));
    if (!alias || !canonical || aliasToRoster.has(alias)) continue;
    aliasToRoster.set(alias, canonical);
  }

  const resolveRosterName = (value = '') => {
    const cleanValue = clean(value);
    if (!cleanValue) return '';
    if (rosterNames.includes(cleanValue)) return cleanValue;
    return aliasToRoster.get(cleanId(cleanValue)) || '';
  };

  // Planner/freeform drafts can reference agents that were renamed or pruned.
  // Reconcile to the actual roster here so validation only sees executable handoffs.
  const handoffs = asArray(remapped.handoffs)
    .map((handoff) => ({
      ...handoff,
      from: resolveRosterName(handoff.from),
      to: resolveRosterName(handoff.to),
    }))
    .filter((handoff) => handoff.from && handoff.to);

  const finalAnswerOwner = resolveRosterName(remapped.final_answer_owner)
    || clean(roster.find((agent) => normalizeTeamRole(agent?.role) === 'synthesizer')?.name)
    || clean(roster.find((agent) => normalizeTeamRole(agent?.role) === 'reviewer')?.name)
    || clean(roster[roster.length - 1]?.name);

  return normalizeInteractionSpec({
    ...remapped,
    final_answer_owner: finalAnswerOwner,
    handoffs,
  });
}


function inferCounterpartRoleBlueprints(description = '') {
  const text = clean(description);
  const hints = inferTaskStructureHints(text);
  if (!hints.debate && !hints.discussion && !/반대\s*의견|counter(?:-?| )argument|devil'?s advocate|skeptic/i.test(text)) {
    return [];
  }
  return [
    {
      name: 'Lead Thesis Researcher',
      role: 'researcher',
      purpose: '핵심 주장과 투자 thesis를 가장 강한 형태로 구조화한다',
      model: parseNaturalLanguageModelPreference(text, 'researcher'),
    },
    {
      name: 'Counterpoint Researcher',
      role: 'researcher',
      purpose: '다른 조사 agent의 핵심 주장에 대한 반대 의견과 깨지는 조건을 제시한다',
      model: parseNaturalLanguageModelPreference(text, 'researcher'),
    },
  ];
}

function normalizeGeneratedSkillBriefs(list = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(list)) {
    const row = asObject(raw);
    const label = clean(row.label || row.name || row.title);
    if (!label) continue;
    const skillId = cleanId(row.skill_id || row.skillId || `inline.${slugify(label).replace(/_/g, '.')}`) || `inline.${slugify(label).replace(/_/g, '.')}`;
    if (seen.has(skillId)) continue;
    seen.add(skillId);
    out.push({
      skill_id: skillId,
      label,
      goal: clean(row.goal || row.objective || row.description),
      checklist: uniqueIds(row.checklist || row.steps || row.bullets || [], { max: 5 }),
      selected_by: clean(row.selected_by || row.selectedBy || 'team_generator') || 'team_generator',
      executable: row.executable === true,
    });
  }
  return out.slice(0, 3);
}

function inferGeneratedSkillBriefs(agent = {}, planning = {}) {
  const taskText = clean(planning?.taskText || '');
  const hints = inferTaskStructureHints(taskText);
  const specialty = agentSpecialtyKey(agent, taskText);
  const roleId = normalizeTeamRole(agent?.role);
  const out = [];
  const push = (label, goal, checklist = []) => {
    out.push({ label, goal, checklist, selected_by: 'team_generator', executable: false });
  };
  if (roleId === 'researcher' && (hints.debate || hints.discussion)) {
    if (/counter|skeptic|반대|리스크|bear/i.test(`${clean(agent?.name)} ${clean(agent?.purpose)}`) || specialty === 'bear' || specialty === 'review') {
      push('반대 논리 생성 프로토콜', '다른 agent의 주장을 strongest form으로 요약한 뒤 가장 치명적인 반대 근거와 무효화 조건을 제시한다', [
        '상대 주장을 왜곡 없이 한 문장으로 재구성',
        '주장을 깨는 핵심 가정 2~3개 식별',
        '반례와 리스크 신호를 분리해 제시',
      ]);
    } else {
      push('핵심 논지 구조화 프로토콜', '자신의 핵심 thesis를 반박 가능한 형태로 구조화하고 근거 우선순위를 정리한다', [
        '핵심 주장 1개와 보조 주장 2개 이하로 정리',
        '주장별 근거와 불확실성을 분리',
        '상대 반박에 대비한 취약 지점 표시',
      ]);
    }
  }
  if (roleId === 'reviewer' && (hints.debate || hints.compare || hints.review)) {
    push('상반 관점 판정 루브릭', '충돌하는 주장 사이에서 근거 강도, 누락, 모순, 의사결정 영향을 판정한다', [
      '양측이 공유하는 사실과 갈리는 가정 분리',
      '가장 load-bearing한 근거 3개 우선 검토',
      '판정과 남는 불확실성 구분',
    ]);
  }
  if (roleId === 'synthesizer' && (hints.debate || hints.compare || hints.synthesize)) {
    push('찬반 결론 통합 루브릭', '서로 다른 관점의 결론을 사용자가 바로 판단할 수 있는 형태로 통합한다', [
      '합의점/쟁점/판단 포인트 3단으로 정리',
      '즉시 행동과 관찰 포인트를 분리',
      '최종 추천과 보류 조건을 함께 제시',
    ]);
  }
  if (roleId === 'researcher' && hints.filings && specialty === 'filings') {
    push('공시 숫자 검증 체크리스트', '공시와 실적 숫자를 해석할 때 비교 기준과 왜곡 가능성을 먼저 점검한다', [
      '전년/전분기 비교 기준 명시',
      '일회성 요인과 지속 요인 분리',
      '시장 기대와 숫자의 차이 확인',
    ]);
  }
  return normalizeGeneratedSkillBriefs(out);
}

function composeAssignedGoalText(purpose = '', generatedSkillBriefs = []) {
  const lines = [clean(purpose)].filter(Boolean);
  const briefs = normalizeGeneratedSkillBriefs(generatedSkillBriefs);
  if (briefs.length > 0) {
    lines.push('추가 수행 프로토콜:');
    for (const brief of briefs.slice(0, 2)) {
      lines.push(`- ${brief.label}: ${brief.goal || 'task-specific protocol'}`);
    }
  }
  return lines.join('\n').trim();
}

function mergeHandoffs(base = [], patch = []) {
  const out = [];
  const seen = new Set();
  for (const row of [...asArray(base), ...asArray(patch)]) {
    const entry = {
      from: clean(row?.from),
      to: clean(row?.to),
      payload: cleanId(row?.payload || 'summary_only') || 'summary_only',
    };
    if (!entry.from || !entry.to) continue;
    const key = `${cleanId(entry.from)}|${cleanId(entry.to)}|${entry.payload}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

function buildInteractionSpecForTeam({ taskText = '', agents = [], current = null } = {}) {
  const roster = asArray(agents).map((agent) => ({ name: agent?.name }));
  let spec = parseNaturalLanguageInteractionPatch(taskText, {
    current: current || buildDefaultInteractionSpec(agents, { task: taskText }),
    agentRoster: roster,
  });
  const hints = inferTaskStructureHints(taskText);
  const researchers = asArray(agents).filter((agent) => normalizeTeamRole(agent?.role) === 'researcher');
  const builders = asArray(agents).filter((agent) => normalizeTeamRole(agent?.role) === 'builder');
  const reviewer = asArray(agents).find((agent) => normalizeTeamRole(agent?.role) === 'reviewer') || null;
  const synthesizer = asArray(agents).find((agent) => normalizeTeamRole(agent?.role) === 'synthesizer') || null;
  const explicitSequential = /순차|pipeline|sequential/i.test(taskText);
  const explicitParallel = /병렬|parallel/i.test(taskText);
  const explicitDebate = hints.debate || hints.discussion;
  if (!explicitSequential && !explicitParallel && !explicitDebate && hints.build && builders.length > 0 && reviewer) {
    const finalOwner = clean(synthesizer?.name || reviewer?.name || builders[0]?.name);
    spec = normalizeInteractionSpec({
      ...spec,
      execution_pattern: 'builder_reviewer_loop',
      final_answer_owner: finalOwner,
      handoffs: mergeHandoffs([
        researchers[0] && builders[0] ? { from: researchers[0].name, to: builders[0].name, payload: 'repo_map_and_constraints' } : null,
        builders[0] && reviewer ? { from: builders[0].name, to: reviewer.name, payload: 'draft_plus_change_summary' } : null,
        reviewer && synthesizer ? { from: reviewer.name, to: synthesizer.name, payload: 'approved_summary_only' } : null,
      ], spec.handoffs),
      policies: {
        ...asObject(spec.policies),
        reviewer_visibility: 'full_workspace_summary',
        synthesizer_visibility: synthesizer ? 'upstream_outputs_only' : spec?.policies?.synthesizer_visibility,
        require_reviewer_before_final: true,
      },
    });
  }
  if ((hints.debate || hints.discussion) && researchers.length >= 2) {
    const counter = researchers.find((agent) => /counter|skeptic|반대|bear|리스크/i.test(`${clean(agent?.name)} ${clean(agent?.purpose)}`)) || researchers[1];
    const lead = researchers.find((agent) => agent !== counter) || researchers[0];
    spec = normalizeInteractionSpec({
      ...spec,
      execution_pattern: reviewer ? 'multi_research_adjudication' : 'sequential_pipeline',
      final_answer_owner: clean(synthesizer?.name || reviewer?.name || counter?.name || lead?.name),
      handoffs: mergeHandoffs([
        lead && counter ? { from: lead.name, to: counter.name, payload: 'claim_plus_supporting_evidence' } : null,
        counter && reviewer ? { from: counter.name, to: reviewer.name, payload: 'counterargument_plus_risks' } : null,
        lead && reviewer ? { from: lead.name, to: reviewer.name, payload: 'summary_plus_key_evidence' } : null,
        reviewer && synthesizer ? { from: reviewer.name, to: synthesizer.name, payload: 'review_summary_only' } : null,
        !reviewer && lead && synthesizer ? { from: lead.name, to: synthesizer.name, payload: 'summary_plus_key_evidence' } : null,
        !reviewer && counter && synthesizer ? { from: counter.name, to: synthesizer.name, payload: 'counterargument_plus_risks' } : null,
      ], spec.handoffs),
      policies: {
        ...asObject(spec.policies),
        reviewer_visibility: reviewer ? 'summaries_plus_selected_evidence' : spec?.policies?.reviewer_visibility,
        synthesizer_visibility: reviewer ? 'upstream_outputs_only' : 'full_context',
        require_reviewer_before_final: reviewer ? true : spec?.policies?.require_reviewer_before_final,
      },
    });
  } else if ((hints.compare || hints.parallel) && researchers.length >= 2) {
    const finalOwner = clean(synthesizer?.name || reviewer?.name || researchers[0]?.name);
    const handoffs = reviewer
      ? [
          ...researchers.map((agent) => ({ from: agent.name, to: reviewer.name, payload: 'summary_plus_key_evidence' })),
          reviewer && synthesizer ? { from: reviewer.name, to: synthesizer.name, payload: 'review_summary_only' } : null,
        ]
      : [
          ...researchers.filter((agent) => agent?.name && agent.name !== finalOwner).map((agent) => ({ from: agent.name, to: finalOwner, payload: 'summary_plus_key_evidence' })),
        ];
    spec = normalizeInteractionSpec({
      ...spec,
      execution_pattern: reviewer && synthesizer ? 'parallel_research_then_review_then_synthesize' : spec.execution_pattern,
      final_answer_owner: finalOwner,
      handoffs: mergeHandoffs(handoffs, spec.handoffs),
      policies: {
        ...asObject(spec.policies),
        reviewer_visibility: reviewer ? 'summaries_plus_selected_evidence' : spec?.policies?.reviewer_visibility,
        synthesizer_visibility: reviewer ? 'upstream_outputs_only' : spec?.policies?.synthesizer_visibility,
        require_reviewer_before_final: reviewer ? true : spec?.policies?.require_reviewer_before_final,
      },
    });
  }
  return spec;
}

function parseNaturalLanguageModelPreference(text = '', role = '') {
  const lower = clean(text).toLowerCase();
  const roleId = cleanId(role);
  const candidates = listSupportedModels();
  for (const candidate of candidates) {
    const label = String(candidate.label || '').toLowerCase();
    const id = String(candidate.id || '').toLowerCase();
    if (lower.includes(id) || lower.includes(label)) {
      if (!roleId) return id;
      if (new RegExp(`${roleId}[^\n,.]{0,30}(?:${id}|${label})`, 'i').test(lower)) return id;
    }
  }
  return '';
}

function inferFreeformAgentBlueprints(description = '') {
  const text = clean(description);
  const lower = text.toLowerCase();
  const hints = inferTaskStructureHints(text);
  const blueprints = [];
  const seenLabels = new Set();
  function pushIfMissing(label, role, purpose) {
    const key = cleanId(label);
    if (!key || seenLabels.has(key)) return;
    seenLabels.add(key);
    blueprints.push({ name: label, role, purpose, model: parseNaturalLanguageModelPreference(text, role) });
  }

  if (/낙관|bull|optimis/i.test(text)) pushIfMissing('Bull Analyst', 'researcher', '낙관적 시나리오와 성장 근거를 수집한다');
  if (/비관|bear|pessimis/i.test(text)) pushIfMissing('Bear Analyst', 'researcher', '비관적 시나리오와 리스크 근거를 수집한다');
  if (/뉴스|news/i.test(text)) pushIfMissing('News Researcher', 'researcher', '최근 뉴스와 이벤트를 수집한다');
  if (/공시|filing|dart|financial/i.test(text)) pushIfMissing('Filings Analyst', 'researcher', '공시와 수치 근거를 확인한다');
  if (/코드|구현|build|builder|refactor|리팩토|web\s*service|web\s*app|frontend|backend|api|server|client|react|next(?:\.js)?|node|express|fastapi|flask|django|spring|웹\s*서비스|웹앱|프론트엔드|백엔드|서버|클라이언트|서비스\s*개발/i.test(text)) pushIfMissing('Builder', 'builder', '구현과 수정 초안을 만든다');
  if (/red[ -]?team|반박|adversarial|critic/i.test(text)) pushIfMissing('Red-Team Reviewer', 'reviewer', '약한 주장과 반례를 지적한다');
  if (/review|검토|reviewer|검수|adjudicat|judge|조정/i.test(text)) pushIfMissing('Reviewer', 'reviewer', '결과를 검토하고 모순을 정리한다');
  if (/요약|정리|synth|summary|memo|보고서|final/i.test(text)) pushIfMissing('Synthesizer', 'synthesizer', '최종 답변과 요약을 작성한다');
  if (/approve|승인|send|배포|operator|gate/i.test(text)) pushIfMissing('Operator', 'operator', '외부 실행 전 승인과 실행 통제를 맡는다');

  const quoted = [];
  const regex = /["'“”‘’]([^"'“”‘’]{2,40})["'“”‘’]/g;
  let match;
  while ((match = regex.exec(text))) quoted.push(clean(match[1]));
  for (const label of quoted.slice(0, 4)) {
    const role = /review|검토|reviewer|critic|red/i.test(label) ? 'reviewer'
      : /builder|coder|개발|코드/i.test(label) ? 'builder'
      : /synth|writer|요약|정리/i.test(label) ? 'synthesizer'
      : 'researcher';
    pushIfMissing(label, role, `${label} 역할을 수행한다`);
  }

  if ((hints.debate || hints.discussion) && !/bull|bear|낙관|비관/i.test(text)) {
    for (const blueprint of inferCounterpartRoleBlueprints(text)) {
      pushIfMissing(blueprint.name, blueprint.role, blueprint.purpose);
    }
  }

  if ((hints.debate || hints.discussion) && !blueprints.some((item) => /reviewer|검증|judge|조정|moderator/i.test(`${clean(item.name)} ${clean(item.purpose)}`))) {
    pushIfMissing('Debate Adjudicator', 'reviewer', '서로 충돌하는 주장과 근거를 비교하고 판정한다');
  }
  if ((hints.debate || hints.discussion) && !blueprints.some((item) => normalizeTeamRole(item.role) === 'synthesizer')) {
    pushIfMissing('Decision Synthesizer', 'synthesizer', '토의 결과와 판정 결과를 사용자가 바로 이해할 결론으로 정리한다');
  }

  if (blueprints.length === 0) {
    pushIfMissing('Generalist Researcher', 'researcher', text || '요청을 조사하고 핵심 근거를 정리한다');
  }
  if (blueprints.length === 1 && !blueprints.some((item) => item.role === 'synthesizer') && /요약|정리|final|summary/i.test(text)) {
    pushIfMissing('Synthesizer', 'synthesizer', '최종 답변과 요약을 작성한다');
  }
  return blueprints.slice(0, 6);
}

function defaultAgentsFromCatalog(runtime = {}, taskText = '') {
  const rows = runtimeCatalog(runtime).slice(0, 4);
  const picked = rows.map((row) => ({
    agent_id: cleanId(row.id || row.agent_id),
    name: clean(row.name || row.id),
    role: cleanId(row.role || row.system_key || row.id),
    model: resolveSupportedModel(row.model || '') || defaultModelForRole(row.role, row.provider),
    purpose: clean(taskText),
    skills: asArray(row.skills).map((skill) => cleanId(skill?.id || skill)),
    provider: cleanId(row.provider || inferProviderForModel(row.model || '') || ''),
  })).filter((row) => row.agent_id);
  if (picked.length > 0) return picked;
  return [{ agent_id: 'researcher', name: 'Researcher', role: 'researcher', model: 'gemini-2.5-pro', purpose: clean(taskText), skills: [], provider: 'gemini' }];
}

export function getSessionTeamState(sessionStore, chatId) {
  const session = sessionStore?.get ? sessionStore.get(chatId) : {};
  return normalizeStoredTeamEnvelope(asObject(session?.team_config));
}

function saveSessionTeamState(sessionStore, chatId, state = {}) {
  if (!sessionStore?.upsert) return;
  const normalized = normalizeStoredTeamEnvelope(state);
  sessionStore.upsert(chatId, (session) => ({
    ...session,
    team_config: {
      status: normalized.status,
      active_team: normalized.active_team,
      pending_team: normalized.pending_team,
      composition_mode: normalized.composition_mode,
      proposal_mode: normalized.proposal_mode,
      updated_at: nowIso(),
    },
  }));
}

export async function hydrateSessionTeamStateFromConversationStore({ sessionStore = null, chatId = '', runtime = null } = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  if (current.active_team || current.pending_team) return current;
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore.getTeamConfig !== 'function') return current;
  const target = teamStoreTarget(runtime);
  if (!target.threadId && !target.jobId) return current;
  try {
    const persisted = normalizeStoredTeamEnvelope(await teamStore.getTeamConfig(target));
    if (!persisted.active_team && !persisted.pending_team) return current;
    saveSessionTeamState(sessionStore, chatId, persisted);
    return getSessionTeamState(sessionStore, chatId);
  } catch {
    return current;
  }
}

async function clearConversationStoreTeamConfiguration(runtime = null) {
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore.setTeamConfig !== 'function') return { ok: false, reason: 'team_store_unavailable' };
  const target = teamStoreTarget(runtime);
  if (!target.threadId && !target.jobId) return { ok: false, reason: 'missing_target' };
  await teamStore.setTeamConfig({ ...target, teamConfig: { status: 'none', active_team: null, pending_team: null, composition_mode: 'structured', proposal_mode: 'suggest', updated_at: nowIso() } });
  return { ok: true };
}

export function buildTeamConfigurationTemplate(team = {}) {
  const row = team && typeof team === 'object' ? team : {};
  const archetypeHint = cleanId(row.task_archetype || row.taskArchetype || row.blueprint_archetype || '');
  const shouldUseArchetypeTemplate = !Array.isArray(row.agents) || row.agents.length === 0;
  if (shouldUseArchetypeTemplate) {
    const archetype = archetypeHint || inferTaskArchetype({ team: row, structure: asObject(row.structure || row.structure_v2), memoryPlan: asObject(row.memory_plan) });
    const template = buildTaskArchetypeBlueprintDocument(archetype === 'general' ? 'implementation' : archetype, {
      title: clean(row.team_name || row.title || ''),
      taskBrief: clean(row.task_brief || row.taskBrief || row.description || ''),
      applyState: 'pending',
    });
    return JSON.stringify(template, null, 2);
  }
  const normalized = normalizeTeamConfig(row, { runtime: null, autoRenameGenericNames: false });
  const blueprintDocument = attachTeamBlueprint(normalized, { runtime: null, applyState: 'pending', source: 'template' });
  return JSON.stringify({
    kind: 'ddalggak_team_blueprint',
    version: 1,
    primary_schema: 'team_blueprint_v1',
    apply_state: 'pending',
    blueprint: blueprintDocument.team_blueprint,
    team: blueprintDocument,
    requirements: blueprintDocument.requirements,
  }, null, 2);
}

function stripBlueprintFieldsForRefinement(raw = {}) {
  const row = asObject(raw);
  const next = { ...row };
  delete next.structure_v2;
  delete next.structureV2;
  delete next.structure;
  delete next.team_blueprint;
  delete next.teamBlueprint;
  delete next.primary_schema;
  delete next.primarySchema;
  return next;
}

function normalizeTeamConfig(raw = {}, { runtime = null, autoRenameGenericNames = true } = {}) {
  const input = asObject(raw);
  const explicitStructure = input.kind === 'team_structure_v2'
    ? input
    : asObject(input.structure_v2 || input.structureV2);
  const normalizedStructure = Object.keys(explicitStructure).length > 0
    ? normalizeTeamStructureV2(explicitStructure)
    : null;
  const structureDerived = normalizedStructure ? deriveTeamConfigFromStructureV2(normalizedStructure) : {};
  const preferStructure = normalizedStructure && (
    ['structure_v2', 'team_blueprint_v1'].includes(cleanId(input.primary_schema || input.primarySchema || ''))
    || cleanId(input.kind || '') === 'team_structure_v2'
  );
  const row = normalizedStructure
    ? {
        ...(preferStructure ? input : structureDerived),
        ...(preferStructure ? structureDerived : input),
        requirements: input.requirements || normalizedStructure.requirements || structureDerived.requirements,
        capability_gaps: input.capability_gaps || input.capabilityGaps || structureDerived.capability_gaps || structureDerived.capabilityGaps,
        install_proposal_state: input.install_proposal_state || input.installProposalState || structureDerived.install_proposal_state || structureDerived.installProposalState,
        credential_binding_state: input.credential_binding_state || input.credentialBindingState || structureDerived.credential_binding_state || structureDerived.credentialBindingState,
        structure_v2: normalizedStructure,
        primary_schema: 'team_blueprint_v1',
      }
    : input;
  const compositionMode = normalizeCompositionMode(row.composition_mode || row.compositionMode || normalizedStructure?.metadata?.composition_mode || 'structured');
  const proposalMode = normalizeProposalMode(row.proposal_mode || row.proposalMode || (compositionMode === 'freeform' ? 'create' : 'suggest'));
  const taskBrief = clean(row.task_brief || row.taskBrief || row.task || row.design_prompt || row.designPrompt || normalizedStructure?.intent?.task_brief || '');
  const interactionAliasMap = new Map();
  const seenDisplayNames = new Set();
  const agents = asArray(row.agents).map((entry, index) => {
    const agentId = cleanId(entry.agent_id || entry.agentId || entry.id);
    if (!agentId) return null;
    const runtimeAgent = findCatalogAgent(runtime || {}, agentId) || {};
    const role = resolvePreferredTeamRole(
      entry.role,
      entry.role_id,
      entry.roleId,
      runtimeAgent.role,
      runtimeAgent.system_key,
      entry.name,
      runtimeAgent.name,
      entry.purpose,
      runtimeAgent.description,
      agentId,
    );
    const model = resolveSupportedModel(entry.model || runtimeAgent.model || '') || defaultModelForRole(role, runtimeAgent.provider || entry.provider);
    const rawName = clean(entry.name || runtimeAgent.name || agentId);
    const rawPurpose = shouldAutoRewritePurposeText(entry.purpose || runtimeAgent.description || '') ? '' : clean(entry.purpose || runtimeAgent.description || '');
    const autoRenamed = autoRenameGenericNames && shouldAutoRenameAgent(rawName);
    const suggestedName = autoRenamed ? suggestAgentDisplayName({ name: rawName, role, purpose: rawPurpose, taskText: taskBrief, skills: entry.skills, index: index + 1 }) : rawName;
    const name = autoRenamed ? ensureUniqueDisplayName(suggestedName, seenDisplayNames) : suggestedName;
    if (!autoRenamed) seenDisplayNames.add(cleanId(name));
    interactionAliasMap.set(cleanId(rawName), name);
    interactionAliasMap.set(agentId, name);
    const rawCapabilityLabels = uniqueIds(entry.capabilities || entry.skill_labels || []);
    const rawSkills = uniqueIds(entry.skills || []);
    const rawAttachedSkillIds = filterRelevantAttachedSkillIds(
      uniqueIds(entry.attached_skill_ids || entry.attachedSkillIds || rawSkills.filter((skillId) => String(skillId || '').trim().toLowerCase().startsWith('skill.'))),
      {
        role,
        taskText: taskBrief,
        purpose: rawPurpose,
        capabilities: rawCapabilityLabels.length > 0
          ? rawCapabilityLabels
          : uniqueIds(rawSkills.filter((skillId) => !String(skillId || '').trim().toLowerCase().startsWith('skill.'))),
        contextPolicy: entry.context_policy || entry.contextPolicy || {},
      },
    );
    const capabilityLabels = rawCapabilityLabels.length > 0
      ? rawCapabilityLabels
      : uniqueIds(rawSkills.filter((skillId) => !String(skillId || '').trim().toLowerCase().startsWith('skill.')));
    const purpose = autoPurposeForAgent({ role, purpose: rawPurpose, taskText: taskBrief, name, skills: capabilityLabels });
    const resolvedCapabilities = capabilityLabels.length > 0 ? capabilityLabels : skillsForRole(role, { taskText: taskBrief, agentName: name, purpose });
    return {
      agent_id: agentId,
      name,
      role,
      model: model || '',
      purpose,
      capabilities: resolvedCapabilities,
      skills: resolvedCapabilities,
      attached_skill_ids: rawAttachedSkillIds,
      generated_skill_briefs: normalizeGeneratedSkillBriefs(entry.generated_skill_briefs || entry.generatedSkillBriefs || []),
      required_tool_ids: uniqueIds(entry.required_tool_ids || entry.requiredToolIds || []),
      optional_tool_ids: uniqueIds(entry.optional_tool_ids || entry.optionalToolIds || []),
      recommended_tool_ids: uniqueIds(entry.recommended_tool_ids || entry.recommendedToolIds || []),
      matched_preset_id: cleanId(entry.matched_preset_id || entry.matchedPresetId || '' ) || undefined,
      matched_preset_name: clean(entry.matched_preset_name || entry.matchedPresetName || '' ) || undefined,
      provider: cleanId(entry.provider || runtimeAgent.provider || inferProviderForModel(model) || ''),
      context_policy: normalizeContextPolicy(entry.context_policy || entry.contextPolicy, { role, taskText: taskBrief, purpose }),
      source_agent: runtimeAgent,
    };
  }).filter(Boolean);
  const rawInteractionSpec = row.interaction_spec || row.interactions || buildDefaultInteractionSpec(agents, { task: taskBrief });
  const interactionSpec = validateInteractionSpec(
    reconcileInteractionSpecWithRoster(rawInteractionSpec, agents, interactionAliasMap),
    { agentRoster: agents.map((agent) => ({ name: agent.name, agent_id: agent.agent_id, role: agent.role })) }
  );
  const capabilityGaps = normalizeCapabilityGapList(row.capability_gaps || row.capabilityGaps || detectTeamCapabilityGaps({
    team: { agents },
    runtime,
    skillRegistry: getSkillRegistry(),
  }));
  const normalizedTeam = {
    team_name: clean(row.team_name || row.teamName || 'configured_team'),
    mode: cleanId(row.mode || 'scoped_context') || 'scoped_context',
    composition_mode: compositionMode,
    proposal_mode: proposalMode,
    task_brief: taskBrief,
    task_archetype: normalizeTaskArchetype(row.task_archetype || row.taskArchetype || row.team_blueprint?.task_archetype || row.teamBlueprint?.task_archetype || '', 'research'),
    design_prompt: clean(row.design_prompt || row.designPrompt || taskBrief),
    lock_after_apply: row.lock_after_apply !== false,
    agents,
    interaction_spec: interactionSpec,
    interaction_notes: buildInteractionSummaryLines(interactionSpec),
    shortcut_policy: normalizeShortcutPolicy(row.shortcut_policy || row.shortcutPolicy),
    planner_metadata: normalizePlannerMetadata(row.planner_metadata || row.plannerMetadata),
    good_for: asArray(row.good_for || row.goodFor || row.recommended_for || []).map((entry) => clean(entry)).filter(Boolean).slice(0, 8),
    bad_for: asArray(row.bad_for || row.badFor || row.anti_patterns || []).map((entry) => clean(entry)).filter(Boolean).slice(0, 8),
    catalog_tags: uniqueIds(row.catalog_tags || row.catalogTags || [], { max: 8 }),
    memory_plan: asObject(row.memory_plan || row.memoryPlan),
    runtime_execution: asObject(row.runtime_execution || row.runtimeExecution || normalizedStructure?.control_policy?.runtime_execution || normalizedStructure?.control_policy?.runtimeExecution),
    capability_gaps: capabilityGaps,
    requirements: normalizeManifestRequirements(row.requirements || buildManifestRequirements({
      team: row,
      capabilityGaps,
    })),
    status: cleanId(row.status || 'draft') || 'draft',
    created_at: clean(row.created_at || nowIso()),
    updated_at: nowIso(),
  };
  const derivedStructure = buildTeamStructureV2(normalizedTeam);
  const structureV2 = normalizedStructure
    ? normalizeTeamStructureV2({
        ...normalizedStructure,
        metadata: {
          ...asObject(derivedStructure.metadata),
          ...asObject(normalizedStructure.metadata),
        },
        intent: {
          ...asObject(derivedStructure.intent),
          ...asObject(normalizedStructure.intent),
        },
        participants: asArray(normalizedStructure.participants).length > 0 ? normalizedStructure.participants : derivedStructure.participants,
        topology: {
          ...asObject(derivedStructure.topology),
          ...asObject(normalizedStructure.topology),
          execution_pattern: cleanId(asObject(normalizedStructure.topology).execution_pattern || asObject(normalizedStructure.topology).executionPattern || derivedStructure.topology.execution_pattern),
          final_participant_id: cleanId(asObject(normalizedStructure.topology).final_participant_id || asObject(normalizedStructure.topology).finalParticipantId || derivedStructure.topology.final_participant_id || derivedStructure.control_policy?.final_answer_owner_participant_id),
          nodes: asArray(asObject(normalizedStructure.topology).nodes).length > 0 ? asArray(asObject(normalizedStructure.topology).nodes) : derivedStructure.topology.nodes,
          edges: asArray(asObject(normalizedStructure.topology).edges).length > 0 ? asArray(asObject(normalizedStructure.topology).edges) : derivedStructure.topology.edges,
        },
        interaction_policy: {
          ...asObject(derivedStructure.interaction_policy),
          ...asObject(normalizedStructure.interaction_policy),
          visibility: {
            ...asObject(asObject(derivedStructure.interaction_policy).visibility),
            ...asObject(asObject(normalizedStructure.interaction_policy).visibility),
          },
          handoff_policy: {
            ...asObject(asObject(derivedStructure.interaction_policy).handoff_policy),
            ...asObject(asObject(normalizedStructure.interaction_policy).handoff_policy),
          },
          followup_policy: {
            ...asObject(asObject(derivedStructure.interaction_policy).followup_policy),
            ...asObject(asObject(normalizedStructure.interaction_policy).followup_policy),
          },
          debate_policy: {
            ...asObject(asObject(derivedStructure.interaction_policy).debate_policy),
            ...asObject(asObject(normalizedStructure.interaction_policy).debate_policy),
          },
          consensus_policy: {
            ...asObject(asObject(derivedStructure.interaction_policy).consensus_policy),
            ...asObject(asObject(normalizedStructure.interaction_policy).consensus_policy),
          },
        },
        control_policy: {
          ...asObject(derivedStructure.control_policy),
          ...asObject(normalizedStructure.control_policy),
          final_answer_owner_participant_id: cleanId(asObject(normalizedStructure.control_policy).final_answer_owner_participant_id || asObject(normalizedStructure.control_policy).finalAnswerOwnerParticipantId || derivedStructure.control_policy.final_answer_owner_participant_id),
        },
        artifacts: {
          ...asObject(derivedStructure.artifacts),
          ...asObject(normalizedStructure.artifacts),
        },
        knowledge_surface: Object.keys(asObject(normalizedStructure.knowledge_surface || normalizedStructure.knowledgeSurface)).length > 0
          ? asObject(normalizedStructure.knowledge_surface || normalizedStructure.knowledgeSurface)
          : asObject(derivedStructure.knowledge_surface),
        memory_policy: Object.keys(asObject(normalizedStructure.memory_policy || normalizedStructure.memoryPolicy)).length > 0
          ? asObject(normalizedStructure.memory_policy || normalizedStructure.memoryPolicy)
          : asObject(derivedStructure.memory_policy),
        requirements: normalizedTeam.requirements,
        memory_plan: Object.keys(asObject(normalizedStructure.memory_plan || normalizedStructure.memoryPlan)).length > 0
          ? asObject(normalizedStructure.memory_plan || normalizedStructure.memoryPlan)
          : asObject(derivedStructure.memory_plan),
        runtime_state: {
          ...asObject(derivedStructure.runtime_state),
          ...asObject(normalizedStructure.runtime_state),
        },
      })
    : derivedStructure;
  const knowledgeDesign = deriveKnowledgeBaseDesign({
    goal: normalizedTeam.task_brief,
    teamConfig: {
      ...normalizedTeam,
      structure_v2: structureV2,
    },
  });
  const finalStructureV2 = normalizeTeamStructureV2({
    ...structureV2,
    knowledge_surface: knowledgeDesign.knowledge_surface,
    memory_policy: knowledgeDesign.memory_policy,
    memory_plan: knowledgeDesign.memory_plan,
  });
  const publishContractRepair = enforcePublishContractOnStructure(finalStructureV2);
  const repairedStructureV2 = publishContractRepair.structure;
  const repairedKnowledgeDesign = deriveKnowledgeBaseDesign({
    goal: normalizedTeam.task_brief,
    teamConfig: {
      ...normalizedTeam,
      structure_v2: repairedStructureV2,
      memory_plan: repairedStructureV2.memory_plan,
      knowledge_surface: repairedStructureV2.knowledge_surface,
      memory_policy: repairedStructureV2.memory_policy,
    },
  });
  const finalPublishedStructureV2 = normalizeTeamStructureV2({
    ...repairedStructureV2,
    knowledge_surface: repairedKnowledgeDesign.knowledge_surface,
    memory_policy: repairedKnowledgeDesign.memory_policy,
    memory_plan: repairedStructureV2.memory_plan,
  });
  const finalOwnerId = cleanId(finalPublishedStructureV2?.control_policy?.final_answer_owner_participant_id || finalPublishedStructureV2?.topology?.final_participant_id || '');
  const finalOwnerParticipant = asArray(finalPublishedStructureV2?.participants).find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  const finalInteractionSpec = finalOwnerParticipant
    ? validateInteractionSpec({
        ...normalizedTeam.interaction_spec,
        final_answer_owner: clean(finalOwnerParticipant?.name || finalOwnerId) || normalizedTeam.interaction_spec?.final_answer_owner,
      }, { agentRoster: normalizedTeam.agents.map((agent) => ({ name: agent.name, agent_id: agent.agent_id, role: agent.role })) })
    : normalizedTeam.interaction_spec;
  const finalPlannerMetadata = publishContractRepair.repair_summary.changed
    ? normalizePlannerMetadata({
        ...normalizedTeam.planner_metadata,
        reasoning_summary: [
          ...asArray(normalizedTeam.planner_metadata?.reasoning_summary),
          ...asArray(publishContractRepair.repair_summary.reasons),
        ].map((entry) => clean(entry)).filter(Boolean).slice(0, 5),
      })
    : normalizedTeam.planner_metadata;
  return attachTeamBlueprint({
    ...normalizedTeam,
    interaction_spec: finalInteractionSpec,
    planner_metadata: finalPlannerMetadata,
    structure_v2: finalPublishedStructureV2,
    knowledge_surface: repairedKnowledgeDesign.knowledge_surface,
    memory_policy: repairedKnowledgeDesign.memory_policy,
    memory_plan: finalPublishedStructureV2.memory_plan,
    knowledge_base_profile: repairedKnowledgeDesign.profile,
    primary_schema: 'team_blueprint_v1',
  }, { runtime, applyState: 'pending', source: 'normalize_team_config' });
}

function normalizePlannerMetadata(raw = null) {
  const row = asObject(raw);
  const reasoning = asArray(row.reasoning_summary || row.reasoningSummary || []).map((entry) => clean(entry)).filter(Boolean).slice(0, 5);
  return {
    planner_type: cleanId(row.planner_type || row.plannerType || 'heuristic_rule_based') || 'heuristic_rule_based',
    planner_model: clean(row.planner_model || row.plannerModel || ''),
    planning_source: cleanId(row.planning_source || row.plan_source || row.planSource || '') || undefined,
    reasoning_summary: reasoning,
    auto_refine_from_pattern_conflict: row.auto_refine_from_pattern_conflict === true || row.autoRefineFromPatternConflict === true || undefined,
    refine_trigger: cleanId(row.refine_trigger || row.refineTrigger || '') || undefined,
    refine_instruction: clean(row.refine_instruction || row.refineInstruction || '') || undefined,
  };
}

function summarizePlannerMetadata(metadata = null) {
  const row = normalizePlannerMetadata(metadata);
  const engine = row.planner_model ? `${clean(row.planner_type || 'planner')} · ${clean(row.planner_model)}` : clean(row.planner_type || 'planner');
  if (row.reasoning_summary.length === 0) return engine;
  return `${engine} · ${row.reasoning_summary[0]}`;
}

function findPlannerAgentMatch(plannerAgents = [], candidate = {}, used = new Set()) {
  const byName = asArray(plannerAgents).find((row, idx) => !used.has(idx) && cleanId(row?.name) === cleanId(candidate?.name));
  if (byName) return byName;
  const byRole = asArray(plannerAgents).find((row, idx) => !used.has(idx) && normalizeTeamRole(row?.role) === normalizeTeamRole(candidate?.role));
  return byRole || null;
}

function overlayPlannerAgentDraft(base = {}, plannerAgent = {}, { taskText = '' } = {}) {
  if (!plannerAgent || typeof plannerAgent !== 'object') return base;
  const role = normalizeTeamRole(plannerAgent.role || base.role);
  const name = clean(plannerAgent.name || base.name || 'Agent');
  const purpose = clean(plannerAgent.purpose || base.purpose);
  const model = resolveSupportedModel(plannerAgent.model || '') || base.model || defaultModelForRole(role, plannerAgent.provider || base.provider);
  const capabilities = uniqueIds([
    ...asArray(plannerAgent.capabilities),
    ...asArray(base.capabilities || base.skills),
  ], { max: 5 });
  const attachedSkillIds = uniqueIds([
    ...asArray(plannerAgent.attached_skill_ids || plannerAgent.attachedSkillIds),
    ...asArray(base.attached_skill_ids),
  ], { max: 6 });
  const generatedSkillBriefs = normalizeGeneratedSkillBriefs([
    ...asArray(plannerAgent.generated_skill_briefs || plannerAgent.generatedSkillBriefs),
    ...asArray(base.generated_skill_briefs || base.generatedSkillBriefs),
  ]);
  return {
    ...base,
    name,
    role,
    model,
    provider: cleanId(plannerAgent.provider || base.provider || inferProviderForModel(model) || ''),
    purpose: autoPurposeForAgent({ role, purpose, taskText, name, skills: capabilities }),
    capabilities: capabilities.length > 0 ? capabilities : asArray(base.capabilities || base.skills),
    skills: capabilities.length > 0 ? capabilities : asArray(base.capabilities || base.skills),
    attached_skill_ids: attachedSkillIds,
    required_tool_ids: uniqueIds([
      ...asArray(plannerAgent.required_tool_ids || plannerAgent.requiredToolIds),
      ...asArray(base.required_tool_ids),
    ], { max: 6 }),
    optional_tool_ids: uniqueIds([
      ...asArray(plannerAgent.optional_tool_ids || plannerAgent.optionalToolIds),
      ...asArray(base.optional_tool_ids),
      ...asArray(plannerAgent.recommended_tool_ids || plannerAgent.recommendedToolIds),
    ], { max: 6 }),
    recommended_tool_ids: uniqueIds([
      ...asArray(plannerAgent.required_tool_ids || plannerAgent.requiredToolIds),
      ...asArray(plannerAgent.optional_tool_ids || plannerAgent.optionalToolIds),
      ...asArray(plannerAgent.recommended_tool_ids || plannerAgent.recommendedToolIds),
      ...asArray(base.required_tool_ids),
      ...asArray(base.optional_tool_ids),
      ...asArray(base.recommended_tool_ids),
    ], { max: 6 }),
    generated_skill_briefs: generatedSkillBriefs,
    context_policy: normalizeContextPolicy(plannerAgent.context_policy || plannerAgent.contextPolicy || base.context_policy, { role, taskText, purpose }),
    matched_preset_id: cleanId(plannerAgent.matched_preset_id || plannerAgent.matchedPresetId || base.matched_preset_id || '' ) || undefined,
    matched_preset_name: clean(plannerAgent.matched_preset_name || plannerAgent.matchedPresetName || base.matched_preset_name || '' ) || undefined,
  };
}

function canRoleAliasAgent(left = {}, right = {}) {
  const leftRole = normalizeTeamRole(left?.role);
  const rightRole = normalizeTeamRole(right?.role);
  if (!leftRole || !rightRole || leftRole !== rightRole) return false;
  return leftRole !== 'researcher';
}

function buildPlannerDrivenFreeformAgents({ taskText = '', runtime = null, plannerPlan = null, structuredAgents = [] } = {}) {
  const planning = buildPlanningContext(taskText, runtime);
  const plannerAgents = asArray(plannerPlan?.agents).map((agent) => ({
    name: clean(agent?.name),
    role: resolvePreferredTeamRole(agent?.role, agent?.role_id, agent?.roleId, agent?.name, agent?.purpose, agent?.model),
    purpose: clean(agent?.purpose),
    model: clean(agent?.model),
    provider: cleanId(agent?.provider || ''),
    capabilities: uniqueIds(agent?.capabilities || []),
    attached_skill_ids: uniqueIds(agent?.attached_skill_ids || agent?.attachedSkillIds || []),
    generated_skill_briefs: normalizeGeneratedSkillBriefs(agent?.generated_skill_briefs || agent?.generatedSkillBriefs || []),
    required_tool_ids: uniqueIds(agent?.required_tool_ids || agent?.requiredToolIds || []),
    optional_tool_ids: uniqueIds(agent?.optional_tool_ids || agent?.optionalToolIds || []),
    recommended_tool_ids: uniqueIds(agent?.recommended_tool_ids || agent?.recommendedToolIds || []),
    context_policy: agent?.context_policy || agent?.contextPolicy || null,
  })).filter((agent) => agent.name);
  const blueprints = plannerAgents.map((agent) => ({
    name: agent.name,
    role: agent.role,
    purpose: agent.purpose,
    model: agent.model,
    provider: agent.provider,
    context_policy: agent.context_policy,
  }));
  const covered = ensureFreeformBlueprintCoverage(blueprints, taskText, structuredAgents);
  const seen = new Set();
  const usedPlannerIndexes = new Set();
  const drafts = covered.map((item, index) => {
    const base = enrichAgentDraft(agentDraft(item, { seen, taskText, index: index + 1 }), planning);
    const matchedIndex = plannerAgents.findIndex((row, idx) => !usedPlannerIndexes.has(idx) && (cleanId(row.name) === cleanId(item.name) || canRoleAliasAgent(row, item)));
    const matched = matchedIndex >= 0 ? plannerAgents[matchedIndex] : null;
    if (matchedIndex >= 0) usedPlannerIndexes.add(matchedIndex);
    return overlayPlannerAgentDraft(base, matched || null, { taskText });
  });
  return pruneAgentLineup(drafts, taskText, planning);
}


function buildPlannerDrivenRefineAgents({ taskText = '', runtime = null, plannerPlan = null, currentAgents = [] } = {}) {
  const planning = buildPlanningContext(taskText, runtime);
  const plannerAgents = asArray(plannerPlan?.agents).map((agent) => ({
    name: clean(agent?.name),
    role: resolvePreferredTeamRole(agent?.role, agent?.role_id, agent?.roleId, agent?.name, agent?.purpose, agent?.model),
    purpose: clean(agent?.purpose),
    model: clean(agent?.model),
    provider: cleanId(agent?.provider || ''),
    capabilities: uniqueIds(agent?.capabilities || []),
    attached_skill_ids: uniqueIds(agent?.attached_skill_ids || agent?.attachedSkillIds || []),
    generated_skill_briefs: normalizeGeneratedSkillBriefs(agent?.generated_skill_briefs || agent?.generatedSkillBriefs || []),
    required_tool_ids: uniqueIds(agent?.required_tool_ids || agent?.requiredToolIds || []),
    optional_tool_ids: uniqueIds(agent?.optional_tool_ids || agent?.optionalToolIds || []),
    recommended_tool_ids: uniqueIds(agent?.recommended_tool_ids || agent?.recommendedToolIds || []),
    context_policy: agent?.context_policy || agent?.contextPolicy || null,
  })).filter((agent) => agent.name);
  const currentRows = asArray(currentAgents).map((agent) => ({
    name: clean(agent?.name),
    role: resolvePreferredTeamRole(agent?.role, agent?.role_id, agent?.roleId, agent?.name, agent?.purpose, agent?.model),
    purpose: clean(agent?.purpose),
    model: clean(agent?.model),
    provider: cleanId(agent?.provider || ''),
    capabilities: uniqueIds(agent?.capabilities || agent?.skills || []),
    attached_skill_ids: uniqueIds(agent?.attached_skill_ids || agent?.attachedSkillIds || []),
    generated_skill_briefs: normalizeGeneratedSkillBriefs(agent?.generated_skill_briefs || agent?.generatedSkillBriefs || []),
    required_tool_ids: uniqueIds(agent?.required_tool_ids || agent?.requiredToolIds || []),
    optional_tool_ids: uniqueIds(agent?.optional_tool_ids || agent?.optionalToolIds || []),
    recommended_tool_ids: uniqueIds(agent?.recommended_tool_ids || agent?.recommendedToolIds || []),
    context_policy: agent?.context_policy || agent?.contextPolicy || null,
  })).filter((agent) => agent.name);
  const preserveMissing = !/(remove|delete|drop|replace|빼|제거|삭제|교체)/i.test(taskText);
  const seen = new Set();
  const drafts = [];
  const matchedCurrent = new Set();
  for (const [index, item] of plannerAgents.entries()) {
    const currentIndex = currentRows.findIndex((row, idx) => !matchedCurrent.has(idx) && (cleanId(row.name) === cleanId(item.name) || canRoleAliasAgent(row, item)));
    const current = currentIndex >= 0 ? currentRows[currentIndex] : null;
    if (currentIndex >= 0) matchedCurrent.add(currentIndex);
    const baseSource = current || item;
    const base = enrichAgentDraft(agentDraft(baseSource, { seen, taskText, index: index + 1 }), planning);
    drafts.push(overlayPlannerAgentDraft(base, item, { taskText }));
  }
  if (preserveMissing) {
    for (const [index, row] of currentRows.entries()) {
      if (matchedCurrent.has(index)) continue;
      drafts.push(enrichAgentDraft(agentDraft(row, { seen, taskText, index: drafts.length + 1 }), planning));
    }
  }
  const structuredFallback = buildStructuredAgentDrafts({ taskText, runtime, currentTeam: { agents: currentAgents } });
  const covered = ensureFreeformBlueprintCoverage(drafts.map((agent) => ({
    name: agent.name,
    role: agent.role,
    purpose: agent.purpose,
    model: agent.model,
    provider: agent.provider,
    context_policy: agent.context_policy || null,
  })), taskText, structuredFallback);
  const finalSeen = new Set();
  const finalDrafts = covered.map((item, index) => {
    const matched = drafts.find((agent) => cleanId(agent.name) === cleanId(item.name) || canRoleAliasAgent(agent, item));
    if (matched) return enrichAgentDraft(agentDraft(matched, { seen: finalSeen, taskText, index: index + 1 }), planning);
    return enrichAgentDraft(agentDraft(item, { seen: finalSeen, taskText, index: index + 1 }), planning);
  });
  return pruneAgentLineup(finalDrafts, taskText, planning);
}

export async function refineTeamConfigurationAdvanced({ team = {}, instruction = '', runtime = null, planner = null, jobId = '' } = {}) {
  const fallbackRuntime = runtime || { agentsCatalog: asArray(team?.agents).map((agent) => ({ id: agent.agent_id, name: agent.name, role: agent.role, model: agent.model, provider: agent.provider, skills: agent.skills })) };
  const current = normalizeTeamConfig(team, { runtime: fallbackRuntime });
  const instructionText = clean(instruction);
  const taskText = [clean(current.task_brief), instructionText].filter(Boolean).join('\nRefinement instruction: ');
  const activePlanner = typeof planner === 'function' ? planner : planTeamRefinementWithCodex;
  let plannerResult = null;
  try {
    plannerResult = await activePlanner({
      currentTeam: current,
      instruction: instructionText,
      runtime: fallbackRuntime,
      availableToolIds: collectAvailableToolIds(fallbackRuntime, loadAgents()),
      skillRegistry: getSkillRegistry(),
      presetRegistry: getPresetRegistry(),
      jobId,
    });
  } catch (error) {
    plannerResult = { ok: false, reason: `planner_exception:${String(error?.message || error)}` };
  }
  if (!plannerResult?.ok || !plannerResult?.plan) {
    const heuristic = refineTeamConfiguration(current, instructionText, { runtime: fallbackRuntime });
    heuristic.planner_metadata = normalizePlannerMetadata({
      planner_type: 'heuristic_rule_based',
      planner_model: '',
      planning_source: 'heuristic_refine_fallback',
      reasoning_summary: [clean(plannerResult?.reason || 'refine heuristics applied') || 'refine heuristics applied'],
    });
    return normalizeTeamConfig(heuristic, { runtime: fallbackRuntime });
  }
  const agents = buildPlannerDrivenRefineAgents({
    taskText,
    runtime: fallbackRuntime,
    plannerPlan: plannerResult.plan,
    currentAgents: current.agents,
  });
  const interactionSpec = buildInteractionSpecForTeam({
    taskText,
    agents,
    current: plannerResult.plan.interaction_spec || current.interaction_spec,
  });
  return normalizeTeamConfig({
    ...stripBlueprintFieldsForRefinement(current),
    team_name: clean(plannerResult.plan.team_name || current.team_name || 'refined_team'),
    composition_mode: current.composition_mode || 'freeform',
    proposal_mode: 'refine',
    agents,
    interaction_spec: interactionSpec,
    shortcut_policy: normalizeShortcutPolicy(plannerResult.plan.shortcut_policy || current.shortcut_policy),
    planner_metadata: normalizePlannerMetadata(plannerResult.planner_metadata),
    status: 'suggested',
    updated_at: nowIso(),
  }, { runtime: fallbackRuntime });
}

export async function buildAutoRefineDraftFromStructureConflict({ team = {}, instruction = '', runtime = null, planner = null } = {}) {
  const instructionText = clean(instruction);
  const baseRuntime = runtime || { agentsCatalog: asArray(team?.agents).map((agent) => ({ id: agent.agent_id, name: agent.name, role: agent.role, model: agent.model, provider: agent.provider, skills: agent.skills })) };
  const draft = await refineTeamConfigurationAdvanced({
    team,
    instruction: instructionText,
    runtime: baseRuntime,
    planner,
  });
  return normalizeTeamConfig({
    ...draft,
    proposal_mode: 'refine',
    status: 'suggested',
    structure_v2: draft?.structure_v2 && typeof draft.structure_v2 === 'object'
      ? {
          ...draft.structure_v2,
          metadata: {
            ...(asObject(draft.structure_v2.metadata)),
            proposal_mode: 'refine',
            status: 'suggested',
            planner_metadata: normalizePlannerMetadata({
              ...asObject(draft?.planner_metadata || draft?.structure_v2?.metadata?.planner_metadata),
              auto_refine_from_pattern_conflict: true,
              refine_trigger: 'structure_override_required',
              refine_instruction: instructionText,
            }),
          },
        }
      : draft?.structure_v2,
    planner_metadata: normalizePlannerMetadata({
      ...asObject(draft?.planner_metadata),
      auto_refine_from_pattern_conflict: true,
      refine_trigger: 'structure_override_required',
      refine_instruction: instructionText,
    }),
  }, { runtime: baseRuntime });
}

export async function createFreeformTeamConfigurationAdvanced({ description = '', runtime = null, planner = null, jobId = '' } = {}) {
  const effectiveRuntime = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  const taskText = clean(description);
  const initialSelection = selectTaskArchetypeTemplate({ taskText });
  const structuredFallback = suggestTeamConfiguration({ taskText, runtime: effectiveRuntime, preferredTaskArchetype: initialSelection.archetype });
  const heuristicTeam = createFreeformTeamConfiguration({ description: taskText, runtime: effectiveRuntime, preferredTaskArchetype: initialSelection.archetype });
  const activePlanner = typeof planner === 'function' ? planner : planFreeformTeamWithCodex;
  let plannerResult = null;
  try {
    plannerResult = await activePlanner({
      taskText,
      runtime: effectiveRuntime,
      availableToolIds: collectAvailableToolIds(effectiveRuntime, loadAgents()),
      skillRegistry: getSkillRegistry(),
      presetRegistry: getPresetRegistry(),
      jobId,
    });
  } catch (error) {
    plannerResult = { ok: false, reason: `planner_exception:${String(error?.message || error)}` };
  }
  if (!plannerResult?.ok || !plannerResult?.plan) {
    return {
      ...heuristicTeam,
      planner_metadata: normalizePlannerMetadata({
        planner_type: 'heuristic_rule_based',
        planner_model: '',
        planning_source: 'heuristic_fallback',
        reasoning_summary: extendPlannerReasoningSummary({
          reasoning_summary: [clean(plannerResult?.reason || 'freeform heuristics applied') || 'freeform heuristics applied'],
        }, initialSelection),
      }),
    };
  }
  const plannerSelection = selectTaskArchetypeTemplate({
    taskText,
    plannerPlan: plannerResult.plan,
    preferredTaskArchetype: initialSelection.archetype,
  });
  const teamName = clean(plannerResult.plan.team_name || heuristicTeam.team_name || taskText).slice(0, 48).replace(/\s+/g, '_') || 'freeform_team';
  const plannerSeed = buildTeamSeedFromTaskArchetype(plannerSelection.archetype, {
    taskBrief: taskText,
    title: teamName,
  });
  const agents = buildPlannerDrivenFreeformAgents({
    taskText,
    runtime: effectiveRuntime,
    plannerPlan: plannerResult.plan,
    structuredAgents: asArray(structuredFallback?.agents),
  });
  const interactionSpec = buildInteractionSpecForTeam({
    taskText,
    agents,
    current: plannerResult.plan.interaction_spec || plannerSeed.interaction_spec || heuristicTeam.interaction_spec,
  });
  const normalized = normalizeTeamConfig({
    ...plannerSeed,
    team_name: teamName,
    mode: 'scoped_context',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    lock_after_apply: true,
    agents,
    interaction_spec: interactionSpec,
    shortcut_policy: normalizeShortcutPolicy(plannerResult.plan.shortcut_policy || heuristicTeam.shortcut_policy || plannerSeed.shortcut_policy),
    status: 'suggested',
    task_brief: taskText,
    design_prompt: taskText,
    task_archetype: plannerSelection.archetype,
    planner_metadata: normalizePlannerMetadata({
      ...plannerResult.planner_metadata,
      reasoning_summary: extendPlannerReasoningSummary(plannerResult.planner_metadata, plannerSelection),
    }),
  }, { runtime: effectiveRuntime });
  return normalized;
}

export function suggestTeamConfiguration({ taskText = '', runtime = null, preferredTaskArchetype = '', currentTeam = null } = {}) {
  const effectiveRuntime = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  const suggestedName = clean(taskText).slice(0, 36).replace(/\s+/g, '_') || 'team_config';
  const { selection, seed } = buildTaskArchetypeSeed({ taskText, preferredTaskArchetype, currentTeam, title: suggestedName });
  const agents = buildStructuredAgentDrafts({ taskText, runtime: effectiveRuntime, preferredTaskArchetype: selection.archetype, currentTeam });
  const interactionSpec = buildInteractionSpecForTeam({ taskText, agents, current: seed.interaction_spec });
  return normalizeTeamConfig({
    ...seed,
    team_name: suggestedName || seed.team_name || 'team_config',
    mode: 'scoped_context',
    composition_mode: 'structured',
    proposal_mode: 'suggest',
    lock_after_apply: true,
    agents,
    interaction_spec: interactionSpec,
    shortcut_policy: normalizeShortcutPolicy(seed.shortcut_policy || buildDefaultShortcutPolicy()),
    status: 'suggested',
    task_brief: taskText,
    design_prompt: taskText,
    task_archetype: selection.archetype,
    planner_metadata: normalizePlannerMetadata({
      planner_type: 'task_archetype_template',
      planning_source: 'task_archetype_template',
      reasoning_summary: extendPlannerReasoningSummary({ reasoning_summary: [] }, selection),
    }),
  }, { runtime: effectiveRuntime });
}

export function createFreeformTeamConfiguration({ description = '', runtime = null, preferredTaskArchetype = '', currentTeam = null } = {}) {
  const effectiveRuntime = runtime && typeof runtime === 'object' ? runtime : buildFallbackRuntime();
  const taskText = clean(description);
  const suggestedName = clean(taskText).slice(0, 36).replace(/\s+/g, '_') || 'freeform_team';
  const { selection, seed } = buildTaskArchetypeSeed({ taskText, preferredTaskArchetype, currentTeam, title: suggestedName });
  const structuredFallback = suggestTeamConfiguration({ taskText, runtime: effectiveRuntime, preferredTaskArchetype: selection.archetype, currentTeam });
  const agents = buildFreeformAgentDrafts({
    taskText,
    runtime: effectiveRuntime,
    blueprints: inferFreeformAgentBlueprints(taskText),
    structuredAgents: asArray(structuredFallback?.agents),
  });
  const interactionSpec = buildInteractionSpecForTeam({ taskText, agents, current: seed.interaction_spec });
  return normalizeTeamConfig({
    ...seed,
    team_name: suggestedName || seed.team_name || 'freeform_team',
    mode: 'scoped_context',
    composition_mode: 'freeform',
    proposal_mode: 'create',
    lock_after_apply: true,
    agents,
    interaction_spec: interactionSpec,
    shortcut_policy: normalizeShortcutPolicy(seed.shortcut_policy || buildDefaultShortcutPolicy()),
    status: 'suggested',
    task_brief: taskText,
    design_prompt: taskText,
    task_archetype: selection.archetype,
    planner_metadata: normalizePlannerMetadata({
      planner_type: 'task_archetype_template',
      planning_source: 'task_archetype_template',
      reasoning_summary: extendPlannerReasoningSummary({ reasoning_summary: [] }, selection),
    }),
  }, { runtime: effectiveRuntime });
}

export function refineTeamConfiguration(team = {}, instruction = '', { runtime = null } = {}) {
  const fallbackRuntime = runtime || { agentsCatalog: asArray(team?.agents).map((agent) => ({ id: agent.agent_id, name: agent.name, role: agent.role, model: agent.model, provider: agent.provider, skills: agent.skills })) };
  const current = normalizeTeamConfig(team, { runtime: fallbackRuntime });
  const next = { ...stripBlueprintFieldsForRefinement(current), agents: [...current.agents] };
  const text = clean(instruction);
  const lower = text.toLowerCase();
  if (/builder\s+추가|builder\s+add|coder\s+agent|coder\s+add|코더\s*agent|코더\s*추가|ipython|jupyter|notebook/i.test(text)) {
    const existingIds = new Set(next.agents.map((agent) => cleanId(agent.agent_id)));
    const builderCandidate = runtimeCatalog(runtime).find((agent) => agent.role === 'builder' && !existingIds.has(agent.id));
    if (builderCandidate) {
      next.agents.push({
        agent_id: builderCandidate.id,
        name: builderCandidate.name || 'Builder',
        role: normalizeTeamRole(builderCandidate.role || 'builder'),
        model: resolveSupportedModel(builderCandidate.model || '') || defaultModelForRole('builder', builderCandidate.provider),
        purpose: /ipython|jupyter|notebook/i.test(text) ? 'IPython/Jupyter notebook 실습과 과제 초안을 구현한다' : 'Implement changes',
        skills: builderCandidate.skills || [],
        provider: cleanId(builderCandidate.provider || inferProviderForModel(builderCandidate.model || '') || 'codex'),
      });
    } else {
      const seen = new Set(next.agents.map((agent) => cleanId(agent.agent_id)));
      const draft = agentDraft({ name: 'Builder', role: 'builder', purpose: /ipython|jupyter|notebook/i.test(text) ? 'IPython/Jupyter notebook 실습과 과제 초안을 구현한다' : 'Implement changes', model: 'gpt-5-codex' }, { seen, taskText: current.task_brief || text, index: next.agents.length + 1 });
      next.agents.push(draft);
    }
  }
  if (current.composition_mode === 'freeform' && /추가|add|include/i.test(lower)) {
    const seen = new Set(next.agents.map((agent) => cleanId(agent.agent_id)));
    for (const blueprint of inferFreeformAgentBlueprints(text)) {
      if (next.agents.some((agent) => cleanId(agent.name) === cleanId(blueprint.name))) continue;
      next.agents.push(agentDraft(blueprint, { seen, taskText: current.task_brief || text, index: next.agents.length + 1 }));
    }
  }
  next.interaction_spec = buildInteractionSpecForTeam({ taskText: text, agents: next.agents, current: current.interaction_spec });
  next.interaction_notes = buildInteractionSummaryLines(next.interaction_spec);
  next.proposal_mode = 'refine';
  next.status = 'suggested';
  next.updated_at = nowIso();
  return normalizeTeamConfig(next, { runtime: fallbackRuntime });
}

export function parseTeamTemplate(raw = '') {
  const text = clean(raw);
  if (!text) throw new Error('template is empty');
  try { return JSON.parse(text); } catch (error) { throw new Error(`template parse failed: ${String(error?.message || error)}`); }
}

export function validateTeamConfiguration(raw = {}, { runtime = null } = {}) {
  const team = normalizeTeamConfig(raw, { runtime, autoRenameGenericNames: false });
  if (team.agents.length === 0) throw new Error('team must include at least one agent');
  if (!COMPOSITION_MODES.has(team.composition_mode)) throw new Error(`unsupported composition_mode: ${team.composition_mode}`);
  const seenIds = new Set();
  const seenNames = new Set();
  for (const agent of team.agents) {
    if (!agent.model) throw new Error(`unsupported or missing model for ${agent.name}`);
    agent.provider = cleanId(agent.provider || inferProviderForModel(agent.model) || '');
    if (!agent.provider) throw new Error(`unsupported provider for ${agent.name}`);
    const agentId = cleanId(agent.agent_id);
    if (!agentId) throw new Error('agent_id is required');
    if (seenIds.has(agentId)) throw new Error(`duplicate agent_id: ${agent.agent_id}`);
    seenIds.add(agentId);
    const agentName = clean(agent.name);
    if (!agentName) throw new Error(`agent name is required for ${agent.agent_id}`);
    const agentNameKey = agentName.toLowerCase();
    if (seenNames.has(agentNameKey)) throw new Error(`duplicate agent name: ${agent.name}`);
    seenNames.add(agentNameKey);
  }
  validateInteractionSpec(team.interaction_spec, { agentRoster: team.agents.map((agent) => ({ name: agent.name })) });
  return team;
}

export async function syncTeamConfigurationToConversationStore({ runtime = null, teamConfig = null, source = 'team_apply' } = {}) {
  const teamStore = runtime?.capabilities?.conversationTeamStore;
  if (!teamStore || typeof teamStore !== 'object' || !teamConfig) return { ok: false, reason: 'team_store_unavailable' };
  const normalizedTeam = validateTeamConfiguration(teamConfig, { runtime });
  const target = teamStoreTarget(runtime, { source });
  const desiredRows = asArray(normalizedTeam.agents).map((agent, index) => ({
    agent_id: agent.agent_id,
    enabled: true,
    order_index: index,
    overrides_json: {
      name: clean(agent.name),
      purpose: clean(agent.purpose),
      configured_model: agent.model,
      configured_role: agent.role,
      configured_provider: cleanId(agent.provider || inferProviderForModel(agent.model) || ''),
      capabilities: uniqueIds(agent.capabilities || agent.skills || []),
      recommended_tool_ids: uniqueIds(agent.recommended_tool_ids || agent.recommendedToolIds || []),
      matched_preset_id: cleanId(agent.matched_preset_id || agent.matchedPresetId || '' ) || undefined,
      matched_preset_name: clean(agent.matched_preset_name || agent.matchedPresetName || '' ) || undefined,
      attached_skills: uniqueIds(agent.attached_skill_ids || agent.attachedSkillIds || agent.skills || [])
        .map((skillId) => ({ skill_id: cleanId(skillId), selected_by: 'team_config' }))
        .filter((entry) => entry.skill_id),
      generated_skill_briefs: normalizeGeneratedSkillBriefs(agent.generated_skill_briefs || agent.generatedSkillBriefs || []),
      context_policy: normalizeContextPolicy(agent.context_policy || agent.contextPolicy, {
        role: agent.role,
        taskText: normalizedTeam.task_brief,
        purpose: agent.purpose,
      }),
      local_interaction_contract: buildAgentLocalInteractionContract(normalizedTeam.interaction_spec, agent.name),
      composition_mode: normalizedTeam.composition_mode,
      proposal_mode: normalizedTeam.proposal_mode,
    },
  }));
  const desiredIds = new Set(desiredRows.map((row) => cleanId(row.agent_id)));
  let existingRows = [];
  if (typeof teamStore.listAgents === 'function') {
    try {
      const listed = await teamStore.listAgents(target);
      existingRows = asArray(listed?.rows || listed || []).map((row) => ({
        agent_id: cleanId(row?.agent_id || row?.agentId || row?.id),
        enabled: row?.enabled !== false,
        order_index: Number.isFinite(Number(row?.order_index ?? row?.orderIndex ?? row?.order))
          ? Math.max(0, Math.floor(Number(row?.order_index ?? row?.orderIndex ?? row?.order)))
          : null,
        overrides_json: asObject(row?.overrides_json ?? row?.overridesJson ?? row?.overrides),
      })).filter((row) => row.agent_id);
    } catch {}
  }
  for (const existing of existingRows) {
    if (!desiredIds.has(existing.agent_id) && typeof teamStore.removeAgent === 'function') {
      await teamStore.removeAgent({ ...target, agentId: existing.agent_id }).catch(() => null);
    }
  }
  const existingMap = new Map(existingRows.map((row) => [row.agent_id, row]));
  const rows = [];
  for (const desired of desiredRows) {
    const existing = existingMap.get(cleanId(desired.agent_id));
    if (!existing && typeof teamStore.addAgent === 'function') {
      await teamStore.addAgent({
        ...target,
        agentId: desired.agent_id,
        enabled: true,
        orderIndex: desired.order_index,
        overridesJson: desired.overrides_json,
      });
    } else if (existing) {
      const needsPatch = existing.enabled !== true
        || Number(existing.order_index ?? -1) !== desired.order_index
        || JSON.stringify(asObject(existing.overrides_json)) !== JSON.stringify(asObject(desired.overrides_json));
      if (needsPatch) {
        if (typeof teamStore.patchAgent === 'function') {
          await teamStore.patchAgent({ ...target, agentId: desired.agent_id, patch: desired }).catch(() => null);
        } else if (typeof teamStore.setAgentEnabled === 'function') {
          await teamStore.setAgentEnabled({
            ...target,
            agentId: desired.agent_id,
            enabled: true,
            orderIndex: desired.order_index,
            overridesJson: desired.overrides_json,
          }).catch(() => null);
        }
      }
    }
    rows.push(desired);
  }
  if (typeof teamStore.setTeamConfig === 'function') {
    await teamStore.setTeamConfig({
      ...target,
      teamConfig: {
        status: 'active',
        composition_mode: normalizedTeam.composition_mode,
        proposal_mode: normalizedTeam.proposal_mode,
        active_team: normalizedTeam,
        pending_team: null,
        updated_at: nowIso(),
      },
    });
  }
  return { ok: true, rows };
}

export function applyTeamConfigurationToRuntime(runtime = {}, teamConfig = null) {
  const team = teamConfig && typeof teamConfig === 'object' ? teamConfig : null;
  if (!team) return runtime;
  const structure = normalizeTeamStructureV2(team.structure_v2 || buildTeamStructureV2(team));
  const executionProfile = buildRuntimeExecutionProfileFromStructureV2(structure, {
    taskBrief: team.task_brief,
    compositionMode: team.composition_mode,
    proposalMode: team.proposal_mode,
  });
  const catalog = new Map(runtimeCatalog(runtime).map((row) => [cleanId(row.id), row]));
  const configuredAgents = [];
  const runtimeAgents = [];
  const enabledAgentIds = [];
  for (const [index, configAgent] of asArray(executionProfile.configured_agents).entries()) {
    const base = asObject(catalog.get(cleanId(configAgent.agent_id)) || {});
    const merged = {
      ...base,
      id: cleanId(configAgent.agent_id),
      name: clean(configAgent.name || base.name || configAgent.agent_id),
      role: normalizeTeamRole(configAgent.role || base.role || base.system_key || configAgent.agent_id),
      model: clean(configAgent.model || base.model),
      provider: cleanId(configAgent.provider || base.provider || inferProviderForModel(configAgent.model || base.model || '') || ''),
      configured_model: clean(configAgent.model || base.model),
      capabilities: uniqueIds(configAgent.capabilities || configAgent.skills || []),
      skills: asArray(configAgent.capabilities || configAgent.skills).length > 0 ? uniqueIds(configAgent.capabilities || configAgent.skills) : asArray(base.skills),
      attached_skill_ids: uniqueIds(configAgent.attached_skill_ids || configAgent.attachedSkillIds || []),
      generated_skill_briefs: normalizeGeneratedSkillBriefs(configAgent.generated_skill_briefs || configAgent.generatedSkillBriefs || []),
      required_tool_ids: uniqueIds(configAgent.required_tool_ids || configAgent.requiredToolIds || []),
      optional_tool_ids: uniqueIds(configAgent.optional_tool_ids || configAgent.optionalToolIds || []),
      recommended_tool_ids: uniqueIds(configAgent.recommended_tool_ids || configAgent.recommendedToolIds || []),
      interaction_contract: configAgent.interaction_contract || buildAgentLocalInteractionContract(executionProfile.interaction_spec, clean(configAgent.name || base.name || configAgent.agent_id)),
      prompt: clean(base.prompt || configAgent.prompt || ''),
      context_policy: normalizeContextPolicy(configAgent.context_policy || configAgent.contextPolicy, {
        role: configAgent.role || base.role,
        taskText: team.task_brief,
        purpose: configAgent.purpose,
      }),
      enabled: true,
      order_index: index,
      participant_id: clean(configAgent.agent_id),
    };
    configuredAgents.push(merged);
    enabledAgentIds.push(merged.id);
    runtimeAgents.push({
      instance_id: `team_${merged.role}_${index + 1}`,
      slot_id: clean(configAgent.slot_id || configAgent.agent_id || merged.id),
      template_id: merged.id,
      participant_id: merged.id,
      display_label: merged.name,
      role_id: merged.role,
      provider: cleanId(merged.provider || inferProviderForModel(merged.model) || ''),
      model: merged.model,
      attached_skill_ids: uniqueIds(merged.attached_skill_ids || merged.attachedSkillIds || merged.skills),
      capability_tags: uniqueIds(merged.capabilities || merged.skills),
      required_tool_ids: uniqueIds(merged.required_tool_ids || merged.requiredToolIds || []),
      optional_tool_ids: uniqueIds(merged.optional_tool_ids || merged.optionalToolIds || []),
      recommended_tool_ids: uniqueIds(merged.recommended_tool_ids || merged.recommendedToolIds || []),
      assigned_goal: composeAssignedGoalText(configAgent.purpose, merged.generated_skill_briefs),
      interaction_contract: merged.interaction_contract,
      context_policy: merged.context_policy,
      composition_mode: team.composition_mode,
      order_index: configAgent?.interaction_contract?.order_index,
      stage_index: configAgent?.interaction_contract?.stage_index,
      parallel_group_id: configAgent?.interaction_contract?.parallel_group_id,
      status: 'ready',
    });
  }
  runtime.activeTeamConfig = attachTeamBlueprint({ ...team, structure_v2: structure, knowledge_surface: structure.knowledge_surface, memory_policy: structure.memory_policy, memory_plan: structure.memory_plan, runtime_execution: asObject(structure.control_policy?.runtime_execution), knowledge_base_profile: deriveKnowledgeBaseDesign({ goal: team.task_brief || structure?.intent?.task_brief || '', teamConfig: { ...team, structure_v2: structure } }).profile, primary_schema: 'team_blueprint_v1' }, { runtime, applyState: 'active', source: 'apply_team_configuration' });
  runtime.activeTeamStructure = structure;
  runtime.teamLocked = true;
  runtime.teamInteractionSpec = normalizeInteractionSpec(executionProfile.interaction_spec || team.interaction_spec);
  runtime.teamCompositionMode = team.composition_mode;
  runtime.teamTopologyPattern = cleanId(structure?.topology?.pattern || executionProfile?.execution_graph?.pattern || 'hybrid') || 'hybrid';
  runtime.agents = configuredAgents;
  runtime.enabledAgentIds = enabledAgentIds;
  runtime.runtimeParticipants = executionProfile.runtime_participants;
  runtime.nonExecutableParticipants = executionProfile.non_executable_participants;
  runtime.runtimeTeamSnapshot = {
    ...(asObject(runtime.runtimeTeamSnapshot)),
    structure_v2: structure,
    runtime_participants: executionProfile.runtime_participants,
    topology_pattern: runtime.teamTopologyPattern,
    non_executable_participants: executionProfile.non_executable_participants,
    runtime_agents: runtimeAgents,
    interaction_spec: runtime.teamInteractionSpec,
    composition_mode: team.composition_mode,
    proposal_mode: team.proposal_mode,
    shortcut_policy: normalizeShortcutPolicy(team.shortcut_policy),
    knowledge_surface: asObject(structure.knowledge_surface),
    memory_policy: asObject(structure.memory_policy),
    runtime_execution: asObject(structure.control_policy?.runtime_execution),
    execution_graph: executionProfile.execution_graph,
    team_locked: true,
  };
  return runtime;
}


function buildCompactCapabilityHeadline(team = {}, runtime = null) {
  const contract = buildTeamCapabilityContract({ team, runtime });
  const required = formatToolLabels(contract.required_tool_ids || [], { max: 3 }).join(', ');
  const optionalMissing = formatToolLabels(contract.missing_optional_tool_ids || [], { max: 3 }).join(', ');
  if (contract.status === 'ready') return '실행 준비: 바로 실행 가능';
  if (contract.status === 'degraded') return `실행 준비: 일부 제약 있음${required ? ` · 필수 tool ${required}` : ''}`;
  if (contract.status === 'unbound') return `실행 준비: runtime 연결 정보 부족${optionalMissing ? ` · 없으면 아쉬운 tool ${optionalMissing}` : ''}`;
  if (contract.status === 'advisory_gap') return `실행 준비: 기본 진행 가능${optionalMissing ? ` · 있으면 더 좋은 tool ${optionalMissing}` : ''}`;
  return `실행 준비: ${contract.status}`;
}

function buildCompactInteractionSummaryLines(spec = {}, shortcutPolicy = null) {
  const row = spec && typeof spec === 'object' ? spec : {};
  const policies = row.policies && typeof row.policies === 'object' ? row.policies : {};
  const handoffCount = asArray(row.handoffs).length;
  const lines = [
    `흐름: ${humanizeExecutionPattern(row.execution_pattern)}`,
    `최종 답변 담당: ${clean(row.final_answer_owner) || '미정'}`,
  ];
  if (policies.reviewer_visibility) lines.push(`검토 범위: ${humanizeVisibility(policies.reviewer_visibility)}`);
  if (typeof policies.builder_direct_response === 'boolean') lines.push(`Builder 직접 응답: ${policies.builder_direct_response ? '허용' : '비허용'}`);
  if (shortcutPolicy && typeof shortcutPolicy === 'object') {
    const enabled = shortcutPolicy.enabled !== false;
    lines.push(`짧은 후속 질문 shortcut: ${enabled ? '켜짐' : '꺼짐'}`);
  }
  if (handoffCount > 0) lines.push(`handoff: ${handoffCount}개`);
  return lines;
}

function buildCompactAgentPresentationLines(agent = {}, index = 0) {
  const requiredToolLabels = formatToolLabels(agent.required_tool_ids || [], { max: 3 });
  const optionalToolLabels = formatToolLabels(agent.optional_tool_ids || agent.recommended_tool_ids || [], { max: 3 });
  const capabilityLabels = formatSkillLabels(agent.capabilities || agent.skills, { max: 3 });
  const generatedSkillLabels = normalizeGeneratedSkillBriefs(agent.generated_skill_briefs || agent.generatedSkillBriefs || []).map((entry) => entry.label).slice(0, 2);
  const overlayProfile = formatRoleOverlayProfile(agent.role, agent, { includeBaseLabel: true });
  const hasOverlay = /overlay=/.test(String(overlayProfile || ''));
  return [
    `${index + 1}. ${agent.name} · ${roleLabel(agent.role)} · ${humanizeModel(agent.provider || inferProviderForModel(agent.model || ''), agent.model)}`,
    hasOverlay ? `   - 역할 프로필: ${overlayProfile}` : null,
    `   - 맡은 일: ${clean(agent.purpose) || '설명 없음'}`,
    capabilityLabels.length > 0 ? `   - 주력 역량: ${capabilityLabels.join(', ')}` : null,
    generatedSkillLabels.length > 0 ? `   - 생성 skill: ${generatedSkillLabels.join(', ')}` : null,
    requiredToolLabels.length > 0 ? `   - 필수 tool: ${requiredToolLabels.join(', ')}` : null,
    optionalToolLabels.length > 0 ? `   - 선호 tool: ${optionalToolLabels.join(', ')}` : null,
  ].filter(Boolean);
}

export function buildTeamListMessage(teamState = {}, { runtime = null } = {}) {
  const active = teamState?.active_team;
  if (!active) return '현재 활성 팀이 없습니다.\n/team suggest <목적> 또는 /team create <자연어 팀 설명> 으로 팀을 먼저 구성해 주세요.';
  const lines = [
    `팀 이름: ${clean(active.team_name || 'active_team')}`,
    `구성 방식: ${normalizeCompositionMode(active.composition_mode || 'structured')}`,
    active.task_archetype ? `task archetype: ${clean(active.task_archetype)}` : null,
    active.structure_v2?.topology?.pattern ? `structure 패턴: ${clean(active.structure_v2.topology.pattern)}` : null,
    buildCompactCapabilityHeadline(active, runtime),
    '',
    'Agents',
    ...asArray(active.agents).flatMap((agent, index) => buildCompactAgentPresentationLines(agent, index)),
    '',
    'Interaction',
    ...buildCompactInteractionSummaryLines(active.interaction_spec || {}, active.shortcut_policy || {}),
  ];
  return lines.join('\n');
}

export function formatTeamProposalMessage(team = {}, { runtime = null } = {}) {
  const row = team && typeof team === 'object' ? team : {};
  const compositionMode = normalizeCompositionMode(row.composition_mode || 'structured');
  const proposalMode = normalizeProposalMode(row.proposal_mode || (compositionMode === 'freeform' ? 'create' : 'suggest'));
  const lines = [
    `Team proposal · ${clean(row.team_name || 'team_config')}`,
    `구성 방식: ${compositionMode} · 제안 모드: ${proposalMode}`,
    row.task_brief ? `목표: ${clean(row.task_brief)}` : null,
    row.task_archetype ? `task archetype: ${clean(row.task_archetype)}` : null,
    row.structure_v2?.topology?.pattern ? `structure 패턴: ${clean(row.structure_v2.topology.pattern)}` : null,
    row.planner_metadata ? `설계 엔진: ${summarizePlannerMetadata(row.planner_metadata)}` : null,
    asArray(row.good_for).length > 0 ? `good for: ${asArray(row.good_for).slice(0, 2).join(', ')}` : null,
    buildCompactCapabilityHeadline(row, runtime),
    '',
    'Agents',
    ...asArray(row.agents).flatMap((agent, index) => buildCompactAgentPresentationLines(agent, index)),
    '',
    'Interaction',
    ...buildCompactInteractionSummaryLines(row.interaction_spec || {}, row.shortcut_policy || {}),
    ...(formatManifestRequirementLines(row.requirements || buildManifestRequirements({
      team: row,
      capabilityGaps: row.capability_gaps || row.capabilityGaps || [],
    }), { maxLines: 4 }).length > 0 ? [
      '',
      '실행 requirements',
      ...formatManifestRequirementLines(row.requirements || buildManifestRequirements({
        team: row,
        capabilityGaps: row.capability_gaps || row.capabilityGaps || [],
      }), { maxLines: 4 }),
    ] : []),
    '',
    '다음 단계',
    '- /team apply',
    '- /team refine <자연어 수정>',
    '- /team template',
    '- /team options',
  ].filter(Boolean);
  return lines.join('\n');
}


function indexTeamAgents(team = {}) {
  const out = new Map();
  for (const agent of asArray(team?.agents)) {
    const key = cleanId(agent?.agent_id || agent?.name || '');
    if (!key || out.has(key)) continue;
    out.set(key, asObject(agent));
  }
  return out;
}

function indexMemorySurfaces(structure = {}) {
  const plan = asObject(asObject(structure).memory_plan || asObject(structure).memoryPlan);
  const out = new Set();
  for (const surface of asArray(plan.surfaces)) {
    const id = cleanId(surface?.surface_id || surface?.id || '');
    if (id) out.add(id);
  }
  return out;
}

function surfaceMatchesPublishTarget(surface = {}, surfaceId = '') {
  const target = cleanId(surfaceId);
  if (!target) return false;
  if (cleanId(surface?.surface_id || surface?.id || '') === target) return true;
  return asArray(surface?.semantic_slots || surface?.semanticSlots).map((entry) => cleanId(entry)).filter(Boolean).includes(target);
}

function canRolePublishSurfaceFromStructure(structure = {}, roleId = '', surfaceId = '') {
  const cleanRole = cleanId(roleId);
  const target = cleanId(surfaceId);
  if (!cleanRole || !target) return false;
  const plan = asObject(asObject(structure).memory_plan || asObject(structure).memoryPlan);
  for (const surface of asArray(plan.surfaces)) {
    if (!surfaceMatchesPublishTarget(surface, target)) continue;
    const writePolicy = cleanId(surface?.write_policy || surface?.writePolicy || 'shared');
    if (target === 'final_answer' && !['final', 'shared', 'append_only'].includes(writePolicy)) continue;
    if (target === 'artifact_index' && !['index', 'shared', 'append_only'].includes(writePolicy)) continue;
    const targetRoles = asArray(surface?.target_roles || surface?.targetRoles).map((entry) => cleanId(entry)).filter(Boolean);
    if (targetRoles.length === 0 || targetRoles.includes(cleanRole)) return true;
  }
  return false;
}

function summarizePublishContractIssues(structure = {}) {
  const normalized = normalizeTeamStructureV2(structure || {});
  const participants = asArray(normalized?.participants);
  const finalOwnerId = cleanId(normalized?.control_policy?.final_answer_owner_participant_id || normalized?.control_policy?.finalAnswerOwnerParticipantId || normalized?.topology?.final_participant_id || normalized?.topology?.finalParticipantId || '');
  const finalOwner = participants.find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  const finalOwnerRole = cleanId(finalOwner?.role);
  const finalOwnerPublishBlocked = Boolean(finalOwnerId) && (!finalOwnerRole || !canRolePublishSurfaceFromStructure(normalized, finalOwnerRole, 'final_answer'));
  const artifactPublishers = participants
    .filter((row) => canRolePublishSurfaceFromStructure(normalized, cleanId(row?.role), 'artifact_index'))
    .map((row) => clean(row?.name || row?.participant_id || row?.agent_id || ''))
    .filter(Boolean);
  return {
    final_owner_publish_blocked: finalOwnerPublishBlocked,
    final_owner_label: clean(finalOwner?.name || finalOwnerId),
    artifact_publish_missing: artifactPublishers.length === 0,
    artifact_publishers: artifactPublishers,
  };
}

function patchPublishSurfaceTargets(structure = {}, surfaceId = '', roleIds = [], defaults = {}) {
  const normalized = normalizeTeamStructureV2(structure || {});
  const target = cleanId(surfaceId);
  const normalizedRoles = uniqueIds(roleIds, { max: 8 }).map((entry) => cleanId(entry)).filter(Boolean);
  if (!target || normalizedRoles.length === 0) return { structure: normalized, changed: false };
  const plan = asObject(normalized.memory_plan);
  const surfaces = asArray(plan.surfaces).map((surface) => ({
    ...asObject(surface),
    semantic_slots: uniqueIds(surface?.semantic_slots || surface?.semanticSlots || [], { max: 8 }),
    target_roles: uniqueIds(surface?.target_roles || surface?.targetRoles || [], { max: 8 }),
  }));
  let changed = false;
  let matched = false;
  const nextSurfaces = surfaces.map((surface) => {
    if (!surfaceMatchesPublishTarget(surface, target)) return surface;
    matched = true;
    const nextRoles = uniqueIds([...(surface.target_roles || []), ...normalizedRoles], { max: 8 }).map((entry) => cleanId(entry)).filter(Boolean);
    const writePolicy = cleanId(surface.write_policy || surface.writePolicy || defaults.write_policy || (target === 'final_answer' ? 'final' : 'index'));
    const nextSurface = {
      ...surface,
      surface_id: cleanId(surface.surface_id || surface.surfaceId || target) || target,
      semantic_slots: uniqueIds([...(surface.semantic_slots || []), target], { max: 8 }).map((entry) => cleanId(entry)).filter(Boolean),
      target_roles: nextRoles,
      write_policy: writePolicy,
      create_mode: cleanId(surface.create_mode || surface.createMode || defaults.create_mode || 'lazy') || 'lazy',
    };
    if (JSON.stringify(nextSurface) !== JSON.stringify(surface)) changed = true;
    return nextSurface;
  });
  if (!matched) {
    nextSurfaces.push({
      surface_id: target,
      file_name: clean(defaults.file_name || `${target}.md`) || `${target}.md`,
      title: clean(defaults.title || target.replace(/_/g, ' ')) || target,
      purpose: clean(defaults.purpose || `Surface for ${target}.`) || `Surface for ${target}.`,
      semantic_slots: [target],
      target_roles: normalizedRoles,
      load_policy: cleanId(defaults.load_policy || 'on_demand') || 'on_demand',
      write_policy: cleanId(defaults.write_policy || (target === 'final_answer' ? 'final' : 'index')) || (target === 'final_answer' ? 'final' : 'index'),
      create_mode: cleanId(defaults.create_mode || 'lazy') || 'lazy',
    });
    changed = true;
  }
  if (!changed) return { structure: normalized, changed: false };
  return {
    structure: normalizeTeamStructureV2({
      ...normalized,
      memory_plan: {
        ...plan,
        surfaces: nextSurfaces,
      },
    }),
    changed: true,
  };
}

function pickPreferredPublishParticipant(structure = {}, surfaceId = '', preferredRoles = []) {
  const normalized = normalizeTeamStructureV2(structure || {});
  const participants = asArray(normalized.participants);
  const rolePriority = uniqueIds(preferredRoles, { max: 12 }).map((entry) => cleanId(entry)).filter(Boolean);
  const ranked = participants
    .map((participant, index) => ({
      participant,
      role: cleanId(participant?.role),
      rank: rolePriority.indexOf(cleanId(participant?.role)),
      index,
    }))
    .filter((entry) => entry.role)
    .sort((left, right) => {
      const leftRank = left.rank >= 0 ? left.rank : Number.MAX_SAFE_INTEGER;
      const rightRank = right.rank >= 0 ? right.rank : Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.index - right.index;
    });
  return ranked.find((entry) => canRolePublishSurfaceFromStructure(normalized, entry.role, surfaceId))?.participant || null;
}

function enforcePublishContractOnStructure(structure = {}) {
  let normalized = normalizeTeamStructureV2(structure || {});
  const reasons = [];
  const preferredFinalRoles = ['synthesizer', 'reviewer', 'builder', 'operator', 'researcher'];
  const preferredArtifactRoles = ['builder', 'synthesizer', 'reviewer', 'operator', 'researcher'];
  const participants = asArray(normalized.participants);
  let finalOwnerId = cleanId(normalized?.control_policy?.final_answer_owner_participant_id || normalized?.control_policy?.finalAnswerOwnerParticipantId || normalized?.topology?.final_participant_id || normalized?.topology?.finalParticipantId || '');
  let finalOwner = participants.find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  if (finalOwner && cleanId(finalOwner?.role)) {
    const patched = patchPublishSurfaceTargets(normalized, 'final_answer', [cleanId(finalOwner.role)], {
      file_name: 'final_answer.md',
      title: 'Final Answer',
      purpose: 'User-facing final answer and delivery surface.',
      load_policy: 'on_demand',
      write_policy: 'final',
      create_mode: 'lazy',
    });
    if (patched.changed) {
      normalized = patched.structure;
      reasons.push(`publish contract repaired: final_answer surface now includes ${clean(finalOwner?.name || finalOwnerId)} (${cleanId(finalOwner.role)})`);
    }
  }
  finalOwnerId = cleanId(normalized?.control_policy?.final_answer_owner_participant_id || normalized?.control_policy?.finalAnswerOwnerParticipantId || normalized?.topology?.final_participant_id || normalized?.topology?.finalParticipantId || '');
  finalOwner = asArray(normalized.participants).find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  if (!finalOwnerId || !finalOwner || !canRolePublishSurfaceFromStructure(normalized, cleanId(finalOwner?.role), 'final_answer')) {
    let preferredOwner = pickPreferredPublishParticipant(normalized, 'final_answer', preferredFinalRoles);
    if (!preferredOwner && asArray(normalized.participants).length > 0) {
      const fallbackOwner = asArray(normalized.participants).find((row) => cleanId(row?.role)) || asArray(normalized.participants)[0];
      if (fallbackOwner && cleanId(fallbackOwner?.role)) {
        const patched = patchPublishSurfaceTargets(normalized, 'final_answer', [cleanId(fallbackOwner.role)], {
          file_name: 'final_answer.md',
          title: 'Final Answer',
          purpose: 'User-facing final answer and delivery surface.',
          load_policy: 'on_demand',
          write_policy: 'final',
          create_mode: 'lazy',
        });
        if (patched.changed) {
          normalized = patched.structure;
          reasons.push(`publish contract repaired: final_answer surface fallback added for ${clean(fallbackOwner?.name || fallbackOwner?.participant_id)}`);
        }
        preferredOwner = fallbackOwner;
      }
    }
    const preferredOwnerId = cleanId(preferredOwner?.participant_id || preferredOwner?.agent_id || preferredOwner?.id || '');
    if (preferredOwnerId && preferredOwnerId !== finalOwnerId) {
      normalized = normalizeTeamStructureV2({
        ...normalized,
        topology: {
          ...asObject(normalized.topology),
          final_participant_id: preferredOwnerId,
        },
        control_policy: {
          ...asObject(normalized.control_policy),
          final_answer_owner_participant_id: preferredOwnerId,
        },
      });
      reasons.push(`publish contract aligned: final owner set to ${clean(preferredOwner?.name || preferredOwnerId)}`);
    }
  }
  const artifactRolesPresent = uniqueIds(
    asArray(normalized.participants).map((row) => cleanId(row?.role)).filter(Boolean),
    { max: 8 },
  ).filter((roleId) => preferredArtifactRoles.includes(roleId));
  if (artifactRolesPresent.length > 0 && summarizePublishContractIssues(normalized).artifact_publish_missing) {
    const patched = patchPublishSurfaceTargets(normalized, 'artifact_index', artifactRolesPresent, {
      file_name: 'artifact_index.md',
      title: 'Artifact Index',
      purpose: 'Artifact delivery index and workspace handoff surface.',
      load_policy: 'on_demand',
      write_policy: 'index',
      create_mode: 'lazy',
    });
    if (patched.changed) {
      normalized = patched.structure;
      reasons.push(`publish contract repaired: artifact_index surface now includes ${artifactRolesPresent.join(', ')}`);
    }
  }
  return {
    structure: normalized,
    repair_summary: {
      changed: reasons.length > 0,
      reasons,
      issues: summarizePublishContractIssues(normalized),
    },
  };
}

export function buildTeamTransitionGuardrails(currentTeam = null, nextTeam = null) {
  const current = currentTeam && typeof currentTeam === 'object' ? validateTeamConfiguration(currentTeam) : null;
  const candidate = nextTeam && typeof nextTeam === 'object' ? validateTeamConfiguration(nextTeam) : null;
  if (!candidate) return { risk_level: 'low', warning_count: 0, destructive_changes_present: false, warnings: [], issues: {} };

  const currentAgents = indexTeamAgents(current);
  const candidateAgents = indexTeamAgents(candidate);
  const currentRoles = new Set(asArray(current?.agents).map((agent) => cleanId(agent?.role)).filter(Boolean));
  const candidateRoles = new Set(asArray(candidate?.agents).map((agent) => cleanId(agent?.role)).filter(Boolean));
  const removed_agents = [];
  const lost_role_coverage = [];
  const role_changes = [];
  const required_tool_drops = [];
  const optional_tool_drops = [];
  const provider_drops = [];
  const model_drops = [];

  for (const role of Array.from(currentRoles)) {
    if (!candidateRoles.has(role)) lost_role_coverage.push(role);
  }
  for (const [key, before] of currentAgents.entries()) {
    const after = candidateAgents.get(key);
    const label = clean(before?.name || before?.agent_id || key);
    if (!after) {
      removed_agents.push(label);
      continue;
    }
    const beforeRole = cleanId(before?.role);
    const afterRole = cleanId(after?.role);
    if (beforeRole && afterRole && beforeRole !== afterRole) role_changes.push(`${label} (${beforeRole} → ${afterRole})`);
    if (cleanId(before?.provider) && !cleanId(after?.provider)) provider_drops.push(`${label} (${cleanId(before.provider)})`);
    if (clean(before?.model) && !clean(after?.model)) model_drops.push(`${label} (${clean(before.model)})`);
    const beforeRequired = new Set(uniqueIds(before?.required_tool_ids || before?.requiredToolIds || []));
    const afterRequired = new Set(uniqueIds(after?.required_tool_ids || after?.requiredToolIds || []));
    const removedRequired = Array.from(beforeRequired).filter((toolId) => !afterRequired.has(toolId));
    if (removedRequired.length > 0) required_tool_drops.push(`${label}: ${removedRequired.join(', ')}`);
    const beforeOptional = new Set(uniqueIds([...(asArray(before?.optional_tool_ids || before?.optionalToolIds || [])), ...(asArray(before?.recommended_tool_ids || before?.recommendedToolIds || []))]));
    const afterOptional = new Set(uniqueIds([...(asArray(after?.optional_tool_ids || after?.optionalToolIds || [])), ...(asArray(after?.recommended_tool_ids || after?.recommendedToolIds || []))]));
    const removedOptional = Array.from(beforeOptional).filter((toolId) => !afterOptional.has(toolId));
    if (removedOptional.length > 0) optional_tool_drops.push(`${label}: ${removedOptional.join(', ')}`);
  }

  const currentStructure = normalizeTeamStructureV2(current?.structure_v2 || buildTeamStructureV2(current || candidate));
  const candidateStructure = normalizeTeamStructureV2(candidate?.structure_v2 || buildTeamStructureV2(candidate));
  const currentFinal = cleanId(currentStructure?.topology?.final_participant_id || currentStructure?.topology?.finalParticipantId || '');
  const candidateFinal = cleanId(candidateStructure?.topology?.final_participant_id || candidateStructure?.topology?.finalParticipantId || '');
  const currentOwner = cleanId(currentStructure?.control_policy?.final_answer_owner_participant_id || currentStructure?.control_policy?.finalAnswerOwnerParticipantId || '');
  const candidateOwner = cleanId(candidateStructure?.control_policy?.final_answer_owner_participant_id || candidateStructure?.control_policy?.finalAnswerOwnerParticipantId || '');
  const removed_memory_surfaces = Array.from(indexMemorySurfaces(currentStructure)).filter((surfaceId) => !indexMemorySurfaces(candidateStructure).has(surfaceId)).sort();
  const candidatePublishIssues = summarizePublishContractIssues(candidateStructure);

  const warnings = [];
  if (removed_agents.length > 0) warnings.push(`에이전트 제거: ${removed_agents.slice(0, 6).join(', ')}`);
  if (lost_role_coverage.length > 0) warnings.push(`역할 커버리지 감소: ${lost_role_coverage.slice(0, 6).join(', ')}`);
  if (role_changes.length > 0) warnings.push(`역할 변경: ${role_changes.slice(0, 4).join('; ')}`);
  if (currentFinal && currentFinal !== candidateFinal) warnings.push(`최종 participant 변경: ${currentFinal} → ${candidateFinal || '(none)'}`);
  if (currentOwner && currentOwner !== candidateOwner) warnings.push(`최종 답변 owner 변경: ${currentOwner} → ${candidateOwner || '(none)'}`);
  if (required_tool_drops.length > 0) warnings.push(`필수 tool 제거: ${required_tool_drops.slice(0, 4).join('; ')}`);
  if (optional_tool_drops.length > 0) warnings.push(`선호 tool 제거: ${optional_tool_drops.slice(0, 4).join('; ')}`);
  if (provider_drops.length > 0) warnings.push(`provider 힌트 제거: ${provider_drops.slice(0, 4).join('; ')}`);
  if (model_drops.length > 0) warnings.push(`model 힌트 제거: ${model_drops.slice(0, 4).join('; ')}`);
  if (removed_memory_surfaces.length > 0) warnings.push(`memory surface 제거: ${removed_memory_surfaces.slice(0, 6).join(', ')}`);
  if (candidatePublishIssues.final_owner_publish_blocked) warnings.push(`최종 답변 owner publish 차단: ${candidatePublishIssues.final_owner_label || '(unknown)'}가 final_answer surface를 publish할 수 없습니다.`);
  if (candidatePublishIssues.artifact_publish_missing) warnings.push('artifact publish 차단: artifact_index surface를 publish할 participant가 없습니다.');

  const destructive_changes_present = Boolean(removed_agents.length || lost_role_coverage.length || role_changes.length || required_tool_drops.length || removed_memory_surfaces.length || candidatePublishIssues.final_owner_publish_blocked || (currentFinal && currentFinal !== candidateFinal) || (currentOwner && currentOwner !== candidateOwner));
  return {
    risk_level: destructive_changes_present || warnings.length >= 3 ? 'high' : warnings.length > 0 ? 'medium' : 'low',
    warning_count: warnings.length,
    destructive_changes_present,
    warnings,
    issues: {
      removed_agents,
      lost_role_coverage,
      role_changes,
      required_tool_drops,
      optional_tool_drops,
      provider_drops,
      model_drops,
      removed_memory_surfaces,
      final_participant_changed: Boolean(currentFinal && currentFinal !== candidateFinal),
      final_owner_changed: Boolean(currentOwner && currentOwner !== candidateOwner),
      final_owner_publish_blocked: candidatePublishIssues.final_owner_publish_blocked,
      final_owner_publish_label: candidatePublishIssues.final_owner_label,
      artifact_publish_missing: candidatePublishIssues.artifact_publish_missing,
      artifact_publishers: candidatePublishIssues.artifact_publishers,
    },
  };
}

export function formatTeamTransitionGuardrailLines(guardrails = {}, { maxWarnings = 5 } = {}) {
  const row = guardrails && typeof guardrails === 'object' ? guardrails : {};
  const warnings = asArray(row.warnings).map((entry) => clean(entry)).filter(Boolean).slice(0, Math.max(1, Number(maxWarnings) || 5));
  return [
    `- risk: ${cleanId(row.risk_level || 'low') || 'low'}`,
    `- destructive: ${row.destructive_changes_present ? 'yes' : 'no'}`,
    ...warnings.map((entry) => `- ${entry}`),
  ];
}

export function storePendingTeam(sessionStore, chatId, team = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  saveSessionTeamState(sessionStore, chatId, {
    ...current,
    status: 'suggested',
    composition_mode: normalizeCompositionMode(team?.composition_mode || current.composition_mode || 'structured'),
    proposal_mode: normalizeProposalMode(team?.proposal_mode || current.proposal_mode || 'suggest'),
    pending_team: team,
  });
  return getSessionTeamState(sessionStore, chatId);
}

export async function applyPendingTeam({ sessionStore, chatId, runtime = null } = {}) {
  const current = getSessionTeamState(sessionStore, chatId);
  const team = current.pending_team || current.active_team;
  if (!team) throw new Error('no pending team to apply');
  const normalized = validateTeamConfiguration({ ...team, proposal_mode: 'apply' }, { runtime });
  const transitionGuardrails = buildTeamTransitionGuardrails(current.active_team, normalized);
  saveSessionTeamState(sessionStore, chatId, { status: 'active', active_team: normalized, pending_team: null, composition_mode: normalized.composition_mode, proposal_mode: normalized.proposal_mode });
  if (sessionStore?.upsert) {
    sessionStore.upsert(chatId, (session) => ({ ...session, pending_team_apply_confirmation: null, last_team_apply_guardrails: transitionGuardrails }));
  }
  if (runtime) {
    applyTeamConfigurationToRuntime(runtime, normalized);
    await syncTeamConfigurationToConversationStore({ runtime, teamConfig: normalized, source: 'team_apply' }).catch(() => null);
  }
  return { ...normalized, __apply_guardrails: transitionGuardrails };
}

export async function resetTeamConfiguration(sessionStore, chatId, { runtime = null } = {}) {
  saveSessionTeamState(sessionStore, chatId, { status: 'none', active_team: null, pending_team: null, composition_mode: 'structured', proposal_mode: 'suggest' });
  await clearConversationStoreTeamConfiguration(runtime).catch(() => null);
}

export function formatSupportedModelLines() {
  return listSupportedModels().map((row) => `- ${row.label} (${row.id})`).join('\n');
}
