function asArray(v){return Array.isArray(v)?v:[]}
function asObject(v){return v&&typeof v==='object'?v:{}}
function clean(v=''){return String(v||'').trim()}
function cleanId(v=''){return clean(v).toLowerCase()}
function uniq(list=[]){const out=[];const seen=new Set();for(const raw of asArray(list)){const v=clean(raw);if(!v||seen.has(v))continue;seen.add(v);out.push(v);}return out;}

export function defaultInteractionPolicies(){
  return {
    reviewer_visibility: 'summaries_plus_selected_evidence',
    synthesizer_visibility: 'upstream_outputs_only',
    builder_direct_response: false,
    require_reviewer_before_final: true,
  };
}

export function buildDefaultInteractionSpec(agents = [], { task = '' } = {}) {
  const rows = asArray(agents);
  const byRole = new Map();
  for (const row of rows) {
    const roleId = cleanId(row.role || row.role_id || row.roleId || row.role_label || row.roleLabel);
    if (!roleId) continue;
    if (!byRole.has(roleId)) byRole.set(roleId, []);
    byRole.get(roleId).push(row);
  }
  const researchers = asArray(byRole.get('researcher'));
  const builders = asArray(byRole.get('builder'));
  const reviewers = asArray(byRole.get('reviewer'));
  const synthesizers = asArray(byRole.get('synthesizer'));
  const operators = asArray(byRole.get('operator'));
  const policies = defaultInteractionPolicies();
  let executionPattern = 'single_specialist';
  const handoffs = [];
  let finalOwner = clean(researchers[0]?.name || researchers[0]?.display_name || researchers[0]?.agent_id || builders[0]?.agent_id || '');

  const debateMode = hasDebateSignals(task) || researchers.some((row) => /반대|counter|skeptic|devil|adversarial/i.test(`${agentDisplayName(row)} ${clean(row?.purpose || '')}`));

  if (debateMode && researchers.length >= 2 && reviewers.length > 0 && synthesizers.length > 0) {
    executionPattern = 'multi_research_adjudication';
    const lead = researchers[0];
    const counter = researchers.find((row) => row !== lead && /반대|counter|skeptic|devil|adversarial/i.test(`${agentDisplayName(row)} ${clean(row?.purpose || '')}`)) || researchers[1];
    handoffs.push({ from: agentDisplayName(lead), to: agentDisplayName(counter), payload: 'claim_plus_supporting_evidence' });
    for (const row of researchers) {
      handoffs.push({ from: agentDisplayName(row), to: agentDisplayName(reviewers[0]), payload: row === counter ? 'counterargument_plus_risks' : 'summary_plus_key_evidence' });
    }
    handoffs.push({ from: agentDisplayName(reviewers[0]), to: agentDisplayName(synthesizers[0]), payload: 'review_summary_only' });
    finalOwner = agentDisplayName(synthesizers[0]);
  } else if (researchers.length >= 2 && reviewers.length > 0 && synthesizers.length > 0) {
    executionPattern = 'parallel_research_then_review_then_synthesize';
    for (const row of researchers) {
      handoffs.push({ from: agentDisplayName(row), to: agentDisplayName(reviewers[0]), payload: 'summary_plus_key_evidence' });
    }
    handoffs.push({ from: agentDisplayName(reviewers[0]), to: agentDisplayName(synthesizers[0]), payload: 'review_summary_only' });
    finalOwner = agentDisplayName(synthesizers[0]);
  } else if (builders.length > 0 && reviewers.length > 0) {
    executionPattern = 'builder_reviewer_loop';
    handoffs.push({ from: agentDisplayName(builders[0]), to: agentDisplayName(reviewers[0]), payload: 'draft_plus_change_summary' });
    if (synthesizers.length > 0) {
      handoffs.push({ from: agentDisplayName(reviewers[0]), to: agentDisplayName(synthesizers[0]), payload: 'approved_summary_only' });
      finalOwner = agentDisplayName(synthesizers[0]);
    } else {
      finalOwner = agentDisplayName(reviewers[0]);
    }
  } else if (researchers.length > 0 && reviewers.length > 0 && synthesizers.length > 0) {
    executionPattern = 'sequential_pipeline';
    handoffs.push({ from: agentDisplayName(researchers[0]), to: agentDisplayName(reviewers[0]), payload: 'summary_plus_key_evidence' });
    handoffs.push({ from: agentDisplayName(reviewers[0]), to: agentDisplayName(synthesizers[0]), payload: 'review_summary_only' });
    finalOwner = agentDisplayName(synthesizers[0]);
  } else if (operators.length > 0) {
    executionPattern = 'operator_gated_workflow';
    finalOwner = agentDisplayName(operators[0]);
  } else if (rows.length > 0) {
    executionPattern = rows.length > 1 ? 'sequential_pipeline' : 'single_specialist';
    finalOwner = agentDisplayName(rows[rows.length - 1]);
  }

  return normalizeInteractionSpec({
    execution_pattern: executionPattern,
    final_answer_owner: finalOwner,
    handoffs,
    policies,
    selection_reason: clean(task) ? `Derived from task: ${clean(task).slice(0, 160)}` : 'Default interaction policy',
  });
}

function agentDisplayName(row = {}) {
  return clean(row.name || row.display_name || row.displayLabel || row.display_label || row.agent_id || row.agentId || row.id || row.role || 'Agent');
}

function hasDebateSignals(text = '') {
  return /반대\s*의견|반론|토론|토의|논쟁|debate|counter(?:-?| )argument|devil'?s advocate|adversarial|skeptic/i.test(clean(text));
}

export function normalizeInteractionSpec(raw = {}) {
  const row = asObject(raw);
  const policies = { ...defaultInteractionPolicies(), ...asObject(row.policies) };
  return {
    execution_pattern: cleanId(row.execution_pattern || row.executionPattern || 'single_specialist') || 'single_specialist',
    final_answer_owner: clean(row.final_answer_owner || row.finalAnswerOwner),
    handoffs: asArray(row.handoffs).map((entry) => ({
      from: clean(entry?.from),
      to: clean(entry?.to),
      payload: cleanId(entry?.payload || 'summary_only') || 'summary_only',
    })).filter((entry) => entry.from && entry.to),
    policies: {
      reviewer_visibility: cleanId(policies.reviewer_visibility || 'summaries_plus_selected_evidence'),
      synthesizer_visibility: cleanId(policies.synthesizer_visibility || 'upstream_outputs_only'),
      builder_direct_response: policies.builder_direct_response === true,
      require_reviewer_before_final: policies.require_reviewer_before_final !== false,
    },
    selection_reason: clean(row.selection_reason || row.selectionReason),
  };
}

export function validateInteractionSpec(raw = {}, { agentRoster = [] } = {}) {
  const spec = normalizeInteractionSpec(raw);
  const rosterNames = new Set(asArray(agentRoster).map(agentDisplayName).filter(Boolean));
  const allowedPatterns = new Set([
    'single_specialist', 'sequential_pipeline', 'parallel_research_then_review_then_synthesize',
    'builder_reviewer_loop', 'multi_research_adjudication', 'operator_gated_workflow'
  ]);
  if (!allowedPatterns.has(spec.execution_pattern)) {
    throw new Error(`unsupported execution_pattern: ${spec.execution_pattern}`);
  }
  for (const handoff of spec.handoffs) {
    if (rosterNames.size > 0 && !rosterNames.has(handoff.from)) throw new Error(`unknown handoff from: ${handoff.from}`);
    if (rosterNames.size > 0 && !rosterNames.has(handoff.to)) throw new Error(`unknown handoff to: ${handoff.to}`);
  }
  if (spec.final_answer_owner && rosterNames.size > 0 && !rosterNames.has(spec.final_answer_owner)) {
    throw new Error(`unknown final_answer_owner: ${spec.final_answer_owner}`);
  }
  return spec;
}

export function parseNaturalLanguageInteractionPatch(instruction = '', { current = null, agentRoster = [] } = {}) {
  const text = clean(instruction).toLowerCase();
  const base = normalizeInteractionSpec(current || buildDefaultInteractionSpec(agentRoster));
  const next = JSON.parse(JSON.stringify(base));
  if (/병렬|parallel/.test(text)) next.execution_pattern = 'parallel_research_then_review_then_synthesize';
  if (hasDebateSignals(text)) next.execution_pattern = 'multi_research_adjudication';
  if (/순차|pipeline|sequential/.test(text)) next.execution_pattern = 'sequential_pipeline';
  if (/builder.*reviewer.*loop|수정.*검토.*반복/.test(text)) next.execution_pattern = 'builder_reviewer_loop';
  if (/reviewer.*raw.*못\s*보|reviewer.*summary\s*only|reviewer.*summary만/.test(text)) {
    next.policies.reviewer_visibility = 'summary_only';
  }
  if (/synthesizer.*raw.*못\s*보|synthesizer.*upstream/.test(text)) {
    next.policies.synthesizer_visibility = 'upstream_outputs_only';
  }
  if (/builder.*최종.*답.*못|builder.*direct.*response.*false/.test(text)) {
    next.policies.builder_direct_response = false;
  }
  if (/builder.*최종.*답.*가능|builder.*direct.*response.*true/.test(text)) {
    next.policies.builder_direct_response = true;
  }
  if (/reviewer.*필수|reviewer.*승인/.test(text)) next.policies.require_reviewer_before_final = true;
  const ownerMatch = instruction.match(/(final answer owner|최종\s*응답\s*담당|final owner)\s*[:=]?\s*([A-Za-z0-9 _-]+)/i);
  if (ownerMatch?.[2]) next.final_answer_owner = clean(ownerMatch[2]);
  return normalizeInteractionSpec(next);
}

export function buildInteractionSummaryLines(spec = {}) {
  const row = normalizeInteractionSpec(spec);
  const lines = [
    `execution_pattern=${row.execution_pattern}`,
    `final_answer_owner=${row.final_answer_owner || '(unset)'}`,
    `reviewer_visibility=${row.policies.reviewer_visibility}`,
    `synthesizer_visibility=${row.policies.synthesizer_visibility}`,
    `builder_direct_response=${row.policies.builder_direct_response ? 'true' : 'false'}`,
  ];
  for (const handoff of row.handoffs.slice(0, 6)) lines.push(`handoff: ${handoff.from} -> ${handoff.to} (${handoff.payload})`);
  return lines;
}

export function buildRouterInteractionContract(spec = {}) {
  const row = normalizeInteractionSpec(spec);
  return {
    execution_pattern: row.execution_pattern,
    final_answer_owner: row.final_answer_owner,
    handoffs: row.handoffs,
    policies: row.policies,
  };
}

export function buildAgentLocalInteractionContract(spec = {}, agentName = '') {
  const row = normalizeInteractionSpec(spec);
  const target = clean(agentName);
  const incoming = row.handoffs.filter((entry) => entry.to === target);
  const outgoing = row.handoffs.filter((entry) => entry.from === target);
  return {
    execution_pattern: row.execution_pattern,
    final_answer_owner: row.final_answer_owner,
    can_answer_user_directly: row.final_answer_owner ? row.final_answer_owner === target : true,
    require_reviewer_before_final: row.policies.require_reviewer_before_final === true,
    incoming_handoffs: incoming,
    outgoing_handoffs: outgoing,
    reviewer_visibility: row.policies.reviewer_visibility,
    synthesizer_visibility: row.policies.synthesizer_visibility,
    builder_direct_response: row.policies.builder_direct_response === true,
  };
}
