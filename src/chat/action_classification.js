function normalizeActionType(actionOrType = "") {
  if (typeof actionOrType === "string") return String(actionOrType || "").trim().toLowerCase();
  return String(actionOrType?.type || "").trim().toLowerCase();
}

export const TEAM_MEMBERSHIP_MUTATION_ACTION_TYPES = Object.freeze([
  "add_agent_to_conversation",
  "remove_agent_from_conversation",
  "enable_agent",
  "disable_agent",
]);

export const TEAM_SETUP_ACTION_TYPES = Object.freeze([
  ...TEAM_MEMBERSHIP_MUTATION_ACTION_TYPES,
  "propose_agent",
  "create_agent",
  "create_agent_definition",
  "update_agent",
  "fork_agent",
  "search_public_agents",
  "install_agent_blueprint",
  "publish_agent",
]);

const TEAM_SETUP_ACTION_TYPE_SET = new Set(TEAM_SETUP_ACTION_TYPES);
const TEAM_MEMBERSHIP_MUTATION_TYPE_SET = new Set(TEAM_MEMBERSHIP_MUTATION_ACTION_TYPES);
const REAL_EXECUTION_ACTION_TYPE_SET = new Set([
  "run_agent",
  "agent_run",
  "spawn_agents",
]);

export function isTeamMembershipMutationAction(actionOrType = "") {
  return TEAM_MEMBERSHIP_MUTATION_TYPE_SET.has(normalizeActionType(actionOrType));
}

export function isTeamSetupAction(actionOrType = "") {
  return TEAM_SETUP_ACTION_TYPE_SET.has(normalizeActionType(actionOrType));
}

export function isRealExecutionAction(actionOrType = "") {
  return REAL_EXECUTION_ACTION_TYPE_SET.has(normalizeActionType(actionOrType));
}

export function classifyPlanActions(actions = []) {
  const rows = Array.isArray(actions) ? actions : [];
  let hasTeamSetupAction = false;
  let hasRealExecutionAction = false;
  let onlyTeamSetupOrSummary = rows.length > 0;

  for (const action of rows) {
    const type = normalizeActionType(action);
    if (!type) continue;
    if (isRealExecutionAction(type)) {
      hasRealExecutionAction = true;
      onlyTeamSetupOrSummary = false;
      continue;
    }
    if (isTeamSetupAction(type)) {
      hasTeamSetupAction = true;
      continue;
    }
    if (type === "summarize") continue;
    onlyTeamSetupOrSummary = false;
  }

  return {
    has_team_setup_action: hasTeamSetupAction,
    has_real_execution_action: hasRealExecutionAction,
    only_team_setup_or_summary: onlyTeamSetupOrSummary,
  };
}

export function isMutationOnlyTeamSetupPlan(actions = []) {
  const summary = classifyPlanActions(actions);
  return summary.has_team_setup_action
    && !summary.has_real_execution_action
    && summary.only_team_setup_or_summary;
}
