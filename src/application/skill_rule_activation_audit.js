import fs from 'node:fs';
import path from 'node:path';
import { appendSemanticBoardEvent, readSemanticBoard, upsertSemanticBoardLinks } from './semantic_board.js';

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function clean(value = '') { return String(value ?? '').trim(); }
function safeAppendJsonl(filePath = '', row = {}) {
  const target = path.resolve(String(filePath || ''));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(row)}\n`, 'utf8');
  return target;
}

export function defaultActivationLogDir({ jobDir = '', rootDir = process.cwd(), jobId = '' } = {}) {
  if (jobDir) return path.resolve(jobDir, 'local_memory');
  if (jobId) return path.resolve(rootDir, process.env.RUNS_DIR || 'runs', jobId, 'local_memory');
  return path.resolve(rootDir, 'local_memory');
}

export function buildSkillActivationDecision({ skillId = '', roleId = '', slotId = '', taskType = '', decision = 'candidate', reasons = [], score = 0, reuseScore = undefined, selectedBy = 'skill_resolver', agentId = '', modelNodeId = '', metadata = {} } = {}) {
  const id = clean(skillId);
  if (!id) return null;
  return {
    kind: 'skill_activation_decision_v1',
    ts: new Date().toISOString(),
    skill_id: id,
    role_id: clean(roleId) || undefined,
    slot_id: clean(slotId) || undefined,
    agent_id: clean(agentId) || undefined,
    task_type: clean(taskType) || undefined,
    decision: clean(decision) || 'candidate',
    reasons: asArray(reasons).map((v) => clean(v)).filter(Boolean),
    score: Number.isFinite(Number(score)) ? Number(score) : 0,
    reuse_score: Number.isFinite(Number(reuseScore)) ? Number(reuseScore) : undefined,
    selected_by: clean(selectedBy) || 'skill_resolver',
    model_node_id: clean(modelNodeId) || undefined,
    metadata: asObject(metadata),
  };
}

export function buildRuleActivationDecision({ ruleId = '', roleId = '', taskType = '', decision = 'active', reasons = [], reuseScore = undefined, metadata = {} } = {}) {
  const id = clean(ruleId);
  if (!id) return null;
  return {
    kind: 'rule_activation_decision_v1',
    ts: new Date().toISOString(),
    rule_id: id,
    role_id: clean(roleId) || undefined,
    task_type: clean(taskType) || undefined,
    decision: clean(decision) || 'active',
    reasons: asArray(reasons).map((v) => clean(v)).filter(Boolean),
    reuse_score: Number.isFinite(Number(reuseScore)) ? Number(reuseScore) : undefined,
    metadata: asObject(metadata),
  };
}

export function recordSkillActivationDecision(decision = {}, options = {}) {
  const row = buildSkillActivationDecision(decision);
  if (!row) return null;
  const dir = defaultActivationLogDir(options);
  safeAppendJsonl(path.join(dir, 'skill_activations.jsonl'), row);
  safeAppendJsonl(path.join(dir, 'activation_decisions.jsonl'), row);
  if (options.mirrorToBoard !== false) {
    try {
      appendSemanticBoardEvent({ type: 'skill_activation_decision', payload: row }, options);
      const board = readSemanticBoard(options);
      const hasSkillCard = asArray(board.cards).some((card) => card.id === row.skill_id);
      const agentCardId = row.agent_id || row.role_id ? `agent_${row.agent_id || row.role_id}` : '';
      if (hasSkillCard && agentCardId) {
        upsertSemanticBoardLinks([{ from: agentCardId, to: row.skill_id, type: row.decision === 'activated' ? 'uses' : 'considered_skill', weight: row.decision === 'activated' ? 0.8 : 0.3, reason: row.reasons.join(', '), status: row.decision === 'activated' ? 'active' : 'candidate' }], options);
      }
    } catch {
      // audit logging must never block routing
    }
  }
  return row;
}

export function recordRuleActivationDecision(decision = {}, options = {}) {
  const row = buildRuleActivationDecision(decision);
  if (!row) return null;
  const dir = defaultActivationLogDir(options);
  safeAppendJsonl(path.join(dir, 'rule_activations.jsonl'), row);
  safeAppendJsonl(path.join(dir, 'activation_decisions.jsonl'), row);
  if (options.mirrorToBoard !== false) {
    try { appendSemanticBoardEvent({ type: 'rule_activation_decision', payload: row }, options); } catch {}
  }
  return row;
}

export function recordSkillResolutionAudit({ roleId = '', slotId = '', taskType = '', selected = [], candidates = [], auditOptions = {} } = {}) {
  const selectedIds = new Set(asArray(selected).map((row) => clean(row.skill_id || row.attachment?.skill_id)).filter(Boolean));
  const rows = [];
  for (const row of asArray(candidates).slice(0, 12)) {
    const skillId = clean(row.skill_id || row.skill?.id);
    if (!skillId) continue;
    rows.push(recordSkillActivationDecision({
      skillId,
      roleId,
      slotId,
      taskType,
      decision: selectedIds.has(skillId) ? 'activated' : 'not_selected',
      reasons: row.reasons || [],
      score: row.score,
      reuseScore: row.reuse_score ?? row.skill?.performance?.reuse_score ?? row.skill?.ranking_metadata?.reuse_score,
      selectedBy: selectedIds.has(skillId) ? 'skill_resolver' : 'skill_resolver_candidate',
      metadata: { rank: rows.length + 1 },
    }, auditOptions));
  }
  return rows.filter(Boolean);
}

export function formatActivationAuditSummary(rows = []) {
  const decisions = asArray(rows).filter(Boolean);
  const activated = decisions.filter((row) => row.decision === 'activated').length;
  const lines = [
    'Skill/rule activation audit',
    `- decisions: ${decisions.length}`,
    `- activated: ${activated}`,
  ];
  for (const row of decisions.slice(0, 10)) {
    lines.push(`- ${row.decision}: ${row.skill_id || row.rule_id} (${row.role_id || 'role?'}) · ${(row.reasons || []).slice(0, 3).join(', ') || 'no reason'}`);
  }
  return lines.join('\n');
}
