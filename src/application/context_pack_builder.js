import {
  normalizeContextPack,
  normalizeContextPackList,
} from "../domain/context_pack.js";
import {
  normalizeSkillAttachmentList,
  summarizeSkillLoadLevels,
  summarizeSelectedSkillIds,
} from "../domain/skill_attachment.js";

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
    );
    const role = normalizeText(
      inputs.role_label
      || inputs.roleLabel
      || row.role_label
      || row.roleLabel,
      { lower: true }
    );
    if (instanceId) byInstanceId.set(instanceId, row);
    if (role) byRole.set(role, row);
  }
  return { byInstanceId, byRole };
}

function resolveTokenBudget(roleType = "") {
  const role = normalizeText(roleType, { lower: true });
  if (role === "coder") return { soft_limit: 1800, hard_limit: 2800 };
  if (role === "researcher") return { soft_limit: 1600, hard_limit: 2400 };
  if (role === "reviewer" || role === "verifier") return { soft_limit: 1400, hard_limit: 2200 };
  return { soft_limit: 1200, hard_limit: 2000 };
}

function findRole(teamPlan = {}, runtimeAgent = {}) {
  const roles = Array.isArray(teamPlan?.roles) ? teamPlan.roles : [];
  const instanceRole = normalizeText(runtimeAgent?.role_label || runtimeAgent?.roleLabel, { lower: true });
  const instanceId = normalizeText(runtimeAgent?.instance_id || runtimeAgent?.runtime_instance_id);
  if (instanceRole) {
    const byRole = roles.find((row) =>
      normalizeText(row?.id || row?.role_type || row?.role_label, { lower: true }) === instanceRole
    );
    if (byRole) return byRole;
  }
  if (instanceId) {
    const byInstance = roles.find((row) => normalizeText(row?.runtime_instance_id) === instanceId);
    if (byInstance) return byInstance;
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
      const roleType = normalizeText(role?.role_type || role?.id || agent?.role_label, { lower: true });
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
        const hasSkill = !!skillPackage;
        if (!hasSkill) {
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
        target_runtime_agent_instance_id: normalizeText(agent?.instance_id),
        shared_items: [
          { kind: "goal", value: normalizeText(goal) || undefined },
          { kind: "route_reason", value: normalizeText(routeReason) || undefined },
        ].filter((row) => row.value),
        role_specific_items: [
          { kind: "role_type", value: roleType || undefined },
          { kind: "template_id", value: normalizeText(agent?.template_id) || undefined },
          {
            kind: "capability_tags",
            value: asArray(agent?.capability_tags).join(", ") || undefined,
          },
        ].filter((row) => row.value),
        skill_items: skillItems,
        excluded_items: [],
        missing_items: missingItems,
        conflicts: [],
        token_budget: resolveTokenBudget(roleType),
      }, {
        defaultRunId: cleanRunId,
      });
      contextPacks.push(contextPack);

      runtimeAgentsOut.push({
        ...agent,
        attached_skills: upgradedAttachments,
        context_pack_id: contextPack.id,
      });
      roleSkillMap.set(roleType, upgradedAttachments);
    }

    const rolesOut = asArray(plan.roles).map((role) => {
      const roleType = normalizeText(role?.id || role?.role_type || role?.role_label, { lower: true });
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

