import {
  normalizeContextPack,
  normalizeContextPackList,
} from "../domain/context_pack.js";
import {
  normalizeSkillAttachmentList,
  summarizeSkillLoadLevels,
  summarizeSelectedSkillIds,
} from "../domain/skill_attachment.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function includesAny(text = "", keywords = []) {
  const src = normalizeText(text, { lower: true });
  if (!src) return false;
  return asArray(keywords).some((row) => src.includes(normalizeText(row, { lower: true })));
}

function buildActionMap(actions = []) {
  const byInstanceId = new Map();
  const byRole = new Map();
  for (const action of asArray(actions)) {
    const row = action && typeof action === "object" ? action : {};
    const type = normalizeText(row.type, { lower: true });
    if (type !== "agent_run") continue;
    const inputs = row.inputs && typeof row.inputs === "object" ? row.inputs : {};
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

function resolveTokenBudget(roleType = "") {
  const role = normalizeRoleId(roleType);
  if (role === "builder") return { soft_limit: 1800, hard_limit: 2800 };
  if (role === "researcher") return { soft_limit: 1600, hard_limit: 2400 };
  if (role === "reviewer") return { soft_limit: 1400, hard_limit: 2200 };
  if (role === "synthesizer") return { soft_limit: 1200, hard_limit: 1800 };
  if (role === "operator") return { soft_limit: 1500, hard_limit: 2200 };
  return { soft_limit: 1200, hard_limit: 2000 };
}

function findRole(teamPlan = {}, runtimeAgent = {}) {
  const roles = Array.isArray(teamPlan?.roles) && teamPlan.roles.length > 0
    ? teamPlan.roles
    : (Array.isArray(teamPlan?.slots) ? teamPlan.slots : []);
  const instanceRole = normalizeRoleId(
    runtimeAgent?.role_id
    || runtimeAgent?.role_label
    || runtimeAgent?.roleLabel
  );
  const slotId = normalizeText(runtimeAgent?.slot_id || runtimeAgent?.slotId);
  if (slotId) {
    const bySlot = roles.find((row) => normalizeText(row?.slot_id || row?.slotId) === slotId);
    if (bySlot) return bySlot;
  }
  if (instanceRole) {
    const byRole = roles.find((row) => normalizeRoleId(
      row?.role_id
      || row?.role_type
      || row?.id
      || row?.role_label
    ) === instanceRole);
    if (byRole) return byRole;
  }
  return null;
}

function resolveLoadLevelForSkill({
  roleType = "",
  actionPrompt = "",
  goal = "",
  attachment = null,
  skillLoader = null,
  skillPackage = null,
} = {}) {
  const currentLevel = normalizeText(attachment?.load_level || "metadata_only", { lower: true }) || "metadata_only";
  if (skillLoader && typeof skillLoader.resolveLoadLevelForExecution === "function") {
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
  if (includesAny(combined, ["template", "checklist", "script", "audit", "debug", "trace"])) return "resources";
  if (combined.trim()) return "instructions";
  return currentLevel || "metadata_only";
}

export class ContextPackBuilder {
  constructor({
    registry = null,
    skillLoader = null,
  } = {}) {
    this.registry = registry || null;
    this.skillLoader = skillLoader || null;
  }

  _resolveSkill(skillId = "") {
    if (!this.registry || typeof this.registry.resolve !== "function") return null;
    return this.registry.resolve(skillId);
  }

  build({
    runId = "",
    goal = "",
    teamPlan = null,
    runtimeAgents = [],
    effectiveActions = [],
    routeReason = "",
  } = {}) {
    const cleanRunId = normalizeText(runId);
    const plan = teamPlan && typeof teamPlan === "object" ? teamPlan : {};
    const actionMap = buildActionMap(effectiveActions);
    const contextPacks = [];
    const runtimeAgentsOut = [];
    const roleSkillMap = new Map();

    for (const agent of asArray(runtimeAgents)) {
      const role = findRole(plan, agent);
      const roleType = normalizeRoleId(
        role?.role_id
        || role?.role_type
        || role?.id
        || agent?.role_id
        || agent?.role_label
      );
      const action = actionMap.byInstanceId.get(normalizeText(agent?.instance_id))
        || actionMap.byRole.get(roleType)
        || null;
      const actionPrompt = normalizeText(action?.prompt || action?.goal);
      const attachmentsRaw = normalizeSkillAttachmentList(
        role?.attached_skills || agent?.attached_skills || []
      );
      const skillItems = [];
      const missingItems = [];
      const upgradedAttachments = [];

      for (const attachment of attachmentsRaw) {
        const skillPackage = this._resolveSkill(attachment.skill_id);
        const resolvedLevel = resolveLoadLevelForSkill({
          roleType,
          actionPrompt,
          goal,
          attachment,
          skillLoader: this.skillLoader,
          skillPackage,
        });
        const loaded = this.skillLoader && typeof this.skillLoader.loadSkill === "function"
          ? this.skillLoader.loadSkill(attachment.skill_id, { loadLevel: resolvedLevel })
          : null;
        if (!skillPackage) {
          missingItems.push({
            kind: "skill_package",
            skill_id: attachment.skill_id,
            reason: "missing_registry_entry",
          });
        }
        upgradedAttachments.push({
          ...attachment,
          load_level: resolvedLevel,
        });
        skillItems.push({
          skill_id: attachment.skill_id,
          load_level: resolvedLevel,
          selected_by: attachment.selected_by,
          selection_reason: attachment.selection_reason || undefined,
          status: attachment.status,
          included_items: loaded
            ? {
              instructions_ref: loaded?.metadata?.instructions_ref || undefined,
              resource_refs: loaded?.metadata?.resource_refs || [],
              utility_refs: loaded?.metadata?.utility_refs || [],
            }
            : undefined,
        });
      }

      const contextPack = normalizeContextPack({
        run_id: cleanRunId || undefined,
        scope: "role",
        target_instance_id: normalizeText(agent?.instance_id),
        target_runtime_agent_instance_id: normalizeText(agent?.instance_id),
        context_types: [
          "goal",
          "route_reason",
          roleType ? `role:${roleType}` : "",
        ].filter(Boolean),
        shared_items: [
          { kind: "goal", value: normalizeText(goal) || undefined },
          { kind: "route_reason", value: normalizeText(routeReason) || undefined },
        ].filter((row) => row.value),
        role_specific_items: [
          { kind: "role_type", value: roleType || undefined },
          { kind: "slot_id", value: normalizeText(agent?.slot_id || agent?.slotId) || undefined },
          { kind: "template_id", value: normalizeText(agent?.template_id) || undefined },
        ].filter((row) => row.value),
        skill_items: skillItems,
        excluded_items: [],
        missing_items: missingItems,
        conflicts: [],
        budget_tokens: resolveTokenBudget(roleType).hard_limit,
        token_budget: resolveTokenBudget(roleType),
        selection_reason: normalizeText(agent?.selection_reason || routeReason) || undefined,
        load_level: skillItems.some((item) => item.load_level === "resources")
          ? "resources"
          : (skillItems.some((item) => item.load_level === "instructions") ? "instructions" : "metadata_only"),
      }, {
        defaultRunId: cleanRunId,
      });
      contextPacks.push(contextPack);

      runtimeAgentsOut.push({
        ...agent,
        attached_skills: upgradedAttachments,
        attached_skill_ids: summarizeSelectedSkillIds(upgradedAttachments),
        context_pack_id: contextPack.id,
      });
      roleSkillMap.set(roleType, upgradedAttachments);
    }

    const rolesOut = asArray(plan.roles).map((role) => {
      const roleType = normalizeRoleId(role?.role_id || role?.role_type || role?.id || role?.role_label);
      const attached = roleSkillMap.get(roleType);
      if (!attached) return role;
      return {
        ...role,
        attached_skills: attached,
      };
    });

    const contextPackList = normalizeContextPackList(contextPacks, {
      defaultRunId: cleanRunId,
    });
    const selectedSkillIds = summarizeSelectedSkillIds(
      runtimeAgentsOut.flatMap((agent) => agent?.attached_skills || [])
    );
    const skillLoadLevels = {};
    for (const agent of runtimeAgentsOut) {
      const key = normalizeText(agent?.instance_id);
      if (!key) continue;
      skillLoadLevels[key] = summarizeSkillLoadLevels(agent?.attached_skills || []);
    }

    return {
      team_plan: {
        ...plan,
        roles: rolesOut,
      },
      runtime_agents: runtimeAgentsOut,
      context_packs: contextPackList,
      selected_skill_ids: selectedSkillIds,
      skill_load_levels: skillLoadLevels,
    };
  }
}
