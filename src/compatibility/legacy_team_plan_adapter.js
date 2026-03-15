import { normalizeTeamPlan } from "../domain/team_plan.js";

export function adaptLegacyTeamPlan(raw = {}, options = {}) {
  return normalizeTeamPlan(raw, options);
}
