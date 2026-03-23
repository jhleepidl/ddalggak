import {
  collectEffectiveAvailableCapabilityIds,
  collectEffectiveAvailableExternalToolIds,
} from './runtime_tool_availability.js';
import {
  classifyToolishId,
  mergeUniqueIds,
  normalizeParticipantExecutionSchema,
  normalizeRuntimeCapabilityId,
  toLegacyRuntimeCapabilityId,
  uniqueIds,
} from '../shared/participant_schema.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

const legacyGapKind = ['missing', 'tool'].join('_');

function normalizeGapKind(kind = '', capabilityId = '', externalToolId = '', toolId = '') {
  const normalized = cleanId(kind || '');
  if (normalized === legacyGapKind) {
    if (capabilityId || normalizeRuntimeCapabilityId(toolId)) return 'missing_capability';
    if (externalToolId || toolId) return 'missing_external_tool';
  }
  if (normalized === 'missing_capability' || normalized === 'missing_external_tool' || normalized === 'missing_credential' || normalized === 'missing_skill') {
    return normalized;
  }
  return normalized || 'missing_external_tool';
}

function normalizeCapabilityGap(raw = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const legacyToolId = cleanId(row.tool_id || row.toolId || '');
  const capabilityId = cleanId(row.capability_id || row.capabilityId || normalizeRuntimeCapabilityId(legacyToolId) || '');
  const externalToolId = cleanId(row.external_tool_id || row.externalToolId || (!capabilityId ? legacyToolId : ''));
  const kind = normalizeGapKind(row.kind, capabilityId, externalToolId, legacyToolId);
  const resolvedToolId = legacyToolId || (kind === 'missing_capability' ? toLegacyRuntimeCapabilityId(capabilityId) : externalToolId);
  const legacyKind = kind === 'missing_capability' || kind === 'missing_external_tool' ? legacyGapKind : kind;
  return {
    kind: legacyKind,
    canonical_kind: kind,
    legacy_kind: legacyKind,
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    agent_name: clean(row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    capability_id: capabilityId || undefined,
    external_tool_id: externalToolId || undefined,
    tool_id: resolvedToolId || undefined,
    credential_key: clean(row.credential_key || row.credentialKey || ''),
    skill_id: cleanId(row.skill_id || row.skillId || ''),
    detail: clean(row.detail || row.reason || ''),
    suggested_action: clean(row.suggested_action || row.suggestedAction || ''),
  };
}

export function normalizeCapabilityGapList(rows = []) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(rows)) {
    const gap = normalizeCapabilityGap(raw);
    const key = [gap.kind, gap.agent_name, gap.capability_id, gap.external_tool_id, gap.tool_id, gap.credential_key, gap.skill_id, gap.detail].join('|').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out.slice(0, 24);
}

function inferToolSuggestion(toolId = '', capabilityId = '') {
  const capability = cleanId(capabilityId || normalizeRuntimeCapabilityId(toolId) || '');
  const id = cleanId(toolId);
  if (capability === 'filesystem_write') return 'workspace write 권한 또는 파일 생성 capability를 runtime에 연결해 주세요.';
  if (capability === 'filesystem_read') return 'filesystem read 권한이 필요합니다.';
  if (capability === 'shell_exec') return 'shell/terminal 실행 권한이 필요합니다.';
  if (capability === 'web_browse') return 'web browse capability가 필요합니다.';
  if (/browser|search/.test(id)) return 'browser/search connector 또는 검색 adapter를 연결해 주세요.';
  return `${toolId || capability || 'tool'} 정의 또는 연결이 필요합니다.`;
}

function findExplicitCredentialRequest(raw = '') {
  const text = clean(raw);
  if (!text) return '';
  const keyMatch = text.match(/\b([A-Z][A-Z0-9_]*API[_-]?KEY|OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY)\b/);
  const explicitNeed = /(please\s+(provide|set|configure|supply)|missing|not\s+set|not\s+configured|not\s+available|need(?:ed)?|requires?|required|without)\b[^\n]{0,80}\b(api[_ -]?key|credential|token|[A-Z][A-Z0-9_]*API[_-]?KEY)\b/i;
  const explicitNeedReverse = /\b(api[_ -]?key|credential|token|[A-Z][A-Z0-9_]*API[_-]?KEY)\b[^\n]{0,80}\b(missing|required|needed|not\s+set|not\s+configured|not\s+available|please\s+provide|please\s+set)\b/i;
  if (!explicitNeed.test(text) && !explicitNeedReverse.test(text)) return '';
  return clean(keyMatch?.[1] || 'API_KEY');
}

export function detectCapabilityGapsFromText(text = '', { label = 'agent' } = {}) {
  const raw = clean(text);
  if (!raw) return [];
  const gaps = [];
  const push = (gap = {}) => gaps.push(normalizeCapabilityGap({ agent_name: label, ...gap }));

  const toolMatch = raw.match(/Tool ['"]?([a-zA-Z0-9_.-]+)['"]? not found/i);
  if (toolMatch) {
    const classified = classifyToolishId(toolMatch[1]);
    push({
      kind: classified.kind === 'capability' ? 'missing_capability' : 'missing_external_tool',
      severity: 'blocking',
      capability_id: classified.kind === 'capability' ? classified.canonical_id : undefined,
      external_tool_id: classified.kind === 'external_tool' ? classified.canonical_id : undefined,
      tool_id: classified.raw,
      detail: `${classified.raw} 실행 조건이 없어 작업을 완료하지 못했습니다.`,
      suggested_action: inferToolSuggestion(classified.raw, classified.canonical_id),
    });
  }

  const credentialKey = findExplicitCredentialRequest(raw);
  if (credentialKey) {
    push({
      kind: 'missing_credential',
      severity: 'blocking',
      credential_key: credentialKey,
      detail: '외부 API 자격 증명이 필요합니다.',
      suggested_action: '사용 가능한 API 키 또는 환경 변수를 제공해 주세요.',
    });
  }

  return normalizeCapabilityGapList(gaps);
}

export function detectCapabilityGapsFromExecution(executionLike = {}) {
  const rows = [];
  for (const output of asArray(executionLike?.outputs)) {
    rows.push(...detectCapabilityGapsFromText(output?.output || output?.text || output?.summary || '', {
      label: clean(output?.agentId || output?.agent || 'agent') || 'agent',
    }));
  }
  for (const result of asArray(executionLike?.results)) {
    rows.push(...detectCapabilityGapsFromText(result?.note || result?.error || result?.reason || '', {
      label: clean(result?.label || result?.agent || result?.agentId || 'step') || 'step',
    }));
  }
  return normalizeCapabilityGapList(rows);
}

export function detectTeamCapabilityGaps({ team = {}, runtime = null, skillRegistry = null } = {}) {
  const availableCapabilities = collectEffectiveAvailableCapabilityIds(runtime);
  const availableExternalTools = collectEffectiveAvailableExternalToolIds(runtime, runtime);
  const gaps = [];
  const push = (gap = {}) => gaps.push(normalizeCapabilityGap(gap));

  for (const agent of asArray(team?.agents)) {
    const participant = normalizeParticipantExecutionSchema(agent);
    const agentName = clean(agent?.name || agent?.agent_id || 'agent') || 'agent';
    const requiredCapabilities = participant.runtime_capabilities_required;
    const optionalCapabilities = participant.runtime_capabilities_optional;
    const requiredExternalTools = participant.external_tool_requirements;
    const optionalExternalTools = participant.external_tool_preferences;

    for (const capabilityId of requiredCapabilities) {
      if (availableCapabilities.has(capabilityId)) continue;
      push({
        kind: 'missing_capability',
        severity: 'blocking',
        agent_name: agentName,
        capability_id: capabilityId,
        tool_id: toLegacyRuntimeCapabilityId(capabilityId),
        detail: `${agentName}에 필수 capability ${capabilityId} 가 현재 runtime에 없습니다.`,
        suggested_action: inferToolSuggestion(toLegacyRuntimeCapabilityId(capabilityId), capabilityId),
      });
    }
    for (const capabilityId of optionalCapabilities) {
      if (availableCapabilities.has(capabilityId)) continue;
      push({
        kind: 'missing_capability',
        severity: 'advisory',
        agent_name: agentName,
        capability_id: capabilityId,
        tool_id: toLegacyRuntimeCapabilityId(capabilityId),
        detail: `${agentName}에 선호 capability ${capabilityId} 가 현재 runtime에 없습니다.`,
        suggested_action: inferToolSuggestion(toLegacyRuntimeCapabilityId(capabilityId), capabilityId),
      });
    }
    for (const toolId of requiredExternalTools) {
      if (availableExternalTools.has(toolId)) continue;
      push({
        kind: 'missing_external_tool',
        severity: 'blocking',
        agent_name: agentName,
        external_tool_id: toolId,
        tool_id: toolId,
        detail: `${agentName}에 필수 external tool ${toolId} 이 현재 runtime에 없습니다.`,
        suggested_action: inferToolSuggestion(toolId),
      });
    }
    for (const toolId of optionalExternalTools) {
      if (availableExternalTools.has(toolId)) continue;
      push({
        kind: 'missing_external_tool',
        severity: 'advisory',
        agent_name: agentName,
        external_tool_id: toolId,
        tool_id: toolId,
        detail: `${agentName}에 선호 external tool ${toolId} 이 현재 runtime에 없습니다.`,
        suggested_action: inferToolSuggestion(toolId),
      });
    }
    for (const skillId of uniqueIds(participant.skill_package.skill_ids || [], { max: 12 })) {
      const skill = skillRegistry?.resolve?.(skillId);
      const requiredFromSkill = mergeUniqueIds(skill?.required_tools || [], ...(skill?.required_runtime_capabilities || []), ...(skill?.required_external_tools || []));
      for (const toolId of requiredFromSkill) {
        const classified = classifyToolishId(toolId);
        if (classified.kind === 'capability') {
          if (availableCapabilities.has(classified.canonical_id)) continue;
          push({
            kind: 'missing_capability',
            severity: 'blocking',
            agent_name: agentName,
            capability_id: classified.canonical_id,
            tool_id: classified.legacy_id || classified.raw,
            skill_id: skillId,
            detail: `${agentName}의 실행 skill ${skillId} 에 ${classified.canonical_id} capability가 필요합니다.`,
            suggested_action: inferToolSuggestion(classified.legacy_id || classified.raw, classified.canonical_id),
          });
          continue;
        }
        if (availableExternalTools.has(classified.canonical_id)) continue;
        push({
          kind: 'missing_external_tool',
          severity: 'blocking',
          agent_name: agentName,
          external_tool_id: classified.canonical_id,
          tool_id: classified.canonical_id,
          skill_id: skillId,
          detail: `${agentName}의 실행 skill ${skillId} 에 ${classified.canonical_id} external tool이 필요합니다.`,
          suggested_action: inferToolSuggestion(classified.canonical_id),
        });
      }
    }
  }

  return normalizeCapabilityGapList(gaps);
}

export function formatCapabilityGapLines(gaps = [], { maxLines = 4 } = {}) {
  return normalizeCapabilityGapList(gaps)
    .slice(0, Math.max(1, Number(maxLines) || 4))
    .map((gap) => {
      if (gap.kind === 'missing_credential') {
        const key = gap.credential_key || 'API_KEY';
        return `- ${gap.agent_name}: 외부 자격 증명(${key})이 필요합니다. ${gap.suggested_action}`;
      }
      const canonicalKind = gap.canonical_kind || gap.kind;
      if (canonicalKind === 'missing_capability') {
        const capability = gap.capability_id || gap.tool_id || 'capability';
        const legacyTool = gap.tool_id && gap.tool_id !== capability ? ` (${gap.tool_id})` : '';
        const qualifier = String(gap.severity || '').trim().toLowerCase() === 'blocking' ? '필수' : '선호';
        return `- ${gap.agent_name}: ${qualifier} capability ${capability}${legacyTool} 가 부족합니다. ${gap.suggested_action}`;
      }
      if (canonicalKind === 'missing_external_tool' || gap.legacy_kind === legacyGapKind) {
        const toolId = gap.external_tool_id || gap.tool_id || 'tool';
        const qualifier = String(gap.severity || '').trim().toLowerCase() === 'blocking' ? '필수' : '선호';
        return `- ${gap.agent_name}: ${qualifier} external tool ${toolId} 이 부족합니다. ${gap.suggested_action}`;
      }
      return `- ${gap.agent_name}: ${gap.detail || '필요한 실행 조건이 부족합니다.'}`;
    });
}
