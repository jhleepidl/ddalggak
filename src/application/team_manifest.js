import { validateTeamConfiguration, storePendingTeam, applyPendingTeam, getSessionTeamState } from './team_configuration.js';
import { buildManifestRequirements, buildManifestInstallHints, normalizeManifestRequirements } from '../shared/manifest_requirements.js';
import { buildTeamInstallProposal } from './install_proposal.js';
import { normalizeInstallProposalState } from './install_proposal_state.js';
import { normalizeCredentialBindingState } from './credential_binding.js';
import { buildTeamStructureV2, normalizeTeamStructureV2, deriveTeamConfigFromStructureV2 } from '../shared/team_structure_v2.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanState(value = 'pending') {
  return String(value || '').trim().toLowerCase() === 'active' ? 'active' : 'pending';
}

function selectManifestTeam(raw = {}, applyState = 'pending') {
  const row = asObject(raw);
  const primarySchema = clean(row.primary_schema || row.primarySchema || '');
  if ((primarySchema === 'structure_v2' || row.structure_v2 || row.structureV2) && (row.structure_v2 || row.structureV2)) {
    return deriveTeamConfigFromStructureV2(row.structure_v2 || row.structureV2);
  }
  if (row.team && typeof row.team === 'object') return row.team;
  if (applyState === 'active' && row.active_team && typeof row.active_team === 'object') return row.active_team;
  if (row.pending_team && typeof row.pending_team === 'object') return row.pending_team;
  if (row.active_team && typeof row.active_team === 'object') return row.active_team;
  const teamConfig = asObject(row.team_config);
  if ((primarySchema === 'structure_v2' || teamConfig.structure_v2) && teamConfig.structure_v2) {
    return deriveTeamConfigFromStructureV2(teamConfig.structure_v2);
  }
  if (applyState === 'active' && teamConfig.active_team && typeof teamConfig.active_team === 'object') return teamConfig.active_team;
  if (teamConfig.pending_team && typeof teamConfig.pending_team === 'object') return teamConfig.pending_team;
  if (teamConfig.active_team && typeof teamConfig.active_team === 'object') return teamConfig.active_team;
  return row;
}

export function buildTeamManifest(team = {}, { runtime = null, applyState = 'pending', source = 'telegram', installProposalState = null, credentialBindingState = null } = {}) {
  const cleanApplyState = cleanState(applyState);
  const validatedTeam = validateTeamConfiguration(team, { runtime });
  const requirements = normalizeManifestRequirements(
    validatedTeam.requirements || buildManifestRequirements({
      team: validatedTeam,
      capabilityGaps: validatedTeam.capability_gaps || validatedTeam.capabilityGaps || [],
    })
  );
  const installHints = buildManifestInstallHints(requirements, {
    hasGocThreadTarget: !!clean(runtime?.map?.threadId || runtime?.threadId || ''),
  });
  const installProposal = buildTeamInstallProposal({
    team: validatedTeam,
    runtime,
    applyState: cleanApplyState,
  });
  const normalizedInstallProposalState = normalizeInstallProposalState(installProposalState);
  const normalizedCredentialBindingState = normalizeCredentialBindingState(credentialBindingState || {});
  const structureV2 = normalizeTeamStructureV2(
    validatedTeam.structure_v2 || buildTeamStructureV2(validatedTeam, {
      applyState: cleanApplyState,
      installProposalState: normalizedInstallProposalState,
      credentialBindingState: normalizedCredentialBindingState,
    })
  );
  const compatibilityTeam = validateTeamConfiguration({
    ...deriveTeamConfigFromStructureV2(structureV2),
    ...validatedTeam,
    requirements,
    structure_v2: structureV2,
  }, { runtime });
  return {
    kind: 'ddalggak_team_manifest',
    version: 2,
    primary_schema: 'structure_v2',
    source,
    exported_at: new Date().toISOString(),
    apply_state: cleanApplyState,
    thread_id: clean(runtime?.map?.threadId || runtime?.threadId || '') || undefined,
    service_id: clean(runtime?.map?.serviceId || runtime?.serviceId || '') || undefined,
    compatibility: {
      ddalggak: true,
      goc: true,
      install_target: 'thread_team_config',
    },
    summary: {
      agent_count: Array.isArray(compatibilityTeam?.agents) ? compatibilityTeam.agents.length : 0,
      participant_count: Array.isArray(structureV2?.participants) ? structureV2.participants.length : 0,
      structure_pattern: structureV2?.topology?.pattern || 'hybrid',
      structure_warnings: Array.isArray(structureV2?.validation?.warnings) ? structureV2.validation.warnings.length : 0,
      composition_mode: compatibilityTeam.composition_mode || 'structured',
      proposal_mode: compatibilityTeam.proposal_mode || (cleanApplyState === 'active' ? 'apply' : 'refine'),
      tool_requirements: requirements.summary.tool_count,
      credential_requirements: requirements.summary.credential_count,
    },
    requirements: {
      ...requirements,
      install_hints: installHints,
    },
    structure_v2: structureV2,
    install_proposal: installProposal,
    install_proposal_state: normalizedInstallProposalState,
    credential_binding_state: normalizedCredentialBindingState,
    team: {
      ...compatibilityTeam,
      structure_v2: structureV2,
    },
  };
}

export function normalizeTeamManifest(manifest = {}, { runtime = null, applyState = 'pending' } = {}) {
  const raw = asObject(manifest);
  const cleanApplyState = cleanState(applyState || raw?.apply_state || raw?.applyState);
  const rawStructure = raw.kind === 'team_structure_v2' ? raw : (raw.structure_v2 || raw.structureV2 || raw?.team?.structure_v2 || raw?.team?.structureV2 || raw?.team_config?.structure_v2 || null);
  const normalizedStructure = rawStructure && typeof rawStructure === 'object' ? normalizeTeamStructureV2(rawStructure) : null;
  const selectedTeam = selectManifestTeam(raw, cleanApplyState);
  const mergedTeam = normalizedStructure
    ? {
        ...deriveTeamConfigFromStructureV2(normalizedStructure),
        ...selectedTeam,
        requirements: raw.requirements || normalizedStructure.requirements || selectedTeam?.requirements || undefined,
        structure_v2: normalizedStructure,
      }
    : {
        ...selectedTeam,
        requirements: raw.requirements || selectedTeam?.requirements || undefined,
      };
  const validatedTeam = validateTeamConfiguration(mergedTeam, { runtime });
  const normalized = buildTeamManifest(validatedTeam, {
    runtime,
    applyState: cleanApplyState,
    source: clean(raw.source || 'manifest_import') || 'manifest_import',
    installProposalState: raw.install_proposal_state || raw.installProposalState || null,
    credentialBindingState: raw.credential_binding_state || raw.credentialBindingState || null,
  });
  return {
    manifest: {
      ...normalized,
      primary_schema: 'structure_v2',
      thread_id: clean(raw.thread_id || normalized.thread_id || '') || normalized.thread_id,
      service_id: clean(raw.service_id || normalized.service_id || '') || normalized.service_id,
      exported_at: clean(raw.exported_at || raw.exportedAt || normalized.exported_at || '') || normalized.exported_at,
    },
    team: validatedTeam,
    apply_state: cleanApplyState,
  };
}

export async function installTeamManifestToSession({ sessionStore, chatId, manifest = {}, runtime = null, applyState = 'pending' } = {}) {
  const normalized = normalizeTeamManifest(manifest, { runtime, applyState });
  storePendingTeam(sessionStore, chatId, normalized.team);
  let installedTeam = normalized.team;
  if (normalized.apply_state === 'active') {
    installedTeam = await applyPendingTeam({ sessionStore, chatId, runtime });
  }
  return {
    ...normalized,
    team: installedTeam,
    session_state: getSessionTeamState(sessionStore, chatId),
  };
}
