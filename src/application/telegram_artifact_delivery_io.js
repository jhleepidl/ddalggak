import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { formatByteSize } from '../adapters/telegram/uploads.js';
import { createZipBundle } from './telegram_zip_bundle_io.js';
import { WORKSPACE_ARTIFACT_PUBLISH_MANIFEST } from './cli_workspace_contract.js';
import { summarizeRoleMemoryEnforcement } from '../knowledge_base/runtime.js';
import * as runtimeState from './telegram_runtime_state.js';
import { formatActiveArtifactContext } from './artifact_context.js';

const {
  TELEGRAM_SEND_MAX_BYTES,
  jobs,
  tracking,
  runDir,
  runWorkspaceDir,
  resolveWorkspacePath,
  runSharedDir,
} = runtimeState;

const ARTIFACT_INDEX_FILE = 'artifact_index.json';
const WORKSPACE_FILE_SKIP_DIRS = new Set(['uploads', 'outputs', '.git', 'node_modules', '.codex', '.gemini', '.orchestrator']);
const WORKSPACE_FILE_SKIP_NAMES = new Set(['GEMINI.md']);

function asArrayLocal(raw) {
  return Array.isArray(raw) ? raw : [];
}

function asObjectLocal(raw) {
  return raw && typeof raw === 'object' ? raw : {};
}

function cleanLowerId(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

function uniqueStrings(rows = []) {
  const seen = new Set();
  const out = [];
  for (const entry of asArrayLocal(rows)) {
    const value = String(entry || '').trim();
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function formatFileMtime(mtimeMs = 0) {
  if (!Number.isFinite(Number(mtimeMs)) || Number(mtimeMs) <= 0) return '-';
  try {
    return new Date(Number(mtimeMs)).toISOString();
  } catch {
    return '-';
  }
}

function isInternalWorkspaceSupportFile(relPath = '') {
  const cleanRel = String(relPath || '').trim().replace(/\\/g, '/');
  if (!cleanRel) return false;
  const base = path.basename(cleanRel);
  if (WORKSPACE_FILE_SKIP_NAMES.has(base)) return true;
  if (cleanRel.startsWith('.orchestrator/')) return true;
  if (cleanRel.startsWith('.codex/')) return true;
  return false;
}

function listWorkspaceFilesRecursive(rootDir, { skipDirNames = null, includeHiddenFiles = false } = {}) {
  const out = [];
  const stack = [String(rootDir || '')];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = String(entry?.name || '').trim();
      if (!name || name === '.' || name === '..') continue;
      if (name.startsWith('.telegram_')) continue;
      if (!includeHiddenFiles && name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      if (entry.isDirectory()) {
        if (skipDirNames && skipDirNames.has(name)) continue;
        stack.push(abs);
        continue;
      }
      if (entry.isFile()) out.push(abs);
    }
  }
  return out;
}

function normalizeWorkspaceScope(raw = '') {
  const scope = String(raw || '').trim().toLowerCase();
  if (scope === 'uploads' || scope === 'workspace' || scope === 'all') return scope;
  if (scope === 'artifacts' || scope === 'outputs') return 'workspace';
  return 'all';
}

function collectWorkspaceFileEntries(jobId, { scope = 'all' } = {}) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return [];
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const normalizedScope = normalizeWorkspaceScope(scope);
  const targets = [];
  if (normalizedScope === 'all' || normalizedScope === 'uploads') {
    targets.push({
      bucket: 'uploads',
      dir: resolveWorkspacePath(cleanJobId, 'uploads', { asDirectory: true }),
      skipDirNames: null,
      includeHiddenFiles: false,
    });
  }
  if (normalizedScope === 'all' || normalizedScope === 'workspace') {
    targets.push({
      bucket: 'workspace',
      dir: workspaceRoot,
      skipDirNames: WORKSPACE_FILE_SKIP_DIRS,
      includeHiddenFiles: false,
    });
  }

  const out = [];
  for (const target of targets) {
    const files = listWorkspaceFilesRecursive(target.dir, {
      skipDirNames: target.skipDirNames,
      includeHiddenFiles: target.includeHiddenFiles,
    });
    for (const abs of files) {
      let stat = null;
      try {
        stat = fs.statSync(abs);
      } catch {
        stat = null;
      }
      if (!stat || !stat.isFile()) continue;
      const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
      if (!rel || rel.startsWith('..') || isInternalWorkspaceSupportFile(rel)) continue;
      out.push({
        bucket: target.bucket,
        abs,
        rel,
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      });
    }
  }
  out.sort((a, b) => Number(b.mtimeMs || 0) - Number(a.mtimeMs || 0));
  return out;
}

function formatWorkspaceFileListText(jobId, entries = [], { scope = 'all', limit = 20 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const normalizedScope = normalizeWorkspaceScope(scope);
  const lines = [
    `job_id=${cleanJobId}`,
    `scope=${normalizedScope}`,
    `limit=${limit}`,
  ];
  if (!Array.isArray(entries) || entries.length === 0) {
    lines.push('- (no files)');
    return lines.join('\n');
  }
  for (const row of entries) {
    lines.push(`- ${row.rel} (${formatByteSize(row.size)}, mtime=${formatFileMtime(row.mtimeMs)})`);
  }
  return lines.join('\n');
}

function buildWorkspaceFilesPromptSection(jobId, { limitPerBucket = 5 } = {}) {
  const limit = Number.isFinite(Number(limitPerBucket))
    ? Math.max(1, Math.min(20, Math.floor(Number(limitPerBucket))))
    : 5;
  const uploads = collectWorkspaceFileEntries(jobId, { scope: 'uploads' }).slice(0, limit);
  const workspaceFiles = collectWorkspaceFileEntries(jobId, { scope: 'workspace' }).slice(0, limit);
  const activeArtifactContext = formatActiveArtifactContext(runDir(jobId), { maxChars: 1600, limit });
  const render = (rows) => (
    rows.length > 0
      ? rows.map((row) => `- ${row.rel} (${formatByteSize(row.size)})`).join('\n')
      : '- (none)'
  );
  return [
    activeArtifactContext,
    'workspace 파일 목록(최근):',
    'uploads:',
    render(uploads),
    'workspace artifacts:',
    render(workspaceFiles),
    '지시:',
    '- 필요하면 uploads/ 경로의 파일 내용을 참고해라.',
    '- 최종 산출물은 원래 workspace 경로에 유지된다. outputs/ 복사본을 만들지 마라.',
    '- 내부 지원 파일(GEMINI.md, .codex/*, .orchestrator/*)은 사용자 산출물 후보에서 제외된다.',
    '- 매우 큰 파일은 목록만 참고하고 필요한 부분만 선택해 사용해라.',
  ].filter(Boolean).join('\n');
}

function artifactIndexPath(jobId) {
  return path.join(runDir(jobId), ARTIFACT_INDEX_FILE);
}

function loadArtifactIndex(jobId) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return { job_id: '', updated_at: new Date().toISOString(), notes: [], artifacts: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(artifactIndexPath(cleanJobId), 'utf8'));
    const artifacts = Array.isArray(parsed?.artifacts)
      ? parsed.artifacts.map((row) => ({
        id: String(row?.id || '').trim(),
        path: String(row?.path || '').trim(),
        label: String(row?.label || '').trim(),
        kind: String(row?.kind || '').trim(),
        source: String(row?.source || '').trim(),
        size: Number(row?.size || 0),
        mtime_ms: Number(row?.mtime_ms || row?.mtimeMs || 0),
        sendable: row?.sendable !== false,
        final: row?.final !== false,
      })).filter((row) => row.path)
      : [];
    return {
      job_id: String(parsed?.job_id || cleanJobId).trim() || cleanJobId,
      updated_at: String(parsed?.updated_at || new Date().toISOString()),
      notes: uniqueStrings(asArrayLocal(parsed?.notes).map((entry) => String(entry || '').trim()).filter(Boolean)),
      artifacts,
    };
  } catch {
    return { job_id: cleanJobId, updated_at: new Date().toISOString(), notes: [], artifacts: [] };
  }
}

function inferArtifactKind(relPath = '') {
  const ext = path.extname(String(relPath || '').trim()).toLowerCase();
  if (['.md', '.txt', '.pdf', '.doc', '.docx'].includes(ext)) return 'document';
  if (['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.rb', '.php', '.c', '.cpp', '.h', '.hpp', '.json', '.yaml', '.yml', '.toml', '.ini', '.sh', '.sql'].includes(ext)) return 'code';
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg'].includes(ext)) return 'image';
  if (['.csv', '.tsv', '.xlsx', '.parquet', '.ipynb'].includes(ext)) return 'data';
  if (['.zip', '.tar', '.gz', '.tgz'].includes(ext)) return 'archive';
  return 'file';
}

function normalizeWorkspaceArtifactManifest(raw = {}) {
  const row = asObjectLocal(raw);
  const artifacts = asArrayLocal(row.artifacts).map((entry) => {
    const item = asObjectLocal(entry);
    const rel = String(item.path || item.relative_path || item.relativePath || '').trim().replace(/\\/g, '/').replace(/^workspace\//i, '').replace(/^\.\//, '');
    if (!rel) return null;
    return {
      path: rel,
      label: String(item.label || '').trim() || path.basename(rel),
      kind: String(item.kind || '').trim().toLowerCase() || '',
      final: item.final !== false,
      note: String(item.note || '').trim(),
    };
  }).filter(Boolean);
  const notes = uniqueStrings(asArrayLocal(row.notes).map((entry) => String(entry || '').trim()).filter(Boolean));
  return { artifacts, notes };
}

function loadWorkspaceArtifactManifest(jobId = '') {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return { artifacts: [], notes: [] };
  try {
    const manifestPath = jobs.resolveWorkspacePath(cleanJobId, WORKSPACE_ARTIFACT_PUBLISH_MANIFEST);
    if (!fs.existsSync(manifestPath)) return { artifacts: [], notes: [] };
    return normalizeWorkspaceArtifactManifest(JSON.parse(String(fs.readFileSync(manifestPath, 'utf8') || '{}')));
  } catch {
    return { artifacts: [], notes: [] };
  }
}

function renderArtifactIndexMarkdown(artifactIndex = null) {
  const row = artifactIndex && typeof artifactIndex === 'object' ? artifactIndex : { artifacts: [] };
  const artifacts = Array.isArray(row.artifacts) ? row.artifacts : [];
  const notes = uniqueStrings(asArrayLocal(row.notes));
  const lines = [
    '# Artifact Index',
    '',
    `- job_id: ${String(row.job_id || '').trim()}`,
    `- updated_at: ${String(row.updated_at || '').trim()}`,
    `- count: ${artifacts.length}`,
  ];
  if (notes.length > 0) lines.push('', '## Notes', ...notes.map((entry) => `- ${entry}`));
  lines.push('', '## Artifacts');
  if (artifacts.length === 0) return `${[...lines, '- (artifacts not detected yet)'].join('\n')}\n`;
  for (const artifact of artifacts) {
    const flags = [artifact.kind, artifact.final ? 'final' : '', artifact.sendable === false ? 'too_large' : ''].filter(Boolean);
    const label = String(artifact.label || '').trim();
    const display = label && label !== path.basename(String(artifact.path || '').trim())
      ? `${label} — ${artifact.path}`
      : artifact.path;
    lines.push(`- ${display}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

function resolveArtifactDeliveryContract(jobId, runtime = null) {
  const cleanJobId = String(jobId || '').trim();
  const activeTeam = runtime?.activeTeamConfig && typeof runtime.activeTeamConfig === 'object'
    ? runtime.activeTeamConfig
    : null;
  if (!cleanJobId || !activeTeam) {
    return {
      enabled: false,
      warnings: [],
      artifact_publishers: [],
      final_owner_label: '',
      final_owner_can_publish_final_answer: true,
      bundle_allowed: true,
      send_allowed: true,
      required_surface_ids: [],
    };
  }
  let profile = null;
  try {
    profile = tracking.loadProfile(cleanJobId);
  } catch {
    profile = null;
  }
  const structure = activeTeam?.structure_v2 && typeof activeTeam.structure_v2 === 'object' ? activeTeam.structure_v2 : {};
  const participants = asArrayLocal(structure?.participants);
  const agents = asArrayLocal(activeTeam?.agents);
  const finalOwnerId = cleanLowerId(
    structure?.control_policy?.final_answer_owner_participant_id
    || structure?.control_policy?.finalAnswerOwnerParticipantId
    || structure?.topology?.final_participant_id
    || structure?.topology?.finalParticipantId
    || ''
  );
  const finalOwnerName = String(activeTeam?.interaction_spec?.final_answer_owner || '').trim();
  const participantById = new Map();
  const participantByName = new Map();
  for (const row of participants) {
    const item = asObjectLocal(row);
    const pid = cleanLowerId(item.participant_id || item.agent_id || item.id || '');
    const nameKey = cleanLowerId(item.name || item.label || '');
    if (pid) participantById.set(pid, item);
    if (nameKey && !participantByName.has(nameKey)) participantByName.set(nameKey, item);
  }
  const agentRecords = [];
  const seen = new Set();
  const pushAgent = (row = {}) => {
    const item = asObjectLocal(row);
    const agentId = cleanLowerId(item.agent_id || item.participant_id || item.id || '');
    const name = String(item.name || item.label || item.display_label || item.displayLabel || '').trim();
    const roleId = cleanLowerId(item.role || item.role_id || item.roleId || participantById.get(agentId)?.role || participantByName.get(cleanLowerId(name))?.role || '');
    const provider = cleanLowerId(item.provider || participantById.get(agentId)?.provider || participantByName.get(cleanLowerId(name))?.provider || '');
    const key = `${agentId}|${name.toLowerCase()}|${roleId}`;
    if (!roleId || seen.has(key)) return;
    seen.add(key);
    agentRecords.push({ agent_id: agentId, name, role_id: roleId, provider });
  };
  for (const row of agents) pushAgent(row);
  for (const row of participants) pushAgent(row);
  const summaries = agentRecords.map((agent) => ({
    ...agent,
    summary: summarizeRoleMemoryEnforcement({
      profile,
      provider: agent.provider,
      roleId: agent.role_id,
    }),
  }));
  let finalOwner = null;
  if (finalOwnerId) finalOwner = summaries.find((row) => cleanLowerId(row.agent_id) === finalOwnerId) || null;
  if (!finalOwner && finalOwnerName) finalOwner = summaries.find((row) => cleanLowerId(row.name) === cleanLowerId(finalOwnerName)) || null;
  const artifactPublishers = summaries
    .filter((row) => row.summary?.can_publish_artifact_index)
    .map((row) => String(row.name || row.agent_id || row.role_id || '').trim())
    .filter(Boolean);
  const warnings = [];
  if (finalOwnerId || finalOwnerName) {
    if (!finalOwner) warnings.push(`final answer owner를 현재 team roster에서 찾지 못했습니다. (${finalOwnerName || finalOwnerId})`);
    else if (finalOwner.summary?.can_publish_final_answer !== true) warnings.push(`final answer owner ${finalOwner.name || finalOwner.agent_id}가 final_answer surface를 publish할 수 없습니다.`);
  }
  if (artifactPublishers.length === 0) warnings.push('artifact_index publish 권한을 가진 participant가 없어 /send bundle 을 진행할 수 없습니다.');
  return {
    enabled: true,
    warnings,
    artifact_publishers: uniqueStrings(artifactPublishers),
    final_owner_label: String(finalOwner?.name || finalOwnerName || finalOwnerId || '').trim(),
    final_owner_can_publish_final_answer: finalOwner ? finalOwner.summary?.can_publish_final_answer === true : !(finalOwnerId || finalOwnerName),
    bundle_allowed: artifactPublishers.length > 0,
    send_allowed: true,
    required_surface_ids: ['artifact_index', 'final_answer'],
  };
}

function formatArtifactDeliveryContractLines(contract = null) {
  const row = contract && typeof contract === 'object' ? contract : null;
  if (!row?.enabled) return [];
  const lines = [`contract: bundle=${row.bundle_allowed ? 'allowed' : 'blocked'} · final_owner=${row.final_owner_label || '(unset)'}`];
  if (Array.isArray(row.artifact_publishers) && row.artifact_publishers.length > 0) lines.push(`artifact_publishers: ${row.artifact_publishers.join(', ')}`);
  if (Array.isArray(row.warnings)) {
    for (const warning of row.warnings.slice(0, 3)) lines.push(`warning: ${String(warning || '').trim()}`);
  }
  return lines;
}

function collectExecutionArtifactPathCandidates(execution = null) {
  const out = [];
  const seen = new Set();
  for (const row of Array.isArray(execution?.outputs) ? execution.outputs : []) {
    const item = row && typeof row === 'object' ? row : {};
    const rel = String(item.relativePath || item.relative_path || item.path || item.artifact_path || item.artifactPath || '').trim();
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length >= 16) break;
  }
  return out;
}

function buildArtifactIndexEntries(jobId, { execution = null, maxFiles = 12 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const executionRefs = collectExecutionArtifactPathCandidates(execution);
  const workspaceArtifactManifest = loadWorkspaceArtifactManifest(cleanJobId);
  const workspaceFiles = collectWorkspaceFileEntries(cleanJobId, { scope: 'workspace' });
  const fileMetaByRel = new Map(workspaceFiles.map((row) => [row.rel, row]));
  const out = [];
  const seen = new Set();

  const pushEntry = (rel, source = 'workspace_recent', final = false, overrides = {}) => {
    const cleanRel = String(rel || '').trim().replace(/\\/g, '/').replace(/^workspace\//i, '').replace(/^\.\//, '');
    if (!cleanRel || cleanRel.startsWith('uploads/') || cleanRel.startsWith('outputs/') || isInternalWorkspaceSupportFile(cleanRel)) return;
    if (seen.has(cleanRel)) return;
    let meta = fileMetaByRel.get(cleanRel) || null;
    if (!meta) {
      let abs = null;
      try {
        abs = jobs.resolveWorkspacePath(cleanJobId, cleanRel);
      } catch {
        abs = null;
      }
      if (!abs) return;
      let stat = null;
      try { stat = fs.statSync(abs); } catch { stat = null; }
      if (!stat || !stat.isFile()) return;
      meta = {
        abs,
        rel: path.relative(workspaceRoot, abs).replace(/\\/g, '/'),
        size: Number(stat.size || 0),
        mtimeMs: Number(stat.mtimeMs || 0),
      };
    }
    if (!meta.rel || meta.rel.startsWith('.') || meta.rel.includes('/.')) return;
    seen.add(meta.rel);
    out.push({
      id: `artifact_${out.length + 1}`,
      path: meta.rel,
      label: String(overrides.label || '').trim() || path.basename(meta.rel),
      kind: String(overrides.kind || '').trim().toLowerCase() || inferArtifactKind(meta.rel),
      source,
      size: Number(meta.size || 0),
      mtime_ms: Number(meta.mtimeMs || 0),
      sendable: Number(meta.size || 0) <= TELEGRAM_SEND_MAX_BYTES,
      final,
    });
  };

  for (const entry of workspaceArtifactManifest.artifacts) pushEntry(entry.path, 'workspace_manifest', entry.final !== false, entry);
  for (const rel of executionRefs) pushEntry(rel, 'execution_ref', true);
  for (const row of workspaceFiles) pushEntry(row.rel, 'workspace_recent', out.length < 3);

  return out.slice(0, Math.max(1, Math.min(24, Math.floor(Number(maxFiles) || 12))));
}

function refreshArtifactIndex(jobId, { execution = null, maxFiles = 12 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId) return { job_id: '', updated_at: new Date().toISOString(), artifacts: [] };
  const manifest = loadWorkspaceArtifactManifest(cleanJobId);
  const artifactIndex = {
    job_id: cleanJobId,
    updated_at: new Date().toISOString(),
    notes: manifest.notes,
    artifacts: buildArtifactIndexEntries(cleanJobId, { execution, maxFiles }),
  };
  try {
    fs.writeFileSync(artifactIndexPath(cleanJobId), `${JSON.stringify(artifactIndex, null, 2)}\n`, 'utf8');
  } catch {}
  try {
    fs.writeFileSync(path.join(runSharedDir(cleanJobId), 'artifact_index.md'), renderArtifactIndexMarkdown(artifactIndex), 'utf8');
  } catch {}
  return artifactIndex;
}

function formatArtifactIndexText(jobId, artifactIndex = null, { limit = 8 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const normalized = artifactIndex && typeof artifactIndex === 'object'
    ? artifactIndex
    : loadArtifactIndex(cleanJobId);
  const rows = Array.isArray(normalized?.artifacts) ? normalized.artifacts.slice(0, Math.max(1, Math.min(24, Math.floor(Number(limit) || 8)))) : [];
  const lines = [
    `job_id=${cleanJobId}`,
    `count=${rows.length}`,
    `updated_at=${String(normalized?.updated_at || '')}`,
  ];
  if (rows.length === 0) {
    lines.push('- (artifacts not detected yet)');
    return lines.join('\n');
  }
  rows.forEach((row, index) => {
    const flags = [];
    if (row.final) flags.push('final');
    if (!row.sendable) flags.push('too_large');
    if (row.kind) flags.push(row.kind);
    lines.push(`${index + 1}. ${row.path} (${formatByteSize(row.size || 0)}${flags.length > 0 ? `, ${flags.join(', ')}` : ''})`);
  });
  return lines.join('\n');
}

async function maybeSendArtifactSummary(bot, chatId, jobId, { execution = null, replyToMessageId = null, maxFiles = 5 } = {}) {
  const cleanJobId = String(jobId || '').trim();
  if (!cleanJobId || !bot || chatId == null) return null;
  const artifactIndex = refreshArtifactIndex(cleanJobId, { execution, maxFiles: Math.max(3, maxFiles) });
  const rows = Array.isArray(artifactIndex.artifacts) ? artifactIndex.artifacts.slice(0, Math.max(1, Math.min(12, Math.floor(Number(maxFiles) || 5)))) : [];
  if (rows.length === 0) return artifactIndex;
  const lines = [
    '📦 주요 산출물 후보를 찾았어요.',
    `job_id=${cleanJobId}`,
    ...rows.map((row, index) => `${index + 1}. ${row.path} (${formatByteSize(row.size || 0)}${row.sendable ? '' : ', too_large'})`),
    '',
    `예: /send 1 또는 /send ${rows[0]?.path || 'path/to/file'}`,
    '여러 파일은 /send bundle 1,2,3 처럼 zip으로 받을 수 있어요.',
    '파일을 받으려면 /send <번호|path> 또는 /send bundle <번호,번호|path,...> 를 사용하세요.',
  ];
  await bot.sendMessage(
    chatId,
    lines.join('\n'),
    Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
      ? { reply_to_message_id: Number(replyToMessageId) }
      : undefined,
  );
  return artifactIndex;
}

async function maybeAutoSendOutputs() {
  return null;
}

async function sendWorkspaceFileByRelativePath(bot, chatId, jobId, relativePath, { replyToMessageId = null } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const requested = String(relativePath || '').trim().replace(/^workspace\//i, '').replace(/^\.\//, '');
  if (!cleanJobId || !requested) {
    throw new Error('jobId and relative path are required');
  }
  const abs = jobs.resolveWorkspacePath(cleanJobId, requested);
  let stat = null;
  try {
    stat = fs.statSync(abs);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw new Error(`file not found: ${requested}`);
  }
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) {
    throw new Error('Path outside workspace');
  }
  if (rel.startsWith('.') || rel.includes('/.telegram_') || isInternalWorkspaceSupportFile(rel)) {
    throw new Error('internal workspace metadata cannot be sent');
  }
  if (Number(stat.size || 0) > TELEGRAM_SEND_MAX_BYTES) {
    throw new Error(
      `file is too large for sendDocument (limit=${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}, size=${formatByteSize(stat.size)})`,
    );
  }
  await bot.sendDocument(
    chatId,
    abs,
    {
      caption: `📄 ${path.basename(rel)}`,
      reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0
        ? Number(replyToMessageId)
        : undefined,
    },
  );
  return {
    abs,
    rel,
    size: Number(stat.size || 0),
  };
}

function parseArtifactBundleSelection(rawSelection = '') {
  const raw = String(rawSelection || '').trim();
  if (!raw) return null;
  const bundleMatch = raw.match(/^bundle(?:\s+|:)(.+)$/i);
  if (!bundleMatch) return null;
  const body = String(bundleMatch[1] || '').trim();
  if (!body) return { mode: 'bundle', items: [] };
  const items = body
    .split(/[\s,]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  return { mode: 'bundle', items };
}

async function createArtifactBundle(jobId, selections, { artifactIndex = null } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const items = Array.isArray(selections) ? selections.map((row) => String(row || '').trim()).filter(Boolean) : [];
  if (!cleanJobId) throw new Error('jobId is required');
  if (items.length === 0) throw new Error('bundle selection is empty');
  const workspaceRoot = runWorkspaceDir(cleanJobId);
  const seen = new Set();
  const entries = [];
  for (const selection of items) {
    const rel = resolveArtifactSelection(cleanJobId, selection, { artifactIndex });
    const abs = jobs.resolveWorkspacePath(cleanJobId, rel);
    let stat = null;
    try {
      stat = fs.statSync(abs);
    } catch {
      stat = null;
    }
    if (!stat || !stat.isFile()) throw new Error(`file not found: ${rel}`);
    const normalizedRel = path.relative(workspaceRoot, abs).replace(/\\/g, '/');
    if (!normalizedRel || normalizedRel.startsWith('..')) throw new Error('Path outside workspace');
    if (normalizedRel.startsWith('.') || normalizedRel.includes('/.telegram_') || isInternalWorkspaceSupportFile(normalizedRel)) throw new Error('internal workspace metadata cannot be bundled');
    if (seen.has(normalizedRel)) continue;
    seen.add(normalizedRel);
    entries.push({ src: abs, arc: normalizedRel, size: Number(stat.size || 0) });
  }
  if (entries.length === 0) throw new Error('bundle selection is empty');
  return await createZipBundle(cleanJobId, entries);
}

async function sendArtifactBundle(bot, chatId, jobId, selections, { replyToMessageId = null, artifactIndex = null, runtime = null } = {}) {
  const contract = resolveArtifactDeliveryContract(jobId, runtime);
  if (contract?.enabled && contract.bundle_allowed === false) {
    const details = Array.isArray(contract.warnings) && contract.warnings.length > 0 ? ` ${contract.warnings[0]}` : '';
    throw new Error(`artifact publish contract blocked: declared artifact_index publisher is required before bundle delivery.${details}`.trim());
  }
  const bundle = await createArtifactBundle(jobId, selections, { artifactIndex });
  if (bundle.size > TELEGRAM_SEND_MAX_BYTES) {
    throw new Error(`bundle is too large for sendDocument (limit=${formatByteSize(TELEGRAM_SEND_MAX_BYTES)}, size=${formatByteSize(bundle.size)})`);
  }
  await bot.sendDocument(chatId, bundle.bundlePath, {
    caption: `📦 artifact bundle\n- files: ${bundle.entries.length}\n- name: ${bundle.fileName}`,
    filename: bundle.fileName,
    reply_to_message_id: Number.isFinite(Number(replyToMessageId)) && Number(replyToMessageId) > 0 ? Number(replyToMessageId) : undefined,
  });
  return bundle;
}

function resolveArtifactSelection(jobId, selection, { artifactIndex = null } = {}) {
  const cleanJobId = String(jobId || '').trim();
  const requested = String(selection || '').trim().replace(/^workspace\//i, '').replace(/^\.\//, '');
  if (!cleanJobId || !requested) throw new Error('jobId and selection are required');
  if (/^\d+$/.test(requested)) {
    const index = artifactIndex && typeof artifactIndex === 'object' ? artifactIndex : loadArtifactIndex(cleanJobId);
    const rows = Array.isArray(index?.artifacts) ? index.artifacts : [];
    const artifact = rows[Number(requested) - 1];
    if (!artifact?.path) throw new Error(`artifact index ${requested} not found`);
    return artifact.path;
  }
  return requested;
}

async function sendArtifactBySelection(bot, chatId, jobId, selection, { replyToMessageId = null, artifactIndex = null } = {}) {
  const rel = resolveArtifactSelection(jobId, selection, { artifactIndex });
  const sent = await sendWorkspaceFileByRelativePath(bot, chatId, jobId, rel, { replyToMessageId });
  return { ...sent, requested: String(selection || '').trim() };
}

async function deliverWorkspaceOutputs(bot, chatId, jobId, { replyToMessageId = null, maxFiles = 4 } = {}) {
  const artifactIndex = refreshArtifactIndex(jobId, { maxFiles });
  const rows = Array.isArray(artifactIndex.artifacts) ? artifactIndex.artifacts.slice(0, Math.max(1, Math.min(10, Math.floor(Number(maxFiles) || 4)))) : [];
  for (let index = 0; index < rows.length; index += 1) {
    if (!rows[index]?.sendable) continue;
    await sendArtifactBySelection(bot, chatId, jobId, String(index + 1), { replyToMessageId, artifactIndex });
  }
  return artifactIndex;
}

export {
  collectWorkspaceFileEntries,
  formatWorkspaceFileListText,
  buildWorkspaceFilesPromptSection,
  maybeAutoSendOutputs,
  maybeSendArtifactSummary,
  loadArtifactIndex,
  refreshArtifactIndex,
  formatArtifactIndexText,
  resolveArtifactDeliveryContract,
  formatArtifactDeliveryContractLines,
  sendArtifactBySelection,
  sendArtifactBundle,
  sendWorkspaceFileByRelativePath,
  deliverWorkspaceOutputs,
  parseArtifactBundleSelection,
};
