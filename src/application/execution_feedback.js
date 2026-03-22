import fs from 'node:fs';
import path from 'node:path';

import { resolveAgencyOverlayMeta } from './team_presentation.js';

function clean(value = '') {
  return String(value || '').trim();
}

function cleanLower(value = '') {
  return clean(value).toLowerCase();
}

function asObject(value) {
  return value && typeof value === 'object' ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function readJsonl(filePath = '') {
  try {
    if (!filePath || !fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath = '', row = {}) {
  try {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {}
}

function uniqueRows(rows = [], keyFn = (row) => row) {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

function round1(value = 0) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function summarizeRuntimeOverlays(runtimeTeamSnapshot = null) {
  const agents = asArray(runtimeTeamSnapshot?.runtime_agents || runtimeTeamSnapshot?.runtimeAgents);
  const overlays = uniqueRows(agents
    .map((row) => {
      const meta = resolveAgencyOverlayMeta(row);
      const overlayId = cleanLower(meta.overlay_id);
      const title = clean(meta.title);
      if (!overlayId && !title) return null;
      return {
        overlay_id: overlayId || undefined,
        title: title || overlayId || 'overlay',
      };
    })
    .filter(Boolean), (row) => `${row.overlay_id || ''}|${row.title || ''}`);
  return overlays.slice(0, 8);
}

function summarizePromptOverlayUsage(jobDir = '') {
  const rows = readJsonl(jobDir ? path.join(jobDir, 'prompt_metrics.jsonl') : '');
  const overlayRows = rows.filter((row) => row && typeof row === 'object' && (Number(row?.overlay?.tokens || 0) > 0 || clean(row?.overlay?.overlay_id || row?.metadata?.agency_overlay_id || '')));
  const byOverlay = new Map();
  for (const row of overlayRows) {
    const overlayId = cleanLower(row?.overlay?.overlay_id || row?.metadata?.agency_overlay_id || '');
    const title = clean(row?.overlay?.overlay_title || row?.metadata?.agency_overlay_title || overlayId || 'overlay');
    const key = overlayId || title.toLowerCase();
    if (!key) continue;
    const current = byOverlay.get(key) || {
      overlay_id: overlayId || undefined,
      title,
      prompt_count: 0,
      total_overlay_tokens: 0,
      total_overlay_share_pct: 0,
    };
    current.prompt_count += 1;
    current.total_overlay_tokens += Number(row?.overlay?.tokens || 0);
    current.total_overlay_share_pct += Number(row?.overlay?.share_pct || 0);
    byOverlay.set(key, current);
  }
  return Array.from(byOverlay.values())
    .map((row) => ({
      overlay_id: row.overlay_id,
      title: row.title,
      prompt_count: row.prompt_count,
      avg_overlay_tokens: row.prompt_count > 0 ? Math.round(row.total_overlay_tokens / row.prompt_count) : 0,
      avg_overlay_share_pct: row.prompt_count > 0 ? round1(row.total_overlay_share_pct / row.prompt_count) : 0,
    }))
    .sort((a, b) => (b.prompt_count - a.prompt_count) || (b.avg_overlay_tokens - a.avg_overlay_tokens) || String(a.title || '').localeCompare(String(b.title || '')))
    .slice(0, 12);
}

function buildFeedbackRecord({ runId = '', executionInsights = null, runtimeTeamSnapshot = null, status = 'done', jobDir = '' } = {}) {
  const execution = asObject(executionInsights?.execution);
  const pattern = cleanLower(executionInsights?.execution_pattern || runtimeTeamSnapshot?.blueprint_summary?.execution_pattern || runtimeTeamSnapshot?.execution_graph?.pattern || '');
  const planned = Number(execution.planned_agent_count || 0);
  const observed = Number(execution.observed_agent_count || 0);
  const participationPct = planned > 0 ? round1((observed / planned) * 100) : (observed > 0 ? 100 : 0);
  const overlays = summarizeRuntimeOverlays(runtimeTeamSnapshot);
  const overlayPromptUsage = summarizePromptOverlayUsage(jobDir);
  return {
    ts: new Date().toISOString(),
    run_id: clean(runId) || undefined,
    execution_pattern: pattern || undefined,
    status: cleanLower(status) || 'done',
    planned_agent_count: planned,
    observed_agent_count: observed,
    participation_pct: participationPct,
    missing_agent_count: asArray(execution.missing_agents).length,
    extra_agent_count: asArray(execution.extra_agents).length,
    missing_agents: asArray(execution.missing_agents).slice(0, 8),
    participation_by_role: asArray(execution.participation_by_role).slice(0, 8),
    overlays,
    overlay_prompt_usage: overlayPromptUsage.slice(0, 8),
  };
}

function aggregateFeedbackRecords(records = []) {
  const rows = asArray(records).filter((row) => row && typeof row === 'object');
  const patterns = new Map();
  const overlays = new Map();
  for (const row of rows) {
    const pattern = cleanLower(row.execution_pattern || 'unspecified');
    const patternCurrent = patterns.get(pattern) || {
      execution_pattern: pattern,
      run_count: 0,
      total_participation_pct: 0,
      total_planned_agents: 0,
      total_observed_agents: 0,
      total_missing_agents: 0,
      completion_count: 0,
    };
    patternCurrent.run_count += 1;
    patternCurrent.total_participation_pct += Number(row.participation_pct || 0);
    patternCurrent.total_planned_agents += Number(row.planned_agent_count || 0);
    patternCurrent.total_observed_agents += Number(row.observed_agent_count || 0);
    patternCurrent.total_missing_agents += Number(row.missing_agent_count || 0);
    if (cleanLower(row.status) === 'done') patternCurrent.completion_count += 1;
    patterns.set(pattern, patternCurrent);

    const overlayRuns = asArray(row.overlays);
    const promptUsageMap = new Map(asArray(row.overlay_prompt_usage).map((entry) => {
      const item = asObject(entry);
      const key = cleanLower(item.overlay_id || item.title || '');
      return [key, item];
    }).filter((entry) => entry[0]));
    for (const rawOverlay of overlayRuns) {
      const overlay = asObject(rawOverlay);
      const key = cleanLower(overlay.overlay_id || overlay.title || '');
      if (!key) continue;
      const promptUsage = promptUsageMap.get(key) || {};
      const current = overlays.get(key) || {
        overlay_id: cleanLower(overlay.overlay_id) || undefined,
        title: clean(overlay.title) || clean(overlay.overlay_id) || 'overlay',
        run_count: 0,
        total_participation_pct: 0,
        prompt_count: 0,
        total_overlay_tokens: 0,
        total_overlay_share_pct: 0,
      };
      current.run_count += 1;
      current.total_participation_pct += Number(row.participation_pct || 0);
      current.prompt_count += Number(promptUsage.prompt_count || 0);
      current.total_overlay_tokens += Number(promptUsage.avg_overlay_tokens || 0) * Math.max(1, Number(promptUsage.prompt_count || 0));
      current.total_overlay_share_pct += Number(promptUsage.avg_overlay_share_pct || 0) * Math.max(1, Number(promptUsage.prompt_count || 0));
      overlays.set(key, current);
    }
  }
  return {
    updated_at: new Date().toISOString(),
    run_count: rows.length,
    patterns: Array.from(patterns.values())
      .map((row) => ({
        execution_pattern: row.execution_pattern,
        run_count: row.run_count,
        avg_participation_pct: row.run_count > 0 ? round1(row.total_participation_pct / row.run_count) : 0,
        avg_planned_agents: row.run_count > 0 ? round1(row.total_planned_agents / row.run_count) : 0,
        avg_observed_agents: row.run_count > 0 ? round1(row.total_observed_agents / row.run_count) : 0,
        avg_missing_agents: row.run_count > 0 ? round1(row.total_missing_agents / row.run_count) : 0,
        completion_rate_pct: row.run_count > 0 ? round1((row.completion_count / row.run_count) * 100) : 0,
      }))
      .sort((a, b) => (b.run_count - a.run_count) || (b.avg_participation_pct - a.avg_participation_pct)),
    overlays: Array.from(overlays.values())
      .map((row) => ({
        overlay_id: row.overlay_id,
        title: row.title,
        run_count: row.run_count,
        avg_participation_pct: row.run_count > 0 ? round1(row.total_participation_pct / row.run_count) : 0,
        prompt_count: row.prompt_count,
        avg_overlay_tokens: row.prompt_count > 0 ? Math.round(row.total_overlay_tokens / row.prompt_count) : 0,
        avg_overlay_share_pct: row.prompt_count > 0 ? round1(row.total_overlay_share_pct / row.prompt_count) : 0,
      }))
      .sort((a, b) => (b.run_count - a.run_count) || (b.avg_participation_pct - a.avg_participation_pct) || (b.prompt_count - a.prompt_count)),
  };
}

export function recordExecutionFeedback({ jobDir = '', runId = '', executionInsights = null, runtimeTeamSnapshot = null, status = 'done' } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) return null;
  const record = buildFeedbackRecord({ runId, executionInsights, runtimeTeamSnapshot, status, jobDir: cleanJobDir });
  appendJsonl(path.join(cleanJobDir, 'execution_feedback.jsonl'), record);
  const summary = aggregateFeedbackRecords(readJsonl(path.join(cleanJobDir, 'execution_feedback.jsonl')));
  try {
    fs.writeFileSync(path.join(cleanJobDir, 'execution_feedback_summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  } catch {}
  return { record, summary };
}

export function loadExecutionFeedbackSummary(jobDir = '') {
  try {
    const cleanJobDir = clean(jobDir);
    if (!cleanJobDir) return null;
    const filePath = path.join(cleanJobDir, 'execution_feedback_summary.json');
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(String(fs.readFileSync(filePath, 'utf8') || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
