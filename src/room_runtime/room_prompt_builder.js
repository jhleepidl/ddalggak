import { cleanText } from './fs_utils.js';

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

function formatPriorStage(row = {}, detail = 'summary') {
  const structured = row?.structured && typeof row.structured === 'object' ? row.structured : {};
  const lines = [`### ${row.stage_id}`];
  const summary = structured.summary || row.summary || row.output_excerpt || '';
  if (summary) lines.push(`summary: ${clip(summary, detail === 'full' ? 2400 : 1200)}`);
  if (detail === 'full') {
    const decisions = Array.isArray(structured.decisions) ? structured.decisions : [];
    const blockers = Array.isArray(structured.blocking_issues) ? structured.blocking_issues : [];
    const nextActions = Array.isArray(structured.next_actions) ? structured.next_actions : [];
    if (decisions.length) lines.push('decisions:', ...decisions.map((item) => `- ${clip(item, 900)}`));
    if (blockers.length) lines.push('blocking issues:', ...blockers.map((item) => `- ${clip(item, 900)}`));
    if (nextActions.length) lines.push('next actions:', ...nextActions.map((item) => `- ${clip(item, 900)}`));
    const visible = cleanText(row.visible_output || row.output_excerpt || '');
    if (visible && visible !== cleanText(summary)) lines.push(`provider-visible output:\n${clip(visible, 5000)}`);
  }
  return lines.join('\n');
}

export function buildRoomStagePrompt({ spec = {}, stage = {}, workingMemory = {}, priorStageResults = [] } = {}) {
  const selectedPrior = selectPriorStageResults(stage, priorStageResults);
  const detail = stage?.context_policy?.detail === 'full' ? 'full' : 'summary';
  const prior = selectedPrior.map((row) => formatPriorStage(row, detail)).join('\n\n');
  const includeWorkingMemory = stage?.context_policy?.include_working_memory !== false;
  const blockers = includeWorkingMemory && Array.isArray(workingMemory.open_blockers) ? workingMemory.open_blockers : [];
  const decisions = includeWorkingMemory && Array.isArray(workingMemory.decisions) ? workingMemory.decisions : [];
  return [
    'You are an agent inside an AI Room execution graph.',
    '',
    '[HARD BOUNDARY]',
    '- The provided working directory is the complete and only authorized project workspace for this Room.',
    '- Do not inspect, reference, or modify the ddalggak control-plane source tree or any parent/sibling directory.',
    '- Do not use absolute paths outside the working directory.',
    '- Do not create symlinks or request additional directories.',
    `- Workspace access for this stage: ${stage.access}.`,
    '',
    `[ROOM OBJECTIVE]\n${clip(spec.objective, 8000)}`,
    '',
    `[STAGE]\n${stage.stage_id} · role=${stage.role} · purpose=${stage.purpose}`,
    '',
    `[ACTIVE DECISIONS]\n${decisions.length ? decisions.map((item) => `- ${clip(item, 900)}`).join('\n') : '- none'}`,
    '',
    `[OPEN BLOCKERS]\n${blockers.length ? blockers.map((item) => `- ${clip(item, 900)}`).join('\n') : '- none'}`,
    '',
    `[AUTHORIZED PRIOR STAGE CONTEXT]\n${prior || '- none (this stage is intentionally isolated from prior agent claims)'}`,
    '',
    '[OUTPUT CONTRACT]',
    stage.role === 'builder' && blockers.length
      ? 'When you resolve an open blocker, copy its exact text into resolved_issues so the ledger can close it deterministically.'
      : 'Report only externally verifiable coordination facts.',
    'Complete the stage task. End with exactly one machine-readable block:',
    '<ROOM_STAGE_RESULT>',
    '{"summary":"...","decisions":["..."],"blocking_issues":["..."],"resolved_issues":["..."],"next_actions":["..."],"user_message":"..."}',
    '</ROOM_STAGE_RESULT>',
    'Do not include private chain-of-thought. Record only externally verifiable findings, decisions, and actions.',
  ].join('\n');
}

export function parseRoomStageResult(output = '') {
  const text = String(output || '').trim();
  const match = text.match(/<ROOM_STAGE_RESULT>\s*([\s\S]*?)\s*<\/ROOM_STAGE_RESULT>/i);
  let structured = null;
  if (match) {
    try { structured = JSON.parse(match[1]); } catch {}
  }
  const normalizeList = (value) => Array.isArray(value) ? value.map((item) => cleanText(item)).filter(Boolean).slice(0, 32) : [];
  const fallbackSummary = text.replace(/<ROOM_STAGE_RESULT>[\s\S]*?<\/ROOM_STAGE_RESULT>/gi, '').trim().slice(0, 2400);
  return {
    structured: {
      summary: cleanText(structured?.summary) || fallbackSummary || 'Stage completed without a structured summary.',
      decisions: normalizeList(structured?.decisions),
      blocking_issues: normalizeList(structured?.blocking_issues),
      resolved_issues: normalizeList(structured?.resolved_issues),
      next_actions: normalizeList(structured?.next_actions),
      user_message: cleanText(structured?.user_message),
    },
    visible_output: text.replace(/<ROOM_STAGE_RESULT>[\s\S]*?<\/ROOM_STAGE_RESULT>/gi, '').trim(),
    raw_output: text,
    contract_observed: Boolean(match && structured),
  };
}
