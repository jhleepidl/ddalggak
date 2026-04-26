import fs from 'node:fs';
import path from 'node:path';

import { clip, compactWithPinnedContext } from '../textutil.js';
import { formatActiveArtifactContext, loadArtifactObservations } from './artifact_context.js';

const IDLE_COMPACTION_CANDIDATES_FILE = 'idle_compaction_candidates.jsonl';
const IDLE_COMPACTION_SUMMARY_FILE = 'idle_compaction_summary.md';

function clean(value = '') {
  return String(value || '').trim();
}

function safeRead(filePath = '') {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return ''; }
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

function sharedDir(jobDir = '') {
  const dir = path.join(jobDir, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function formatRecentConversation(jobDir = '', { maxRows = 18, maxChars = 3000 } = {}) {
  const rows = readJsonl(path.join(jobDir, 'conversation.jsonl')).slice(-Math.max(1, Math.floor(Number(maxRows) || 18)));
  if (rows.length === 0) return '';
  const lines = ['## Recent conversation tail'];
  for (const row of rows) {
    const role = clean(row.role || row.kind || 'unknown');
    const text = clean(row.text || row.output || row.summary || '');
    if (!text) continue;
    lines.push(`- ${role}: ${clip(text.replace(/\s+/g, ' '), 260)}`);
  }
  return compactWithPinnedContext(lines.join('\n'), Math.max(800, Math.floor(Number(maxChars) || 3000)));
}

function collectSharedDocStats(jobDir = '') {
  const dir = path.join(jobDir, 'shared');
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => {
        const full = path.join(dir, entry.name);
        const stat = fs.statSync(full);
        return { name: entry.name, size: Number(stat.size || 0), mtime_ms: Number(stat.mtimeMs || 0) };
      })
      .sort((a, b) => b.mtime_ms - a.mtime_ms)
      .slice(0, 12);
  } catch {
    return [];
  }
}

export function buildIdleCompactionCandidate({ jobDir = '', maxChars = 7000 } = {}) {
  const cleanJobDir = clean(jobDir);
  if (!cleanJobDir) throw new Error('jobDir is required');
  const activeArtifactContext = formatActiveArtifactContext(cleanJobDir, { maxChars: 1800, limit: 6 });
  const recentConversation = formatRecentConversation(cleanJobDir, { maxRows: 20, maxChars: 3200 });
  const artifactObservations = loadArtifactObservations(cleanJobDir, { limit: 20 });
  const sharedStats = collectSharedDocStats(cleanJobDir);
  const lines = [
    '# Idle Compaction Candidate',
    '',
    `> generatedAt: ${new Date().toISOString()}`,
    '> status: candidate_requires_review',
    '> destructive_changes: false',
    '',
    '## Policy',
    '- This candidate summarizes/pins context only; it does not delete raw history, trace, uploads, or shared docs.',
    '- Active artifact facts and user corrections must remain higher priority than older compacted memory.',
    '- Apply/promote this summary only after review, or use it as an additional prompt surface.',
    '',
    activeArtifactContext || '## Active artifact context\n- (none)',
    '',
    recentConversation || '## Recent conversation tail\n- (none)',
    '',
    '## Artifact observation log summary',
    artifactObservations.length > 0
      ? artifactObservations.slice(-10).map((row) => {
          const labels = Array.isArray(row.observed_labels) && row.observed_labels.length ? ` labels=${row.observed_labels.join(', ')}` : '';
          const rejected = Array.isArray(row.rejected_labels) && row.rejected_labels.length ? ` rejected=${row.rejected_labels.join(', ')}` : '';
          return `- ${row.workspace_path || '(artifact)'}${labels}${rejected} status=${row.status || row.event || 'n/a'}`;
        }).join('\n')
      : '- (none)',
    '',
    '## Shared doc pressure',
    sharedStats.length > 0
      ? sharedStats.map((row) => `- ${row.name}: ${row.size} bytes`).join('\n')
      : '- (none)',
  ];
  const summaryMarkdown = compactWithPinnedContext(lines.filter(Boolean).join('\n'), Math.max(1400, Math.floor(Number(maxChars) || 7000)), { maxPinLines: 16 });
  return {
    ts: new Date().toISOString(),
    kind: 'idle_compaction_candidate',
    status: 'candidate_requires_review',
    destructive_changes: false,
    artifact_observation_count: artifactObservations.length,
    shared_doc_count: sharedStats.length,
    summary_markdown: summaryMarkdown,
  };
}

export function writeIdleCompactionCandidate({ jobDir = '', maxChars = 7000 } = {}) {
  const cleanJobDir = clean(jobDir);
  const candidate = buildIdleCompactionCandidate({ jobDir: cleanJobDir, maxChars });
  fs.appendFileSync(path.join(cleanJobDir, IDLE_COMPACTION_CANDIDATES_FILE), `${JSON.stringify(candidate)}\n`, 'utf8');
  const summaryPath = path.join(sharedDir(cleanJobDir), IDLE_COMPACTION_SUMMARY_FILE);
  fs.writeFileSync(summaryPath, `${candidate.summary_markdown.trim()}\n`, 'utf8');
  return { ...candidate, summary_path: summaryPath };
}

export function formatIdleCompactionCandidateForTelegram(candidate = {}) {
  const artifactCount = Number(candidate.artifact_observation_count || 0);
  const docCount = Number(candidate.shared_doc_count || 0);
  return [
    '🧹 idle compaction candidate 생성 완료',
    `- status: ${candidate.status || 'candidate_requires_review'}`,
    `- destructive_changes: ${candidate.destructive_changes === true ? 'true' : 'false'}`,
    `- artifact_observations: ${artifactCount}`,
    `- shared_docs: ${docCount}`,
    candidate.summary_path ? `- summary: ${candidate.summary_path}` : '',
    '',
    clip(String(candidate.summary_markdown || ''), 1800),
  ].filter(Boolean).join('\n');
}
