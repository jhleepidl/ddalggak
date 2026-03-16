function normalizeText(raw = '', { lower = false } = {}) {
  const value = String(raw || '').trim();
  return lower ? value.toLowerCase() : value;
}

function asArray(raw) {
  return Array.isArray(raw) ? raw : [];
}

const ROLE_LABELS = {
  researcher: 'Researcher',
  builder: 'Builder',
  reviewer: 'Reviewer',
  synthesizer: 'Synthesizer',
  operator: 'Operator',
  supervisor: 'Supervisor',
};

function canonicalRoleDisplayName(roleId = '') {
  const clean = normalizeText(roleId, { lower: true });
  return ROLE_LABELS[clean] || (clean ? clean.replace(/[._-]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()) : 'Runtime Agent');
}

export function isGenericRuntimeDisplayLabel(label = '', roleId = '') {
  const cleanLabel = normalizeText(label, { lower: true });
  const cleanRole = normalizeText(roleId, { lower: true });
  if (!cleanLabel) return true;
  if (!cleanRole) return false;
  if (cleanLabel === cleanRole) return true;
  if (cleanLabel === canonicalRoleDisplayName(cleanRole).toLowerCase()) return true;
  return false;
}

function collectTextParts({
  purpose = '',
  deliverableType = '',
  taskSummary = '',
  domainHints = [],
  requiredSkillIds = [],
  preferredSkillIds = [],
  requiredContextTypes = [],
  attachedSkillIds = [],
  personalityProfile = null,
  collaborationDefaults = null,
} = {}) {
  return [
    normalizeText(purpose, { lower: true }),
    normalizeText(deliverableType, { lower: true }),
    normalizeText(taskSummary, { lower: true }),
    ...asArray(domainHints).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(requiredSkillIds).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(preferredSkillIds).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(requiredContextTypes).map((entry) => normalizeText(entry, { lower: true })),
    ...asArray(attachedSkillIds).map((entry) => normalizeText(entry, { lower: true })),
    normalizeText(personalityProfile?.stance, { lower: true }),
    normalizeText(personalityProfile?.critique_style, { lower: true }),
    normalizeText(collaborationDefaults?.preferred_pattern, { lower: true }),
  ].filter(Boolean).join(' ');
}

function hasAny(text = '', patterns = []) {
  return patterns.some((pattern) => text.includes(pattern));
}

export function inferRuntimeDisplayLabel({
  roleId = '',
  currentLabel = '',
  purpose = '',
  deliverableType = '',
  taskSummary = '',
  domainHints = [],
  requiredSkillIds = [],
  preferredSkillIds = [],
  requiredContextTypes = [],
  attachedSkillIds = [],
  personalityProfile = null,
  collaborationDefaults = null,
  presetDisplayName = '',
} = {}) {
  const cleanRole = normalizeText(roleId, { lower: true });
  const presetName = normalizeText(presetDisplayName);
  if (presetName) return presetName;
  const existing = normalizeText(currentLabel);
  if (existing && !isGenericRuntimeDisplayLabel(existing, cleanRole)) return existing;

  const text = collectTextParts({
    purpose,
    deliverableType,
    taskSummary,
    domainHints,
    requiredSkillIds,
    preferredSkillIds,
    requiredContextTypes,
    attachedSkillIds,
    personalityProfile,
    collaborationDefaults,
  });
  const contextSet = new Set(asArray(requiredContextTypes).map((entry) => normalizeText(entry, { lower: true })).filter(Boolean));

  const hasAny = (patterns = []) => patterns.some((pattern) => text.includes(pattern));
  const skeptical = hasAny(['skeptical', 'adversarial', 'aggressive_but_grounded']);
  const investment = hasAny(['investment', 'equity', 'portfolio', 'market', 'stock', 'filing', 'dart']);
  const news = contextSet.has('news') || hasAny(['news', 'headline', 'briefing', 'market']);
  const filings = contextSet.has('filings') || hasAny(['filing', 'dart', '10-k', '10q', '공시']);
  const evidence = contextSet.has('citations') || contextSet.has('evidence') || hasAny(['evidence', 'citation', 'claim', 'validate', 'fact', 'support']);
  const code = contextSet.has('workspace') || contextSet.has('patch_plan') || hasAny(['code', 'patch', 'implementation', 'workspace', 'repo', 'artifact changes', 'refactor', 'script', 'python', 'javascript']);
  const regression = contextSet.has('tests') || hasAny(['regression', 'test', 'qa']);
  const workflow = contextSet.has('workflow') || contextSet.has('run_state') || hasAny(['workflow', 'runtime state', 'tool-heavy', 'coord']);
  const brief = hasAny(['brief', 'telegram_briefing']);
  const report = contextSet.has('aggregation') || hasAny(['report', 'final output', 'assemble upstream', 'synthesis']);
  const contradiction = contextSet.has('contradictions') || contextSet.has('risk') || hasAny(['contradiction', 'risk']);
  const explicitPatch = hasAny(['patch', 'refactor', 'modify existing', 'edit existing']);

  if (cleanRole === 'researcher') {
    if (news && !filings) return investment ? 'Market News Researcher' : 'News Researcher';
    if (filings) return investment ? 'DART Financial Researcher' : 'Filing Researcher';
    if (evidence) return investment ? 'Investment Evidence Researcher' : 'Evidence Researcher';
    if (investment) return 'Investment Researcher';
    if (code) return 'Implementation Researcher';
    return 'Task Researcher';
  }

  if (cleanRole === 'reviewer') {
    if ((skeptical || hasAny(['stress-test', 'stress test'])) && (evidence || contradiction)) {
      return evidence ? 'Skeptical Claim Reviewer' : 'Skeptical Risk Reviewer';
    }
    if (regression && code) return 'Implementation Reviewer';
    if (evidence) return investment ? 'Investment Claim Reviewer' : 'Claim Reviewer';
    if (contradiction) return investment ? 'Investment Risk Reviewer' : 'Risk Reviewer';
    if (code) return 'Implementation Reviewer';
    if (skeptical) return 'Skeptical Reviewer';
    return 'Reviewer';
  }

  if (cleanRole === 'builder') {
    if (hasAny(['notebook', 'ipynb', 'jupyter'])) return 'Notebook Builder';
    if (explicitPatch) return 'Patch Builder';
    if (code) return 'Implementation Builder';
    return 'Builder';
  }

  if (cleanRole === 'synthesizer') {
    if (investment && report) return 'Investment Memo Synthesizer';
    if (investment && brief) return 'Investment Brief Synthesizer';
    if (brief) return 'Briefing Synthesizer';
    if (report) return 'Report Synthesizer';
    if (code) return 'Implementation Synthesizer';
    return 'Synthesizer';
  }

  if (cleanRole === 'operator') {
    if (workflow) return 'Workflow Operator';
    return 'Operator';
  }

  if (cleanRole === 'supervisor') {
    return 'Supervisor Runtime';
  }

  if (!cleanRole) {
    if (code) return explicitPatch ? 'Patch Agent' : 'Implementation Agent';
    if (report) return investment ? 'Investment Report Agent' : 'Report Agent';
    if (evidence || contradiction) return skeptical ? 'Skeptical Review Agent' : 'Review Agent';
    if (news || filings || investment) return investment ? 'Investment Research Agent' : 'Research Agent';
    if (workflow) return 'Workflow Agent';
  }

  return existing || canonicalRoleDisplayName(cleanRole) || 'Runtime Agent';
}
