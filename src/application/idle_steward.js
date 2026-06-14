import fs from 'node:fs';
import path from 'node:path';

import { clip } from '../textutil.js';
import { runIdleMemoryMaintenance } from './idle_compaction.js';
import { listLocalSkillPackages } from './local_skill_catalog.js';
import { readAgentPackageRegistry } from './agent_package_runtime.js';
import { readSharedTeamPackageRegistry } from './team_package_registry.js';
import { appendProposalsToLog } from './proposal_log.js';

const IDLE_STEWARD_STATE_FILE = 'idle_steward_state.json';
const IDLE_STEWARD_EVENTS_FILE = 'idle_steward_events.jsonl';
const IDLE_STEWARD_REPORT_FILE = 'idle_steward_report.md';

function clean(value = '', { maxLen = 1000 } = {}) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}
function cleanId(value = '') {
  return clean(value, { maxLen: 180 }).toLowerCase().replace(/[^a-z0-9가-힣_:-]+/g, '_').replace(/^_+|_+$/g, '');
}
function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function nowIso() { return new Date().toISOString(); }
function localMemoryDir(jobDir = '') {
  const dir = path.join(String(jobDir || ''), 'local_memory');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sharedDir(jobDir = '') {
  const dir = path.join(String(jobDir || ''), 'shared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function readJson(filePath = '', fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return fallback; }
}
function writeJson(filePath = '', payload = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function appendJsonl(filePath = '', payload = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}
function envBool(name = '', fallback = true) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function hash(value = '') {
  let h = 0;
  const text = String(value || '');
  for (let i = 0; i < text.length; i += 1) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}
function statePath(jobDir = '') { return path.join(localMemoryDir(jobDir), IDLE_STEWARD_STATE_FILE); }

function summarizeSkillCatalog({ rootDir = process.cwd() } = {}) {
  const skills = listLocalSkillPackages({ rootDir });
  const missingDescription = skills.filter((skill) => !clean(skill.description));
  const disabled = skills.filter((skill) => skill.disabled === true || skill.enabled === false);
  const bySlug = new Map();
  for (const skill of skills) {
    const key = cleanId(skill.slug || skill.name || skill.skill_id);
    if (!key) continue;
    bySlug.set(key, [...(bySlug.get(key) || []), skill]);
  }
  const duplicateSlugs = [...bySlug.entries()].filter(([, rows]) => rows.length > 1).map(([slug, rows]) => ({ slug, count: rows.length }));
  return {
    skill_count: skills.length,
    missing_description_count: missingDescription.length,
    disabled_count: disabled.length,
    duplicate_slug_count: duplicateSlugs.length,
    duplicate_slugs: duplicateSlugs.slice(0, 12),
    examples_missing_description: missingDescription.slice(0, 8).map((skill) => skill.skill_id || skill.name),
  };
}

function summarizeAgentRegistries() {
  const agentRegistry = readAgentPackageRegistry();
  const teamRegistry = readSharedTeamPackageRegistry();
  const agentPackages = asArray(agentRegistry.packages);
  const teamPackages = asArray(teamRegistry.packages);
  const malformedAgentPackages = agentPackages.filter((pkg) => asArray(pkg.agents).length === 0);
  const malformedTeamPackages = teamPackages.filter((pkg) => {
    const blueprint = asObject(pkg.blueprint || pkg.team_blueprint || pkg.teamBlueprint);
    const team = asObject(pkg.team || pkg.team_seed || pkg.teamSeed || blueprint.team_seed || blueprint.teamSeed);
    const roles = asArray(team.agents || pkg.roles || pkg.role_contracts || pkg.roleContracts);
    return roles.length === 0;
  });
  const publicTeamPackages = teamPackages.filter((pkg) => clean(pkg.visibility || pkg.publish_visibility).includes('public'));
  return {
    agent_package_count: agentPackages.length,
    shared_team_package_count: teamPackages.length,
    public_team_package_count: publicTeamPackages.length,
    malformed_agent_package_count: malformedAgentPackages.length,
    malformed_team_package_count: malformedTeamPackages.length,
    examples_malformed_agents: malformedAgentPackages.slice(0, 8).map((pkg) => pkg.package_id || pkg.id || pkg.title),
    examples_malformed_teams: malformedTeamPackages.slice(0, 8).map((pkg) => pkg.package_id || pkg.id || pkg.title),
  };
}

function proposalId(kind = '', summary = '') {
  return `proposal_idle_${cleanId(kind || 'steward')}_${hash(summary).slice(0, 10)}`;
}

export function buildIdleStewardProposal({ jobDir = '', rootDir = process.cwd(), jobId = '', chatId = '', threadId = '', runId = '', memoryMaintenance = null } = {}) {
  const cleanJobDir = clean(jobDir, { maxLen: 1000 });
  if (!cleanJobDir) throw new Error('jobDir is required');
  const memory = asObject(memoryMaintenance);
  const topology = asObject(memory.topology);
  const stress = Number(topology?.stress?.score || memory?.state?.last_topology_stress || 0);
  const mode = clean(topology?.mode || memory?.state?.last_topology_mode || 'unknown', { maxLen: 80 });
  const skillSummary = summarizeSkillCatalog({ rootDir });
  const registrySummary = summarizeAgentRegistries();
  const proposals = [];

  if (memory.candidate) {
    const summary = `Idle memory compaction candidate is ready for review (${mode}, stress=${stress.toFixed(2)}).`;
    proposals.push({
      proposal_id: proposalId('memory_compaction_review', summary),
      kind: 'idle_memory_compaction_review',
      title: 'Review idle memory compaction candidate',
      summary,
      risk: stress >= 3 ? 'medium' : 'low',
      status: 'pending_review',
      recommended_action: 'review_or_promote_memory_candidate_in_goc',
      source: 'idle_steward',
      source_id: clean(memory.candidate.summary_path || jobId || cleanJobDir, { maxLen: 300 }),
      run_id: runId,
      payload: { memory_topology_mode: mode, memory_topology_stress: stress, candidate_summary_path: memory.candidate.summary_path || '' },
    });
  } else if (stress >= Number(process.env.IDLE_STEWARD_MEMORY_STRESS_THRESHOLD || 2.4)) {
    const summary = `Memory topology stress is elevated (${mode}, stress=${stress.toFixed(2)}) but no compaction candidate was promoted automatically.`;
    proposals.push({
      proposal_id: proposalId('memory_topology_review', summary),
      kind: 'idle_memory_topology_review',
      title: 'Review memory topology pressure',
      summary,
      risk: 'low',
      status: 'pending_review',
      recommended_action: 'inspect_memory_topology_and_decide_whether_to_materialize_or_split',
      source: 'idle_steward',
      source_id: jobId || cleanJobDir,
      run_id: runId,
      payload: { memory_topology_mode: mode, memory_topology_stress: stress },
    });
  }

  if (skillSummary.missing_description_count > 0 || skillSummary.duplicate_slug_count > 0 || skillSummary.disabled_count > 0) {
    const summary = `Skill catalog cleanup candidate: ${skillSummary.skill_count} skills, ${skillSummary.missing_description_count} missing descriptions, ${skillSummary.duplicate_slug_count} duplicate slugs, ${skillSummary.disabled_count} disabled.`;
    proposals.push({
      proposal_id: proposalId('skill_catalog_cleanup', summary),
      kind: 'idle_skill_catalog_cleanup',
      title: 'Review local skill catalog cleanup',
      summary,
      risk: 'low',
      status: 'pending_review',
      recommended_action: 'review_skill_manifest_metadata_before_editing_or_archiving',
      source: 'idle_steward',
      source_id: 'skills',
      run_id: runId,
      payload: skillSummary,
    });
  }

  if (registrySummary.malformed_agent_package_count > 0 || registrySummary.malformed_team_package_count > 0 || registrySummary.shared_team_package_count > 0) {
    const summary = `Agent/team registry hygiene candidate: ${registrySummary.agent_package_count} agent packages, ${registrySummary.shared_team_package_count} shared team packages, ${registrySummary.malformed_agent_package_count + registrySummary.malformed_team_package_count} malformed or incomplete packages.`;
    proposals.push({
      proposal_id: proposalId('agent_team_registry_hygiene', summary),
      kind: 'idle_agent_team_registry_hygiene',
      title: 'Review agent/team package registry hygiene',
      summary,
      risk: 'low',
      status: 'pending_review',
      recommended_action: 'inspect_clone_safe_packages_and_archive_or_fix_incomplete_entries_after_review',
      source: 'idle_steward',
      source_id: 'agent_team_registry',
      run_id: runId,
      payload: registrySummary,
    });
  }

  const reportLines = [
    '# Idle Steward Report',
    '',
    `> generatedAt: ${nowIso()}`,
    '> status: proposals_only',
    '> destructive_changes: false',
    '',
    '## Policy',
    '- The idle steward never deletes, merges, edits, or publishes canonical memory/skills/agents by itself.',
    '- It only writes review proposals and lightweight reports while the user/session is idle or after a run ends.',
    '- GoC/user approval is required before promote/merge/archive actions.',
    '',
    '## Memory',
    `- topology: ${mode}`,
    `- stress: ${stress.toFixed(2)}`,
    `- compaction candidate: ${memory.candidate ? 'yes' : 'no'}`,
    '',
    '## Skill catalog',
    `- skills: ${skillSummary.skill_count}`,
    `- missing descriptions: ${skillSummary.missing_description_count}`,
    `- duplicate slugs: ${skillSummary.duplicate_slug_count}`,
    `- disabled: ${skillSummary.disabled_count}`,
    '',
    '## Agent/team registries',
    `- agent packages: ${registrySummary.agent_package_count}`,
    `- shared team packages: ${registrySummary.shared_team_package_count}`,
    `- public team packages: ${registrySummary.public_team_package_count}`,
    `- incomplete packages: ${registrySummary.malformed_agent_package_count + registrySummary.malformed_team_package_count}`,
    '',
    '## Proposals',
    proposals.length ? proposals.map((p) => `- [${p.kind}] ${p.summary}`).join('\n') : '- none',
  ];

  return {
    kind: 'idle_steward_report_v1',
    generated_at: nowIso(),
    status: 'proposals_only',
    destructive_changes: false,
    job_id: clean(jobId, { maxLen: 120 }),
    chat_id: clean(chatId, { maxLen: 120 }),
    thread_id: clean(threadId, { maxLen: 120 }),
    run_id: clean(runId, { maxLen: 120 }),
    memory: { topology_mode: mode, topology_stress: stress, candidate_written: Boolean(memory.candidate) },
    skill_summary: skillSummary,
    registry_summary: registrySummary,
    proposal_count: proposals.length,
    proposals,
    report_markdown: clip(reportLines.join('\n'), 9000),
  };
}

export function writeIdleStewardReport({ jobDir = '', rootDir = process.cwd(), jobId = '', chatId = '', threadId = '', runId = '', memoryMaintenance = null, appendToProposalLog = true } = {}) {
  const cleanJobDir = clean(jobDir, { maxLen: 1000 });
  const report = buildIdleStewardProposal({ jobDir: cleanJobDir, rootDir, jobId, chatId, threadId, runId, memoryMaintenance });
  const reportPath = path.join(sharedDir(cleanJobDir), IDLE_STEWARD_REPORT_FILE);
  fs.writeFileSync(reportPath, `${report.report_markdown.trim()}\n`, 'utf8');
  appendJsonl(path.join(localMemoryDir(cleanJobDir), IDLE_STEWARD_EVENTS_FILE), { ...report, report_markdown: undefined, report_path: reportPath });
  let proposalLog = null;
  if (appendToProposalLog && report.proposals.length > 0) {
    proposalLog = appendProposalsToLog({
      jobDir: cleanJobDir,
      proposals: report.proposals,
      defaults: { source: 'idle_steward', actor: 'idle_steward', run_id: runId },
      dedupe: true,
    });
  }
  return { ...report, report_path: reportPath, proposal_log: proposalLog };
}

export function runIdleStewardMaintenance({ jobDir = '', rootDir = process.cwd(), jobId = '', chatId = '', threadId = '', runId = '', force = false, memoryMaintenance = null, minIntervalMs = null } = {}) {
  const cleanJobDir = clean(jobDir, { maxLen: 1000 });
  if (!cleanJobDir) throw new Error('jobDir is required');
  if (!force && !envBool('IDLE_STEWARD_ENABLED', true)) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  const interval = Number.isFinite(Number(minIntervalMs))
    ? Math.max(0, Number(minIntervalMs))
    : Math.max(0, Number(process.env.IDLE_STEWARD_MIN_INTERVAL_MS || 10 * 60 * 1000));
  const stateFile = statePath(cleanJobDir);
  const state = readJson(stateFile, {}) || {};
  const now = Date.now();
  const lastRunMs = Date.parse(String(state.last_run_at || '')) || 0;
  if (!force && lastRunMs && interval > 0 && now - lastRunMs < interval) {
    return { ok: true, skipped: true, reason: 'interval', next_after_ms: interval - (now - lastRunMs) };
  }
  const memory = memoryMaintenance || runIdleMemoryMaintenance({ jobDir: cleanJobDir, jobId, chatId, threadId, runId, force: false });
  const report = writeIdleStewardReport({ jobDir: cleanJobDir, rootDir, jobId, chatId, threadId, runId, memoryMaintenance: memory, appendToProposalLog: true });
  const nextState = {
    kind: 'idle_steward_state_v1',
    last_run_at: nowIso(),
    last_report_path: report.report_path,
    last_proposal_count: report.proposal_count,
    last_memory_stress: report.memory.topology_stress,
    last_status: report.proposal_count > 0 ? 'proposals_written' : 'no_proposals',
  };
  writeJson(stateFile, nextState);
  return { ok: true, skipped: false, report, state: nextState };
}

export function formatIdleStewardReportForTelegram(report = {}) {
  const row = asObject(report.report || report);
  return [
    '🧹 Idle steward report',
    `- status: ${row.status || 'proposals_only'}`,
    `- destructive_changes: ${row.destructive_changes === true ? 'true' : 'false'}`,
    `- proposals: ${Number(row.proposal_count || 0)}`,
    row.report_path ? `- report: ${row.report_path}` : '',
    row.memory ? `- memory: ${row.memory.topology_mode || 'unknown'} stress=${Number(row.memory.topology_stress || 0).toFixed(2)}` : '',
    '',
    clip(String(row.report_markdown || ''), 1800),
  ].filter(Boolean).join('\n');
}
