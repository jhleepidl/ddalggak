import { classifyToolishId, normalizeRuntimeCapabilityId, toLegacyRuntimeCapabilityId } from './participant_schema.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function cleanId(value = '') {
  return clean(value).toLowerCase();
}

function uniqueRows(rows = [], keyFn = (row) => JSON.stringify(row), { max = 24 } = {}) {
  const out = [];
  const seen = new Set();
  for (const row of asArray(rows)) {
    const key = String(keyFn(row) || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeCapabilityRequirement(raw = {}) {
  const row = asObject(raw);
  const capabilityId = cleanId(row.capability_id || row.capabilityId || normalizeRuntimeCapabilityId(row.tool_id || row.toolId || row.id || row.tool));
  return {
    capability_id: capabilityId,
    tool_id: cleanId(row.tool_id || row.toolId || toLegacyRuntimeCapabilityId(capabilityId)),
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    reason: clean(row.reason || row.detail || row.note || ''),
    source_kind: cleanId(row.source_kind || row.sourceKind || row.kind || 'missing_capability') || 'missing_capability',
  };
}

function normalizeExternalToolRequirement(raw = {}) {
  const row = asObject(raw);
  const toolId = cleanId(row.external_tool_id || row.externalToolId || row.tool_id || row.toolId || row.id || row.tool);
  return {
    external_tool_id: toolId,
    tool_id: toolId,
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    reason: clean(row.reason || row.detail || row.note || ''),
    source_kind: cleanId(row.source_kind || row.sourceKind || row.kind || 'missing_external_tool') || 'missing_external_tool',
  };
}

function normalizeCredentialRequirement(raw = {}) {
  const row = asObject(raw);
  return {
    credential_key: clean(row.credential_key || row.credentialKey || row.key || 'API_KEY') || 'API_KEY',
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    reason: clean(row.reason || row.detail || row.note || ''),
    source_kind: cleanId(row.source_kind || row.sourceKind || row.kind || 'missing_credential') || 'missing_credential',
  };
}

function normalizeSkillRequirement(raw = {}) {
  const row = asObject(raw);
  return {
    skill_id: cleanId(row.skill_id || row.skillId || row.id || row.skill),
    required_by: clean(row.required_by || row.requiredBy || row.agent_name || row.agentName || row.agent || row.label || 'agent') || 'agent',
    severity: cleanId(row.severity || 'blocking') || 'blocking',
    reason: clean(row.reason || row.detail || row.note || ''),
    source_kind: cleanId(row.source_kind || row.sourceKind || row.kind || 'missing_skill') || 'missing_skill',
  };
}

function buildLegacyToolRequirements(capabilities = [], externalTools = []) {
  return uniqueRows([
    ...capabilities.map((entry) => ({ ...entry, tool_id: entry.tool_id || toLegacyRuntimeCapabilityId(entry.capability_id) })),
    ...externalTools.map((entry) => ({ ...entry, tool_id: entry.tool_id || entry.external_tool_id })),
  ], (entry) => [entry.tool_id, entry.required_by, entry.severity, entry.source_kind].join('|'));
}

export function normalizeManifestRequirements(raw = {}) {
  const row = asObject(raw);
  const capabilities = uniqueRows(
    asArray(row.capabilities || row.runtime_capabilities || row.runtimeCapabilities)
      .map(normalizeCapabilityRequirement)
      .filter((entry) => entry.capability_id),
    (entry) => [entry.capability_id, entry.required_by, entry.severity, entry.source_kind].join('|'),
  );
  const externalTools = uniqueRows(
    asArray(row.external_tools || row.externalTools)
      .map(normalizeExternalToolRequirement)
      .filter((entry) => entry.external_tool_id),
    (entry) => [entry.external_tool_id, entry.required_by, entry.severity, entry.source_kind].join('|'),
  );
  const legacyTools = uniqueRows(
    asArray(row.tools)
      .flatMap((entry) => {
        const classified = classifyToolishId(entry?.tool_id || entry?.toolId || entry?.id || entry?.tool);
        return classified.kind === 'capability'
          ? [normalizeCapabilityRequirement(entry)]
          : [normalizeExternalToolRequirement(entry)];
      }),
    (entry) => [entry.capability_id || entry.external_tool_id, entry.required_by, entry.severity, entry.source_kind].join('|'),
  );
  const mergedCapabilities = uniqueRows([...capabilities, ...legacyTools.filter((entry) => entry.capability_id)], (entry) => [entry.capability_id, entry.required_by, entry.severity, entry.source_kind].join('|'));
  const mergedExternalTools = uniqueRows([...externalTools, ...legacyTools.filter((entry) => entry.external_tool_id)], (entry) => [entry.external_tool_id, entry.required_by, entry.severity, entry.source_kind].join('|'));
  const credentials = uniqueRows(
    asArray(row.credentials).map(normalizeCredentialRequirement).filter((entry) => entry.credential_key),
    (entry) => [entry.credential_key, entry.required_by, entry.severity, entry.source_kind].join('|'),
  );
  const skills = uniqueRows(
    asArray(row.skills).map(normalizeSkillRequirement).filter((entry) => entry.skill_id),
    (entry) => [entry.skill_id, entry.required_by, entry.severity, entry.source_kind].join('|'),
  );
  const warnings = uniqueRows(asArray(row.warnings).map((entry) => clean(entry)).filter(Boolean), (entry) => entry, { max: 12 });
  const install_hints = uniqueRows(asArray(row.install_hints || row.installHints).map((entry) => clean(entry)).filter(Boolean), (entry) => entry, { max: 12 });
  const tools = buildLegacyToolRequirements(mergedCapabilities, mergedExternalTools);
  return {
    capabilities: mergedCapabilities,
    external_tools: mergedExternalTools,
    tools,
    credentials,
    skills,
    warnings,
    install_hints,
    summary: {
      capability_count: mergedCapabilities.length,
      external_tool_count: mergedExternalTools.length,
      tool_count: tools.length,
      credential_count: credentials.length,
      skill_count: skills.length,
      warning_count: warnings.length,
      install_hint_count: install_hints.length,
    },
  };
}

export function buildManifestRequirements({ team = {}, capabilityGaps = [] } = {}) {
  const teamRow = asObject(team);
  const merged = {
    capabilities: [],
    external_tools: [],
    credentials: [],
    skills: [],
    warnings: [],
    install_hints: [],
  };

  const pushWarning = (value = '') => {
    const text = clean(value);
    if (text) merged.warnings.push(text);
  };

  const existing = normalizeManifestRequirements(teamRow.requirements || teamRow.requirement_summary || {});
  merged.capabilities.push(...existing.capabilities);
  merged.external_tools.push(...existing.external_tools);
  merged.credentials.push(...existing.credentials);
  merged.skills.push(...existing.skills);
  merged.warnings.push(...existing.warnings);
  merged.install_hints.push(...existing.install_hints);

  for (const rawGap of asArray(capabilityGaps.length > 0 ? capabilityGaps : (teamRow.capability_gaps || teamRow.capabilityGaps || []))) {
    const gap = asObject(rawGap);
    const kind = cleanId(gap.kind || gap.source_kind || '');
    if (kind === 'missing_capability') {
      merged.capabilities.push(normalizeCapabilityRequirement({
        ...gap,
        required_by: gap.agent_name || gap.agentName || gap.agent || gap.label,
        reason: gap.detail || gap.reason || gap.note,
        source_kind: kind,
      }));
      pushWarning(gap.detail || gap.reason || '');
      continue;
    }
    if (kind === 'missing_external_tool' || kind === 'missing_tool') {
      const classified = classifyToolishId(gap.tool_id || gap.toolId || gap.external_tool_id || gap.externalToolId);
      if (classified.kind === 'capability') {
        merged.capabilities.push(normalizeCapabilityRequirement({
          ...gap,
          capability_id: gap.capability_id || classified.canonical_id,
          tool_id: gap.tool_id || classified.legacy_id,
          required_by: gap.agent_name || gap.agentName || gap.agent || gap.label,
          reason: gap.detail || gap.reason || gap.note,
          source_kind: kind === 'missing_tool' ? 'missing_capability' : kind,
        }));
      } else {
        merged.external_tools.push(normalizeExternalToolRequirement({
          ...gap,
          external_tool_id: gap.external_tool_id || classified.canonical_id,
          tool_id: gap.tool_id || classified.canonical_id,
          required_by: gap.agent_name || gap.agentName || gap.agent || gap.label,
          reason: gap.detail || gap.reason || gap.note,
          source_kind: kind === 'missing_tool' ? 'missing_external_tool' : kind,
        }));
      }
      pushWarning(gap.detail || gap.reason || '');
      continue;
    }
    if (kind === 'missing_credential') {
      merged.credentials.push(normalizeCredentialRequirement({
        ...gap,
        required_by: gap.agent_name || gap.agentName || gap.agent || gap.label,
        reason: gap.detail || gap.reason || gap.note,
        source_kind: kind,
      }));
      pushWarning(gap.detail || gap.reason || '');
      continue;
    }
    if (kind === 'missing_skill') {
      merged.skills.push(normalizeSkillRequirement({
        ...gap,
        required_by: gap.agent_name || gap.agentName || gap.agent || gap.label,
        reason: gap.detail || gap.reason || gap.note,
        source_kind: kind,
      }));
      pushWarning(gap.detail || gap.reason || '');
    }
  }

  return normalizeManifestRequirements({
    ...merged,
    install_hints: merged.install_hints.length > 0
      ? merged.install_hints
      : buildManifestInstallHints(normalizeManifestRequirements(merged)),
  });
}

export function buildManifestInstallHints(requirements = {}, { hasGocThreadTarget = false } = {}) {
  const row = normalizeManifestRequirements(requirements);
  const hints = [];
  if (row.capabilities.some((entry) => entry.capability_id === 'filesystem_write')) {
    hints.push('파일·노트북 산출물이 필요하면 filesystem_write capability 또는 workspace write 권한을 runtime에 연결하세요.');
  }
  if (row.capabilities.some((entry) => entry.capability_id === 'web_browse')) {
    hints.push('검색형 작업이면 web browse capability가 runtime에 있는지 확인하거나, 해당 capability를 쓸 수 있는 agent로 팀을 refine 하세요.');
  }
  if (row.external_tools.some((entry) => /browser|search|retrieval|github|jira|slack|notion/.test(entry.external_tool_id))) {
    hints.push('browser/search/retrieval/MCP connector 등 필요한 external tool binding이 연결되어 있는지 확인하세요.');
  }
  if (row.credentials.length > 0) {
    const keys = row.credentials.map((entry) => entry.credential_key).filter(Boolean).slice(0, 3).join(', ');
    hints.push(`필요한 credential(${keys || 'API_KEY'})을 환경 변수나 안전한 비밀 저장소로 제공하세요.`);
  }
  if (row.summary.tool_count > 0 || row.summary.credential_count > 0 || row.summary.skill_count > 0) {
    hints.push('/team requirements 로 실행 전제조건을 다시 확인할 수 있습니다.');
    hints.push('/team export 로 blueprint JSON을 내보내 GoC에서 Validate/Install 할 수 있습니다. 이 단계는 주로 team metadata와 requirement를 동기화합니다.');
  }
  if (hasGocThreadTarget) hints.push('현재 GoC thread가 연결되어 있으면 /team push 로 thread team config에 바로 동기화할 수 있습니다.');
  return uniqueRows(hints, (entry) => entry, { max: 8 });
}

export function formatManifestRequirementLines(requirements = {}, { maxLines = 6 } = {}) {
  const row = normalizeManifestRequirements(requirements);
  const lines = [
    ...row.capabilities.map((entry) => `- capability: ${entry.capability_id} · by ${entry.required_by} · severity=${entry.severity || 'blocking'}`),
    ...row.external_tools.map((entry) => `- external tool: ${entry.external_tool_id} · by ${entry.required_by} · severity=${entry.severity || 'blocking'}`),
    ...row.credentials.map((entry) => `- credential: ${entry.credential_key} · by ${entry.required_by}`),
    ...row.skills.map((entry) => `- skill: ${entry.skill_id} · by ${entry.required_by}`),
    ...row.warnings.map((entry) => `- note: ${entry}`),
    ...row.install_hints.map((entry) => `- hint: ${entry}`),
  ].filter(Boolean);
  return lines.slice(0, Math.max(1, Number(maxLines) || 6));
}
