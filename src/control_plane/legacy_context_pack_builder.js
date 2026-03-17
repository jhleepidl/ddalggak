import {
  normalizeContextPack,
  normalizeContextPackList,
} from '../domain/context_pack.js';
import { normalizeStringList } from '../shared/normalize.js';
import {
  normalizeSkillAttachmentList,
  summarizeSkillLoadLevels,
  summarizeSelectedSkillIds,
} from '../domain/skill_attachment.js';
import { normalizeRoleId } from '../compatibility/legacy_roles.js';

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function includesAny(text = '', keywords = []) {
  const src = normalizeText(text, { lower: true });
  return asArray(keywords).some((row) => src.includes(normalizeText(row, { lower: true })));
}

function buildActionMap(actions = []) {
  const byInstanceId = new Map();
  const byRole = new Map();
  for (const action of asArray(actions)) {
    const row = action && typeof action === 'object' ? action : {};
    const type = normalizeText(row.type, { lower: true });
    if (type !== 'agent_run') continue;
    const inputs = row.inputs && typeof row.inputs === 'object' ? row.inputs : {};
    const instanceId = normalizeText(
      inputs.runtime_instance_id
      || inputs.runtimeInstanceId
      || inputs.instance_id
      || inputs.instanceId
    );
    const role = normalizeRoleId(
      inputs.role_id
      || inputs.roleId
      || inputs.role_label
      || inputs.roleLabel
      || row.role_label
      || row.roleLabel
      || row.agent
      || row.agent_id
    );
    if (instanceId) byInstanceId.set(instanceId, row);
    if (role) byRole.set(role, row);
  }
  return { byInstanceId, byRole };
}

function resolveTokenBudget(roleType = '') {
  const role = normalizeRoleId(roleType);
  if (role === 'builder') return { soft_limit: 1800, hard_limit: 2800 };
  if (role === 'researcher') return { soft_limit: 1800, hard_limit: 2600 };
  if (role === 'reviewer') return { soft_limit: 1500, hard_limit: 2300 };
  if (role === 'synthesizer') return { soft_limit: 1300, hard_limit: 1900 };
  if (role === 'operator') return { soft_limit: 1500, hard_limit: 2200 };
  return { soft_limit: 1200, hard_limit: 2000 };
}

function findSlot(teamPlan = {}, runtimeAgent = {}) {
  const slots = Array.isArray(teamPlan?.slots) ? teamPlan.slots : [];
  const slotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
  const roleId = normalizeRoleId(runtimeAgent?.role_id || runtimeAgent?.role_label);
  if (slotId) {
    const bySlot = slots.find((row) => normalizeText(row?.slot_id || row?.slotId) === slotId);
    if (bySlot) return bySlot;
  }
  if (roleId) {
    const byRole = slots.find((row) => normalizeRoleId(row?.role_id || row?.role_label) === roleId);
    if (byRole) return byRole;
  }
  return null;
}

function resolveLoadLevelForSkill({
  roleType = '',
  actionPrompt = '',
  goal = '',
  attachment = null,
  skillLoader = null,
  skillPackage = null,
} = {}) {
  const currentLevel = normalizeText(attachment?.load_level || 'metadata_only', { lower: true }) || 'metadata_only';
  if (skillLoader && typeof skillLoader.resolveLoadLevelForExecution === 'function') {
    return skillLoader.resolveLoadLevelForExecution({
      currentLevel,
      roleType,
      goal,
      actionPrompt,
      attachment,
      skillPackage,
    });
  }
  const combined = `${goal}\n${actionPrompt}`.toLowerCase();
  if (includesAny(combined, ['template', 'checklist', 'script', 'audit', 'debug', 'trace', 'filing', 'citation'])) {
    return 'resources';
  }
  if (combined.trim()) return 'instructions';
  return currentLevel || 'metadata_only';
}

function buildRolePackProfile({
  roleType = '',
  purpose = '',
  goal = '',
  taskInterpretation = {},
} = {}) {
  const text = `${purpose}\n${goal}\n${taskInterpretation?.task_summary || ''}`;
  switch (normalizeRoleId(roleType)) {
    case 'researcher':
      return {
        context_types: [
          'evidence',
          'citations',
          includesAny(text, ['news', 'market', 'headline']) ? 'news' : '',
          includesAny(text, ['filing', 'dart', '공시']) ? 'filings' : '',
        ].filter(Boolean),
        shared_items: [{ kind: 'research_focus', value: normalizeText(purpose) || undefined }],
        role_specific_items: [{ kind: 'source_policy', value: 'evidence_first' }],
      };
    case 'builder':
      return {
        context_types: ['workspace', 'code', 'patch_plan', 'tests'],
        shared_items: [{ kind: 'implementation_goal', value: normalizeText(purpose) || undefined }],
        role_specific_items: [{ kind: 'workspace_scope', value: 'repo_local' }],
      };
    case 'reviewer':
      return {
        context_types: ['contradictions', 'claim_check', 'risk', 'tests'],
        shared_items: [{ kind: 'review_focus', value: normalizeText(purpose) || undefined }],
        role_specific_items: [{ kind: 'review_policy', value: normalizeText(taskInterpretation?.review_policy) || 'required' }],
      };
    case 'synthesizer':
      return {
        context_types: ['upstream_results', 'aggregation', 'final_output'],
        shared_items: [{ kind: 'output_style', value: normalizeText(taskInterpretation?.deliverable_type) || 'report' }],
        role_specific_items: [{ kind: 'finalization', value: 'synthesize_upstream_results' }],
      };
    case 'operator':
      return {
        context_types: ['workflow', 'run_state', 'tools', 'team_state'],
        shared_items: [{ kind: 'control_mode', value: normalizeText(taskInterpretation?.control_mode) || 'supervised' }],
        role_specific_items: [{ kind: 'workflow_goal', value: normalizeText(purpose) || undefined }],
      };
    default:
      return { context_types: ['goal'], shared_items: [], role_specific_items: [] };
  }
}

export class LegacyContextPackBuilder {
  constructor({ registry = null, skillLoader = null } = {}) {
    this.registry = registry || null;
    this.skillLoader = skillLoader || null;
  }

  _resolveSkill(skillId = '') {
    if (!this.registry || typeof this.registry.resolve !== 'function') return null;
    return this.registry.resolve(skillId);
  }

  build({
    runId = '',
    goal = '',
    teamPlan = null,
    runtimeAgents = [],
    effectiveActions = [],
    routeReason = '',
    taskInterpretation = {},
  } = {}) {
    const cleanRunId = normalizeText(runId);
    const plan = teamPlan && typeof teamPlan === 'object' ? teamPlan : {};
    const actionMap = buildActionMap(effectiveActions);
    const contextPacks = [];
    const runtimeAgentsOut = [];

    for (const agent of asArray(runtimeAgents)) {
      const slot = findSlot(plan, agent);
      const roleType = normalizeRoleId(slot?.role_id || agent?.role_id || agent?.role_label);
      const action = actionMap.byInstanceId.get(normalizeText(agent?.instance_id))
        || actionMap.byRole.get(roleType)
        || null;
      const actionPrompt = normalizeText(action?.prompt || action?.goal);
      const attachmentsRaw = normalizeSkillAttachmentList(slot?.attached_skills || agent?.attached_skills || []);
      const profile = buildRolePackProfile({ roleType, purpose: slot?.purpose || agent?.assigned_goal || goal, goal, taskInterpretation });
      const skillItems = [];
      const missingItems = [];
      const upgradedAttachments = [];

      for (const attachment of attachmentsRaw) {
        const skillPackage = this._resolveSkill(attachment.skill_id);
        const resolvedLevel = resolveLoadLevelForSkill({ roleType, actionPrompt, goal, attachment, skillLoader: this.skillLoader, skillPackage });
        const loaded = this.skillLoader && typeof this.skillLoader.loadSkill === 'function'
          ? this.skillLoader.loadSkill(attachment.skill_id, { loadLevel: resolvedLevel })
          : null;
        if (!skillPackage) {
          missingItems.push({ kind: 'skill_package', skill_id: attachment.skill_id, reason: 'missing_registry_entry' });
        }
        upgradedAttachments.push({ ...attachment, load_level: resolvedLevel });
        skillItems.push({
          skill_id: attachment.skill_id,
          load_level: resolvedLevel,
          selected_by: attachment.selected_by,
          selection_reason: attachment.selection_reason || undefined,
          status: attachment.status,
          included_items: loaded ? {
            instructions_ref: loaded?.metadata?.instructions_ref || undefined,
            resource_refs: loaded?.metadata?.resource_refs || [],
            utility_refs: loaded?.metadata?.utility_refs || [],
          } : undefined,
        });
      }

      const contextTypes = normalizeStringList([
        ...profile.context_types,
        ...(slot?.required_context_types || []),
      ], { max: 32, lower: true });
      const contextPack = normalizeContextPack({
        run_id: cleanRunId || undefined,
        scope: 'role',
        target_instance_id: normalizeText(agent?.instance_id),
        target_runtime_agent_instance_id: normalizeText(agent?.instance_id),
        context_types: contextTypes,
        shared_items: [
          { kind: 'goal', value: normalizeText(goal) || undefined },
          { kind: 'route_reason', value: normalizeText(routeReason) || undefined },
          ...profile.shared_items,
        ].filter((row) => row.value),
        role_specific_items: [
          { kind: 'role_type', value: roleType || undefined },
          { kind: 'slot_id', value: normalizeText(agent?.slot_id || agent?.slotId) || undefined },
          { kind: 'slot_purpose', value: normalizeText(slot?.purpose) || undefined },
          ...profile.role_specific_items,
        ].filter((row) => row.value),
        skill_items: skillItems,
        excluded_items: [],
        missing_items: missingItems,
        conflicts: [],
        budget_tokens: resolveTokenBudget(roleType).hard_limit,
        token_budget: resolveTokenBudget(roleType),
        selection_reason: normalizeText(agent?.selection_reason || routeReason) || undefined,
        load_level: skillItems.some((item) => item.load_level === 'resources')
          ? 'resources'
          : (skillItems.some((item) => item.load_level === 'instructions') ? 'instructions' : 'metadata_only'),
      }, { defaultRunId: cleanRunId });
      contextPacks.push(contextPack);

      runtimeAgentsOut.push({
        ...agent,
        attached_skills: upgradedAttachments,
        attached_skill_ids: summarizeSelectedSkillIds(upgradedAttachments),
        context_pack_id: contextPack.id,
      });
    }

    const slotsOut = asArray(plan.slots).map((slot) => {
      const runtimeAgent = runtimeAgentsOut.find((agent) => normalizeText(agent?.slot_id) === normalizeText(slot?.slot_id));
      if (!runtimeAgent) return slot;
      return { ...slot, attached_skills: runtimeAgent.attached_skills };
    });
    const rolesOut = asArray(plan.roles).map((role) => {
      const roleType = normalizeRoleId(role?.role_id || role?.role_type || role?.id || role?.role_label);
      const runtimeAgent = runtimeAgentsOut.find((agent) => normalizeRoleId(agent?.role_id || agent?.role_label) === roleType);
      if (!runtimeAgent) return role;
      return { ...role, attached_skills: runtimeAgent.attached_skills };
    });

    const contextPackList = normalizeContextPackList(contextPacks, { defaultRunId: cleanRunId });
    const selectedSkillIds = summarizeSelectedSkillIds(runtimeAgentsOut.flatMap((agent) => agent?.attached_skills || []));
    const skillLoadLevels = {};
    for (const agent of runtimeAgentsOut) {
      const key = normalizeText(agent?.instance_id);
      if (!key) continue;
      skillLoadLevels[key] = summarizeSkillLoadLevels(agent?.attached_skills || []);
    }

    return {
      team_plan: { ...plan, slots: slotsOut, roles: rolesOut },
      runtime_agents: runtimeAgentsOut,
      context_packs: contextPackList,
      selected_skill_ids: selectedSkillIds,
      skill_load_levels: skillLoadLevels,
    };
  }
}
