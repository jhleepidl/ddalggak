import fs from 'node:fs';
import path from 'node:path';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value = '') {
  return String(value || '').trim();
}

function lower(value = '') {
  return clean(value).toLowerCase();
}

function clamp01(value, fallback = undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function clampInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.floor(n));
}

function safeJson(filePath = '') {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(filePath = '', value = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

export function defaultSkillRulePerformancePath({ rootDir = process.cwd(), filePath = '' } = {}) {
  return path.resolve(rootDir, filePath || process.env.SKILL_RULE_PERFORMANCE_PATH || 'config/skill_rule_performance.json');
}

export function normalizePerformanceMetric(raw = {}) {
  const row = asObject(raw);
  const id = lower(row.id || row.skill_id || row.skillId || row.rule_id || row.ruleId);
  const kind = lower(row.kind || row.type || (row.rule_id || row.ruleId ? 'rule' : 'skill')) || 'skill';
  if (!id) return null;
  const usageCount = clampInt(row.usage_count ?? row.usageCount, 0);
  const successRate = clamp01(row.success_rate ?? row.successRate, undefined);
  const verificationPassRate = clamp01(row.verification_pass_rate ?? row.verificationPassRate, undefined);
  const humanOverrideRate = clamp01(row.human_override_rate ?? row.humanOverrideRate, undefined);
  const regressionRate = clamp01(row.regression_rate ?? row.regressionRate, undefined);
  const score = Number(row.score ?? row.reuse_score ?? row.reuseScore);
  const risk = lower(row.risk || row.risk_level || row.riskLevel) || undefined;
  return {
    id,
    kind: kind === 'rule' ? 'rule' : 'skill',
    usage_count: usageCount,
    success_rate: successRate,
    verification_pass_rate: verificationPassRate,
    human_override_rate: humanOverrideRate,
    regression_rate: regressionRate,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : undefined,
    risk,
    scope: asObject(row.scope),
    updated_at: clean(row.updated_at || row.updatedAt) || new Date().toISOString(),
  };
}

export function computeReuseScore(metric = {}) {
  const row = normalizePerformanceMetric(metric);
  if (!row) return 0;
  let score = 35;
  if (Number.isFinite(row.success_rate)) score += row.success_rate * 30;
  if (Number.isFinite(row.verification_pass_rate)) score += row.verification_pass_rate * 18;
  if (Number.isFinite(row.human_override_rate)) score -= row.human_override_rate * 18;
  if (Number.isFinite(row.regression_rate)) score -= row.regression_rate * 28;
  score += Math.min(12, Math.log10(Math.max(1, row.usage_count + 1)) * 8);
  if (row.risk === 'low' || row.risk === 'safe') score += 5;
  if (row.risk === 'high') score -= 12;
  return Math.round(Math.max(0, Math.min(100, score)) * 10) / 10;
}

export function normalizeSkillRulePerformanceStore(raw = {}) {
  const row = asObject(raw);
  const skills = {};
  const rules = {};
  const incomingSkills = Array.isArray(row.skills) ? row.skills : Object.values(asObject(row.skills));
  const incomingRules = Array.isArray(row.rules) ? row.rules : Object.values(asObject(row.rules));
  for (const item of incomingSkills) {
    const metric = normalizePerformanceMetric({ ...asObject(item), kind: 'skill' });
    if (!metric) continue;
    skills[metric.id] = { ...metric, reuse_score: metric.score ?? computeReuseScore(metric) };
  }
  for (const item of incomingRules) {
    const metric = normalizePerformanceMetric({ ...asObject(item), kind: 'rule' });
    if (!metric) continue;
    rules[metric.id] = { ...metric, reuse_score: metric.score ?? computeReuseScore(metric) };
  }
  return {
    kind: 'skill_rule_performance_store_v1',
    updated_at: clean(row.updated_at || row.updatedAt) || new Date().toISOString(),
    skills,
    rules,
  };
}

export function readSkillRulePerformanceStore({ rootDir = process.cwd(), filePath = '' } = {}) {
  const target = defaultSkillRulePerformancePath({ rootDir, filePath });
  const parsed = safeJson(target);
  return normalizeSkillRulePerformanceStore(parsed || {});
}

export function writeSkillRulePerformanceStore(store = {}, { rootDir = process.cwd(), filePath = '' } = {}) {
  const normalized = normalizeSkillRulePerformanceStore(store);
  normalized.updated_at = new Date().toISOString();
  writeJson(defaultSkillRulePerformancePath({ rootDir, filePath }), normalized);
  return normalized;
}

export function getSkillPerformanceMetric(skillId = '', options = {}) {
  const id = lower(skillId);
  if (!id) return null;
  const store = readSkillRulePerformanceStore(options);
  return store.skills[id] || null;
}

export function getRulePerformanceMetric(ruleId = '', options = {}) {
  const id = lower(ruleId);
  if (!id) return null;
  const store = readSkillRulePerformanceStore(options);
  return store.rules[id] || null;
}

export function mergeSkillPerformanceIntoPackage(skill = {}, { store = null, rootDir = process.cwd(), filePath = '' } = {}) {
  const id = lower(skill.id || skill.skill_id || skill.skillId);
  if (!id) return skill;
  const performanceStore = store || readSkillRulePerformanceStore({ rootDir, filePath });
  const metric = performanceStore.skills?.[id];
  if (!metric) return skill;
  const successRate = Number(metric.success_rate);
  const usageCount = Number(metric.usage_count);
  const ranking = {
    ...asObject(skill.ranking_metadata),
    ...(Number.isFinite(successRate) ? { success_rate: successRate } : {}),
    ...(Number.isFinite(usageCount) ? { usage_count: usageCount } : {}),
    risk: metric.risk || skill.ranking_metadata?.risk,
    reuse_score: metric.reuse_score,
  };
  return {
    ...skill,
    ranking_metadata: ranking,
    performance: metric,
  };
}

export function recordSkillRulePerformanceEvent(event = {}, { rootDir = process.cwd(), filePath = '' } = {}) {
  const row = asObject(event);
  const kind = lower(row.kind || row.type || 'skill') === 'rule' ? 'rule' : 'skill';
  const id = lower(row.id || row.skill_id || row.rule_id);
  if (!id) return null;
  const store = readSkillRulePerformanceStore({ rootDir, filePath });
  const bucket = kind === 'rule' ? store.rules : store.skills;
  const prev = bucket[id] || { id, kind, usage_count: 0 };
  const success = row.success === true || row.outcome === 'success';
  const failure = row.success === false || row.outcome === 'failure';
  const usageCount = clampInt(prev.usage_count, 0) + 1;
  const prevSuccess = Number.isFinite(Number(prev.success_rate)) ? Number(prev.success_rate) : 0.5;
  const nextSuccessRate = success || failure
    ? ((prevSuccess * Math.max(0, usageCount - 1)) + (success ? 1 : 0)) / usageCount
    : prevSuccess;
  const metric = normalizePerformanceMetric({
    ...prev,
    id,
    kind,
    usage_count: usageCount,
    success_rate: nextSuccessRate,
    verification_pass_rate: row.verification_pass_rate ?? row.verificationPassRate ?? prev.verification_pass_rate,
    human_override_rate: row.human_override_rate ?? row.humanOverrideRate ?? prev.human_override_rate,
    regression_rate: row.regression_rate ?? row.regressionRate ?? prev.regression_rate,
    risk: row.risk || prev.risk,
    updated_at: new Date().toISOString(),
  });
  bucket[id] = { ...metric, reuse_score: computeReuseScore(metric) };
  writeSkillRulePerformanceStore(store, { rootDir, filePath });
  return bucket[id];
}

export function formatSkillRulePerformanceSummary(store = {}) {
  const normalized = normalizeSkillRulePerformanceStore(store);
  const skillRows = Object.values(normalized.skills).sort((a, b) => Number(b.reuse_score || 0) - Number(a.reuse_score || 0));
  const ruleRows = Object.values(normalized.rules).sort((a, b) => Number(b.reuse_score || 0) - Number(a.reuse_score || 0));
  const lines = [
    'Skill / rule performance',
    `- skills: ${skillRows.length}`,
    `- rules: ${ruleRows.length}`,
  ];
  if (skillRows.length) {
    lines.push('', 'Top skills:');
    for (const row of skillRows.slice(0, 8)) {
      lines.push(`- ${row.id}: reuse=${row.reuse_score ?? 0} · success=${row.success_rate ?? '-'} · usage=${row.usage_count ?? 0}`);
    }
  }
  if (ruleRows.length) {
    lines.push('', 'Top rules:');
    for (const row of ruleRows.slice(0, 8)) {
      lines.push(`- ${row.id}: reuse=${row.reuse_score ?? 0} · success=${row.success_rate ?? '-'} · usage=${row.usage_count ?? 0}`);
    }
  }
  return lines.join('\n');
}

export function buildDefaultSkillRulePerformanceStore() {
  return normalizeSkillRulePerformanceStore({
    skills: [
      {
        id: 'skill.karpathy_coding_guidelines.v1',
        kind: 'skill',
        usage_count: 12,
        success_rate: 0.74,
        verification_pass_rate: 0.7,
        human_override_rate: 0.08,
        regression_rate: 0.04,
        risk: 'low',
      },
    ],
    rules: [
      {
        id: 'rule.no_unrequested_refactor',
        kind: 'rule',
        usage_count: 8,
        success_rate: 0.78,
        verification_pass_rate: 0.72,
        risk: 'low',
      },
    ],
  });
}
