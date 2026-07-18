import { cleanText } from './fs_utils.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clip(value = '', max = 6000) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max)}\n...[truncated]` : text;
}

function selectPriorStageResults(stage = {}, priorStageResults = []) {
  const policy = stage?.context_policy && typeof stage.context_policy === 'object' ? stage.context_policy : {};
  if (Array.isArray(policy.prior_stage_ids)) {
    const allowed = new Set(policy.prior_stage_ids.map((value) => cleanText(value)).filter(Boolean));
    return priorStageResults.filter((row) => allowed.has(cleanText(row?.stage_id)));
  }
  if (policy.mode === 'none') return [];
  return priorStageResults;
}

function formatReceipt(receipt = {}) {
  const row = asObject(receipt);
  if (!row.receipt_id) return '';
  const lines = [
    `receipt: ${row.receipt_id}`,
    `provider/status: ${row.provider || '-'} / ${row.status || '-'}`,
    `workspace revision: ${row.workspace?.revision_after || '-'}`,
    `file changes: ${asArray(row.workspace?.files_changed).length}`,
    `validations: ${asArray(row.reported?.validations).length}`,
    `artifacts: ${asArray(row.reported?.artifacts).length}`,
    `blockers: ${asArray(row.reported?.blocking_issues).length}`,
  ];
  return lines.join('\n');
}

function formatPriorStage(row = {}, detail = 'summary') {
  const structured = row?.structured && typeof row.structured === 'object' ? row.structured : {};
  const lines = [`### ${row.stage_id}`];
  const summary = structured.summary || row.summary || row.output_excerpt || '';
  if (summary) lines.push(`summary: ${clip(summary, detail === 'full' ? 2400 : 1200)}`);
  const receiptSummary = formatReceipt(row.receipt);
  if (receiptSummary) lines.push(receiptSummary);
  if (detail === 'full') {
    const decisions = asArray(structured.decisions);
    const blockers = asArray(structured.blocking_issues);
    const nextActions = asArray(structured.next_actions);
    const validations = asArray(structured.validations);
    const artifacts = asArray(structured.artifacts);
    if (decisions.length) lines.push('decisions:', ...decisions.map((item) => `- ${clip(item, 900)}`));
    if (blockers.length) lines.push('blocking issues:', ...blockers.map((item) => `- ${clip(item, 900)}`));
    if (nextActions.length) lines.push('next actions:', ...nextActions.map((item) => `- ${clip(item, 900)}`));
    if (validations.length) lines.push('reported validations:', ...validations.map((item) => `- ${clip(typeof item === 'string' ? item : `${item.name || item.command || 'validation'}: ${item.status || 'reported'} ${item.evidence || ''}`, 1200)}`));
    if (artifacts.length) lines.push('reported artifacts:', ...artifacts.map((item) => `- ${clip(typeof item === 'string' ? item : item.path || item.uri || item.location || '', 1200)}`));
    const visible = cleanText(row.visible_output || row.output_excerpt || '');
    if (visible && visible !== cleanText(summary)) lines.push(`provider-visible output:\n${clip(visible, 5000)}`);
  }
  return lines.join('\n');
}

function formatRoomContract(contract = {}, fallbackObjective = '') {
  const row = asObject(contract);
  const sources = asObject(row.sources);
  const completion = asArray(row.completion_contract);
  const constraints = asArray(row.constraints);
  const corrections = asArray(row.corrections).filter((item) => String(item?.status || 'active').toLowerCase() === 'active');
  const artifacts = asArray(row.requested_artifacts);
  return [
    `[ROOM CONTRACT]\nschema=${row.schema_version || 'ai_rooms.room_contract/v1'} revision=${row.contract_revision || '-'} hash=${row.contract_hash || '-'}`,
    `[ROOM GOAL]\n${clip(row.goal || fallbackObjective, 8000)}`,
    `[CURRENT OBJECTIVE]\n${clip(row.objective || fallbackObjective, 8000)}`,
    `[COMPLETION CONTRACT]\n${completion.length ? completion.map((item, index) => `${index + 1}. ${clip(item, 1800)}`).join('\n') : '- complete the objective and report validation or blockers'}`,
    `[ACTIVE CONSTRAINTS]\n${constraints.length ? constraints.map((item) => `- ${clip(item, 1800)}`).join('\n') : '- none'}`,
    `[AUTHORITATIVE SOURCES]\n${asArray(sources.authoritative).length ? asArray(sources.authoritative).map((item) => `- ${clip(item.label || item.uri || item.source_id || '', 1800)}`).join('\n') : '- none explicitly registered'}`,
    `[EXCLUDED SOURCES]\n${asArray(sources.excluded).length ? asArray(sources.excluded).map((item) => `- ${clip(item.label || item.uri || item.source_id || '', 1800)}`).join('\n') : '- none'}`,
    `[ACTIVE CORRECTIONS]\n${corrections.length ? corrections.map((item) => `- ${clip(item.text || '', 1800)}`).join('\n') : '- none'}`,
    `[REQUESTED ARTIFACTS]\n${artifacts.length ? artifacts.map((item) => `- ${clip(item.location || item.path || item.uri || '', 1800)}`).join('\n') : '- infer only artifacts necessary to complete the objective'}`,
    `[APPROVAL POLICY]\nmode=${row.approval_policy?.mode || 'bounded'}; require_for=${asArray(row.approval_policy?.require_for).join(', ') || 'none explicitly registered'}`,
  ].join('\n\n');
}

export function buildRoomStagePrompt({ spec = {}, stage = {}, workingMemory = {}, priorStageResults = [] } = {}) {
  const selectedPrior = selectPriorStageResults(stage, priorStageResults);
  const detail = stage?.context_policy?.detail === 'full' ? 'full' : 'summary';
  const prior = selectedPrior.map((row) => formatPriorStage(row, detail)).join('\n\n');
  const includeWorkingMemory = stage?.context_policy?.include_working_memory !== false;
  const blockers = includeWorkingMemory ? asArray(workingMemory.open_blockers) : [];
  const decisions = includeWorkingMemory ? asArray(workingMemory.decisions) : [];
  const nextActions = includeWorkingMemory ? asArray(workingMemory.next_actions) : [];
  const isFinalReporter = stage.kind === 'verify' || (spec.execution_graph?.collaboration_profile_id === 'solo' && stage.kind === 'execute');
  return [
    'You are an execution provider inside an AI Room control plane.',
    'Use your native planning, tools, skills, MCP servers, and internal delegation when useful. The Room does not need your private internal plan or chain-of-thought.',
    '',
    '[HARD BOUNDARY]',
    '- The provided working directory is the complete and only authorized project workspace for this Room.',
    '- Do not inspect, reference, or modify the ddalggak control-plane source tree or any parent/sibling directory.',
    '- Do not use absolute paths outside the working directory.',
    '- Do not create symlinks or request additional directories.',
    `- Workspace access for this stage: ${stage.access}.`,
    `- Required provider capabilities: ${asArray(stage.required_capabilities).join(', ') || 'none declared'}.`,
    '',
    formatRoomContract(spec.room_contract || {}, spec.objective),
    '',
    `[STAGE]\n${stage.stage_id} · kind=${stage.kind || '-'} · role=${stage.role} · provider=${stage.provider} · purpose=${stage.purpose}`,
    '',
    `[ACTIVE DECISIONS]\n${decisions.length ? decisions.map((item) => `- ${clip(item, 900)}`).join('\n') : '- none'}`,
    '',
    `[OPEN BLOCKERS]\n${blockers.length ? blockers.map((item) => `- ${clip(item, 900)}`).join('\n') : '- none'}`,
    '',
    `[CURRENT NEXT ACTIONS]\n${nextActions.length ? nextActions.map((item) => `- ${clip(item, 900)}`).join('\n') : '- none'}`,
    '',
    `[AUTHORIZED PRIOR STAGE CONTEXT]\n${prior || '- none (this stage is intentionally isolated from prior provider claims)'}`,
    '',
    '[OUTPUT CONTRACT]',
    stage.kind === 'revise' && blockers.length
      ? 'When you resolve an open blocker, copy its exact text into resolved_issues so the ledger can close it deterministically.'
      : 'Report only externally verifiable coordination facts and evidence.',
    isFinalReporter
      ? 'user_message must be a complete user-facing completion report including what changed, validation performed, and any remaining blocker.'
      : 'user_message may be empty unless this stage must communicate a blocking user decision.',
    'End with exactly one machine-readable block:',
    '<ROOM_STAGE_RESULT>',
    JSON.stringify({
      summary: 'externally verifiable stage summary',
      decisions: ['decision'],
      blocking_issues: ['exact blocker text'],
      resolved_issues: ['exact previously delivered blocker text'],
      next_actions: ['provider-neutral next action'],
      validations: [{ name: 'test or check', status: 'passed|failed|not_run', evidence: 'observable evidence' }],
      artifacts: [{ path: 'relative/path', kind: 'file|report|patch', description: 'artifact purpose' }],
      claims: [{ claim: 'externally verifiable claim', evidence: ['file, command, test, or source reference'] }],
      checkpoint: { next_action: 'what a different provider should do next', resume_notes: 'bounded state needed to resume' },
      user_message: 'complete user-facing report when required',
    }),
    '</ROOM_STAGE_RESULT>',
    'Do not include private chain-of-thought. Do not claim validation that was not actually performed.',
  ].join('\n');
}

function normalizeList(value, limit = 64) {
  return asArray(value).map((item) => cleanText(item)).filter(Boolean).slice(0, limit);
}

function normalizeObjects(value, normalizer, limit = 64) {
  return asArray(value).map((item, index) => normalizer(item, index)).filter(Boolean).slice(0, limit);
}

function normalizeValidation(value, index) {
  const row = typeof value === 'string' ? { name: value } : asObject(value);
  const name = cleanText(row.name || row.command || row.check || `validation-${index + 1}`);
  return name ? { name, status: cleanText(row.status || 'reported').toLowerCase(), evidence: cleanText(row.evidence || row.summary || row.output || '') } : null;
}

function normalizeArtifact(value, index) {
  const row = typeof value === 'string' ? { path: value } : asObject(value);
  const location = cleanText(row.path || row.uri || row.location || row.name || '');
  return location ? { path: location, kind: cleanText(row.kind || 'file').toLowerCase(), description: cleanText(row.description || '') } : null;
}

function normalizeClaim(value, index) {
  const row = typeof value === 'string' ? { claim: value } : asObject(value);
  const claim = cleanText(row.claim || row.text || row.summary || '');
  return claim ? { claim, evidence: normalizeList(row.evidence, 16), claim_id: cleanText(row.claim_id || row.id || `claim-${index + 1}`) } : null;
}

export function parseRoomStageResult(output = '') {
  const text = String(output || '').trim();
  const match = text.match(/<ROOM_STAGE_RESULT>\s*([\s\S]*?)\s*<\/ROOM_STAGE_RESULT>/i);
  let structured = null;
  if (match) {
    try { structured = JSON.parse(match[1]); } catch {}
  }
  const fallbackSummary = text.replace(/<ROOM_STAGE_RESULT>[\s\S]*?<\/ROOM_STAGE_RESULT>/gi, '').trim().slice(0, 2400);
  return {
    structured: {
      summary: cleanText(structured?.summary) || fallbackSummary || 'Stage completed without a structured summary.',
      decisions: normalizeList(structured?.decisions),
      blocking_issues: normalizeList(structured?.blocking_issues),
      resolved_issues: normalizeList(structured?.resolved_issues),
      next_actions: normalizeList(structured?.next_actions),
      validations: normalizeObjects(structured?.validations, normalizeValidation),
      artifacts: normalizeObjects(structured?.artifacts, normalizeArtifact),
      claims: normalizeObjects(structured?.claims, normalizeClaim),
      checkpoint: asObject(structured?.checkpoint),
      user_message: cleanText(structured?.user_message),
    },
    visible_output: text.replace(/<ROOM_STAGE_RESULT>[\s\S]*?<\/ROOM_STAGE_RESULT>/gi, '').trim(),
    raw_output: text,
    contract_observed: Boolean(match && structured),
  };
}
