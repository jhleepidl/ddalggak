import { normalizeTaskInterpretation } from "../domain/task_interpretation.js";

export function interpretTask({
  goal = "",
  mode = "run",
  seedInstruction = "",
  preferredRoles = [],
  routeContext = null,
} = {}) {
  return normalizeTaskInterpretation({
    goal,
    mode,
    preferred_roles: preferredRoles,
    route_reason_hint: routeContext?.reason,
    notes: seedInstruction ? [seedInstruction] : [],
  }, {
    fallbackGoal: goal,
    fallbackMode: mode,
  });
}
