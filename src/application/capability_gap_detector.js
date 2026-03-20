function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

function uniqueIds(values = [], { max = 64 } = {}) {
  const out = [];
  const seen = new Set();
  for (const raw of asArray(values)) {
    const value = cleanId(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function collectAvailableToolIds(runtime = null) {
  const out = [];
  for (const row of asArray(runtime?.agentsCatalog)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  for (const row of asArray(runtime?.agents)) out.push(...asArray(row?.tools || row?.tool_ids || row?.toolIds));
  out.push(...asArray(runtime?.availableToolIds || runtime?.toolIds || runtime?.tool_ids));
  return new Set(uniqueIds(out, { max: 128 }));
}

function normalizeCapabilityGap(raw = {}) {
  const row = raw && typeof raw === 'object' ? raw : {};
  return {
    kind: cleanId(row.kind || 'missing_tool') || 'missing_tool',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    agent_name: clean(row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    tool_id: cleanId(row.tool_id || row.toolId || ''),
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
    const key = [gap.kind, gap.agent_name, gap.tool_id, gap.credential_key, gap.skill_id, gap.detail].join('|').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(gap);
  }
  return out.slice(0, 24);
}

function inferToolSuggestion(toolId = '') {
  if (/write_file|create_file|save_file|ipynb|workspace_fs/.test(toolId)) {
    return 'workspace_fs 도구 또는 파일 생성 helper를 연결한 뒤 다시 실행해 주세요.';
  }
  if (/web|browser|search/.test(toolId)) {
    return 'web/browser 계열 도구를 연결하거나 검색 가능한 에이전트로 재구성해 주세요.';
  }
  if (/shell|bash|terminal/.test(toolId)) {
    return 'shell/terminal 실행 권한이 필요합니다.';
  }
  return `${toolId} 도구 정의 또는 연결이 필요합니다.`;
}

export function detectCapabilityGapsFromText(text = '', { label = 'agent' } = {}) {
  const raw = clean(text);
  if (!raw) return [];
  const gaps = [];
  const push = (gap = {}) => {
    gaps.push(normalizeCapabilityGap({ agent_name: label, ...gap }));
  };

  const toolMatch = raw.match(/Tool ['"]?([a-zA-Z0-9_.-]+)['"]? not found/i);
  if (toolMatch) {
    const toolId = cleanId(toolMatch[1]);
    push({
      kind: 'missing_tool',
      severity: 'blocking',
      tool_id: toolId,
      detail: `${toolId} 도구가 없어 작업을 완료하지 못했습니다.`,
      suggested_action: inferToolSuggestion(toolId),
    });
  }

  const credentialMatch = raw.match(/\b([A-Z][A-Z0-9_]*API[_-]?KEY|OPENAI_API_KEY|GEMINI_API_KEY|ANTHROPIC_API_KEY)\b/);
  if (credentialMatch || /api[_ -]?key|credential|token required/i.test(raw)) {
    push({
      kind: 'missing_credential',
      severity: 'blocking',
      credential_key: clean(credentialMatch?.[1] || 'API_KEY'),
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
  const availableTools = collectAvailableToolIds(runtime);
  const gaps = [];
  const push = (gap = {}) => gaps.push(normalizeCapabilityGap(gap));

  for (const agent of asArray(team?.agents)) {
    const agentName = clean(agent?.name || agent?.agent_id || 'agent') || 'agent';
    const recommendedTools = uniqueIds(agent?.recommended_tool_ids || agent?.recommendedToolIds || []);
    for (const toolId of recommendedTools) {
      if (availableTools.has(toolId)) continue;
      push({
        kind: 'missing_tool',
        severity: /workspace_fs|write_file|create_file|save_file/.test(toolId) ? 'blocking' : 'advisory',
        agent_name: agentName,
        tool_id: toolId,
        detail: `${agentName}에 추천된 ${toolId} 도구가 현재 runtime에 없습니다.`,
        suggested_action: inferToolSuggestion(toolId),
      });
    }
    for (const skillId of uniqueIds(agent?.attached_skill_ids || agent?.attachedSkillIds || [])) {
      const skill = skillRegistry?.resolve?.(skillId);
      for (const toolId of uniqueIds(skill?.required_tools || [])) {
        if (availableTools.has(toolId)) continue;
        push({
          kind: 'missing_tool',
          severity: 'blocking',
          agent_name: agentName,
          tool_id: toolId,
          skill_id: skillId,
          detail: `${agentName}의 실행 skill ${skillId} 에 ${toolId} 도구가 필요합니다.`,
          suggested_action: inferToolSuggestion(toolId),
        });
      }
    }
    const codeLike = /ipynb|notebook|jupyter|file|json|python|script|workspace|코드|노트북|파일/.test(`${clean(agent?.purpose)} ${clean(agent?.name)}`.toLowerCase());
    if (cleanId(agent?.role) === 'builder' && codeLike && !availableTools.has('workspace_fs')) {
      push({
        kind: 'missing_tool',
        severity: 'blocking',
        agent_name: agentName,
        tool_id: 'workspace_fs',
        detail: `${agentName}는 파일/노트북 산출물을 만들 가능성이 높지만 workspace_fs 가 없습니다.`,
        suggested_action: inferToolSuggestion('workspace_fs'),
      });
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
      if (gap.kind === 'missing_tool') {
        const toolId = gap.tool_id || 'tool';
        return `- ${gap.agent_name}: ${toolId} 도구가 부족합니다. ${gap.suggested_action}`;
      }
      return `- ${gap.agent_name}: ${gap.detail || '필요한 실행 조건이 부족합니다.'}`;
    });
}
