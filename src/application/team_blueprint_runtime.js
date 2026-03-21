import { validateTeamConfiguration, storePendingTeam, applyPendingTeam, getSessionTeamState } from './team_configuration.js';
import { buildTeamBlueprintDocument, normalizeTeamBlueprintPayload } from './team_blueprint.js';

function clean(value = '') {
  return String(value || '').trim();
}

function cleanState(value = 'pending') {
  return String(value || '').trim().toLowerCase() === 'active' ? 'active' : 'pending';
}

export function buildTeamBlueprint(team = {}, options = {}) {
  const cleanApplyState = cleanState(options?.applyState);
  const validatedTeam = validateTeamConfiguration(team, { runtime: options?.runtime || null });
  return buildTeamBlueprintDocument(validatedTeam, {
    runtime: options?.runtime || null,
    applyState: cleanApplyState,
    source: clean(options?.source || 'telegram') || 'telegram',
    installProposalState: options?.installProposalState || null,
    credentialBindingState: options?.credentialBindingState || null,
  });
}

export function normalizeTeamBlueprint(blueprint = {}, { runtime = null, applyState = 'pending' } = {}) {
  const cleanApplyState = cleanState(applyState || blueprint?.apply_state || blueprint?.applyState);
  const normalized = normalizeTeamBlueprintPayload(blueprint, {
    runtime,
    applyState: cleanApplyState,
    source: clean(blueprint?.source || 'blueprint_import') || 'blueprint_import',
  });
  const validatedTeam = validateTeamConfiguration(normalized.team, { runtime });
  return {
    blueprint: buildTeamBlueprint(validatedTeam, {
      runtime,
      applyState: cleanApplyState,
      source: clean(blueprint?.source || 'blueprint_import') || 'blueprint_import',
      installProposalState: blueprint?.install_proposal_state || blueprint?.installProposalState || null,
      credentialBindingState: blueprint?.credential_binding_state || blueprint?.credentialBindingState || null,
    }),
    team: validatedTeam,
    apply_state: cleanApplyState,
  };
}

export async function installTeamBlueprintToSession({ sessionStore, chatId, blueprint = {}, manifest = null, runtime = null, applyState = 'pending' } = {}) {
  const sourceBlueprint = manifest && typeof manifest === 'object' ? manifest : blueprint;
  const normalized = normalizeTeamBlueprint(sourceBlueprint, { runtime, applyState });
  storePendingTeam(sessionStore, chatId, normalized.team);
  let installedTeam = normalized.team;
  if (normalized.apply_state === 'active') installedTeam = await applyPendingTeam({ sessionStore, chatId, runtime });
  return { ...normalized, team: installedTeam, session_state: getSessionTeamState(sessionStore, chatId) };
}
