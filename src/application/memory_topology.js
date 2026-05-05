import fs from 'node:fs';
import path from 'node:path';

import { syncTrackingFilesView } from './memory_tracking_files_view.js';

const TOPOLOGY_FILE = 'memory_topology.json';
const TOPOLOGY_EVENTS_FILE = 'memory_topology_events.jsonl';
const VALID_MODES = new Set(['ephemeral', 'compact_single', 'structured_single', 'team_scoped', 'graph_snapshot']);

function clean(value = '', { lower = false } = {}) {
  const out = String(value || '').trim();
  return lower ? out.toLowerCase() : out;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function ensureDir(dirPath = '') {
  if (!dirPath) return '';
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function localMemoryDir(jobDir = '') {
  const base = clean(jobDir);
  if (!base) return '';
  return ensureDir(path.join(base, 'local_memory'));
}

function safeRead(filePath = '') {
  try { return filePath && fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : ''; } catch { return ''; }
}

function safeJsonParse(text = '') {
  try { return JSON.parse(String(text || '')); } catch { return null; }
}

function readJsonl(filePath = '') {
  return safeRead(filePath)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function countJsonl(filePath = '') {
  return readJsonl(filePath).length;
}

function listSharedDocs(jobDir = '') {
  const dir = path.join(jobDir, 'shared');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const fullPath = path.join(dir, entry.name);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch {}
        return {
          name: entry.name,
          path: fullPath,
          bytes: Number(stat?.size || 0),
          mtime_ms: Number(stat?.mtimeMs || 0),
          system: ['knowledge_base_contract.md'].includes(entry.name),
        };
      })
      .filter((entry) => !entry.system);
  } catch {
    return [];
  }
}

function countRoleSummaries(jobDir = '') {
  const dir = path.join(jobDir, 'local_memory', 'role_summaries');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .length;
  } catch {
    return 0;
  }
}

function countArtifacts(jobDir = '') {
  const manifestCount = countJsonl(path.join(jobDir, 'workspace', 'uploads', 'manifest.jsonl'));
  const observationCount = countJsonl(path.join(jobDir, 'artifact_observations.jsonl'));
  return { manifest_count: manifestCount, observation_count: observationCount, count: Math.max(manifestCount, observationCount) };
}

function parseLatestContextMeta(jobDir = '') {
  const rows = readJsonl(path.join(jobDir, 'local_memory', 'context_meta.jsonl'));
  return rows.length ? asObject(rows[rows.length - 1]) : {};
}

function roleFromAgent(agent = {}) {
  return clean(agent.role || agent.role_id || agent.roleId || agent.agent_id || agent.id || agent.name, { lower: true });
}

function teamAgentsFrom(input = {}) {
  const out = [];
  const runMeta = asObject(input.runMeta || input.run_meta);
  const snapshot = asObject(runMeta.runtimeTeamSnapshot || runMeta.runtime_team_snapshot || input.runtimeTeamSnapshot || input.runtime_team_snapshot);
  for (const participant of asArray(snapshot.participants || snapshot.runtime_agents || snapshot.runtimeAgents)) {
    const role = roleFromAgent(participant);
    if (role) out.push({ role, provider: clean(participant.provider, { lower: true }), id: clean(participant.id || participant.agent_id || participant.agentId || role, { lower: true }) });
  }
  const team = asObject(input.teamConfig || input.team_config || runMeta.teamConfig || runMeta.team_config);
  for (const agent of asArray(team.agents || team.participants)) {
    const role = roleFromAgent(agent);
    if (role) out.push({ role, provider: clean(agent.provider, { lower: true }), id: clean(agent.id || agent.agent_id || agent.name || role, { lower: true }) });
  }
  const explicitRole = clean(input.roleId || input.role_id, { lower: true });
  if (explicitRole) out.push({ role: explicitRole, provider: clean(input.provider, { lower: true }), id: clean(input.agentId || input.agent_id || explicitRole, { lower: true }) });
  const seen = new Set();
  return out.filter((agent) => {
    const key = `${agent.role}:${agent.id}`;
    if (!agent.role || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferCorrectionPressure({ jobDir = '', userText = '' } = {}) {
  const sample = [
    clean(userText),
    safeRead(path.join(jobDir, 'local_memory', 'turns.jsonl')).slice(-12000),
    safeRead(path.join(jobDir, 'conversation.jsonl')).slice(-12000),
    safeRead(path.join(jobDir, 'artifact_observations.jsonl')).slice(-12000),
  ].join('\n');
  const correctionHits = sample.match(/아니라|잘못|정정|틀렸|혼동|retract|correction|wrong|not\s+that/gi) || [];
  const rejectedHits = sample.match(/rejected_labels|rejected_previous_labels|negative_labels|verified_no|verified_absence|철회/gi) || [];
  return { correction_count: correctionHits.length, rejection_count: rejectedHits.length };
}

function collectMemoryStats({ jobDir = '', runMeta = {}, teamConfig = null, userText = '', roleId = '', agentId = '', provider = '' } = {}) {
  const cleanJobDir = clean(jobDir);
  const localTurns = countJsonl(path.join(cleanJobDir, 'local_memory', 'turns.jsonl'));
  const conversationTurns = countJsonl(path.join(cleanJobDir, 'conversation.jsonl'));
  const sharedDocs = listSharedDocs(cleanJobDir);
  const sharedBytes = sharedDocs.reduce((sum, doc) => sum + Number(doc.bytes || 0), 0);
  const artifactStats = countArtifacts(cleanJobDir);
  const roleSummaryCount = countRoleSummaries(cleanJobDir);
  const userFactCount = countJsonl(path.join(cleanJobDir, 'user_facts.jsonl'));
  const writeEvents = readJsonl(path.join(cleanJobDir, 'memory_write_events.jsonl'));
  const writeRoles = [...new Set(writeEvents.map((row) => clean(row.role_id || row.roleId || row.actor_role || row.provider, { lower: true })).filter(Boolean))];
  const teamAgents = teamAgentsFrom({ runMeta, teamConfig, roleId, agentId, provider });
  const latestContextMeta = parseLatestContextMeta(cleanJobDir);
  const compiledChars = Number(latestContextMeta?.context_meta?.compiledChars || latestContextMeta?.context_meta?.compiled_chars || latestContextMeta?.compiledChars || 0) || 0;
  const correction = inferCorrectionPressure({ jobDir: cleanJobDir, userText });
  return {
    job_dir: cleanJobDir,
    turn_count: Math.max(localTurns, conversationTurns),
    local_turn_count: localTurns,
    conversation_turn_count: conversationTurns,
    shared_doc_count: sharedDocs.length,
    shared_bytes: sharedBytes,
    shared_docs: sharedDocs.map((doc) => ({ name: doc.name, bytes: doc.bytes })).slice(0, 16),
    artifact_count: artifactStats.count,
    artifact_observation_count: artifactStats.observation_count,
    upload_count: artifactStats.manifest_count,
    user_fact_count: userFactCount,
    role_summary_count: roleSummaryCount,
    memory_write_event_count: writeEvents.length,
    memory_write_role_count: writeRoles.length,
    memory_write_roles: writeRoles.slice(0, 12),
    team_agent_count: teamAgents.length,
    team_roles: [...new Set(teamAgents.map((agent) => agent.role).filter(Boolean))].slice(0, 12),
    compiled_context_chars: compiledChars,
    correction_count: correction.correction_count,
    rejection_count: correction.rejection_count,
  };
}

function pushReason(reasons, condition, reason) {
  if (condition) reasons.push(reason);
}

export function estimateMemoryTopologyStress(input = {}) {
  const stats = input.stats && typeof input.stats === 'object' ? input.stats : collectMemoryStats(input);
  const reasons = [];
  const components = {
    conversation_depth: clamp(Number(stats.turn_count || 0) / 35, 0, 1.6),
    shared_doc_pressure: clamp(Number(stats.shared_doc_count || 0) / 8, 0, 1.2),
    shared_byte_pressure: clamp(Number(stats.shared_bytes || 0) / 220000, 0, 1.2),
    artifact_pressure: clamp(Number(stats.artifact_count || 0) * 0.28 + Number(stats.artifact_observation_count || 0) * 0.08, 0, 1.4),
    fact_pressure: clamp(Number(stats.user_fact_count || 0) * 0.18, 0, 1.1),
    role_summary_pressure: clamp(Number(stats.role_summary_count || 0) * 0.18, 0, 0.9),
    write_contention: clamp(Number(stats.memory_write_role_count || 0) * 0.45, 0, 1.8),
    team_pressure: clamp(Math.max(0, Number(stats.team_agent_count || 0) - 1) * 0.7, 0, 2.1),
    correction_pressure: clamp(Number(stats.correction_count || 0) * 0.22 + Number(stats.rejection_count || 0) * 0.35, 0, 1.7),
    compiled_context_pressure: clamp(Number(stats.compiled_context_chars || 0) / 70000, 0, 1.5),
  };
  pushReason(reasons, stats.turn_count > 10, 'conversation_depth');
  pushReason(reasons, stats.shared_doc_count > 3 || stats.shared_bytes > 60000, 'shared_doc_pressure');
  pushReason(reasons, stats.artifact_count > 0, 'artifact_pressure');
  pushReason(reasons, stats.user_fact_count > 0, 'typed_user_facts');
  pushReason(reasons, stats.role_summary_count > 0, 'role_summary_sidecar');
  pushReason(reasons, stats.memory_write_role_count > 1, 'multi_writer_contention');
  pushReason(reasons, stats.team_agent_count > 1, 'multi_agent_team');
  pushReason(reasons, stats.correction_count > 0 || stats.rejection_count > 0, 'correction_or_retraction');
  pushReason(reasons, stats.compiled_context_chars > 30000, 'prompt_pressure');
  const score = Number(Object.values(components).reduce((sum, value) => sum + Number(value || 0), 0).toFixed(2));
  return { score, components, reasons: [...new Set(reasons)], stats };
}

export function selectMemoryMode({ stress = null, stats = null, forceMode = '' } = {}) {
  const forced = clean(forceMode || process.env.MEMORY_TOPOLOGY_FORCE_MODE || '', { lower: true });
  if (VALID_MODES.has(forced)) return { mode: forced, reason: [`forced:${forced}`] };
  const row = stress || estimateMemoryTopologyStress({ stats });
  const s = Number(row.score || 0);
  const st = stats || row.stats || {};
  const reasons = [];
  if (Number(st.turn_count || 0) <= 2 && Number(st.artifact_count || 0) === 0 && Number(st.user_fact_count || 0) === 0 && Number(st.team_agent_count || 0) <= 1 && Number(st.role_summary_count || 0) === 0 && s < 1.2) {
    return { mode: 'ephemeral', reason: ['fresh_single_turn'] };
  }
  if (s < 3.0 && Number(st.team_agent_count || 0) <= 1 && Number(st.shared_doc_count || 0) <= 3) {
    reasons.push('single_agent_low_pressure');
    return { mode: 'compact_single', reason: reasons };
  }
  if (s < 5.4 && Number(st.team_agent_count || 0) <= 1) {
    reasons.push('single_agent_structured_pressure');
    return { mode: 'structured_single', reason: reasons };
  }
  if (s < 7.5 || Number(st.team_agent_count || 0) > 1 || Number(st.memory_write_role_count || 0) > 1) {
    reasons.push(Number(st.team_agent_count || 0) > 1 ? 'team_requires_stewards' : 'structured_context_pressure');
    return { mode: 'team_scoped', reason: reasons };
  }
  return { mode: 'graph_snapshot', reason: ['high_pressure_needs_snapshot_projection'] };
}

function surface({ id, kind = 'summary', path: filePath = '', steward = 'runtime', readers = ['*'], writers = ['runtime'], writeMode = 'runtime_append', lens = '', promotionPolicy = '' } = {}) {
  return {
    id,
    kind,
    path: filePath,
    steward: asArray(steward).length ? asArray(steward) : [steward].filter(Boolean),
    readers: asArray(readers).length ? asArray(readers) : ['*'],
    writers: asArray(writers).length ? asArray(writers) : ['runtime'],
    write_mode: writeMode,
    lens,
    promotion_policy: promotionPolicy || undefined,
  };
}

export function deriveMemorySurfaces({ mode = 'compact_single', stats = {}, jobDir = '' } = {}) {
  const hasArtifacts = Number(stats.artifact_count || stats.artifact_observation_count || 0) > 0;
  const hasFacts = Number(stats.user_fact_count || 0) > 0;
  const shared = (name) => clean(jobDir) ? path.join(jobDir, 'shared', name) : `shared/${name}`;
  const local = (name) => clean(jobDir) ? path.join(jobDir, 'local_memory', name) : `local_memory/${name}`;
  if (mode === 'ephemeral') {
    return [surface({ id: 'conversation_tail', kind: 'transient', path: local('turns.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'none', lens: 'latest request and last few turns only', promotionPolicy: 'promote_to_compact_single_after_memory_pressure' })];
  }
  if (mode === 'compact_single') {
    const rows = [
      surface({ id: 'core', kind: 'compact_summary', path: local('summary.md'), readers: ['*'], writers: ['runtime'], writeMode: 'runtime_compaction', lens: 'single shared working memory', promotionPolicy: 'split_when_topic_or_agent_pressure_high' }),
    ];
    if (hasFacts) rows.push(surface({ id: 'user_facts', kind: 'typed_facts', path: path.join(jobDir, 'user_facts.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'typed_event_append', lens: 'explicit user facts, corrections, and verified absence' }));
    if (hasArtifacts) rows.push(surface({ id: 'artifacts', kind: 'artifact_index', path: path.join(jobDir, 'artifact_observations.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'typed_event_append', lens: 'active artifact observations and rejected labels' }));
    return rows;
  }
  if (mode === 'structured_single') {
    return [
      surface({ id: 'shared_core', kind: 'summary', path: local('summary.md'), readers: ['*'], writers: ['runtime'], writeMode: 'runtime_compaction', lens: 'current task, directives, pinned facts, compact history' }),
      surface({ id: 'facts', kind: 'typed_facts', path: path.join(jobDir, 'user_facts.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'typed_event_append', lens: 'stable user facts, corrections, verified absence' }),
      surface({ id: 'artifacts', kind: 'artifact_index', path: path.join(jobDir, 'artifact_observations.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'typed_event_append', lens: 'artifact state and observations' }),
      surface({ id: 'decisions', kind: 'shared_doc', path: shared('final_answer.md'), readers: ['*'], writers: ['runtime', 'synthesizer', 'operator'], writeMode: 'contracted_append', lens: 'decisions and final deliverables' }),
    ];
  }
  if (mode === 'team_scoped') {
    return [
      surface({ id: 'shared_core', kind: 'summary', path: local('summary.md'), readers: ['*'], writers: ['runtime'], writeMode: 'runtime_compaction', lens: 'common current task and constraints' }),
      surface({ id: 'research', kind: 'team_surface', path: shared('research.md'), steward: ['researcher', 'reviewer'], readers: ['researcher', 'reviewer', 'builder', 'synthesizer', 'operator'], writers: ['researcher', 'reviewer', 'runtime'], writeMode: 'contracted_append', lens: 'evidence, context recovery, uncertainties' }),
      surface({ id: 'implementation', kind: 'team_surface', path: shared('progress.md'), steward: ['builder'], readers: ['builder', 'reviewer', 'synthesizer', 'operator'], writers: ['builder', 'runtime'], writeMode: 'contracted_append', lens: 'implementation progress, patches, commands' }),
      surface({ id: 'review', kind: 'team_surface', path: shared('review_findings.md'), steward: ['reviewer'], readers: ['reviewer', 'builder', 'synthesizer', 'operator'], writers: ['reviewer', 'runtime'], writeMode: 'contracted_append', lens: 'defects, risks, verification results' }),
      surface({ id: 'decisions', kind: 'team_surface', path: shared('decisions.md'), steward: ['synthesizer', 'operator'], readers: ['*'], writers: ['synthesizer', 'operator', 'runtime'], writeMode: 'contracted_append', lens: 'decisions, rationale, final state' }),
      surface({ id: 'artifacts', kind: 'artifact_index', path: path.join(jobDir, 'artifact_observations.jsonl'), steward: ['builder', 'reviewer'], readers: ['*'], writers: ['runtime', 'builder', 'reviewer'], writeMode: 'typed_event_append', lens: 'artifact state and validation' }),
    ];
  }
  return [
    surface({ id: 'context_graph', kind: 'typed_graph', path: path.join(jobDir, 'context_events.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'snapshot_projection', lens: 'typed context event graph' }),
    surface({ id: 'projection_certificates', kind: 'certificate_log', path: path.join(jobDir, 'projection_certificates.jsonl'), readers: ['*'], writers: ['runtime'], writeMode: 'certificate_append', lens: 'read_set/protected_set projection audit' }),
    surface({ id: 'write_intents', kind: 'intent_log', path: path.join(jobDir, 'context_write_intents.jsonl'), readers: ['operator', 'reviewer', 'synthesizer'], writers: ['*'], writeMode: 'write_intent_only', lens: 'agent writes validated at commit time' }),
    ...deriveMemorySurfaces({ mode: 'team_scoped', stats, jobDir }).filter((row) => row.id !== 'artifacts'),
  ];
}

function roleGroup(roleId = '', provider = '') {
  const role = clean(roleId, { lower: true });
  const prov = clean(provider, { lower: true });
  if (['builder', 'coder', 'developer', 'engineer'].includes(role) || prov === 'codex') return 'builder';
  if (['researcher', 'scout', 'analyst'].includes(role)) return 'researcher';
  if (['reviewer', 'critic', 'judge'].includes(role)) return 'reviewer';
  if (['synthesizer', 'operator', 'chair', 'planner', 'router'].includes(role) || prov === 'chatgpt') return 'synthesizer';
  return role || 'general';
}

function surfaceReadableBy(surfaceRow = {}, role = '') {
  const readers = asArray(surfaceRow.readers).map((entry) => clean(entry, { lower: true })).filter(Boolean);
  return readers.includes('*') || readers.includes(role);
}

function surfaceWritableBy(surfaceRow = {}, role = '') {
  const writers = asArray(surfaceRow.writers).map((entry) => clean(entry, { lower: true })).filter(Boolean);
  return writers.includes('*') || writers.includes(role) || writers.includes('runtime');
}

export function assignAgentMemoryGrants({ mode = 'compact_single', surfaces = [], agents = [], roleId = '', agentId = '', provider = '' } = {}) {
  const candidates = asArray(agents).length ? asArray(agents) : [{ role: clean(roleId, { lower: true }) || 'agent', id: clean(agentId || roleId || 'agent', { lower: true }), provider: clean(provider, { lower: true }) }];
  const grants = {};
  for (const agent of candidates) {
    const role = roleGroup(agent.role || agent.role_id || agent.roleId, agent.provider || provider);
    const key = clean(agent.id || agent.agent_id || agent.agentId || agent.role || role, { lower: true }) || role;
    let read = [];
    let write = [];
    if (mode === 'ephemeral') {
      read = ['conversation_tail'];
      write = [];
    } else if (mode === 'compact_single') {
      read = surfaces.map((row) => row.id).filter(Boolean);
      write = ['core'];
    } else if (mode === 'structured_single') {
      read = surfaces.map((row) => row.id).filter(Boolean);
      write = role === 'builder' ? ['shared_core', 'artifacts'] : role === 'reviewer' ? ['shared_core', 'decisions'] : ['shared_core', 'decisions'];
    } else {
      read = surfaces.filter((row) => surfaceReadableBy(row, role)).map((row) => row.id);
      if (!read.includes('shared_core') && surfaces.some((row) => row.id === 'shared_core')) read.unshift('shared_core');
      write = surfaces.filter((row) => surfaceWritableBy(row, role)).map((row) => row.id);
      if (role === 'builder' && !write.includes('implementation')) write.push('implementation');
      if (role === 'researcher' && !write.includes('research')) write.push('research');
      if (role === 'reviewer' && !write.includes('review')) write.push('review');
      if (['synthesizer', 'operator'].includes(role) && !write.includes('decisions')) write.push('decisions');
    }
    grants[key] = {
      agent_id: key,
      role,
      provider: clean(agent.provider || provider, { lower: true }) || undefined,
      read: [...new Set(read.filter(Boolean))],
      write: [...new Set(write.filter(Boolean))],
      lens: role === 'builder'
        ? 'implementation and artifact-delivery lens over shared context'
        : role === 'researcher'
          ? 'evidence and uncertainty lens over shared context'
          : role === 'reviewer'
            ? 'verification and risk lens over shared context'
            : 'synthesis and decision lens over shared context',
      write_mode: mode === 'graph_snapshot' ? 'write_intent_only' : (mode === 'ephemeral' ? 'none' : 'contracted_or_runtime_append'),
    };
  }
  return grants;
}

function compactForCompare(topology = {}) {
  const row = asObject(topology);
  return JSON.stringify({ mode: row.mode, surfaces: row.surfaces, agent_grants: row.agent_grants, stress_score: Number(row.stress?.score || 0).toFixed(2) });
}

export function loadMemoryTopology({ jobDir = '' } = {}) {
  const dir = localMemoryDir(jobDir);
  if (!dir) return null;
  return safeJsonParse(safeRead(path.join(dir, TOPOLOGY_FILE)));
}

export function writeMemoryTopology({ jobDir = '', topology = {}, previous = null, eventReason = 'refresh' } = {}) {
  const dir = localMemoryDir(jobDir);
  if (!dir) return null;
  const next = { ...asObject(topology), updated_at: new Date().toISOString() };
  if (!next.created_at) next.created_at = asObject(previous).created_at || next.updated_at;
  fs.writeFileSync(path.join(dir, TOPOLOGY_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  try { syncTrackingFilesView({ jobDir, topology: next }); } catch {}
  if (!previous || compactForCompare(previous) !== compactForCompare(next)) {
    const event = {
      ts: next.updated_at,
      kind: 'memory_topology_event',
      reason: eventReason,
      previous_mode: previous?.mode || null,
      next_mode: next.mode,
      stress_score: next.stress?.score,
      reasons: next.stress?.reasons || next.selection_reason || [],
      surface_count: asArray(next.surfaces).length,
    };
    fs.appendFileSync(path.join(dir, TOPOLOGY_EVENTS_FILE), `${JSON.stringify(event)}\n`, 'utf8');
  }
  return next;
}

export function planMemoryTopology(input = {}) {
  const jobDir = clean(input.jobDir || input.job_dir);
  if (!jobDir) throw new Error('jobDir is required');
  const previous = loadMemoryTopology({ jobDir });
  const stats = collectMemoryStats(input);
  const stress = estimateMemoryTopologyStress({ stats });
  const selected = selectMemoryMode({ stress, stats, forceMode: input.forceMode || input.force_mode });
  const surfaces = deriveMemorySurfaces({ mode: selected.mode, stats, jobDir });
  const agents = teamAgentsFrom(input);
  const agentGrants = assignAgentMemoryGrants({ mode: selected.mode, surfaces, agents, roleId: input.roleId || input.role_id, agentId: input.agentId || input.agent_id, provider: input.provider });
  const topology = {
    version: 1,
    mode: selected.mode,
    state: selected.mode === 'ephemeral' ? 'flat_ephemeral' : selected.mode,
    selection_reason: selected.reason,
    stress,
    stats,
    surfaces,
    agent_grants: agentGrants,
    maintenance: buildMemoryMaintenancePlan({ mode: selected.mode, stress, stats, previous }),
    previous_mode: previous?.mode || undefined,
    created_at: previous?.created_at || new Date().toISOString(),
  };
  if (input.persist === false) return topology;
  return writeMemoryTopology({ jobDir, topology, previous, eventReason: input.eventReason || input.event_reason || 'plan' });
}

export function getAgentMemoryGrant(topology = {}, { agentId = '', roleId = '', provider = '' } = {}) {
  const grants = asObject(topology.agent_grants);
  const keys = [agentId, roleId, roleGroup(roleId, provider), 'agent']
    .map((entry) => clean(entry, { lower: true }))
    .filter(Boolean);
  for (const key of keys) {
    if (grants[key]) return grants[key];
  }
  return assignAgentMemoryGrants({ mode: topology.mode || 'compact_single', surfaces: topology.surfaces || [], roleId, agentId, provider })[clean(agentId || roleId || 'agent', { lower: true })] || null;
}

export function shouldIncludeRoleLocalMemory(topology = {}, grant = null) {
  const mode = clean(topology.mode, { lower: true });
  if (mode === 'ephemeral') return false;
  // In compact_single mode role summaries are allowed only as a small lens-sidecar;
  // they are not treated as separate steward-owned memory surfaces.
  if (mode === 'compact_single') return true;
  const write = new Set(asArray(grant?.write).map((entry) => clean(entry, { lower: true })));
  const read = new Set(asArray(grant?.read).map((entry) => clean(entry, { lower: true })));
  return ['research', 'implementation', 'review', 'decisions', 'shared_core'].some((id) => read.has(id) || write.has(id));
}

export function buildMemoryTopologyPromptBlock(topology = {}, grant = null) {
  const row = asObject(topology);
  const mode = clean(row.mode, { lower: true }) || 'compact_single';
  const g = asObject(grant);
  const read = asArray(g.read).join(', ') || '(none)';
  const write = asArray(g.write).join(', ') || '(none)';
  const reasons = asArray(row.stress?.reasons || row.selection_reason).slice(0, 5).join(', ') || 'low_pressure';
  return [
    '[MEMORY TOPOLOGY]',
    `mode=${mode}`,
    `stress=${Number(row.stress?.score || 0).toFixed(2)} reasons=${reasons}`,
    g.role ? `agent_role=${g.role}` : '',
    `read_surfaces=${read}`,
    `write_surfaces=${write}`,
    `write_mode=${g.write_mode || (mode === 'graph_snapshot' ? 'write_intent_only' : 'contracted_or_runtime_append')}`,
    '- Start flat: use the shared/core memory first. Do not invent new memory files.',
    '- Split or specialize memory only when the topology mode says pressure is high enough.',
    '- Latest user request, corrections, and verified absences override older summaries.',
  ].filter(Boolean).join('\n');
}

export function buildMemoryMaintenancePlan({ mode = 'compact_single', stress = {}, stats = {}, previous = null } = {}) {
  const actions = [];
  if (mode === 'ephemeral') {
    actions.push({ action: 'defer_persistent_memory', reason: 'fresh low-pressure turn', destructive: false });
  }
  if (mode === 'compact_single') {
    actions.push({ action: 'refresh_core_summary', target: 'local_memory/summary.md', reason: 'keep single memory compact', destructive: false });
    if (Number(stats.shared_doc_count || 0) > 3) actions.push({ action: 'merge_low_value_surfaces', reason: 'compact mode should avoid premature surface sprawl', destructive: false, candidate_only: true });
  }
  if (mode === 'structured_single') {
    actions.push({ action: 'split_core_into_semantic_surfaces', reason: 'single agent context pressure', destructive: false, candidate_only: true });
    actions.push({ action: 'pin_corrections_and_artifacts', reason: 'preserve high-priority typed context', destructive: false });
  }
  if (mode === 'team_scoped') {
    actions.push({ action: 'assign_surface_stewards', reason: 'multiple agents or writers detected', destructive: false });
    actions.push({ action: 'build_cross_surface_digest', reason: 'avoid isolated agent context', destructive: false });
  }
  if (mode === 'graph_snapshot') {
    actions.push({ action: 'prepare_context_event_log', reason: 'high pressure needs snapshot projection', destructive: false, candidate_only: true });
    actions.push({ action: 'route_agent_writes_to_intents', reason: 'avoid stale concurrent writes', destructive: false, candidate_only: true });
  }
  if (previous?.mode && previous.mode !== mode) {
    actions.unshift({ action: 'record_topology_transition', from: previous.mode, to: mode, reason: `stress=${Number(stress?.score || 0).toFixed(2)}`, destructive: false });
  }
  return {
    generated_at: new Date().toISOString(),
    idle_safe: true,
    destructive_changes: false,
    actions,
  };
}

export function formatMemoryTopologyForTelegram(topology = {}) {
  const row = asObject(topology);
  const stats = asObject(row.stats);
  const grantRows = Object.values(asObject(row.agent_grants)).slice(0, 8);
  const surfaces = asArray(row.surfaces).slice(0, 10);
  return [
    '🧠 memory topology',
    `- mode: ${row.mode || 'unknown'}`,
    `- stress: ${Number(row.stress?.score || 0).toFixed(2)} (${asArray(row.stress?.reasons || row.selection_reason).join(', ') || 'low_pressure'})`,
    `- stats: turns=${stats.turn_count || 0}, artifacts=${stats.artifact_count || 0}, facts=${stats.user_fact_count || 0}, shared_docs=${stats.shared_doc_count || 0}, agents=${stats.team_agent_count || 0}, writer_roles=${stats.memory_write_role_count || 0}, role_summaries=${stats.role_summary_count || 0}`,
    '',
    'Surfaces:',
    ...(surfaces.length ? surfaces.map((s) => `- ${s.id}: ${s.kind}; readers=${asArray(s.readers).join(',')}; writers=${asArray(s.writers).join(',')}; steward=${asArray(s.steward).join(',')}`) : ['- (none)']),
    '',
    'Agent grants:',
    ...(grantRows.length ? grantRows.map((g) => `- ${g.agent_id || g.role}: read=[${asArray(g.read).join(', ')}], write=[${asArray(g.write).join(', ')}], mode=${g.write_mode}`) : ['- (none)']),
    '',
    'Idle maintenance:',
    ...asArray(row.maintenance?.actions).slice(0, 8).map((a) => `- ${a.action}${a.target ? ` -> ${a.target}` : ''}: ${a.reason || ''}${a.candidate_only ? ' (candidate)' : ''}`),
  ].join('\n');
}

export function readMemoryTopologyEvents({ jobDir = '', limit = 20 } = {}) {
  const rows = readJsonl(path.join(jobDir, 'local_memory', TOPOLOGY_EVENTS_FILE));
  return rows.slice(-Math.max(1, Math.floor(Number(limit) || 20)));
}

export { TOPOLOGY_FILE as MEMORY_TOPOLOGY_FILE, TOPOLOGY_EVENTS_FILE as MEMORY_TOPOLOGY_EVENTS_FILE };
