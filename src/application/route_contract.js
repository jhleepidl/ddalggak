import { normalizeTeamStructureV2 } from '../shared/team_structure_v2.js';

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

function uniqueStrings(values = [], { max = 12, lower = false } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const text = clean(raw);
    if (!text) continue;
    const key = lower ? text.toLowerCase() : text;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function surfaceMatchesPublishTarget(surface = {}, target = '') {
  const cleanTarget = cleanId(target).replace(/\.md$/i, '');
  if (!cleanTarget) return false;
  const surfaceId = cleanId(surface?.surface_id || surface?.surfaceId || surface?.id || '').replace(/\.md$/i, '');
  if (surfaceId && surfaceId === cleanTarget) return true;
  const semanticSlots = uniqueStrings(surface?.semantic_slots || surface?.semanticSlots || [], { max: 8, lower: true })
    .map((entry) => entry.toLowerCase().replace(/\.md$/i, ''));
  if (semanticSlots.includes(cleanTarget)) return true;
  const purpose = cleanId(surface?.purpose || '');
  if (cleanTarget === 'final_answer') return purpose.includes('final answer');
  if (cleanTarget === 'artifact_index') return purpose.includes('artifact') && purpose.includes('index');
  return false;
}

function canRolePublishSurfaceFromStructure(structure = {}, roleId = '', targetSurface = '') {
  const normalized = normalizeTeamStructureV2(structure || {});
  const cleanRole = cleanId(roleId);
  const target = cleanId(targetSurface).replace(/\.md$/i, '');
  if (!cleanRole || !target) return false;
  const surfaces = asArray(asObject(normalized.memory_plan).surfaces);
  for (const surface of surfaces) {
    if (!surfaceMatchesPublishTarget(surface, target)) continue;
    const writePolicy = cleanId(surface?.write_policy || surface?.writePolicy || 'shared');
    if (target === 'final_answer' && !['final', 'shared', 'append_only'].includes(writePolicy)) continue;
    if (target === 'artifact_index' && !['index', 'shared', 'append_only'].includes(writePolicy)) continue;
    const targetRoles = asArray(surface?.target_roles || surface?.targetRoles).map((entry) => cleanId(entry)).filter(Boolean);
    if (targetRoles.length === 0 || targetRoles.includes(cleanRole)) return true;
  }
  return false;
}


function inferRouteContractIntent(message = '') {
  const text = cleanId(message);
  return {
    wants_status: /(?:\bstatus\b|상태|진행|progress|어디까지|현황|situation|ready|readiness)/.test(text),
    wants_final: /최종|마무리|정리|요약|답변|final|summary|synthesis|handoff|finish|결론/.test(text),
    wants_artifact: /artifact|산출물|bundle|send|전송|deliver|내보내|번들|파일/.test(text),
  };
}

function buildAvailableAgentMap(agents = []) {
  const map = new Map();
  for (const row of asArray(agents)) {
    const id = cleanId(row?.id || row?.agent_id || row?.agentId || '');
    if (!id) continue;
    map.set(id, row);
  }
  return map;
}

function collectRouteContractAgentCandidates({ activeTeam = null, runtimeTeamSnapshot = null } = {}) {
  const out = [];
  const seen = new Set();
  const pushRow = (row = {}) => {
    const ids = uniqueStrings([
      row?.agent_id,
      row?.agentId,
      row?.template_id,
      row?.templateId,
      row?.participant_id,
      row?.participantId,
      row?.slot_id,
      row?.slotId,
      row?.id,
      row?.role,
      row?.role_id,
      row?.roleId,
      row?.role_label,
      row?.roleLabel,
      row?.name,
      row?.display_label,
      row?.displayLabel,
    ], { max: 16, lower: false });
    const key = ids.map((entry) => cleanId(entry)).filter(Boolean).join('|');
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      ids: ids.map((entry) => cleanId(entry)).filter(Boolean),
      label: clean(row?.name || row?.display_label || row?.displayLabel || row?.participant_id || row?.slot_id || row?.role || ''),
      role: cleanId(row?.role || row?.role_id || row?.roleId || row?.role_label || row?.roleLabel || ''),
      provider: cleanId(row?.provider || ''),
    });
  };
  const active = asObject(activeTeam);
  for (const row of asArray(active?.agents)) pushRow(row);
  for (const row of asArray(active?.participants)) pushRow(row);
  const snapshot = asObject(runtimeTeamSnapshot);
  for (const row of asArray(snapshot?.runtime_agents)) pushRow(row);
  return out;
}

function resolvePreferredAgentIdFromCandidates({
  summary = null,
  agents = [],
  activeTeam = null,
  runtimeTeamSnapshot = null,
  intent = {},
} = {}) {
  const row = summary && typeof summary === 'object' ? summary : null;
  if (!row?.available) return '';
  const availableAgentMap = buildAvailableAgentMap(agents);
  if (availableAgentMap.size === 0) return '';
  const candidates = collectRouteContractAgentCandidates({ activeTeam, runtimeTeamSnapshot });
  const finalOwnerLabel = cleanId(row.final_owner || '');
  const finalOwnerId = cleanId(row.final_owner_id || '');
  const finalOwnerRole = cleanId(row.final_owner_role || '');
  const artifactPublisherLabels = new Set(uniqueStrings(row.artifact_publishers || [], { max: 12, lower: true }));
  const artifactPublisherIds = new Set(uniqueStrings(row.artifact_publisher_ids || [], { max: 24, lower: true }));

  const scoreId = (agentId = '') => {
    const cleanAgentId = cleanId(agentId);
    const agent = availableAgentMap.get(cleanAgentId);
    if (!agent) return -1;
    let score = 0;
    if (finalOwnerRole && cleanAgentId === finalOwnerRole) score += 7;
    if (finalOwnerId && cleanAgentId === finalOwnerId) score += 10;
    if (finalOwnerLabel && cleanAgentId === finalOwnerLabel) score += 9;
    if (intent.wants_final && row.final_answer_publish_ok) {
      if (finalOwnerRole && cleanAgentId === finalOwnerRole) score += 8;
      if (finalOwnerId && cleanAgentId === finalOwnerId) score += 10;
      if (finalOwnerLabel && cleanAgentId === finalOwnerLabel) score += 8;
    }
    if (intent.wants_artifact && row.artifact_publish_ok && (artifactPublisherLabels.has(cleanAgentId) || artifactPublisherIds.has(cleanAgentId))) score += 8;
    return score;
  };

  let best = { id: '', score: -1 };
  for (const candidate of candidates) {
    let score = 0;
    for (const candidateId of candidate.ids) {
      const idScore = scoreId(candidateId);
      if (idScore > score) score = idScore;
    }
    if (finalOwnerLabel && cleanId(candidate.label) === finalOwnerLabel) score += 9;
    if (finalOwnerRole && candidate.role === finalOwnerRole) score += 7;
    if (intent.wants_final && row.final_answer_publish_ok && candidate.role && canRolePublishSurfaceFromStructure(resolveRouteContractStructure({ activeTeam, runtimeTeamSnapshot }) || {}, candidate.role, 'final_answer')) score += 6;
    if (intent.wants_artifact && row.artifact_publish_ok && (artifactPublisherLabels.has(cleanId(candidate.label)) || candidate.ids.some((id) => artifactPublisherIds.has(cleanId(id))))) score += 7;
    if (intent.wants_artifact && row.artifact_publish_ok && candidate.role && canRolePublishSurfaceFromStructure(resolveRouteContractStructure({ activeTeam, runtimeTeamSnapshot }) || {}, candidate.role, 'artifact_index')) score += 6;
    for (const candidateId of candidate.ids) {
      const cleanCandidateId = cleanId(candidateId);
      if (!availableAgentMap.has(cleanCandidateId)) continue;
      const candidateScore = score + scoreId(cleanCandidateId);
      if (candidateScore > best.score) best = { id: cleanCandidateId, score: candidateScore };
    }
  }

  if (best.id) return best.id;
  if (finalOwnerId && availableAgentMap.has(finalOwnerId)) return finalOwnerId;
  if (finalOwnerRole && availableAgentMap.has(finalOwnerRole)) return finalOwnerRole;
  if (finalOwnerLabel && availableAgentMap.has(finalOwnerLabel)) return finalOwnerLabel;
  if (intent.wants_artifact && row.artifact_publish_ok) {
    for (const label of artifactPublisherLabels) {
      if (availableAgentMap.has(label)) return label;
    }
  }
  return '';
}


export function rankAgentsByRouteContract({
  message = '',
  agents = [],
  activeTeam = null,
  runtimeTeamSnapshot = null,
} = {}) {
  const summary = resolveRoutingContractSummary({ activeTeam, runtimeTeamSnapshot });
  const intent = inferRouteContractIntent(message);
  const availableAgentMap = buildAvailableAgentMap(agents);
  const ranked = [];
  for (const [id, agent] of availableAgentMap.entries()) {
    const preferred = resolvePreferredAgentIdFromCandidates({
      summary,
      agents,
      activeTeam,
      runtimeTeamSnapshot,
      intent,
    });
    let score = 0;
    if (preferred && id === preferred) score += 20;
    const provider = cleanId(agent?.provider || '');
    if (intent.wants_final && provider === 'chatgpt') score += 2;
    if (intent.wants_artifact && provider === 'codex') score += 2;
    ranked.push({ id, score, provider });
  }
  ranked.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
  return {
    summary,
    intent,
    ranked_agent_ids: ranked.map((row) => row.id),
    preferred_agent_id: ranked[0]?.score > 0 ? ranked[0].id : resolvePreferredAgentIdFromCandidates({ summary, agents, activeTeam, runtimeTeamSnapshot, intent }) || undefined,
  };
}

export function alignPlanActionsToRouteContract({
  plan = null,
  message = '',
  agents = [],
  activeTeam = null,
  runtimeTeamSnapshot = null,
  preserveExplicitAgent = false,
} = {}) {
  const sourcePlan = plan && typeof plan === 'object' ? plan : {};
  const sourceActions = Array.isArray(sourcePlan.actions) ? sourcePlan.actions : [];
  const heuristic = resolveRouteContractHeuristic({ message, agents, activeTeam, runtimeTeamSnapshot });
  const preferred = cleanId(heuristic.preferred_agent_id || '');
  if (!preferred || preserveExplicitAgent || sourceActions.length === 0) {
    return { plan: { ...sourcePlan, route_contract: heuristic.summary || sourcePlan.route_contract }, adjusted: false, preferred_agent_id: preferred || undefined };
  }
  const availableAgentMap = buildAvailableAgentMap(agents);
  if (!availableAgentMap.has(preferred)) {
    return { plan: { ...sourcePlan, route_contract: heuristic.summary || sourcePlan.route_contract }, adjusted: false, preferred_agent_id: preferred || undefined };
  }
  const intent = heuristic.intent || {};
  const structure = resolveRouteContractStructure({ activeTeam, runtimeTeamSnapshot }) || {};
  let adjusted = false;
  let adjustedType = '';
  const nextActions = sourceActions.map((action, index) => {
    if (index > 0) return action;
    const row = asObject(action);
    const type = cleanId(row.type || '');
    if (type === 'synthesize_final' && intent.wants_final && heuristic.summary?.final_answer_publish_ok !== false) {
      const currentAgentId = cleanId(row.agent_id || row.agentId || row.agent || '');
      if (preferred && currentAgentId !== preferred) {
        adjusted = true;
        adjustedType = 'synthesize_final';
        return { ...row, agent_id: preferred, route_contract_adjusted: true, route_contract_preferred_agent: preferred };
      }
      return row;
    }
    if (type === 'run_agent' && (intent.wants_final || intent.wants_artifact)) {
      const currentAgentId = cleanId(row.agent_id || row.agentId || row.agent || '');
      const currentAgent = availableAgentMap.get(currentAgentId);
      const currentRole = cleanId(currentAgent?.role || '');
      const currentFinalCapable = intent.wants_final && heuristic.summary?.final_answer_publish_ok !== false && currentRole && canRolePublishSurfaceFromStructure(structure, currentRole, 'final_answer');
      const currentArtifactCapable = intent.wants_artifact && heuristic.summary?.artifact_publish_ok !== false && currentRole && canRolePublishSurfaceFromStructure(structure, currentRole, 'artifact_index');
      if (!currentFinalCapable && !currentArtifactCapable && preferred && currentAgentId !== preferred) {
        adjusted = true;
        adjustedType = 'run_agent';
        return { ...row, agent_id: preferred, route_contract_adjusted: true, route_contract_preferred_agent: preferred };
      }
    }
    return row;
  });
  return {
    plan: {
      ...sourcePlan,
      actions: nextActions,
      route_contract: heuristic.summary || sourcePlan.route_contract,
      route_contract_adjusted: adjusted || sourcePlan.route_contract_adjusted === true,
      route_contract_preferred_agent: preferred || sourcePlan.route_contract_preferred_agent,
      route_contract_adjustment_type: adjustedType || sourcePlan.route_contract_adjustment_type,
    },
    adjusted,
    preferred_agent_id: preferred || undefined,
    heuristic,
  };
}

export function formatRouteReadiness(summary = null, { compact = false } = {}) {
  const row = summary && typeof summary === 'object' ? summary : null;
  if (!row?.available) return compact ? '' : '(route readiness unavailable)';
  const owner = clean(row.final_owner || '');
  const ownerText = owner ? `owner=${owner}` : 'owner=(unset)';
  const finalState = clean(row.final_answer_publish_state || (row.final_answer_publish_ok === false ? 'blocked' : 'ready')) || 'ready';
  const artifactState = clean(row.artifact_publish_state || (row.artifact_publish_ok === false ? 'blocked' : 'ready')) || 'ready';
  const finalText = `final ${finalState}`;
  const artifactText = `artifact ${artifactState}`;
  if (compact) return [ownerText, finalText, artifactText].join(' · ');
  const memory = clean(row.memory_contract_enforcement?.read_scope || '');
  return [ownerText, finalText, artifactText, memory ? `memory=${memory}` : ''].filter(Boolean).join(' · ');
}

export function resolveRouteContractHeuristic({ message = '', agents = [], activeTeam = null, runtimeTeamSnapshot = null } = {}) {
  const summary = resolveRoutingContractSummary({ activeTeam, runtimeTeamSnapshot });
  const intent = inferRouteContractIntent(message);
  const preferredAgentId = resolvePreferredAgentIdFromCandidates({
    summary,
    agents,
    activeTeam,
    runtimeTeamSnapshot,
    intent,
  });
  const blockedFinalization = Boolean(intent.wants_final && summary?.available && summary.final_answer_publish_ok === false);
  const blockedArtifactDelivery = Boolean(intent.wants_artifact && summary?.available && summary.artifact_publish_ok === false);
  let blockedExplanation = '';
  if (blockedFinalization && summary?.final_owner) blockedExplanation = `${summary.final_owner} cannot publish final_answer yet`;
  else if (blockedFinalization && summary?.final_owner_missing) blockedExplanation = 'final answer owner is not declared';
  else if (blockedArtifactDelivery) blockedExplanation = 'artifact_index publisher is missing';
  return {
    summary,
    intent,
    preferred_agent_id: preferredAgentId || undefined,
    route_readiness: formatRouteReadiness(summary, { compact: true }) || undefined,
    blocked_finalization: blockedFinalization,
    blocked_artifact_delivery: blockedArtifactDelivery,
    blocked_explanation: blockedExplanation || undefined,
    should_explain_constraints: blockedFinalization || blockedArtifactDelivery,
  };
}

export function summarizePublishContractIssues(structure = {}) {
  const normalized = normalizeTeamStructureV2(structure || {});
  const participants = asArray(normalized?.participants);
  const finalOwnerId = cleanId(normalized?.control_policy?.final_answer_owner_participant_id || normalized?.control_policy?.finalAnswerOwnerParticipantId || normalized?.topology?.final_participant_id || normalized?.topology?.finalParticipantId || '');
  const finalOwner = participants.find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  const finalOwnerRole = cleanId(finalOwner?.role);
  const finalOwnerMissing = !finalOwnerId || !finalOwner;
  const finalOwnerPublishBlocked = finalOwnerMissing || !finalOwnerRole || !canRolePublishSurfaceFromStructure(normalized, finalOwnerRole, 'final_answer');
  const artifactPublisherRows = participants.filter((row) => canRolePublishSurfaceFromStructure(normalized, cleanId(row?.role), 'artifact_index'));
  const artifactPublishers = uniqueStrings(
    artifactPublisherRows
      .map((row) => clean(row?.name || row?.participant_id || row?.agent_id || ''))
      .filter(Boolean),
    { max: 12, lower: false },
  );
  const artifactPublisherIds = uniqueStrings(
    artifactPublisherRows.flatMap((row) => [
      clean(row?.participant_id || ''),
      clean(row?.agent_id || ''),
      clean(row?.id || ''),
      clean(row?.name || ''),
      clean(row?.role || ''),
    ]).filter(Boolean),
    { max: 24, lower: false },
  ).map((entry) => cleanId(entry));
  return {
    final_owner_missing: finalOwnerMissing,
    final_owner_id: clean(finalOwner?.participant_id || finalOwner?.agent_id || finalOwner?.id || finalOwnerId),
    final_owner_publish_blocked: finalOwnerPublishBlocked,
    final_owner_label: clean(finalOwner?.name || finalOwnerId),
    final_owner_role: cleanId(finalOwner?.role),
    artifact_publish_missing: artifactPublishers.length === 0,
    artifact_publishers: artifactPublishers,
    artifact_publisher_ids: artifactPublisherIds,
  };
}

function resolveRouteContractStructure({ activeTeam = null, runtimeTeamSnapshot = null } = {}) {
  const active = asObject(activeTeam);
  const snapshot = asObject(runtimeTeamSnapshot);
  const snapshotPlan = asObject(snapshot.team_plan);
  const structure = active.structure_v2
    || active.structureV2
    || snapshot.structure_v2
    || snapshot.structureV2
    || snapshotPlan.structure_v2
    || snapshotPlan.structureV2
    || null;
  return structure && typeof structure === 'object' ? normalizeTeamStructureV2(structure) : null;
}

export function resolveRoutingContractSummary({ activeTeam = null, runtimeTeamSnapshot = null } = {}) {
  const structure = resolveRouteContractStructure({ activeTeam, runtimeTeamSnapshot });
  if (!structure) return null;
  const participants = asArray(structure.participants);
  const issues = summarizePublishContractIssues(structure);
  const finalOwnerId = cleanId(structure?.control_policy?.final_answer_owner_participant_id || structure?.control_policy?.finalAnswerOwnerParticipantId || structure?.topology?.final_participant_id || structure?.topology?.finalParticipantId || '');
  const finalOwner = participants.find((row) => cleanId(row?.participant_id || row?.agent_id || row?.id || '') === finalOwnerId) || null;
  const finalOwnerLabel = clean(finalOwner?.name || issues.final_owner_label || asObject(activeTeam).interaction_spec?.final_answer_owner || '');
  const finalOwnerIdLabel = clean(finalOwner?.participant_id || finalOwner?.agent_id || finalOwner?.id || issues.final_owner_id || '');
  const finalOwnerRole = cleanId(finalOwner?.role || issues.final_owner_role || '');
  const finalAnswerPublishOk = !issues.final_owner_publish_blocked && Boolean(finalOwnerLabel || finalOwnerIdLabel);
  const artifactPublishOk = !issues.artifact_publish_missing;
  const memoryContractEnforcement = {
    read_scope: 'hard_role_scoped_local_only',
    write_scope: 'hard_reroute',
    publish_scope: 'declared_only',
    final_publish_rule: 'final_owner_declared_surface_required',
    artifact_publish_rule: 'declared_artifact_surface_required',
  };
  const plannerFacts = [];
  if (finalOwnerLabel) plannerFacts.push(`final_owner=${finalOwnerLabel}`);
  if (finalOwnerIdLabel) plannerFacts.push(`final_owner_id=${finalOwnerIdLabel}`);
  if (finalOwnerRole) plannerFacts.push(`final_owner_role=${finalOwnerRole}`);
  const finalPublishState = !finalOwnerLabel && !finalOwnerIdLabel ? 'unset' : (finalAnswerPublishOk ? 'ready' : 'blocked');
  const artifactPublishState = artifactPublishOk ? 'ready' : 'blocked';
  plannerFacts.push(`final_publish=${finalPublishState}`);
  plannerFacts.push(`artifact_publish=${artifactPublishState}`);
  plannerFacts.push(`memory_contract=${memoryContractEnforcement.read_scope}`);
  const summaryLine = [
    finalOwnerLabel ? `final owner ${finalOwnerLabel}` : 'final owner unset',
    finalPublishState === 'unset' ? 'final publish unset' : `final publish ${finalPublishState}`,
    `artifact publish ${artifactPublishState}`,
  ].join(' · ');
  const explanationLines = [];
  explanationLines.push(`current team route contract: ${summaryLine}`);
  if (issues.artifact_publishers.length > 0) explanationLines.push(`artifact publishers: ${issues.artifact_publishers.join(', ')}`);
  if (!finalOwnerLabel && !finalOwnerIdLabel) explanationLines.push('route risk: final answer owner is not declared in the current team');
  else if (!finalAnswerPublishOk && finalOwnerLabel) explanationLines.push(`route risk: ${finalOwnerLabel} cannot publish final_answer in the current memory contract`);
  if (!artifactPublishOk) explanationLines.push('route risk: no participant can publish artifact_index in the current memory contract');
  return {
    available: true,
    final_owner: finalOwnerLabel || undefined,
    final_owner_id: finalOwnerIdLabel || undefined,
    final_owner_missing: issues.final_owner_missing === true,
    final_owner_role: finalOwnerRole || undefined,
    final_answer_publish_ok: finalAnswerPublishOk,
    final_answer_publish_state: finalPublishState,
    artifact_publish_ok: artifactPublishOk,
    artifact_publish_state: artifactPublishState,
    artifact_publishers: issues.artifact_publishers,
    artifact_publisher_ids: issues.artifact_publisher_ids || [],
    memory_contract_enforcement: memoryContractEnforcement,
    summary_line: summaryLine,
    explanation_lines: explanationLines,
    planner_facts: plannerFacts,
  };
}

export function buildRouteContractSelectionExplanations(summary = null) {
  const row = summary && typeof summary === 'object' ? summary : null;
  if (!row?.available) return [];
  const reasons = [];
  for (const line of asArray(row.explanation_lines).slice(0, 4)) {
    const text = clean(line);
    if (!text) continue;
    reasons.push({ subject_id: 'route_contract', reason: text });
  }
  return reasons;
}
