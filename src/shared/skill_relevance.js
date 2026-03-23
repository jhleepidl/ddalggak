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

function buildHaystack(text = '', taskInterpretation = {}) {
  return [
    clean(text),
    clean(taskInterpretation?.task_summary || taskInterpretation?.goal || ''),
    ...asArray(taskInterpretation?.domain_hints || []),
    ...asArray(taskInterpretation?.preferred_domains || []),
  ].filter(Boolean).join('\n').toLowerCase();
}

function includesAny(haystack = '', terms = []) {
  return asArray(terms).some((term) => {
    const normalized = cleanId(term);
    return normalized && haystack.includes(normalized);
  });
}

function extractSkillSignals(skill = {}) {
  return uniqueIds([
    ...(skill?.capability_tags || []),
    ...(skill?.tags || []),
    ...(skill?.trigger_terms || []),
    skill?.category,
    skill?.description,
    skill?.name,
    skill?.title,
    skill?.slug,
  ]);
}

export function requiresExplicitDomainMatch(skill = {}) {
  const skillId = cleanId(skill?.id || skill?.skill_id || '');
  if (skillId === 'skill.kr_equity_analysis.v1') return true;
  const category = cleanId(skill?.category || '');
  const signals = extractSkillSignals(skill);
  return [
    'finance',
    'legal',
    'medical',
    'biotech',
    'security',
    'compliance',
  ].includes(category) || signals.some((entry) => /equity|valuation|financial|securities|legal|contract|medical|clinical|biotech|malware|vuln|security/.test(entry));
}

export function isKrEquityRequest(text = '', taskInterpretation = {}) {
  const haystack = buildHaystack(text, taskInterpretation);
  if (!haystack) return false;
  const explicitKrFinance = /(?:한국|국내|korea(?:n)?|kr\b).{0,24}(?:주식|증시|종목|투자|equity|stock|valuation|financial|earnings|filing|공시|실적)|(?:주식|증시|종목|투자|equity|stock|valuation|financial|earnings|filing|공시|실적).{0,24}(?:한국|국내|korea(?:n)?|kr\b)/i;
  const strongKrMarket = /kospi|kosdaq|코스피|코스닥|dart|전자공시|kr equity|한국\s*주식|국내\s*주식/i;
  return explicitKrFinance.test(haystack) || strongKrMarket.test(haystack);
}

export function hasExplicitSkillDomainMatch({ skill = {}, skillId = '', text = '', taskInterpretation = {} } = {}) {
  const resolvedSkillId = cleanId(skillId || skill?.id || skill?.skill_id || '');
  const haystack = buildHaystack(text, taskInterpretation);
  if (!haystack) return false;

  if (resolvedSkillId === 'skill.kr_equity_analysis.v1') {
    return isKrEquityRequest(haystack, taskInterpretation);
  }
  if (resolvedSkillId === 'skill.claim_evidence_audit.v1') {
    return /claim|evidence|citation|fact|support|contradiction|근거|출처|주장|검증|모순/.test(haystack);
  }
  if (resolvedSkillId === 'skill.context_selection_policy.v1') {
    return /context|scope|grant|memory|selection|문맥|스코프|그랜트|메모리/.test(haystack);
  }
  if (resolvedSkillId === 'skill.thread_team_reconciliation.v1') {
    return /team|agent|membership|reconciliation|apply|refine|handoff|coord|멤버십|동기화|팀/.test(haystack);
  }
  if (resolvedSkillId === 'skill.telegram_briefing.v1') {
    return /telegram|brief|summary|요약|브리핑|메시지|chat/.test(haystack);
  }
  if (resolvedSkillId === 'skill.run_trace_debugging.v1') {
    return /debug|trace|stalled|queued|reroute|run|실행|큐|로그|오류|버그/.test(haystack);
  }
  if (resolvedSkillId === 'skill.deep_research_workflow.v1') {
    return /deep research|literature|survey|evidence map|briefing|source cluster|논문|문헌|브리핑|출처 맵/.test(haystack);
  }

  if (!requiresExplicitDomainMatch(skill)) return true;

  const category = cleanId(skill?.category || '');
  if (category === 'finance') {
    return /finance|financial|stock|equity|valuation|earnings|securities|invest|투자|증시|주식|밸류|실적|공시/.test(haystack);
  }
  if (category === 'legal' || category === 'compliance') {
    return /legal|law|contract|regulation|compliance|법률|계약|규제|준법/.test(haystack);
  }
  if (category === 'medical') {
    return /medical|clinical|patient|diagnos|treatment|의료|임상|환자|진단|치료/.test(haystack);
  }
  if (category === 'biotech') {
    return /biotech|bio|clinical|drug|genomics|바이오|임상|신약|유전체/.test(haystack);
  }
  if (category === 'security') {
    return /security|vulnerability|malware|exploit|취약점|보안|악성코드/.test(haystack);
  }

  const signals = extractSkillSignals(skill);
  return includesAny(haystack, signals);
}
