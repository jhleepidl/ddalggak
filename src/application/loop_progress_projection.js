import { readActiveLoopRun, readLoopRun } from './loop_run_store.js';
import { readDiscussionLedger, deriveDiscussionState } from './loop_discussion_ledger.js';
import { inspectLoopMemoryPressure } from './loop_memory_manager.js';
import { normalizeLoopVisibility } from './loop_execution_kernel.js';

function clean(value = '') { return String(value || '').trim(); }
function clip(value = '', max = 500) { const text = clean(value).replace(/\s+/g, ' '); return text.length <= max ? text : `${text.slice(0, max - 1)}…`; }
function asArray(value) { return Array.isArray(value) ? value : []; }

export function buildLoopProgressProjection({ jobDir = '', loopId = '', visibility = '' } = {}) {
  const run = loopId ? readLoopRun({ jobDir, loopId, includeEvents: true }) : readActiveLoopRun({ jobDir, includeEvents: true });
  if (!run?.state) return null;
  const state = run.state;
  const stages = asArray(state.spec?.topology?.stages);
  const currentStage = stages.find((row) => row.stage_id === state.current_stage_id) || stages[state.current_stage_index] || null;
  const discussion = deriveDiscussionState({ records: readDiscussionLedger({ jobDir, loopId: state.loop_id }) });
  const memory = inspectLoopMemoryPressure({ jobDir, loopId: state.loop_id });
  const mode = normalizeLoopVisibility(visibility || state.progress_visibility || state.spec?.progress_policy?.visibility);
  const base = {
    kind: 'loop_progress_projection_v1',
    loop_id: state.loop_id,
    objective: state.spec?.objective,
    topology: state.spec?.topology?.label || state.spec?.topology?.topology_id,
    status: state.status,
    visibility: mode,
    stage: currentStage ? { id: currentStage.stage_id, label: currentStage.label, index: Number(currentStage.stage_index || 0) + 1, total: stages.length } : null,
    round: state.current_round,
    max_rounds: state.spec?.budget_policy?.max_rounds,
    active_agents: state.active_agents,
    blocking_issues: discussion.blocking_open_count,
    open_objections: discussion.open_objection_count,
    counters: state.counters,
    latest_summary: state.latest_summary,
    next_action: state.next_action,
    memory: {
      pressure_level: memory.pressure_level,
      raw_bytes: memory.raw_bytes,
      event_count: memory.event_count,
      compaction_recommended: memory.compaction_recommended,
    },
    milestones: asArray(state.milestones).slice(mode === 'quiet' ? -3 : mode === 'standard' ? -8 : -20),
    recent_events: mode === 'debug' ? asArray(run.events).slice(-12) : undefined,
    generated_at: new Date().toISOString(),
  };
  return base;
}

export function formatLoopProgressForUser({ projection = null, locale = 'ko' } = {}) {
  if (!projection) return '활성 loop가 없습니다.';
  const p = projection;
  const stage = p.stage ? `${p.stage.index}/${p.stage.total} · ${p.stage.label}` : '-';
  const lines = [
    `🔁 ${clip(p.objective, 160)}`,
    `- 상태: ${p.status}`,
    `- topology: ${p.topology || '-'}`,
    `- 단계: ${stage}`,
    `- round: ${p.round || 1}/${p.max_rounds || 1}`,
  ];
  if (p.blocking_issues) lines.push(`- blocking issue: ${p.blocking_issues}`);
  if (p.latest_summary) lines.push(`- 최근 진행: ${clip(p.latest_summary, 260)}`);
  if (p.next_action) lines.push(`- 다음: ${p.next_action}`);
  if (p.memory?.compaction_recommended) lines.push(`- memory: ${p.memory.pressure_level} · compaction 권장`);
  if (p.visibility !== 'quiet' && asArray(p.milestones).length) {
    lines.push('', '주요 milestone:');
    for (const row of p.milestones.slice(-6)) lines.push(`- ${clip(row.label, 220)}`);
  }
  if (p.visibility === 'debug' && asArray(p.recent_events).length) {
    lines.push('', '최근 raw events:');
    for (const row of p.recent_events.slice(-8)) lines.push(`- ${row.event_type}: ${clip(row.summary || row.actor || '', 180)}`);
  }
  return lines.join('\n');
}

export function shouldNotifyLoopEvent(event = {}, visibility = 'quiet') {
  const type = clean(event.event_type);
  const mode = normalizeLoopVisibility(visibility);
  const always = new Set(['run_started', 'blocking_issue_found', 'approval_required', 'run_redirected', 'run_recovered', 'run_completed', 'run_failed']);
  if (always.has(type)) return true;
  if (mode === 'quiet') return type === 'stage_started';
  if (mode === 'standard') return ['stage_started', 'stage_completed', 'blocking_issue_resolved', 'memory_compacted'].includes(type);
  return true;
}

export default { buildLoopProgressProjection, formatLoopProgressForUser, shouldNotifyLoopEvent };
