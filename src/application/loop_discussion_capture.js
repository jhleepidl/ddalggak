import { readActiveLoopRun, appendLoopRunEvent } from './loop_run_store.js';
import { appendDiscussionRecord } from './loop_discussion_ledger.js';

function clean(value = '') { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }

function parsePayload(raw = '') {
  try {
    const parsed = JSON.parse(String(raw || '').trim());
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed?.records)) return parsed.records;
    if (Array.isArray(parsed?.loop_discussion_records)) return parsed.loop_discussion_records;
    return parsed && typeof parsed === 'object' ? [parsed] : [];
  } catch { return []; }
}

export function extractLoopDiscussionRecords(output = '') {
  const text = String(output || '');
  const records = [];
  const ranges = [];
  const patterns = [
    /```loop_discussion\s*([\s\S]*?)```/gi,
    /<loop_discussion>\s*([\s\S]*?)<\/loop_discussion>/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      ranges.push([match.index, match.index + match[0].length]);
      records.push(...parsePayload(match[1]));
    }
  }
  let cleanOutput = text;
  for (const [start, end] of ranges.sort((a, b) => b[0] - a[0])) cleanOutput = `${cleanOutput.slice(0, start)}${cleanOutput.slice(end)}`;
  return {
    records: records.filter((row) => row && typeof row === 'object').slice(0, 24),
    clean_output: cleanOutput.replace(/\n{3,}/g, '\n\n').trim(),
    block_count: ranges.length,
  };
}

export function persistLoopDiscussionRecords({ jobDir = '', output = '', actor = '', roleId = '', source = 'agent_output' } = {}) {
  const active = readActiveLoopRun({ jobDir });
  const extracted = extractLoopDiscussionRecords(output);
  if (!active?.state?.loop_id || extracted.records.length === 0) return { ...extracted, persisted: [], loop_id: active?.state?.loop_id || null };
  const persisted = [];
  for (const raw of extracted.records) {
    const row = appendDiscussionRecord({
      jobDir,
      loopId: active.state.loop_id,
      record: {
        ...raw,
        actor: clean(raw.actor || actor),
        role_id: clean(raw.role_id || raw.roleId || roleId),
        source,
      },
    });
    persisted.push(row);
    if (row.record_type === 'objection' && row.severity === 'blocking' && row.status !== 'resolved') {
      appendLoopRunEvent({ jobDir, loopId: active.state.loop_id, eventType: 'blocking_issue_found', actor, roleId, summary: row.text, payload: { issue_id: row.record_id, discussion_record_id: row.record_id }, source: 'loop_discussion_capture' });
    }
    if (row.record_type === 'resolution') {
      appendLoopRunEvent({ jobDir, loopId: active.state.loop_id, eventType: 'blocking_issue_resolved', actor, roleId, summary: row.text, payload: { issue_id: row.parent_id || row.metadata?.resolves_id, discussion_record_id: row.record_id }, source: 'loop_discussion_capture' });
    }
  }
  return { ...extracted, persisted, loop_id: active.state.loop_id };
}

export function buildLoopDiscussionOutputContract({ roleId = '', workflowContract = null } = {}) {
  const workflowKind = clean(workflowContract?.workflow_kind || workflowContract?.workflowKind).toLowerCase();
  if (!workflowKind || workflowKind === 'single_task') return '';
  const role = clean(roleId).toLowerCase();
  const allowed = role.includes('review') || role.includes('critic') || role.includes('challenger')
    ? 'objection, resolution, decision'
    : role.includes('adjudicat') || role.includes('synth')
      ? 'resolution, decision'
      : 'claim, response, resolution, decision';
  return [
    'LOOP DISCUSSION RECORD CONTRACT',
    '- Do not reveal private chain-of-thought. Record only concise, externally verifiable coordination facts.',
    `- Allowed record types for this role: ${allowed}.`,
    '- Blocking objections must name the concrete defect and evidence reference when available.',
    '- Append exactly one optional machine-readable block at the end; it will be stripped before user presentation:',
    '```loop_discussion',
    '{"records":[{"record_type":"claim|objection|response|resolution|decision","text":"...","severity":"blocking|major|minor|note","parent_id":"optional","evidence_refs":["optional"]}]}',
    '```',
    '- Use {"records":[]} when there is no coordination record worth retaining.',
  ].join('\n');
}

export default { extractLoopDiscussionRecords, persistLoopDiscussionRecords, buildLoopDiscussionOutputContract };
