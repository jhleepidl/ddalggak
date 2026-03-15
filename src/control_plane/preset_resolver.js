import { normalizeStringList } from "../shared/normalize.js";
import { normalizeRoleId } from "../compatibility/legacy_roles.js";

function normalizeText(raw = "", {
  lower = false,
} = {}) {
  const value = String(raw || "").trim();
  return lower ? value.toLowerCase() : value;
}

function tokenize(text = "") {
  return normalizeStringList(
    normalizeText(text, { lower: true }).split(/[^a-z0-9가-힣._-]+/g),
    { max: 128, lower: true }
  );
}

export function scorePresetForTask({
  preset = {},
  goal = "",
  roleId = "",
} = {}) {
  const requestedRole = normalizeRoleId(roleId);
  const presetRole = normalizeRoleId(preset.role_id);
  const goalTokens = new Set(tokenize(goal));
  const presetTokens = tokenize(preset.retrieval_text || "");
  let tokenMatches = 0;
  for (const token of presetTokens) {
    if (goalTokens.has(token)) tokenMatches += 1;
  }
  return (
    (requestedRole && presetRole === requestedRole ? 50 : 0)
    + Math.min(30, tokenMatches * 3)
    + (preset.default_skill_ids?.length || 0)
  );
}

export class PresetResolver {
  constructor({
    registry = null,
  } = {}) {
    this.registry = registry || null;
  }

  resolveForRole({
    roleId = "",
    goal = "",
  } = {}) {
    if (!this.registry || typeof this.registry.list !== "function") return null;
    const candidates = this.registry.list({
      roleId: normalizeRoleId(roleId, { allowDeprecatedControlPlane: false }),
    });
    let best = null;
    for (const preset of candidates) {
      const score = scorePresetForTask({ preset, goal, roleId });
      if (!best || score > best.score) best = { preset, score };
    }
    return best ? best.preset : null;
  }
}
