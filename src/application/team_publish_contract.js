import { buildTeamStructureV2, normalizeTeamStructureV2 } from '../shared/team_structure_v2.js';
import {
  getParticipantLegacyOptionalToolIds,
  getParticipantLegacyRecommendedToolIds,
  getParticipantLegacyRequiredToolIds,
} from '../shared/participant_schema.js';

function asArray(v) { return Array.isArray(v) ? v : []; }
function asObject(v) { return v && typeof v === 'object' ? v : {}; }
function clean(v = '') { return String(v || '').trim(); }
function cleanId(v = '') { return clean(v).toLowerCase(); }

function uniqueIds(values = [], { max = 16 } = {}) {
  const out = [];
  const seen = new Set();
  for (const value of asArray(values)) {
    const id = clean(value);
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
    if (out.length >= Math.max(1, Number(max) || 16)) break;
  }
  return out;
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

export function canRolePublishSurfaceFromStructure(structure = {}, roleId = '', surfaceId = '') {
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

export function summarizePublishContractIssues(structure = {}) {
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

export function patchPublishSurfaceTargets(structure = {}, surfaceId = '', roleIds = [], defaults = {}) {
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

export function pickPreferredPublishParticipant(structure = {}, surfaceId = '', preferredRoles = []) {
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

export function enforcePublishContractOnStructure(structure = {}) {
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
    if (preferredOwner) {
      const participantId = cleanId(preferredOwner?.participant_id || preferredOwner?.agent_id || preferredOwner?.id || '');
      if (participantId) {
        normalized = normalizeTeamStructureV2({
          ...normalized,
          topology: {
            ...asObject(normalized.topology),
            final_participant_id: participantId,
          },
          control_policy: {
            ...asObject(normalized.control_policy),
            final_answer_owner_participant_id: participantId,
          },
        });
        reasons.push(`publish contract repaired: final answer owner moved to ${clean(preferredOwner?.name || participantId)}`);
      }
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

export function buildTeamTransitionGuardrailsImpl({ currentTeam = null, nextTeam = null } = {}) {
  const current = currentTeam && typeof currentTeam === 'object' ? currentTeam : null;
  const candidate = nextTeam && typeof nextTeam === 'object' ? nextTeam : null;
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
    const beforeRequired = new Set(getParticipantLegacyRequiredToolIds(before));
    const afterRequired = new Set(getParticipantLegacyRequiredToolIds(after));
    const removedRequired = Array.from(beforeRequired).filter((toolId) => !afterRequired.has(toolId));
    if (removedRequired.length > 0) required_tool_drops.push(`${label}: ${removedRequired.join(', ')}`);
    const beforeOptional = new Set(getParticipantLegacyOptionalToolIds(before).concat(getParticipantLegacyRecommendedToolIds(before)));
    const afterOptional = new Set(getParticipantLegacyOptionalToolIds(after).concat(getParticipantLegacyRecommendedToolIds(after)));
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
  const risk_level = destructive_changes_present || warnings.length >= 3 ? 'high' : warnings.length > 0 ? 'medium' : 'low';
  const change_summary = {
    removed_agent_count: removed_agents.length,
    lost_role_count: lost_role_coverage.length,
    role_change_count: role_changes.length,
    provider_drop_count: provider_drops.length,
    model_drop_count: model_drops.length,
    required_tool_drop_count: required_tool_drops.length,
    optional_tool_drop_count: optional_tool_drops.length,
    removed_memory_surface_count: removed_memory_surfaces.length,
    final_participant_changed: Boolean(currentFinal && currentFinal !== candidateFinal),
    final_owner_changed: Boolean(currentOwner && currentOwner !== candidateOwner),
    final_owner_publish_blocked: candidatePublishIssues.final_owner_publish_blocked,
    artifact_publish_missing: candidatePublishIssues.artifact_publish_missing,
  };
  let recommended_action = 'safe_to_apply';
  let summary_line = '위험한 team 변경이 감지되지 않았습니다.';
  if (candidatePublishIssues.final_owner_publish_blocked) {
    recommended_action = 'fix_publish_contract';
    summary_line = `최종 답변 owner publish가 막혀 있습니다${candidatePublishIssues.final_owner_label ? ` (${candidatePublishIssues.final_owner_label})` : ''}. 먼저 publish contract를 고치세요.`;
  } else if (candidatePublishIssues.artifact_publish_missing) {
    recommended_action = 'fix_publish_contract';
    summary_line = 'artifact_index를 publish할 participant가 없어 산출물 전송이 막힐 수 있습니다.';
  } else if (risk_level === 'high' && destructive_changes_present) {
    recommended_action = 'review_and_confirm_apply';
    summary_line = '이 apply는 역할/도구/메모리 구성을 줄일 수 있어 재확인이 필요합니다.';
  } else if (warnings.length > 0) {
    recommended_action = 'review_warnings';
    summary_line = `경고 ${warnings.length}개가 있어 diff 확인을 권장합니다.`;
  }
  return {
    risk_level,
    warning_count: warnings.length,
    recommended_action,
    summary_line,
    change_summary,
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
  const summary = row.change_summary && typeof row.change_summary === 'object' ? row.change_summary : {};
  const summaryBits = [
    Number(summary.removed_agent_count || 0) > 0 ? `agents -${Number(summary.removed_agent_count || 0)}` : '',
    Number(summary.lost_role_count || 0) > 0 ? `roles -${Number(summary.lost_role_count || 0)}` : '',
    Number(summary.required_tool_drop_count || 0) > 0 ? `required tools -${Number(summary.required_tool_drop_count || 0)}` : '',
    Number(summary.optional_tool_drop_count || 0) > 0 ? `optional tools -${Number(summary.optional_tool_drop_count || 0)}` : '',
    Number(summary.removed_memory_surface_count || 0) > 0 ? `memory -${Number(summary.removed_memory_surface_count || 0)}` : '',
    summary.final_owner_changed ? 'owner changed' : '',
    summary.final_owner_publish_blocked ? 'final publish blocked' : '',
    summary.artifact_publish_missing ? 'artifact publish missing' : '',
  ].filter(Boolean);
  return [
    `- risk: ${cleanId(row.risk_level || 'low') || 'low'}`,
    `- destructive: ${row.destructive_changes_present ? 'yes' : 'no'}`,
    row.summary_line ? `- summary: ${clean(row.summary_line)}` : '',
    row.recommended_action ? `- next: ${cleanId(row.recommended_action)}` : '',
    summaryBits.length > 0 ? `- diff: ${summaryBits.join(' · ')}` : '',
    ...warnings.map((entry) => `- ${entry}`),
  ].filter(Boolean);
}
