#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { buildTeamSelectionPortfolio } from '../../src/application/team_configuration.js';

function parseArgs(argv = process.argv.slice(2)) {
  const out = { input: 'experiments/datasets/aetg_selection/smoke.jsonl', out: 'experiments/runs/aetg_selection_smoke' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--input') out.input = argv[++i];
    else if (arg === '--out') out.out = argv[++i];
  }
  return out;
}
function readJsonl(file) {
  return String(fs.readFileSync(file, 'utf8') || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
function runtimeFromCase(row = {}) {
  const caps = {};
  for (const cap of Array.isArray(row.available_capabilities) ? row.available_capabilities : []) caps[cap] = true;
  return { capabilities: caps, availableToolIds: row.available_capabilities || [], agents: [], enabledAgentIds: [] };
}
function rolesOf(candidate = {}) {
  return new Set((candidate.roles || candidate.team?.agents?.map((a) => a.role) || []).map((v) => String(v || '').toLowerCase()).filter(Boolean));
}
function evaluateCandidate(candidate = {}, oracle = {}) {
  const roles = rolesOf(candidate);
  const acceptable = new Set(oracle.acceptable_motifs || []);
  const required = oracle.required_roles || [];
  const forbidden = oracle.forbidden_roles || [];
  const blocking = new Set(candidate.gate?.blocking_reason_codes || candidate.gate?.violations || []);
  const forbiddenBlocking = oracle.forbidden_blocking_reasons || [];
  const roleOk = required.every((role) => roles.has(String(role).toLowerCase())) && forbidden.every((role) => !roles.has(String(role).toLowerCase()));
  const motifOk = acceptable.size === 0 || acceptable.has(candidate.motif_id);
  const blockingOk = forbiddenBlocking.every((code) => !blocking.has(code));
  return { success: roleOk && motifOk && blockingOk && candidate.gate?.executable === true, roleOk, motifOk, blockingOk };
}
function chooseGreedy(candidates = []) {
  const pool = candidates.filter((c) => c.gate?.executable === true);
  const rows = pool.length ? pool : candidates;
  return [...rows].sort((a, b) => (a.agent_count || 99) - (b.agent_count || 99) || (a.score?.estimated_cost || 0) - (b.score?.estimated_cost || 0))[0] || null;
}
function chooseMaxUtility(candidates = []) {
  return [...candidates].sort((a, b) => (b.score?.utility || 0) - (a.score?.utility || 0))[0] || null;
}
function summarize(rows = []) {
  const byPolicy = {};
  for (const row of rows) {
    const p = row.policy;
    byPolicy[p] ||= { policy: p, count: 0, success: 0, winning_motif_covered: 0, avg_candidate_count: 0, avg_cost: 0, avg_utility: 0 };
    byPolicy[p].count += 1;
    byPolicy[p].success += row.success ? 1 : 0;
    byPolicy[p].winning_motif_covered += row.winning_motif_covered ? 1 : 0;
    byPolicy[p].avg_candidate_count += row.candidate_count || 0;
    byPolicy[p].avg_cost += row.estimated_cost || 0;
    byPolicy[p].avg_utility += row.utility || 0;
  }
  return Object.values(byPolicy).map((r) => ({
    ...r,
    success_rate: r.count ? r.success / r.count : 0,
    coverage_rate: r.count ? r.winning_motif_covered / r.count : 0,
    avg_candidate_count: r.count ? r.avg_candidate_count / r.count : 0,
    avg_cost: r.count ? r.avg_cost / r.count : 0,
    avg_utility: r.count ? r.avg_utility / r.count : 0,
  }));
}
const args = parseArgs();
fs.mkdirSync(args.out, { recursive: true });
process.env.TEAM_SELECTION_TRACE_LOG ||= path.join(args.out, 'team_selection_traces.jsonl');
const cases = readJsonl(args.input);
const rows = [];
for (const item of cases) {
  const portfolio = buildTeamSelectionPortfolio({ taskText: item.request, runtime: runtimeFromCase(item), maxCandidates: 8 });
  const candidates = portfolio.candidates || [];
  const policies = {
    portfolio_contract: candidates.find((c) => c.selected) || candidates[0],
    greedy_smallest_executable: chooseGreedy(candidates),
    max_utility: chooseMaxUtility(candidates),
  };
  const acceptable = new Set(item.oracle?.acceptable_motifs || []);
  const winningMotifCovered = candidates.some((candidate) => acceptable.has(candidate.motif_id));
  for (const [policy, candidate] of Object.entries(policies)) {
    const evalRow = evaluateCandidate(candidate || {}, item.oracle || {});
    rows.push({
      case_id: item.id,
      policy,
      selected_candidate_id: candidate?.candidate_id || null,
      selected_motif: candidate?.motif_id || null,
      candidate_count: candidates.length,
      winning_motif_covered: winningMotifCovered,
      estimated_cost: candidate?.score?.estimated_cost || 0,
      utility: candidate?.score?.utility || 0,
      success: evalRow.success,
      eval: evalRow,
    });
  }
}
const summary = summarize(rows);
fs.writeFileSync(path.join(args.out, 'aetg_selection_results.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(args.out, 'aetg_selection_summary.json'), JSON.stringify({ count: cases.length, summary }, null, 2));
console.log(JSON.stringify({ count: cases.length, summary }, null, 2));
